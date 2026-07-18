// ── firebase.js integration ──────────────────────────────────────────────────
// scheduleSync() is called after every data mutation so changes automatically
// propagate to Firestore when the user is signed in. If not signed in or offline,
// the call is a no-op and localStorage continues working as usual.
import { signInWithGoogle, signOutUser, scheduleSync, getSyncStatus, deleteCloudData,
         createShare, deleteShare, listMyShares } from './firebase.js';
import { packShare, unpackShare, normalizeShareCode, formatShareCode } from './share.js';
import { TR } from './translations.js';
import { buildRulesRows } from './calc.js';
import { DEFAULT_PROFILE, isUsableProfile } from './profile.js';
import { needsNightSchedule } from './profile-v2.js';
import { buildRows, exportCSV, exportPDF, showExportToast, monthsWithData as expMonthsWithData } from './export.js';
import { pad, mkds, pd, dowOf, isSun, isSat, getMonday } from './core/dates.js';
import { entryHours, isZeroDay } from './domain/log-entries.js';
import { shiftForIn, applyAnchor, recentAnchorsFixedDay } from './domain/shift-pattern.js';
import { normalizeWages, wageForIn, activeWageIdx } from './domain/wage-history.js';
import { DEFAULT_INSURANCE, careRateOfGross as careRateOf, insuranceRate as insRateOf, applyDeductionRate } from './domain/deductions.js';
import { calcWageIn, liveGrossIn, autoEffIn, allWeekdaysLoggedIn, probeHoursIn, engineDayClassIn, baseEffForIn, bucketKeysIn, bucketForIn, bucketDeterministicEffIn } from './domain/earnings.js';
import { defaultLogForIn, buildQuickLogEntryIn } from './domain/quick-log.js';
import { createHolidayService, translateHolidayName, getUpcomingIn, upcomingHolCutoff } from './data/holidays.js';
import { wizT as wizTCore, WIZ_DEFAULT_RULES as WIZ_DEFAULT_RULES_Core,
         wizardAnswersFrom as wizardAnswersFromCore, wizardProfileFrom as wizardProfileFromCore,
         rulesStateFromProfile as rulesStateFromProfileCore } from './domain/wizard-core.js';
import { WZI, SHM_IC_CHECK, SHM_IC_SEARCH } from './ui/icons.js';
import { animateModalClose, escHTML } from './ui/dom.js';
import { workplaceFormHTML, wireWorkplaceForm, obxNeedsSchedPage,
         obxWorkplaceHTML, obxWireWorkplace, obxNightHTML, obxWireNight } from './ui/workplace-form.js';
import { wireShareCodeInput, shareLookupByCode, shmEmptyHTML, shmFoundHeadHTML, buildShareLikeModal } from './ui/share-widgets.js';
import { buildAllHolidaysModal } from './ui/modals/holidays.js';
import { buildWageModal } from './ui/modals/wage.js';
import { buildResetModal } from './ui/modals/reset.js';
import { buildAllShiftsModal } from './ui/modals/all-shifts.js';
import { buildModal } from './ui/modals/day-log.js';
import { buildWorkplaceModal, buildShareModal, buildImportModal } from './ui/modals/workplace-share.js';
import { initOnboarding } from './onboarding/onboarding.js';
import { animateStatsHero, initCardTilt } from './ui/motion.js';
import { buildCal, wireCalendar, updateHolSeps } from './ui/views/calendar.js';

// ── App signature footer ─────────────────────────────────────────────────────
// Premium credit footer shared beneath the last card on the Calendar, Overview,
// and Settings tabs. Bump APP_VERSION on release — it surfaces in the pill on
// the right. The credit text stays localized via t('calHint').
const APP_VERSION = 'v2.1.4';
function appFooter(){
  return `
  <footer class="app-footer">
    <div class="app-footer-rule"><span class="app-footer-spark"></span></div>
    <div class="app-footer-pill">
      <span class="app-footer-credit">${t('calHint')}</span>
      <span class="app-footer-div"></span>
      <span class="app-footer-ver">${APP_VERSION}</span>
    </div>
  </footer>`;
}

// ── Auth state (global, set by firebase.js) ─────────────────────────────────
// CURRENT_USER is the single source of truth for auth in the render layer.
// firebase.js calls setCURRENT_USER when onAuthStateChanged fires,
// which triggers render() so every part of the UI derives from this value.
let CURRENT_USER = null;
function setCURRENT_USER(user){ CURRENT_USER = user; render(); }
// updateSyncUI: lightweight badge refresh without full re-render
function updateSyncUI(){
  const badge=document.getElementById('sync-badge');
  if(!badge)return;
  const status=getSyncStatus();
  const isOffline=!navigator.onLine;
  // When the network is gone, always show the offline icon regardless of
  // what firebase.js reports (it may not have fired its 'offline' event yet).
  const effectiveStatus=isOffline?'offline':status;
  const tips={synced:'Synced',pending:'Syncing…',offline:'Offline — saved locally',idle:''};
  // SYNC_ICONS is defined later in module scope (function hoisting isn't in play
  // for const, but updateSyncUI only ever runs after first render, by which time
  // the constant is initialised).
  badge.innerHTML=SYNC_ICONS[effectiveStatus]||SYNC_ICONS.synced;
  badge.title=tips[effectiveStatus]||'';
  badge.setAttribute('aria-label',tips[effectiveStatus]||'');
  badge.dataset.status=effectiveStatus;
  badge.className='sync-badge sync-badge--'+effectiveStatus;
  updateSyncedTime();
}
// Refresh the "Last synced Xm ago" label in place (web header). Cheap; safe to
// call frequently. Also swaps the whole block in/out if sync state appears.
function updateSyncedTime(){
  const el=document.getElementById('hdr-synced-time');
  if(!el)return;
  const lbl=lastSyncedLabel();
  if(lbl) el.textContent=lbl;
}
// Tick the relative sync time so it updates live (e.g. 55s → 56s → 57s) without
// any reload. Cheap textContent swap; runs every second.
let _syncTick=null;
function startSyncTicker(){
  if(_syncTick)clearInterval(_syncTick);
  _syncTick=setInterval(updateSyncedTime,1000); // every second — instant feel
}
// updateOfflineBanner: sets the banner text in the current language.
// Called from render() and whenever the language changes.
function updateOfflineBanner(){
  const el=document.getElementById('offline-banner-text');
  if(!el)return;
  // Fall back to English if key missing in a language block
  const lang=S?.lang||localStorage.getItem('wt4_lang')||'en';
  el.textContent=(TR[lang]?.offlineBanner)||TR.en.offlineBanner;
}
// Expose to window so firebase.js (a separate ES module) can call these.
// ES modules have isolated scopes — window is the only shared global.
window._appBridge = { setCURRENT_USER, updateSyncUI, get render(){ return render; } };

// ── Dynamic Korean Public Holidays ───────────────────────────────────────────
// The fetch/cache/cooldown lifecycle lives in data/holidays.js (Phase 5). The
// MAPS stay app-owned (the golden oracle injects HOLIDAYS per fixture; isHol
// below is sliced) — the service fills them and calls back render() when a
// fetch actually lands new data.

let HOLIDAYS = {};    // "YYYY-MM-DD" → English name
let HOL_KO_DYN = {};  // "YYYY-MM-DD" → Korean name (dateName from API)
const HOL_SVC = createHolidayService({
  holidays: HOLIDAYS,
  holidaysKo: HOL_KO_DYN,
  onUpdate: () => render(),
});

// Seed the cache synchronously on startup (zero network, zero flicker).
HOL_SVC.seedFromCache();

// Adapters over the holiday service (data/holidays.js, Phase 5).
function ensureHolidays(years){ return HOL_SVC.ensureYears(years); }
function prefetchHolidays(){ HOL_SVC.prefetch(); }

// ── Upcoming holidays ─────────────────────────────────────────────────────────
// The next `limit` public holidays strictly after today; the service returns
// {ds, diffDays}, holName supplies the display name (app-side, S.lang-aware).
function getUpcomingHolidays(limit = 3) {
  return getUpcomingIn(HOLIDAYS, today(), limit).map(h => ({ ...h, name: holName(h.ds) }));
}

// ── All-Holidays modal ────────────────────────────────────────────────────────


const DEFAULT_WAGE=10320,DEFAULT_TAX=3.3;

// ── Language flag icons ────────────────────────────────────────────────────────
// Emoji flags (🇺🇸 etc.) are regional-indicator pairs, and Windows ships no flag
// glyphs — every Windows browser falls back to rendering the bare letters ("US",
// "KR", …). These inline SVG data-URIs (flag-icons, MIT) render identically on
// every platform and stay offline-safe (no CDN, cached with the shell). Keyed by
// language code, so en→US, ko→KR, zh→CN, ne→NP.
const FLAGS={
    en:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-us%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23bd3d44%22%20d%3D%22M0%200h640v480H0%22%2F%3E%3Cpath%20stroke%3D%22%23fff%22%20stroke-width%3D%2237%22%20d%3D%22M0%2055.3h640M0%20129h640M0%20203h640M0%20277h640M0%20351h640M0%20425h640%22%2F%3E%3Cpath%20fill%3D%22%23192f5d%22%20d%3D%22M0%200h364.8v258.5H0%22%2F%3E%3Cmarker%20id%3D%22us-a%22%20markerHeight%3D%2230%22%20markerWidth%3D%2230%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22m14%200%209%2027L0%2010h28L5%2027z%22%2F%3E%3C%2Fmarker%3E%3Cpath%20fill%3D%22none%22%20marker-mid%3D%22url(%23us-a)%22%20d%3D%22m0%200%2016%2011h61%2061%2061%2061%2060L47%2037h61%2061%2060%2061L16%2063h61%2061%2061%2061%2060L47%2089h61%2061%2060%2061L16%20115h61%2061%2061%2061%2060L47%20141h61%2061%2060%2061L16%20166h61%2061%2061%2061%2060L47%20192h61%2061%2060%2061L16%20218h61%2061%2061%2061%2060z%22%2F%3E%3C%2Fsvg%3E',
    ko:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20id%3D%22flag-icons-kr%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3CclipPath%20id%3D%22kr-a%22%3E%3Cpath%20fill-opacity%3D%22.7%22%20d%3D%22M-95.8-.4h682.7v512H-95.8z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3Cg%20fill-rule%3D%22evenodd%22%20clip-path%3D%22url(%23kr-a)%22%20transform%3D%22translate(89.8%20.4)scale(.9375)%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M-95.8-.4H587v512H-95.8Z%22%2F%3E%3Cg%20transform%3D%22rotate(-56.3%20361.6%20-101.3)scale(10.66667)%22%3E%3Cg%20id%3D%22kr-c%22%3E%3Cpath%20id%3D%22kr-b%22%20fill%3D%22%23000001%22%20d%3D%22M-6-26H6v2H-6Zm0%203H6v2H-6Zm0%203H6v2H-6Z%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23kr-b%22%20width%3D%22100%25%22%20height%3D%22100%25%22%20y%3D%2244%22%2F%3E%3C%2Fg%3E%3Cpath%20stroke%3D%22%23fff%22%20d%3D%22M0%2017v10%22%2F%3E%3Cpath%20fill%3D%22%23cd2e3a%22%20d%3D%22M0-12a12%2012%200%200%201%200%2024Z%22%2F%3E%3Cpath%20fill%3D%22%230047a0%22%20d%3D%22M0-12a12%2012%200%200%200%200%2024A6%206%200%200%200%200%200Z%22%2F%3E%3Ccircle%20cy%3D%22-6%22%20r%3D%226%22%20fill%3D%22%23cd2e3a%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22rotate(-123.7%20191.2%2062.2)scale(10.66667)%22%3E%3Cuse%20xlink%3Ahref%3D%22%23kr-c%22%20width%3D%22100%25%22%20height%3D%22100%25%22%2F%3E%3Cpath%20stroke%3D%22%23fff%22%20d%3D%22M0-23.5v3M0%2017v3.5m0%203v3%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    id:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-id%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23e70011%22%20d%3D%22M0%200h640v240H0Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%20240h640v240H0Z%22%2F%3E%3C%2Fsvg%3E',
    th:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-th%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cg%20fill-rule%3D%22evenodd%22%3E%3Cpath%20fill%3D%22%23f4f5f8%22%20d%3D%22M0%200h640v480H0z%22%2F%3E%3Cpath%20fill%3D%22%232d2a4a%22%20d%3D%22M0%20162.5h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%23a51931%22%20d%3D%22M0%200h640v82.5H0zm0%20400h640v80H0z%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    ru:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-ru%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%230039a6%22%20d%3D%22M0%20160h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%23d52b1e%22%20d%3D%22M0%20320h640v160H0z%22%2F%3E%3C%2Fsvg%3E',
    zh:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20id%3D%22flag-icons-cn%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3Cpath%20id%3D%22cn-a%22%20fill%3D%22%23ff0%22%20d%3D%22M-.6.8%200-1%20.6.8-1-.3h2z%22%2F%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%22%23ee1c25%22%20d%3D%22M0%200h640v480H0z%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(71.9991%200%200%2072%20120%20120)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(-12.33562%20-20.5871%2020.58684%20-12.33577%20240.3%2048)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(-3.38573%20-23.75998%2023.75968%20-3.38578%20288%2095.8)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(6.5991%20-23.0749%2023.0746%206.59919%20288%20168)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(14.9991%20-18.73557%2018.73533%2014.99929%20240%20216)%22%2F%3E%3C%2Fsvg%3E',
    fr:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-fr%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23000091%22%20d%3D%22M0%200h213.3v480H0z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M213.3%200h213.4v480H213.3z%22%2F%3E%3Cpath%20fill%3D%22%23e1000f%22%20d%3D%22M426.7%200H640v480H426.7z%22%2F%3E%3C%2Fsvg%3E',
    ne:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-np%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3CclipPath%20id%3D%22np-a%22%3E%3Cpath%20fill-opacity%3D%22.7%22%20d%3D%22M0-16h512v512H0z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3Cg%20clip-path%3D%22url(%23np-a)%22%20transform%3D%22translate(0%2015)scale(.9375)%22%3E%3Cg%20fill-rule%3D%22evenodd%22%3E%3Cpath%20fill%3D%22%23ce0000%22%20stroke%3D%22%23000063%22%20stroke-width%3D%2213.8%22%20d%3D%22M6.5%20489.5h378.8L137.4%20238.1l257.3.3L6.6-9.5v499z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22m180.7%20355.8-27%209%2021.2%2019.8-28.5-1.8%2011.7%2026.2-25.5-12.3.5%2028.6-18.8-20.9-10.7%2026.6-9.2-26.3-20.3%2020.6%201.8-27.7L49%20409l12.6-25-29.3.6%2021.5-18.3-27.3-10.5%2027-9L32.2%20327l28.4%201.8L49%20302.6l25.6%2012.3-.5-28.6%2018.8%2020.9%2010.7-26.6%209.1%2026.3%2020.4-20.6-1.9%2027.7%2027-11.4-12.7%2025%2029.4-.6-21.5%2018.3zm-32.4-184.7-11.3%208.4%205.6%204.6a94%2094%200%200%200%2030.7-36c1.8%2021.3-17.7%2069-68.7%2069.5a70.6%2070.6%200%200%201-71.5-70.3c10%2018.2%2016.2%2027%2032%2036.5l4.7-4.4-10.6-8.9%2013.7-3.6-7.4-12.4%2014.4%201-1.8-14.4%2012.6%207.4%204-13.5%209%2010.8%208.5-10.3%204.6%2014%2011.8-8.2-1.5%2014.3%2014.2-1.7-6.7%2013.2z%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E',
};
// Renders a language flag as an isolated <img> (data-URI SVG), so each flag's
// internal element ids can't collide when the same flag appears more than once.
const flagImg=(code,cls)=>`<img class="${cls}" src="${FLAGS[code]||''}" alt="" aria-hidden="true" draggable="false">`;

// ── Deductions ───────────────────────────────────────────────────────────────
// Two mutually-exclusive modes decide what's subtracted from gross pay:
//   'tax'       → a single flat withholding % (default; Korea's 3.3% freelancer
//                 withholding is the out-of-the-box value)
//   'insurance' → Korea's 4대 보험 employee-side contributions, summed
// Only ONE mode is ever active, so net = gross × (1 − activeRate) in both cases;
// only the source of activeRate differs. Mode defaults to 'tax' so existing
// users see zero change until they opt in.
//
// The rates, statutory defaults, and math live in domain/deductions.js
// (Phase 3); these adapters bind stored settings (the ins||getInsurance()
// defaulting is storage glue, not math).
function getDeductionMode(){ return ld('wt4_deduction_mode', 'tax'); }
function getInsurance(){
  const s = ld('wt4_insurance', null);
  return s ? { ...DEFAULT_INSURANCE, ...s } : { ...DEFAULT_INSURANCE };
}
function careRateOfGross(ins){ return careRateOf(ins || getInsurance()); }
function insuranceRate(ins){ return insRateOf(ins || getInsurance()); }
// Tax rate is stored as a percentage (e.g. 3.3) in wt4_tax_rate
function getTax(){return ld('wt4_tax_rate',DEFAULT_TAX)/100;}
// The single active deduction fraction, per current mode.
function deductionRate(){
  return getDeductionMode()==='insurance' ? insuranceRate() : getTax();
}
// Display-facing versions of the above: whatever mode is active (tax vs.
// 4대 보험 insurance), these give the correct percentage AND the correct
// localized noun so UI copy never says "X% tax" while insurance is active.
// Use these (not getTaxPct()/hardcoded "tax" strings) for any user-facing
// label that shows the deduction rate.
function getActiveDeductionPct(){return Math.round(deductionRate()*100*100)/100;}
function getDeductionNoun(){return t(getDeductionMode()==='insurance'?'deductionModeInsurance':'deductionModeTax');}
function ld(k,d){try{const v=localStorage.getItem(k);return v!==null?JSON.parse(v):d;}catch{return d;}}
function sv(k,v){localStorage.setItem(k,JSON.stringify(v));}
// pad/mkds/pd/dowOf/isSun/isSat/getMonday moved to core/dates.js (Phase 2).
// today() stays HERE: the golden oracle reassigns it to a pinned fixture date,
// which an imported binding cannot be.
function today(){const d=new Date();return mkds(d.getFullYear(),d.getMonth(),d.getDate());}
function getLogs(){return ld('wt4_logs',{});}
function saveLogs(l){sv('wt4_logs',l);scheduleSync();}

// ── One-tap default inference — moved to domain/quick-log.js (Phase 4) ───────
function defaultLogFor(dateStr){ return defaultLogForIn(APP_ENV, dateStr); }
function buildQuickLogEntry(dateStr){ return buildQuickLogEntryIn(APP_ENV, dateStr); }
function getShifts(){return ld('wt4_shifts',{});}
function saveShifts(s){sv('wt4_shifts',s);scheduleSync();}
// ── Wage history ──────────────────────────────────────────────────────────────
// Stored as wt4_wages: [{date:'YYYY-MM-DD', amount:number}, ...] sorted by date.
// wageFor(dateStr) returns the wage active on that date (most recent entry ≤ date).
// Migration: if the old scalar wt4_wage key is present, import it as the
// initial entry dated '2000-01-01' so all historical logs keep their value.
// Timeline resolution + both read-migrations live in domain/wage-history.js
// (Phase 3); this adapter persists when a migration dirtied the data.
function getWages(){
  const { wages, dirty, fromLegacy } = normalizeWages(ld('wt4_wages', null), ld('wt4_wage', null), DEFAULT_WAGE);
  if(dirty){ sv('wt4_wages', wages); if(fromLegacy) localStorage.removeItem('wt4_wage'); }
  return wages;
}
function saveWages(wages){ sv('wt4_wages', wages); scheduleSync(); }
function wageFor(dateStr){ return wageForIn(getWages(), dateStr, DEFAULT_WAGE); }
// Current wage (for display in settings / modal default)
function getWage(){ return wageFor(today()); }
function isHol(s){return!!HOLIDAYS[s];}
// The API returns the Korean local name directly (localName field).
// We use that for all languages since it's already in Korean from the government API.
// For English/Indonesian we use the English name (name field) which we store as the value.
// Since date.nager.at gives localName (Korean) as the value, we store both.
// Implementation: we store localName as primary. To get English, we keep a parallel en map.
function holName(s){
  // Always look up the Korean name first (source of truth from the API)
  const ko = HOL_KO_DYN[s];
  if(!ko) return HOLIDAYS[s] || s; // legacy fallback for pre-fetched data
  if(S.lang === 'ko') return ko;
  return translateHolidayName(ko, S.lang);
}
// Applies whichever deduction mode is active (tax or insurance).
// Named applyTax for backward-compat with existing call sites.
function applyDeductions(g){return applyDeductionRate(g,deductionRate());}
function applyTax(g){return applyDeductions(g);}

// ── Shift: anchor-based propagation forward indefinitely ─────────────────────
// The inference algorithm lives in domain/shift-pattern.js (Phase 3).
function shiftFor(s){ return shiftForIn(getShifts(), s); }

function setShiftFromWeek(ws,shift){
  saveShifts(applyAnchor(getShifts(), ws, shift));
}

function toggleShift(ws){
  setShiftFromWeek(ws, shiftFor(ws)==='day'?'night':'day');
}

// ── Sunday auto-credit: all Mon–Fri of that week must be logged ──────────────
// (rule lives in domain/earnings.js, Phase 4)
function allWeekdaysLogged(s){ return allWeekdaysLoggedIn(APP_ENV, s); }

// ── Wage calculation ──────────────────────────────────────────────────────────
// Phase 1: the calculator moved VERBATIM to calc.js (single source of truth,
// shared with export.js). This adapter keeps the original call signature so
// every existing call site is untouched; it packages the app-side environment
// (language, holiday set, shift inference, holAuto, active deduction) into the
// explicit ctx that calc.js's pure implementation requires.
// Phase 2a: the calculator is profile-driven. getProfile() reads wt4_profile
// and falls back WHOLESALE to the default (today's rulebook) when absent or
// unrecognized — every existing user is grandfathered with zero change.
// wt4_profile does not sync yet; it joins SYNC_KEYS a release after the
// merge:true fix in firebase.js has rolled out (see that file).
function getProfile(){
  const p = ld('wt4_profile', null);
  return isUsableProfile(p) ? p : DEFAULT_PROFILE;
}
// Phase 4 (structural): the projection primitives live in domain/earnings.js —
// every number the Overview projections use comes from an engine probe of the
// ACTIVE profile, through these env-bound adapters.
function probeHours(){ return probeHoursIn(getProfile()); }
function engineDayClass(ds){ return engineDayClassIn(APP_ENV, ds); }
function baseEffFor(ds, sh){ return baseEffForIn(APP_ENV, ds, sh); }
function bucketKeys(){ return bucketKeysIn(getProfile()); }
function bucketFor(ds){ return bucketForIn(APP_ENV, ds); }
function bucketDeterministicEff(bucket){ return bucketDeterministicEffIn(APP_ENV, bucket); }

// ═════════════════════════════════════════════════════════════════════════════
// Phase 5: pay-rules wizard — the authoring UI over compile.js.
// Pure state → HTML → answers → compiled profile. Shared verbatim between the
// onboarding step and the Settings "Edit pay rules" editor.
// ═════════════════════════════════════════════════════════════════════════════
// The wizard's pure layer lives in domain/wizard-core.js (Phase 6). These five
// keep their names because the golden oracle slices them; each delegates.
function wizT(lang,k){ return wizTCore(lang,k); }
function WIZ_DEFAULT_RULES(){ return WIZ_DEFAULT_RULES_Core(); }
function wizardAnswersFrom(rules){ return wizardAnswersFromCore(rules); }
function wizardProfileFrom(rules, pattern){ return wizardProfileFromCore(rules, pattern); }
function rulesStateFromProfile(profile){ return rulesStateFromProfileCore(profile); }
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// The workplace form \u2014 a configuration panel, not a form. Shared verbatim by
// onboarding step 3 and the Settings "Edit workplace" modal.
//
// RENDERS ONCE. Every interaction after mount is a surgical DOM update: class
// toggles for selection, textContent swaps for the live preview, and animated
// grid-row FOLDS for the progressive sections (Customize questions, the night
// panel, the unpaid break). The form is never re-rendered, so scroll position,
// focus, and the glass panels never jump.
//
// Context-aware: pass {pattern:'day'} and everything night-related \u2014 the night
// question, the schedule panel, the night preview line \u2014 simply doesn't exist.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// WZI moved to ui/icons.js (Phase 6).
// \u2500\u2500 Rate steppers \u2014 the Customize interaction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Each pay rule is one row: icon \u00b7 label \u00b7 plain-language caption ("+50%") \u00b7
// a \u00d7-multiplier stepper that snaps along a \u00d70.25 detent grid. Legacy profiles
// may hold off-grid multipliers (\u00d71.6), so a step first snaps to the grid in
// the direction of travel instead of drifting by a fixed increment.
// WZ_STEP/WZ_BRK + the stepper/break/normalize helpers live in
// domain/wizard-core.js (Phase 6) \u2014 imported above; the form markup below uses them.
// The workplace form + night-schedule page moved to ui/workplace-form.js (Phase 6).

// Phase 3b: the "Wage Calculation Rules" card is generated from the ACTIVE
// profile via engine probes — correct for any custom profile, not just the
// factory default (verified against the legacy table by tests/rules-replay).
function rulesRows(){
  return buildRulesRows(getProfile(), TR[S.lang].seg,
    { holAuto: isHolAuto(), dedPct: getActiveDeductionPct(), dedNoun: getDeductionNoun() });
}
// The app's capability record for the domain layer (Phase 4). Members are the
// app's own functions — late-bound, never data snapshots — so read-per-call
// semantics stay byte-identical. Arrow wrappers where the target is reassigned
// (the oracle re-pins today) or dynamic (S.lang).
const APP_ENV = {
  getLogs, wageFor, shiftFor, isHol,
  isHolAuto: () => isHolAuto(),
  applyTax, getProfile,
  tr: () => TR[S.lang],
  todayStr: () => today(),
};
function calcWage(dateStr,regHrs,otHrs,wage,shiftOverride,holCreditOverride){
  return calcWageIn(APP_ENV, dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride);
}

// ── State ─────────────────────────────────────────────────────────────────────
let S={
  lang:ld('wt4_lang','en'),theme:ld('wt4_theme','dark'),holAuto:ld('wt4_hol_auto',true),
  taxRate:ld('wt4_tax_rate',DEFAULT_TAX),
  targetHrs:ld('wt4_target_hrs',250),
  tab:'calendar',calY:new Date().getFullYear(),calM:new Date().getMonth(),
  modal:null,
  chartRange:'3m',   // '3m' | '6m' | '1y'
  wageModal:null,   // transient: {mode:'add'|'edit'|'delete', idx?:number} or null
  resetModal:false, // transient: whether the "Reset all data" confirmation modal is open
  rulesCollapsed:ld('wt4_rules_collapsed',false), // settings: Wage Calc Rules card collapsed?
};
function t(k,...a){const fn=TR[S.lang][k];return typeof fn==='function'?fn(...a):(fn||k);}
// Success feedback uses the same floating toast as exports (showExportToast):
// a self-dismissing checkmark pill at the bottom of the screen, instead of an
// inline message inside the card. Call sites may pass either a ready-made
// message string (e.g. t('wageSaved')) or one of the keys mapped below.
//
// We also re-render here so the rest of the UI (hero stats, the holiday
// switch, etc.) immediately reflects the change that was just saved — every
// caller of showSuccess() has just mutated state and expects a refresh.
const _SUCCESS_MSG={
  taxRate:   ()=>t('taxRateSaved'),
  insurance: ()=>t('insuranceSaved'),
  targetHrs: ()=>t('monthlyTargetSaved'),
  holAuto:   ()=>t('holAutoSaved'),
};
function showSuccess(val){
  const msg=_SUCCESS_MSG[val]?_SUCCESS_MSG[val]():val;
  render();
  if(msg) showExportToast(msg);
}

// ── Interactive undo toast ──────────────────────────────────────────────────
// Like showExportToast, but carries an "Undo" action button and stays a little
// longer so the user has time to react. Used by the week-shift flip so a tap
// that re-alternates every following week is always recoverable.
let _undoToastTimer=null;
function showUndoToast(message,onUndo){
  document.getElementById('undo-toast')?.remove();
  clearTimeout(_undoToastTimer);

  const el=document.createElement('div');
  el.id='undo-toast';
  el.className='undo-toast';
  el.innerHTML=`<svg class="undo-toast__ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>`+
    `<span class="undo-toast__msg">${message}</span>`+
    `<button type="button" class="undo-toast__btn">${t('undo')}</button>`;
  document.body.appendChild(el);

  const dismiss=()=>{
    el.classList.remove('undo-toast--visible');
    setTimeout(()=>el.remove(),220);
  };
  el.querySelector('.undo-toast__btn').addEventListener('click',()=>{
    clearTimeout(_undoToastTimer);
    dismiss();
    onUndo?.();
  });

  requestAnimationFrame(()=>el.classList.add('undo-toast--visible'));
  _undoToastTimer=setTimeout(dismiss,4500);
}
function isHolAuto(){return S.holAuto!==false;}
function getTaxPct(){return S.taxRate;} // percentage for display (e.g. 3.3)
function applyTheme(){document.documentElement.setAttribute('data-theme',S.theme);}

// ── Single source of truth for earnings on a given date ────────────────────────────
// liveGross(ds, logs?) always recomputes gross from stored hours × wageFor(ds).
// This ensures wage history changes are reflected everywhere immediately —
// no stale gross/net values baked into log entries are ever used for display.
//
// For logged days:  recompute via calcWage using stored regHrs/otHrs/shiftOverride.
// For auto-credits: 8h × wageFor(ds) (holidays and qualifying Sundays).
// For everything else: 0.
//
// Pass a pre-fetched logs object to avoid repeated localStorage reads in loops.
// (bodies live in domain/earnings.js since Phase 4 — same rules, env-bound)
function liveGross(ds, logsArg){ return liveGrossIn(APP_ENV, ds, logsArg); }

// autoGross / autoEff: wrappers used throughout the render layer.
// autoGross delegates entirely to liveGross — one definition, no divergence.
function autoGross(ds, logsArg){
  return liveGross(ds, logsArg);
}
function autoEff(ds, logsArg){ return autoEffIn(APP_ENV, ds, logsArg); }

// ── Holiday separator visibility ─────────────────────────────────────────────
// Hides a .hol-sep when it has wrapped to the start of a new row — i.e. when
// its top offset differs from the chip that follows it. Called after render
// and on resize so it stays correct on all screen sizes.

// ── Header icons ──────────────────────────────────────────────────────────────
// Inline SVGs so header controls match the app's stroked iconography instead of
// emoji (which render inconsistently across platforms and clash with the UI).
// All share: 16px box, currentColor, stroke-width 2, round caps/joins.
const _svg=(inner,w=16)=>`<svg class="hdr-svg" width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_SUN   =_svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>');
const ICON_MOON  =_svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');
const ICON_GLOBE =_svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>');
// Google "G" — multicolor, matches the OAuth provider. Fixed colors (not currentColor).
const ICON_GOOGLE=`<svg class="hdr-svg" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>`;
const ICON_OFFLINE=_svg('<path d="M18 10h-1.26a8 8 0 0 0-3.4-4.5"/><path d="M6.3 6.3A8 8 0 0 0 9 20h9a5 5 0 0 0 1.9-.37"/><path d="M2 2l20 20"/>',15);
// Sync states — cloud (synced), cloud with arrows (pending), cloud-off (offline)
const SYNC_ICONS={
  synced:  _svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',15),
  pending: _svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><path d="M9.5 14.5l1.6 1.6 3-3.2"/>',15),
  offline: _svg('<path d="M18 10h-1.26a8 8 0 0 0-3.4-4.5"/><path d="M6.3 6.3A8 8 0 0 0 9 20h9a5 5 0 0 0 1.9-.37"/><path d="M2 2l20 20"/>',15),
  idle:    '',
};

// ── Header helpers: greeting + relative sync time ─────────────────────────────
// Time-based greeting for the brand's secondary label. Falls back to English if
// a locale hasn't defined the key (t() returns the key itself when missing).
function greeting(){
  const h=new Date().getHours();
  // Morning 5–11, Afternoon 12–17, Evening 18–4 (no "good night").
  const key=h<5?'greetEvening':h<12?'greetMorning':h<18?'greetAfternoon':'greetEvening';
  const fallback={greetMorning:'Good morning',greetAfternoon:'Good afternoon',greetEvening:'Good evening'}[key];
  const v=t(key);
  const text=v===key?fallback:v;
  // Punctuation: '~!' for en/ko/fr/zh, plain '!' elsewhere.
  const lang=S?.lang||localStorage.getItem('wt4_lang')||'en';
  const suffix=['en','ko','fr','zh'].includes(lang)?'~!':'!';
  return text+suffix;
}
// "Last synced 2m ago" style relative label from the wt4_syncedAt timestamp.
// Returns null when there's nothing to show (never synced / not signed in).
function lastSyncedLabel(){
  const ts=Number(localStorage.getItem('wt4_syncedAt')||0);
  if(!ts) return null;
  const secs=Math.max(0,Math.floor((Date.now()-ts)/1000));
  if(secs<10)  return t2('syncJustNow','Just now');
  if(secs<60)  return t2('syncSecsAgo','{n}s ago').replace('{n}',secs);
  const mins=Math.floor(secs/60);
  if(mins<60)  return t2('syncMinsAgo','{n}m ago').replace('{n}',mins);
  const hrs=Math.floor(mins/60);
  if(hrs<24)   return t2('syncHrsAgo','{n}h ago').replace('{n}',hrs);
  const days=Math.floor(hrs/24);
  return t2('syncDaysAgo','{n}d ago').replace('{n}',days);
}
// t2: translate-with-fallback (t() returns the key when a string is missing).
function t2(key,fallback){ const v=t(key); return v===key?fallback:v; }

// ── Modal context (Phase 7) ──────────────────────────────────────────────────
// The app-owned surface the extracted modal modules receive (they can't import
// app.js). Stable function/state refs are passed directly; CURRENT_USER is
// reassigned, so it arrives as an accessor. Each modal destructures its subset.
function modalCtx(){
  return { S, t, render, today, getWages, saveWages, getWage, showSuccess,
           getLogs, saveLogs, shiftFor, liveGross, applyTax, wageFor, calcWage,
           isHol, isSat, isSun, holName, isHolAuto, allWeekdaysLogged,
           showUndoToast, getActiveDeductionPct, getDeductionNoun,
           currentUser: () => CURRENT_USER,
           openAllShifts: (restore) => buildAllShiftsModal(modalCtx(), restore) };
}
// The workplace editor / share / import modals' surface (profile-centric).
function wpShareCtx(){
  return { S, render, sv, getProfile, isHolAuto, getActiveDeductionPct, getDeductionNoun,
           storedPatternIsFixedDay, ruleRowsHTML, currentUser: () => CURRENT_USER };
}
// Open the day-log modal for a date (calendar cells, log-edit, Overview CTA).
function openDayModal(date){ S.modal={date, existing:getLogs()[date]||null}; buildModal(modalCtx()); }
// The Calendar view's surface (Phase 8).
function calendarCtx(){
  return { S, t, render, today, getLogs, saveLogs, getShifts, saveShifts, shiftFor,
           toggleShift, isHol, holName, isHolAuto, allWeekdaysLogged, defaultLogFor,
           buildQuickLogEntry, autoEff, appFooter, ensureHolidays, HOLIDAYS,
           showUndoToast, openDayModal };
}
// The onboarding flow's surface (Phase 7f). openImportModal wraps the
// grandfathered-user join link so onboarding needn't know wpShareCtx.
function onboardingCtx(){
  return { S, render, ld, sv, today, prefetchHolidays, flagImg, DEFAULT_WAGE, DEFAULT_TAX,
           currentUser: () => CURRENT_USER,
           openImportModal: (prefill, opts) => buildImportModal(wpShareCtx(), prefill, opts) };
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(){
  applyTheme();
  document.title = t('pageTitle');
  // If a modal is open, don't rebuild #app — the modal is self-contained.
  // Rebuilding #app while a modal is open re-stacks event listeners and
  // causes the page to visually flash behind the overlay.
  const modalOpen = !!(S.modal || S.wageModal || S.resetModal || document.getElementById('all-shifts-ov'));
  if(!modalOpen){
    _headerBound=false;   // header nodes are about to be recreated
    document.getElementById('app').innerHTML=buildApp();
    attachListeners();
  }
  if(S.modal)buildModal(modalCtx());
  if(S.wageModal)buildWageModal(modalCtx());
  if(S.resetModal)buildResetModal(modalCtx());
  updateOfflineBanner();
}

function buildApp(){
  // Sync badge — only shown when signed in; status from firebase.js.
  const ss=getSyncStatus();
  const ssTip={synced:'Synced',pending:'Syncing…',offline:'Offline — saved locally',idle:''}[ss]||'';
  const syncHTML=CURRENT_USER
    ?`<span id="sync-badge" class="sync-badge sync-badge--${ss}" title="${ssTip}" aria-label="${ssTip}">${SYNC_ICONS[ss]||SYNC_ICONS.synced}</span>`
    :'';
  // Account trigger — avatar or initial; dropdown is a body-level portal (see attachListeners)
  const accountHTML=CURRENT_USER
    ?`<button class="hdr-icon-btn hdr-avatar-btn" id="account-btn" title="${CURRENT_USER.displayName||CURRENT_USER.email}" aria-label="Account">
        ${CURRENT_USER.photoURL
          ?`<img src="${CURRENT_USER.photoURL}" class="avatar" alt="">`
          :`<span class="avatar-initials">${(CURRENT_USER.displayName||CURRENT_USER.email||'?')[0].toUpperCase()}</span>`}
      </button>`
    :`<button id="auth-login" class="hdr-signin${!navigator.onLine?' hdr-signin--disabled':''}"${!navigator.onLine?' disabled aria-disabled="true"':''} aria-label="${t('signIn')}">
        ${navigator.onLine?ICON_GOOGLE:ICON_OFFLINE}
        <span class="hdr-signin-label">${!navigator.onLine?t('offlineShort'):t('signIn')}</span>
      </button>`;
  // Theme + language triggers use inline SVGs to match the rest of the UI.
  const themeHTML=`<button class="hdr-icon-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme">${S.theme==='dark'?ICON_SUN:ICON_MOON}</button>`;
  const langHTML=`<button class="hdr-icon-btn" id="lang-btn" title="Language" aria-label="Language">${ICON_GLOBE}</button>`;
  // Brand secondary label — a time-based greeting for a premium, personal feel.
  const greet=greeting();
  // Last-synced sits in the left section, right after the greeting, separated by
  // a faded vertical divider. Desktop only (hidden on mobile via CSS).
  const syncedLbl=CURRENT_USER?lastSyncedLabel():null;
  const lastSyncedHTML=syncedLbl
    ?`<span class="hdr-sub-divider" aria-hidden="true"></span>
      <span class="hdr-synced" id="hdr-synced" aria-live="polite">
        <span class="hdr-synced-dot" aria-hidden="true"></span>
        <span class="hdr-synced-text">${t2('lastSynced','Last synced')}</span>
        <span class="hdr-synced-time" id="hdr-synced-time">${syncedLbl}</span>
      </span>`
    :'';
  const logoSrc=S.theme==='dark'?'./logo-dark.svg':'./logo-light.svg';
  return`<div class="hdr">
    <div class="hdr-glow" aria-hidden="true"></div>
    <div class="hdr-brand">
      <span class="hdr-mark" aria-hidden="true">
        <img src="${logoSrc}" width="100%" height="100%" alt="" draggable="false">
      </span>
      <div class="hdr-brand-text">
        <div class="hdr-title">
          <span class="hdr-logo" role="img" aria-label="Shiftr">Shift<span class="hdr-logo-r">r</span></span>
        </div>
        <div class="hdr-subrow">
          <span class="hdr-greeting">${greet}</span>
          ${lastSyncedHTML}
        </div>
      </div>
    </div>
    <div class="hdr-right">
      <div class="hdr-cluster">
        ${syncHTML}
        ${themeHTML}
        ${langHTML}
        ${CURRENT_USER?`<span class="hdr-cluster-sep" aria-hidden="true"></span>${accountHTML}`:''}
      </div>
      ${CURRENT_USER?'':accountHTML}
    </div>
  </div>
  ${buildStats()}
  <div class="tab-row" id="tab-row">
    <button class="tab${S.tab==='calendar'?' on':''}" data-tab="calendar">${t('tabCal')}</button>
    <button class="tab${S.tab==='overview'?' on':''}" data-tab="overview">${t('tabOverview')}</button>
    <button class="tab${S.tab==='settings'?' on':''}" data-tab="settings">${t('tabSet')}</button>
    <span class="tab-underline" id="tab-underline" aria-hidden="true"></span>
  </div>
  <div id="tab-content">${buildTabContent()}</div>`;
}

// Just the active tab's content — split out so tab switches can update this
// region alone instead of rebuilding the whole app (header, stats, etc.).
function buildTabContent(){
  return S.tab==='calendar'?buildCal(calendarCtx()):S.tab==='overview'?buildOverview():buildSettings();
}

// Switch tabs WITHOUT rebuilding the header/stats. Only the #tab-content region
// is replaced, so the header's glass, glow, sync dot animation, and portal
// listeners stay intact (no flicker, no re-mount). Content listeners are
// re-attached via attachListeners(), which is guarded to bind one-time header
// handlers only once (see _headerBound in attachListeners).
function switchTab(tab){
  // Clicking the already-active tab must be a no-op: re-mounting identical
  // content would needlessly replay the Overview entrance choreography.
  if(S.tab===tab) return;
  S.tab=tab;
  // Update tab-button active states in place
  document.querySelectorAll('.tab[data-tab]').forEach(b=>{
    b.classList.toggle('on', b.dataset.tab===tab);
  });
  // Slide the shared underline to the newly active tab (animated). Flag it so the
  // attachListeners() placement below doesn't snap-override the in-flight slide.
  _tabSwitching=true;
  positionTabUnderline(true);
  // Swap only the content region
  const host=document.getElementById('tab-content');
  if(host){
    host.innerHTML=buildTabContent();
  }else{
    // Fallback: if the container is missing for any reason, do a full render
    render();
    _tabSwitching=false;
    return;
  }
  // Re-wire listeners (header handlers are guarded to attach only once)
  attachListeners();
  // Clear the flag after the placement rAF has had its chance to run.
  requestAnimationFrame(()=>{ requestAnimationFrame(()=>{ _tabSwitching=false; }); });
}
let _tabSwitching=false;

// Position the single sliding tab indicator under the active tab. The bar uses a
// real px width (--tu-w) and slides via translateX (--tu-x) — the translate is
// GPU-composited for a smooth slide, while width animates crisply (no 1px-texture
// stretching, so no blur). Width and transform share the same easing/duration.
function positionTabUnderline(animate){
  const row=document.getElementById('tab-row');
  const bar=document.getElementById('tab-underline');
  if(!row||!bar) return;
  const active=row.querySelector('.tab.on')||row.querySelector('.tab');
  if(!active) return;
  const rowRect=row.getBoundingClientRect();
  const r=active.getBoundingClientRect();
  const x=Math.round((r.left-rowRect.left)*100)/100;
  const w=Math.round(r.width*100)/100;
  // On first placement (or when explicitly non-animated), disable the transition
  // for one frame so the bar appears in position instead of sliding in from 0.
  if(!animate){
    const prevTransition=bar.style.transition;
    bar.style.transition='none';
    bar.style.setProperty('--tu-x', x+'px');
    bar.style.setProperty('--tu-w', w+'px');
    bar.style.setProperty('--tu-o', '1');
    // force style flush, then restore the transition
    void bar.offsetWidth;
    bar.style.transition=prevTransition;
  }else{
    bar.style.setProperty('--tu-x', x+'px');
    bar.style.setProperty('--tu-w', w+'px');
    bar.style.setProperty('--tu-o', '1');
  }
}

// The stats-hero count-up + glass-card tilt animations live in ui/motion.js
// (Phase 8); attachListeners calls animateStatsHero / initCardTilt.

function buildStats(){
  const daysInM=new Date(S.calY,S.calM+1,0).getDate();
  const totalDays=daysInM;
  let days=0,hrs=0,gross=0;
  const logs=getLogs();
  for(let d=1;d<=daysInM;d++){
    const ds=mkds(S.calY,S.calM,d);
    const g=autoGross(ds,logs),e=autoEff(ds,logs);
    if(g>0||(logs[ds]&&isZeroDay(logs[ds]))){days++;gross+=g;hrs+=e;}
  }
  const net=applyTax(gross);
  const target=S.targetHrs||250;
  const hrsProgress=Math.min(100,Math.round((hrs/target)*100));
  const daysProgress=Math.min(100,Math.round((days/totalDays)*100));
  const mn=t('mn')[S.calM];

  // Delta vs previous month
  let prevNet=0;
  const prevM=S.calM===0?11:S.calM-1,prevY=S.calM===0?S.calY-1:S.calY;
  const daysInPrev=new Date(prevY,prevM+1,0).getDate();
  for(let d=1;d<=daysInPrev;d++){
    const ds=mkds(prevY,prevM,d);
    prevNet+=applyTax(autoGross(ds,logs));
  }
  const delta=net-prevNet;
  const prevMn=t('mn')[prevM];
  const deltaHTML=prevNet>0
    ?`<div class="stat-pay-delta${delta<0?' stat-pay-delta--neg':''}">
        ${delta>=0?'▲ +':'▼ '}₩${Math.abs(delta).toLocaleString()} ${t('deltaFrom', prevMn)}
      </div>`
    :'';

  // Circular ring for pay card — thicker stroke, gradient, integrated glow
  const RING_R=46,RING_C=58,RING_STROKE=9;
  const circumference=2*Math.PI*RING_R;

  return`<div class="stats-hero">
    <div class="stat-pay-card">
      <div class="stat-pay-left">
        <div class="stat-pay-label">${t('statEstPayLabel', getActiveDeductionPct(), getDeductionNoun())} ${mn.toUpperCase()}</div>
        <div class="stat-pay-value" id="stat-pay-value" data-target="${net}">₩0</div>
        ${deltaHTML}
      </div>
      <div class="stat-pay-ring">
        <svg viewBox="0 0 ${RING_C*2} ${RING_C*2}" width="124" height="124">
          <defs>
            <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#6c86ff"/>
              <stop offset="100%" stop-color="#a78bfa"/>
            </linearGradient>
          </defs>
          <circle cx="${RING_C}" cy="${RING_C}" r="${RING_R}" fill="none" stroke="var(--ring-track)" stroke-width="${RING_STROKE}"/>
          <circle id="stat-pay-arc" cx="${RING_C}" cy="${RING_C}" r="${RING_R}" fill="none" stroke="url(#ring-grad)" stroke-width="${RING_STROKE}"
            data-target="${hrsProgress}" data-circ="${circumference}"
            stroke-dasharray="0 ${circumference}" stroke-dashoffset="${circumference/4}"
            stroke-linecap="round"/>
          <text id="stat-pay-pct" x="${RING_C}" y="${RING_C+1}" text-anchor="middle" dominant-baseline="middle"
            data-target="${hrsProgress}"
            fill="var(--text)" font-size="19" font-weight="700" font-family="'Space Grotesk',Inter,system-ui,sans-serif">0%</text>
        </svg>
        <div class="stat-pay-ring-sub">${hrs.toFixed(1)} / ${target}${t('hoursUnit')}</div>
      </div>
    </div>
    <div class="stat-mini-col">
      <div class="stat-mini-card">
        <div>
          <div class="stat-mini-top"><div class="stat-mini-icon"><i class="fa-solid fa-calendar-days"></i></div></div>
          <div class="stat-mini-label">${t('statDays').toUpperCase()}</div>
          <div class="stat-mini-value stat-count" data-target="${days}" data-dp="0">0</div>
          <div class="stat-mini-sub">/ ${t('dayCount', totalDays)}</div>
        </div>
        <div class="stat-progress-bar"><div class="stat-progress-fill stat-progress-fill--blue stat-bar" data-target="${daysProgress}" style="width:0%"></div></div>
      </div>
      <div class="stat-mini-card">
        <div>
          <div class="stat-mini-top"><div class="stat-mini-icon stat-mini-icon--purple"><i class="fa-solid fa-clock"></i></div></div>
          <div class="stat-mini-label">${t('statHours').toUpperCase()}</div>
          <div class="stat-mini-value stat-count" data-target="${hrs.toFixed(1)}" data-dp="1">0.0</div>
          <div class="stat-mini-sub">/ ${target}${t('hoursUnit')}</div>
        </div>
        <div class="stat-progress-bar"><div class="stat-progress-fill stat-progress-fill--purple stat-bar" data-target="${hrsProgress}" style="width:0%"></div></div>
      </div>
    </div>
    <div class="stat-mini-compact">
      <div class="smc-item">
        <div class="stat-mini-icon"><i class="fa-solid fa-calendar-days"></i></div>
        <div class="smc-text">
          <div class="smc-value stat-count" data-target="${days}" data-dp="0">0</div>
          <div class="smc-sub">${t('statDays').toUpperCase()} / ${totalDays}</div>
        </div>
      </div>
      <div class="smc-divider"></div>
      <div class="smc-item">
        <div class="stat-mini-icon stat-mini-icon--purple"><i class="fa-solid fa-clock"></i></div>
        <div class="smc-text">
          <div class="smc-value stat-count" data-target="${hrs.toFixed(1)}" data-dp="1">0.0</div>
          <div class="smc-sub">${t('statHours').toUpperCase()} / ${target}${t('hoursUnit')}</div>
        </div>
      </div>
    </div>
  </div>`;
}

function buildOverview(){
  const logs=getLogs(),todayStr=today();
  const allEntries=Object.entries(logs);
  if(!allEntries.length) return buildOverviewEmpty();

  // ── Per-month aggregation ──────────────────────────────────────────────────
  // Mirrors buildStats() exactly: iterate every calendar day up to today,
  // using autoGross() so auto-credited holidays and Sundays are included in
  // ALL months, not just the current one. This ensures Best Month always
  // matches the Calendar tab's monthly total.
  const monthData={};
  function ensureMonth(ym){ if(!monthData[ym]) monthData[ym]={net:0,gross:0,days:0,hrs:0,overtimeNet:0,topDay:null}; }

  // Derive the range of months to scan from the log keys (plus current month).
  const now=new Date(),curY=now.getFullYear(),curMo=now.getMonth();
  const curYM=`${curY}-${pad(curMo+1)}`;
  const logMonths=new Set(Object.keys(logs).map(ds=>ds.slice(0,7)));
  logMonths.add(curYM);

  logMonths.forEach(ym=>{
    const [yStr,mStr]=ym.split('-');
    const y=parseInt(yStr),mo=parseInt(mStr)-1;
    const daysInMo=new Date(y,mo+1,0).getDate();
    for(let d=1;d<=daysInMo;d++){
      const ds=mkds(y,mo,d);
      if(ds>todayStr) break;
      const g=autoGross(ds,logs);  // liveGross: always recomputed from hours × wageFor(ds)
      const e=autoEff(ds,logs);
      const isLogged=!!logs[ds];
      const zeroDay=isLogged&&isZeroDay(logs[ds]);
      if(g>0||zeroDay){
        ensureMonth(ym);
        const m=monthData[ym];
        const net=applyTax(g);
        m.net+=net; m.gross+=g; m.days++; m.hrs+=e;
        // Overtime = earnings beyond the plain base for that day type
        const l=logs[ds];
        const sh=(l&&l.shiftOverride)||shiftFor(ds);
        const baseEff=baseEffFor(ds, sh); // engine probe of the active profile
        const basePay=applyTax(Math.round(Math.min(e,baseEff)*wageFor(ds)));
        m.overtimeNet+=Math.max(0,net-basePay);
        if(!m.topDay||net>m.topDay.net) m.topDay={ds,net,hrs:e};
      }
    }
  });

  const daysInCur=new Date(curY,curMo+1,0).getDate();

  const months=Object.keys(monthData).sort();
  const curData=monthData[curYM]||{net:0,gross:0,days:0,hrs:0,overtimeNet:0,topDay:null};
  const curBaseNet=Math.max(0,curData.net-curData.overtimeNet);

  // ── Pattern-based projection (v2) ──────────────────────────────────────────
  // Days are classified into SIX buckets so shift type (day/night) and
  // Sunday-vs-holiday pay differences are no longer averaged together:
  //   'dayWeekday'   — Mon–Fri, day shift, not a public holiday
  //   'nightWeekday' — Mon–Fri, night shift, not a public holiday
  //   'daySat'       — Saturday, day shift, not a public holiday
  //   'nightSat'     — Saturday, night shift, not a public holiday
  //   'sun'          — plain Sunday (always auto-credited)
  //   'holiday'      — public holiday (any day of week; auto-credit depends on holAuto)
  // Buckets mirror the engine's rate cells, so each bucket's average reflects
  // a single, internally-consistent pay formula (classes with their own tables
  // split by shift; aliased classes pool with their target; rest days and
  // holidays stand alone). See bucketKeys()/bucketFor() at top level.
  const BUCKET_KEYS=bucketKeys(); // derived from the active profile (Phase 4)

  // Exponential-decay weighted average: more recent entries count more.
  // weight(daysAgo) = DECAY^daysAgo, normalized so weights sum to 1.
  // DECAY=0.9 → an entry 7 days old carries ~48% the weight of today's;
  // 14 days old ~23%. Smooth, no discontinuity (unlike the old 70/30 split).
  const DECAY=0.9;
  function decayWeightedAvg(entries, refDateStr){
    if(!entries.length) return 0;
    if(entries.length===1) return entries[0].net;
    const refMs=pd(refDateStr).getTime();
    const dayMs=24*3600*1000;
    let wSum=0,vSum=0;
    for(const e of entries){
      const daysAgo=Math.max(0,Math.round((refMs-pd(e.ds).getTime())/dayMs));
      const w=Math.pow(DECAY,daysAgo);
      wSum+=w; vSum+=w*e.net;
    }
    return wSum>0 ? vSum/wSum : 0;
  }

  // Build per-bucket entries for a given year-month string.
  // Includes both manually logged entries AND auto-credited sun/hol days.
  function buildMonthEntries(ym){
    const [yStr,mStr]=ym.split('-');
    const y=parseInt(yStr),mo=parseInt(mStr)-1;
    const daysInMo=new Date(y,mo+1,0).getDate();
    const isCurrent=ym===curYM;
    const cutoff=isCurrent?todayStr:`${ym}-${pad(daysInMo)}`; // whole month for past months
    const bucket={}; BUCKET_KEYS.forEach(k=>bucket[k]=[]);

    for(let d=1;d<=daysInMo;d++){
      const ds=mkds(y,mo,d);
      if(ds>cutoff) break;
      const cls=bucketFor(ds);
      // Always use liveGross so projection averages reflect current wage history
      const g=autoGross(ds,logs);
      // Exclude double-shift days from the average — they're outliers that would
      // inflate projections. They still count toward actual earned totals via curData.
      if(g>0 && logs[ds]?.shiftOverride!=='double') bucket[cls].push({net:applyTax(g), ds});
    }
    // Sort oldest→newest within each bucket so decay weighting is time-ordered
    BUCKET_KEYS.forEach(k=>bucket[k].sort((a,b)=>a.ds.localeCompare(b.ds)));
    return bucket;
  }

  const curEntries=buildMonthEntries(curYM);

  // Per-bucket confidence: each bucket's reliability depends on ITS OWN count
  // this month, not the total. A user with 12 day-shift entries but 0 Saturday
  // entries should get full confidence on dayWeekday but fall back to last
  // month (or the deterministic estimate) for sat.
  // Lower thresholds than before (2/4 vs 5/9) since buckets are now finer-grained
  // and naturally accumulate fewer entries per month.
  const CONF_LO=2, CONF_HI=4;
  function confidenceFor(bucket){
    const n=curEntries[bucket].length;
    return n<=CONF_LO ? 0 : n>=CONF_HI ? 1 : (n-CONF_LO)/(CONF_HI-CONF_LO);
  }

  // Find the most recent previous month with at least CONF_LO entries in this bucket.
  const prevEntriesCache={};
  function getPrevMonthEntries(bucket){
    if(prevEntriesCache[bucket]!==undefined) return prevEntriesCache[bucket];
    const prevMonths=months.filter(ym=>ym<curYM).sort().reverse();
    for(const ym of prevMonths){
      const e=buildMonthEntries(ym);
      if(e[bucket].length>=CONF_LO){ prevEntriesCache[bucket]=e; return e; }
    }
    prevEntriesCache[bucket]=null;
    return null;
  }

  // Deterministic fallback: when there's no usable historical data for a bucket
  // (neither this month nor a previous month), estimate using calcWage() directly
  // with a representative 8h day, the wage active on the projection date, and the
  // correct shift/holiday-credit context. This replaces the old "8h × wage" guess
  // that only applied to the combined sunhol bucket — now every bucket has a
  // deterministic floor.
  function deterministicEstimate(bucket, dateStr){
    return applyTax(Math.round(bucketDeterministicEff(bucket)*wageFor(dateStr)));
  }

  // Blend per-bucket averages: (confidence × current) + ((1-confidence) × previous),
  // falling back to a deterministic estimate when no historical data exists at all.
  // refDateStr anchors the decay weighting and wage lookup for the fallback.
  // Returns {avg, low, high}: low/high are the min/max observed net values across
  // the pooled current+previous entries used for this bucket, giving an honest
  // range for the projection rather than a single false-precision number.
  function blendAvg(bucket, refDateStr){
    const confidence=confidenceFor(bucket);
    const curList=curEntries[bucket];
    const curAvg=decayWeightedAvg(curList, refDateStr);
    let avg, pooled;
    if(confidence===1 || curList.length>0){
      const prevEntries=confidence<1 ? getPrevMonthEntries(bucket) : null;
      if(prevEntries){
        const prevAvg=decayWeightedAvg(prevEntries[bucket], refDateStr);
        avg=curAvg*confidence + prevAvg*(1-confidence);
        pooled=curList.concat(prevEntries[bucket]);
      }else{
        avg=curAvg; // no previous data to blend with — use current as-is
        pooled=curList;
      }
    }else{
      // No current-month data at all for this bucket
      const prevEntries=getPrevMonthEntries(bucket);
      avg=prevEntries ? decayWeightedAvg(prevEntries[bucket], refDateStr) : 0;
      pooled=prevEntries ? prevEntries[bucket] : [];
    }
    if(avg<=0){
      const det=deterministicEstimate(bucket, refDateStr);
      return {avg:det, low:det, high:det};
    }
    if(!pooled.length) return {avg, low:avg, high:avg};
    const nets=pooled.map(e=>e.net);
    return {avg, low:Math.min(...nets), high:Math.max(...nets)};
  }

  // Count remaining days of each type after today (future logs already counted in curData),
  // and accumulate the projection using a PER-DAY average anchored to that day's date
  // (so wage changes mid-projection and decay weighting both resolve correctly).
  // Also accumulate low/high bounds for a confidence range display.
  let remainder=0, remainderLow=0, remainderHigh=0;
  for(let d=1;d<=daysInCur;d++){
    const ds=mkds(curY,curMo,d);
    if(ds<=todayStr) continue;      // past/today already in curData.net
    if(logs[ds]) continue;          // manually logged future day already in curData.net
    const cls=bucketFor(ds);
    const {avg,low,high}=blendAvg(cls, ds);
    remainder+=avg; remainderLow+=low; remainderHigh+=high;
  }

  // Projected = actual earned so far + sum of per-day estimates for remaining days.
  // projectionLow/High give an honest range using the min/max historically observed
  // net value per bucket, rather than presenting a single number with false precision.
  const projection=Math.round(curData.net + remainder);
  const projectionLow=Math.round(curData.net + remainderLow);
  const projectionHigh=Math.round(curData.net + remainderHigh);


  // Best month (exclude current for the "past best" card)
  let bestYM=null,bestNet=0;
  months.forEach(ym=>{ if(monthData[ym].net>bestNet){bestNet=monthData[ym].net;bestYM=ym;} });
  const pastBestYM = bestYM===curYM ? (months.length>1?months.slice(0,-1).reduce((a,b)=>monthData[a].net>monthData[b].net?a:b):null) : bestYM;

  // When the current month is the ONLY month with earnings there is no "past
  // best" to compare against — but the Best Month card should still celebrate
  // it rather than sit empty behind dashes. Treat the sole month as the current
  // leader and badge it (below) so the missing comparison reads as intentional
  // and the card promises the comparison becomes meaningful with more data.
  const soleBestMonth = !pastBestYM && curData.net>0;
  const bestMonthYM = pastBestYM || (soleBestMonth ? curYM : null);

  const mnames=t('mn');
  function fmtYM(ym){ const[y,m]=ym.split('-'); return`${mnames[parseInt(m)-1]} ${y}`; }

  // Chart data — up to 7 months, oldest→newest; current month uses projection.
  // Chart data — all months oldest→newest; current month uses projection.
  // Stored on a module-level var so renderTrendChart() reads the same values
  // without re-computing separately. All months are stored; renderTrendChart()
  // slices based on S.chartRange ('3m' | '6m' | '1y').
  const chartMonths=months.slice();
  // Smart labels: include year suffix only when the visible slice spans multiple years.
  // renderTrendChart() re-runs this logic after slicing, so we store raw ym keys too.
  const chartValues=chartMonths.map(ym=>ym===curYM?projection:monthData[ym].net);
  _trendChartData={months:chartMonths,values:chartValues,curYM,mnames};

  // Best Single Day across ALL logged days (not just current month)
  let allTimeTopDay=null;
  months.forEach(ym=>{ const td=monthData[ym].topDay; if(td&&(!allTimeTopDay||td.net>allTimeTopDay.net)) allTimeTopDay=td; });

  // Range toggle — only show options that have enough data to be meaningful
  const has6=chartMonths.length>3;
  const hasYear=chartMonths.length>6;
  const rangeOpts=[
    {k:'3m', label:t('chartRange3m')},
    ...(has6?[{k:'6m', label:t('chartRange6m')}]:[]),
    ...(hasYear?[{k:'1y', label:t('chartRange1y')}]:[]),
  ];
  // Clamp stored range if it's no longer valid for this data set
  if(!rangeOpts.find(o=>o.k===S.chartRange)) S.chartRange=rangeOpts[rangeOpts.length-1].k;

  // ── Recent Shifts (last 5 logged entries) ────────────────────────────────
  const allLogEntries=Object.entries(logs)
    .filter(([ds])=>ds<=todayStr)
    .sort((a,b)=>b[0].localeCompare(a[0]))
    .slice(0,5);
  const dn=t('dn');
  const recentHTML=allLogEntries.length?allLogEntries.map(([ds,l])=>{
    const sh=(l.shiftOverride)||shiftFor(ds);
    const shLabel=sh==='double'?`<i class="fa-solid fa-rotate"></i> ${t('doubleShift')}`:sh==='night'?`<i class="fa-solid fa-moon"></i> ${t('nightShift')}`:`<i class="fa-solid fa-sun"></i> ${t('dayShift')}`;
    const shCls=sh==='double'?'rs-shift--double':sh==='night'?'rs-shift--night':'rs-shift--day';
    const {reg,ot}=entryHours(l);
    const totalH=(sh==='double'?0:reg)+ot;
    const net=applyTax(liveGross(ds,logs));
    const isToday=ds===todayStr;
    return`<div class="rs-item">
      <div class="rs-left">
        ${isToday?`<span class="rs-today-badge">${t('todayBadge')}</span>`:''}
        <span class="rs-date">${t('mn')[parseInt(ds.slice(5,7))-1]} ${parseInt(ds.slice(8,10))}</span>
        <span class="rs-shift ${shCls}">${shLabel}</span>
      </div>
      <div class="rs-right">
        <span class="rs-hrs">${totalH>0?totalH+t('hoursUnit'):'0'+t('hoursUnit')}</span>
        <span class="rs-pay">₩${net.toLocaleString()}</span>
        <span class="rs-chevron"><i class="fa-solid fa-chevron-right"></i></span>
      </div>
    </div>`;
  }).join(''):`<div class="rs-empty">${t('ovNoData')}</div>`;

  // ── This Month summary + bar chart ────────────────────────────────────────
  const target=S.targetHrs||250;
  const remaining=Math.max(0,target-curData.days*0+0); // placeholder — use hrs
  const hrsWorked=parseFloat(
    (() => {
      let h=0;
      const dInM=new Date(curY,curMo+1,0).getDate();
      for(let d=1;d<=dInM;d++){
        const ds=mkds(curY,curMo,d);
        if(ds>todayStr)break;
        h+=autoEff(ds,logs);
      }
      return h.toFixed(1);
    })()
  );
  const hrsRemaining=Math.max(0,target-hrsWorked);
  const hrsProgress=Math.min(100,Math.round((hrsWorked/target)*100));
  const avgPerDay=curData.days>0?Math.round(curData.net/curData.days):0;
  const avgHrsPerDay=curData.days>0?+(hrsWorked/curData.days).toFixed(1):0;
  const daysInMonth=new Date(curY,curMo+1,0).getDate();

  // Mini ring SVG helper
  function miniRing(pct,color='#6c8eff'){
    const r=18,circ=2*Math.PI*r,dash=Math.round((Math.min(100,pct)/100)*circ);
    return`<svg viewBox="0 0 44 44" width="44" height="44" style="flex-shrink:0;transform:rotate(-90deg)">
      <circle cx="22" cy="22" r="18" fill="none" stroke="var(--ring-track)" stroke-width="4"/>
      <circle cx="22" cy="22" r="18" fill="none" stroke="${color}" stroke-width="4"
        stroke-dasharray="${dash} ${circ-dash}" stroke-linecap="round"/>
    </svg>`;
  }

  const tmRingPct=hrsProgress;
  const avgRingPct=daysInMonth>0?Math.min(100,Math.round((avgHrsPerDay/(target/daysInMonth))*100)):0;

  // ── Anchor data for the 4 stat cards ────────────────────────────────────────
  // Each card gets a real, meaningful bottom line (not decoration) so all four
  // share the Hours-Worked card's complete top-to-bottom structure.

  // Avg Per Day: month-over-month change in average net/day.
  const _avgPrevIdx=months.indexOf(curYM)-1;
  const _prevMonth=_avgPrevIdx>=0?monthData[months[_avgPrevIdx]]:null;
  const _prevAvg=_prevMonth&&_prevMonth.days>0?Math.round(_prevMonth.net/_prevMonth.days):0;
  const avgDeltaPct=(_prevAvg>0&&avgPerDay>0)?((avgPerDay-_prevAvg)/_prevAvg*100):null;

  // Best Month: how much the best past month beats the runner-up, plus the
  // hours/days that actually produced it — same "show your work" treatment
  // the Hours Worked and Avg Per Day cards already get.
  let bestMonthDeltaPct=null;
  if(pastBestYM){
    const _bestNet=monthData[pastBestYM].net;
    const _runnerUp=months.filter(m=>m!==pastBestYM&&m!==curYM)
      .reduce((best,m)=>monthData[m].net>best?monthData[m].net:best,0);
    if(_runnerUp>0) bestMonthDeltaPct=((_bestNet-_runnerUp)/_runnerUp*100);
  }
  const bestMonthHrs=bestMonthYM?monthData[bestMonthYM].hrs:null;
  const bestMonthDays=bestMonthYM?monthData[bestMonthYM].days:null;

  // Best Single Day: hours worked on that day (captured in topDay above),
  // plus how far it sits above a typical working day, all-time.
  const bestDayHrs=allTimeTopDay&&allTimeTopDay.hrs!=null?+allTimeTopDay.hrs.toFixed(1):null;
  let bestDayAbovePct=null;
  if(allTimeTopDay){
    const _allNet=months.reduce((s,m)=>s+monthData[m].net,0);
    const _allDays=months.reduce((s,m)=>s+monthData[m].days,0);
    const _avgAll=_allDays>0?_allNet/_allDays:0;
    if(_avgAll>0) bestDayAbovePct=((allTimeTopDay.net-_avgAll)/_avgAll*100);
  }

  // Format an hours value the same way the rest of the Overview does: whole
  // numbers stay bare, fractional ones keep one decimal place.
  function fmtHrs(v){ return v%1?v.toFixed(1):Math.round(v); }

  // Small ▲/▼ delta chip, matching the projection card's idiom.
  function deltaChip(pct,suffix){
    if(pct==null||!isFinite(pct)) return '';
    const up=pct>=0, sign=up?'▲':'▼';
    return`<div class="ov-stat4-delta ov-stat4-delta--${up?'up':'down'}">${sign} ${Math.abs(pct).toFixed(0)}% ${suffix}</div>`;
  }

  // ── Entrance / count-up gating ──────────────────────────────────────────────
  // The choreographed entrance (hero → stat cards → bottom panels) plays EXACTLY
  // ONCE per app session — the first time the Overview is mounted. Switching to
  // Calendar and back must NOT replay it (the user has already seen the data
  // assemble; replaying reads as a glitch), so we latch a module-level flag the
  // first time we arm the entrance. Every later mount, in-place re-render (auth
  // resolving, theme toggle, a shift edited from the All-Shifts modal), and tab
  // return renders the cards already settled. Number motion for genuine data
  // CHANGES is still handled by initOverviewMotion(), which tweens old→new.
  const _reduceMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ovEnter=!_reduceMotion&&!_ovEntranceDone;
  if(ovEnter) _ovEntranceDone=true;
  // Signature of everything the count-ups display — initOverviewMotion() uses
  // it to tell "same data re-rendered" (snap, no motion) from "data changed".
  const ovSig=[curYM,projection,curData.net,curData.overtimeNet,curData.days,hrsWorked,hrsProgress,avgPerDay,
    bestMonthYM?monthData[bestMonthYM].net:0,allTimeTopDay?allTimeTopDay.net:0,hrsRemaining.toFixed(1)].join('|');

  // Animated-number span: renders the FINAL formatted value (so no-JS, reduced
  // motion, and prerender all read correctly) and stamps the numeric target +
  // formatting + start delay for initOverviewMotion() to drive. Delays are
  // matched to each card's CSS entrance delay so a value starts counting just
  // as its card lands — the dashboard assembles itself from live data instead
  // of numbers popping in fully formed.
  function ovNum(key,value,o){
    o=o||{};
    const dp=o.dp||0,pre=o.pre||'',suf=o.suf||'';
    const txt=pre+(dp?value.toFixed(dp):Math.round(value).toLocaleString())+suf;
    return`<span class="ov-num" data-k="${key}" data-t="${value}" data-dp="${dp}" data-pre="${pre}" data-suf="${suf}" data-delay="${o.delay||0}">${txt}</span>`;
  }

  // Whether only the current month has been logged. In that case the trend chart
  // keeps its exact layout but renders a "not enough history yet" state — one real
  // point trailing into ghosted future months — instead of a normal multi-month
  // line (see renderTrendChart). A caption over the empty region explains it.
  const soloTrend = chartMonths.length < 2;

  return`<div class="ov-wrap${ovEnter?' ov-enter':''}" data-ovsig="${ovSig}">

    <!-- Projected Earnings card — left KPI panel + right chart panel -->
    <div class="ov-proj-card">
      <!-- Left: KPI summary -->
      <div class="ov-proj-kpi">
        <div class="ov-proj-kpi-header">${t('ovEstTotal')} <span class="ov-proj-period">• ${fmtYM(curYM)}</span></div>
        <div class="ov-proj-value">${ovNum('proj',projection,{pre:'₩',delay:140})}</div>
        ${(()=>{
          const prevIdx=months.indexOf(curYM)-1;
          const prevNet=prevIdx>=0?monthData[months[prevIdx]].net:0;
          if(!prevNet) return '';
          const pct=((projection-prevNet)/prevNet*100);
          const sign=pct>=0?'▲':'▼';
          const cls=pct>=0?'ov-proj-delta--up':'ov-proj-delta--down';
          const prevLabel=fmtYM(months[prevIdx]);
          return`<div class="ov-proj-delta ${cls}">${sign} ${Math.abs(pct).toFixed(1)}% ${t('deltaFrom', prevLabel)}</div>`;
        })()}
        ${projectionHigh>projectionLow?`<div class="ov-proj-range">${t('ovEstRange',projectionLow,projectionHigh)}</div>`:''}
        <div class="ov-proj-stat-cards">
          <div class="ov-proj-stat">
            <div class="ov-proj-stat-icon ov-proj-stat-icon--base"><i class="fa-solid fa-shield-halved"></i></div>
            <div class="ov-proj-stat-body">
              <div class="ov-proj-stat-label">${t('ovBaseEarnings')}</div>
              <div class="ov-proj-stat-val">${ovNum('base',curBaseNet,{pre:'₩',delay:300})}</div>
            </div>
          </div>
          <div class="ov-proj-stat">
            <div class="ov-proj-stat-icon ov-proj-stat-icon--ot"><i class="fa-solid fa-gem"></i></div>
            <div class="ov-proj-stat-body">
              <div class="ov-proj-stat-label">${t('ovOvertimeDesc')}</div>
              <div class="ov-proj-stat-val">${ovNum('ot',curData.overtimeNet,{pre:'₩',delay:370})}</div>
            </div>
          </div>
        </div>
      </div>
      <!-- Right: chart panel — same component whatever the data volume -->
      <div class="ov-proj-chart-panel">
        <div class="ov-proj-chart-glow"></div>
        ${rangeOpts.length>1?`<div class="ov-chart-range ov-chart-range--floating">
          ${rangeOpts.map(o=>`<button class="ov-range-btn${S.chartRange===o.k?' ov-range-btn--active':''}" data-range="${o.k}">${o.label}</button>`).join('')}
        </div>`:''}
        <div class="ov-proj-chart-wrap${soloTrend?' ov-proj-chart-wrap--solo':''}">
          <canvas id="ov-trend-chart"></canvas>
        </div>
        ${soloTrend?`<div class="ov-chart-empty-note"><span class="ov-chart-empty-pill"><i class="fa-solid fa-arrow-trend-up"></i><span>${t('ovTrendLocked')}</span></span></div>`:''}
      </div>
    </div>

    <!-- 4 stat cards -->
    <div class="ov-stat4-row">

      <!-- Hours Worked (This Month) -->
      <div class="ov-stat4-card ov-stat4-card--blue">
        <div class="ov-stat4-header">
          <div class="ov-stat4-icon ov-stat4-icon--blue"><i class="fa-solid fa-clock"></i></div>
          <div class="ov-stat4-header-text">
            <span class="ov-stat4-label">${t('hoursWorked')}</span>
            <span class="ov-stat4-header-sub">${fmtYM(curYM)}</span>
          </div>
        </div>
        <div class="ov-stat4-hrs-row">
          <span class="ov-stat4-hrs-val">${ovNum('hrs',hrsWorked,{dp:hrsWorked%1?1:0,suf:t('hoursUnit'),delay:260})}</span>
          <span class="ov-stat4-hrs-target">/ ${target}${t('hoursUnit')}</span>
        </div>
        <div class="ov-stat4-bar-wrap">
          <div class="ov-stat4-bar-track">
            <div class="ov-stat4-bar-fill ov-stat4-bar-fill--blue" data-ov-bar="hrs" data-t="${hrsProgress}" data-delay="320" style="width:${hrsProgress}%"></div>
          </div>
          <span class="ov-stat4-bar-pct">${ovNum('pct',hrsProgress,{suf:'%',delay:320})}</span>
        </div>
        <div class="ov-stat4-foot">
          <div class="ov-stat4-secondary">${t('dayCount', curData.days)}</div>
          ${hrsRemaining>0?`<div class="ov-stat4-secondary ov-stat4-secondary--accent">${hrsRemaining.toFixed(0)}${t('hoursUnit')} ${t('remainingLabel').toLowerCase()}</div>`:''}
        </div>
      </div>

      <!-- Avg Per Day -->
      <div class="ov-stat4-card ov-stat4-card--purple">
        <div class="ov-stat4-header">
          <div class="ov-stat4-icon ov-stat4-icon--purple"><i class="fa-solid fa-chart-line"></i></div>
          <div class="ov-stat4-header-text">
            <span class="ov-stat4-label">${t('ovAvgPerDay')}</span>
            <span class="ov-stat4-header-sub">${fmtYM(curYM)}</span>
          </div>
        </div>
        <div class="ov-stat4-val ov-stat4-val--white">${ovNum('avg',avgPerDay,{pre:'₩',delay:330})}</div>
        <div class="ov-stat4-foot ov-stat4-foot--stack">
          <div class="ov-stat4-secondary">${avgHrsPerDay}${t('hoursUnit')} ${t('hoursWorked').toLowerCase()}</div>
          ${deltaChip(avgDeltaPct,t('ovVsLastMonth'))}
        </div>
      </div>

      <!-- Best Month -->
      <div class="ov-stat4-card${bestMonthYM?'':' ov-stat4-card--empty'} ov-stat4-card--gold">
        <div class="ov-stat4-header">
          <div class="ov-stat4-icon ov-stat4-icon--gold"><i class="fa-solid fa-trophy"></i></div>
          <div class="ov-stat4-header-text">
            <span class="ov-stat4-label">${t('ovBestMonth')}</span>
            <span class="ov-stat4-header-sub">${bestMonthYM?fmtYM(bestMonthYM):'—'}</span>
          </div>
        </div>
        <div class="ov-stat4-val ov-stat4-val--gold">${bestMonthYM?ovNum('bestm',monthData[bestMonthYM].net,{pre:'₩',delay:400}):'—'}</div>
        ${bestMonthYM?`<div class="ov-stat4-foot ov-stat4-foot--stack">
          ${bestMonthHrs!=null?`<div class="ov-stat4-secondary">${fmtHrs(bestMonthHrs)}${t('hoursUnit')} ${t('ovHoursWorkedShort')}</div>`:''}
          ${bestMonthDays!=null?`<div class="ov-stat4-secondary">${t('dayCount',bestMonthDays)}</div>`:''}
          ${
            soleBestMonth
              ? `<div class="ov-stat4-badge ov-stat4-badge--gold"><i class="fa-solid fa-crown"></i> ${t('ovSoleMonth')}</div>`
              : bestMonthDeltaPct!=null
                ? deltaChip(bestMonthDeltaPct,t('ovVsPrevBest'))
                : `<div class="ov-stat4-secondary">${t('ovVsPrevBest')}</div>`
          }
        </div>`:''}
      </div>

      <!-- Best Single Day -->
      <div class="ov-stat4-card${allTimeTopDay?'':' ov-stat4-card--empty'} ov-stat4-card--teal">
        <div class="ov-stat4-header">
          <div class="ov-stat4-icon ov-stat4-icon--teal"><i class="fa-solid fa-gem"></i></div>
          <div class="ov-stat4-header-text">
            <span class="ov-stat4-label">${t('ovHighestDay')}</span>
            <span class="ov-stat4-header-sub">${allTimeTopDay?allTimeTopDay.ds:'—'}</span>
          </div>
        </div>
        <div class="ov-stat4-val ov-stat4-val--teal">${allTimeTopDay?ovNum('bestd',allTimeTopDay.net,{pre:'₩',delay:470}):'—'}</div>
        ${allTimeTopDay?`<div class="ov-stat4-foot ov-stat4-foot--stack">
          ${bestDayHrs!=null?`<div class="ov-stat4-secondary">${bestDayHrs}${t('hoursUnit')} ${t('ovHoursWorkedShort')}</div>`:''}
          ${bestDayAbovePct!=null?deltaChip(bestDayAbovePct,t('ovAboveAvg')):''}
        </div>`:''}
      </div>

    </div>

    <!-- Recent Shifts + Monthly Breakdown -->
    <div class="ov-bottom-row">
      <!-- Recent Shifts -->
      <div class="ov-panel card">
        <div class="ov-panel-hdr">
          <div class="ov-panel-title">${t('recentShifts')}</div>
          ${allLogEntries.length?`<a class="ov-view-all-link" id="rs-view-all" href="javascript:void(0)" role="button">${t('viewAll')}</a>`:''}
        </div>
        <div class="rs-list">${recentHTML}</div>
      </div>

      <!-- Daily Breakdown -->
      <div class="ov-panel card">
        <div class="ov-panel-title">${t('monthlyBreakdown')||'DAILY BREAKDOWN'} · ${fmtYM(curYM)}</div>
        <div class="tm-chart-wrap">
          <canvas id="ov-month-bar-chart" height="180"></canvas>
        </div>
        <div class="ov-breakdown-footer">
          <div class="ov-breakdown-stat">
            <span class="ov-breakdown-stat-label">${t('hoursWorked')}</span>
            <span class="ov-breakdown-stat-val">${ovNum('fhrs',hrsWorked,{dp:hrsWorked%1?1:0,suf:t('hoursUnit'),delay:640})}</span>
          </div>
          <div class="ov-breakdown-stat">
            <span class="ov-breakdown-stat-label">${t('targetHours')}</span>
            <span class="ov-breakdown-stat-val">${target}${t('hoursUnit')}</span>
          </div>
          <div class="ov-breakdown-stat">
            <span class="ov-breakdown-stat-label">${t('daysWorkedLabel')}</span>
            <span class="ov-breakdown-stat-val">${t('dayCount', curData.days)}</span>
          </div>
          <div class="ov-breakdown-stat">
            <span class="ov-breakdown-stat-label">${t('remainingLabel')}</span>
            <span class="ov-breakdown-stat-val ov-breakdown-stat-val--blue">${ovNum('frem',hrsRemaining,{dp:1,suf:t('hoursUnit'),delay:700})}</span>
          </div>
        </div>
      </div>
    </div>

  </div>
  ${appFooter()}`;
  // Charts rendered after DOM injection — see renderTrendChart() called from attachListeners
}

// ── Overview EMPTY STATE — the real dashboard, waiting for data ──────────────
// Shown to brand-new users with zero logged days. It renders the FIRST viewport
// of the real Overview (reusing the exact ov-* card classes) as a ghosted, inert
// skeleton — reduced opacity, desaturated, softly blurred, with shimmering
// skeleton loaders where figures will land. The stage is height-capped and
// fades out at the bottom, implying more analytics unlock below the fold. A
// lightweight hero (headline + CTA, no card/badge/scrim) floats over it so the
// dashboard, not a modal, stays the focus. When the first shift is logged the
// live buildOverview() renders the identical shell — it simply fills in.
// The root deliberately avoids the `.ov-wrap` class so initOverviewMotion()
// no-ops, and includes no <canvas> so the chart renderers no-op too.
function buildOverviewEmpty(){
  const oLang=getLang();
  // Onboarding-specific copy only — a lightweight hero, not a modal. Every
  // DASHBOARD label below is pulled from the SAME t() keys the live Overview
  // uses, so this reads as the real dashboard waiting for data, not a preview.
  const OV={
    en:{title:'Your dashboard is ready.',
      sub:'Log your first shift and this fills with live pay, overtime and trends.',
      cta:'Log your first shift'},
    ko:{title:'대시보드가 준비됐어요',
      sub:'첫 근무를 기록하면 실시간 급여·초과근무·추세로 채워져요.',
      cta:'첫 근무 기록하기'},
    id:{title:'Dasbor Anda sudah siap.',
      sub:'Catat shift pertama, dan ini terisi gaji, lembur, dan tren langsung.',
      cta:'Catat shift pertama'},
    th:{title:'แดชบอร์ดของคุณพร้อมแล้ว',
      sub:'บันทึกกะแรก แล้วหน้านี้จะเต็มไปด้วยค่าจ้าง ล่วงเวลา และแนวโน้มแบบสด',
      cta:'บันทึกกะแรก'},
    ru:{title:'Ваш дашборд готов.',
      sub:'Отметьте первую смену — и он заполнится зарплатой, переработками и трендами.',
      cta:'Отметить первую смену'},
    zh:{title:'你的仪表盘已就绪。',
      sub:'记录第一次班次，这里就会填满实时工资、加班与趋势。',
      cta:'记录第一次班次'},
    fr:{title:'Votre tableau de bord est prêt.',
      sub:'Enregistrez votre premier service et tout se remplit : paie, heures supp., tendances.',
      cta:'Enregistrer mon premier service'},
    ne:{title:'तपाईंको ड्यासबोर्ड तयार छ।',
      sub:'पहिलो शिफ्ट रेकर्ड गर्नुहोस्, यो प्रत्यक्ष तलब, ओभरटाइम र प्रवृत्तिले भरिन्छ।',
      cta:'पहिलो शिफ्ट रेकर्ड गर्नुहोस्'},
  };
  const ot=k=>(OV[oLang]||OV.en)[k]||OV.en[k];

  const hu=t('hoursUnit');
  // Skeleton value — a shimmering placeholder where a real figure will land.
  // Reads as "loading / waiting for data", not fake data. Labels and structure
  // around it stay intact so every card is instantly recognizable.
  const sk=(w,h)=>`<span class="ovb-sk" style="width:${w};height:${h}"></span>`;

  // Month labels for the sample period, pulled from the live month names so the
  // replica's card subheaders match what the real Overview would show.
  const mn=t('mn')||[];
  const _now=new Date();
  const sampleMonth=`${mn[_now.getMonth()]||''} ${_now.getFullYear()}`;
  const _prev=new Date(_now.getFullYear(),_now.getMonth()-1,1);
  const prevMonth=`${mn[_prev.getMonth()]||''} ${_prev.getFullYear()}`;
  const _best=new Date(_now.getFullYear(),_now.getMonth()-2,1);
  const bestMonth=`${mn[_best.getMonth()]||''} ${_best.getFullYear()}`;

  // Sample "best single day" date, shown raw like the live card does.
  const _bd=pd(today()); _bd.setDate(_bd.getDate()-9);
  const bestDayDs=mkds(_bd.getFullYear(),_bd.getMonth(),_bd.getDate());

  // ── Recent-shift placeholders — real rs-item markup, dates relative to today ──
  const shiftMeta={
    day:{cls:'rs-shift--day',label:`<i class="fa-solid fa-sun"></i> ${t('dayShift')}`},
    night:{cls:'rs-shift--night',label:`<i class="fa-solid fa-moon"></i> ${t('nightShift')}`},
    double:{cls:'rs-shift--double',label:`<i class="fa-solid fa-rotate"></i> ${t('doubleShift')}`},
  };
  const sampleShifts=[
    {off:0,sh:'night',h:9,today:true},
    {off:1,sh:'day',h:8},
    {off:3,sh:'day',h:8.5},
    {off:5,sh:'double',h:16},
    {off:6,sh:'night',h:9},
  ];
  const recentHTML=sampleShifts.map(s=>{
    const d=pd(today()); d.setDate(d.getDate()-s.off);
    const label=`${mn[d.getMonth()]||''} ${d.getDate()}`;
    const m=shiftMeta[s.sh];
    return`<div class="rs-item">
      <div class="rs-left">
        ${s.today?`<span class="rs-today-badge">${t('todayBadge')}</span>`:''}
        <span class="rs-date">${label}</span>
        <span class="rs-shift ${m.cls}">${m.label}</span>
      </div>
      <div class="rs-right">
        <span class="rs-hrs">${s.h}${hu}</span>
        <span class="rs-pay">${sk('58px','13px')}</span>
      </div>
    </div>`;
  }).join('');

  // Monthly-breakdown skeleton bars (no <canvas>, so renderMonthBarChart no-ops).
  const skelBars=[42,68,54,88,72,96,60].map(h=>`<span class="ovb-skel-bar" style="height:${h}%"></span>`).join('');

  // NOTE: the stage deliberately does NOT use the .ov-wrap class and includes no
  // <canvas>, so initOverviewMotion() / renderTrendChart() / renderMonthBarChart()
  // all no-op — nothing here animates counters or instantiates Chart.js.
  return`<div class="ov-onboard" id="ov-onboard">
    <div class="ovb-stage-wrap">

      <!-- Locked replica of the REAL Overview: identical ov-* cards & layout -->
      <div class="ovb-stage" aria-hidden="true">

        <!-- Projected Earnings — same left-KPI + right-chart split -->
        <div class="ov-proj-card">
          <div class="ov-proj-kpi">
            <div class="ov-proj-kpi-header">${t('ovEstTotal')} <span class="ov-proj-period">• ${sampleMonth}</span></div>
            <div class="ov-proj-value">${sk('152px','30px')}</div>
            <div class="ov-proj-delta ov-proj-delta--up">${sk('118px','13px')}</div>
            <div class="ov-proj-stat-cards">
              <div class="ov-proj-stat">
                <div class="ov-proj-stat-icon ov-proj-stat-icon--base"><i class="fa-solid fa-shield-halved"></i></div>
                <div class="ov-proj-stat-body">
                  <div class="ov-proj-stat-label">${t('ovBaseEarnings')}</div>
                  <div class="ov-proj-stat-val">${sk('90px','15px')}</div>
                </div>
              </div>
              <div class="ov-proj-stat">
                <div class="ov-proj-stat-icon ov-proj-stat-icon--ot"><i class="fa-solid fa-gem"></i></div>
                <div class="ov-proj-stat-body">
                  <div class="ov-proj-stat-label">${t('ovOvertimeDesc')}</div>
                  <div class="ov-proj-stat-val">${sk('74px','15px')}</div>
                </div>
              </div>
            </div>
          </div>
          <div class="ov-proj-chart-panel ovb-chart">
            <div class="ov-chart-range ov-chart-range--floating">
              <span class="ov-range-btn ov-range-btn--active">${t('chartRange3m')}</span>
              <span class="ov-range-btn">${t('chartRange6m')}</span>
              <span class="ov-range-btn">${t('chartRange1y')}</span>
            </div>
            <svg class="ovb-chart-svg" viewBox="0 0 300 150" preserveAspectRatio="none">
              <defs>
                <linearGradient id="ovbArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.24"/>
                  <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <line x1="0" y1="112" x2="300" y2="112" stroke="var(--border)" stroke-width="1"/>
              <line x1="0" y1="74" x2="300" y2="74" stroke="var(--border)" stroke-width="1"/>
              <line x1="0" y1="36" x2="300" y2="36" stroke="var(--border)" stroke-width="1"/>
              <path d="M0,118 C36,104 60,110 96,80 C130,52 156,66 190,44 C222,24 256,34 300,16 L300,150 L0,150 Z" fill="url(#ovbArea)"/>
              <path d="M0,118 C36,104 60,110 96,80 C130,52 156,66 190,44 C222,24 256,34 300,16" fill="none" stroke="var(--primary)" stroke-width="2.4" stroke-linecap="round" stroke-opacity="0.55"/>
              <circle cx="300" cy="16" r="3.5" fill="var(--primary)" fill-opacity="0.6"/>
            </svg>
          </div>
        </div>

        <!-- 4 stat cards — identical to the live Overview -->
        <div class="ov-stat4-row">

          <!-- Hours Worked -->
          <div class="ov-stat4-card ov-stat4-card--blue">
            <div class="ov-stat4-header">
              <div class="ov-stat4-icon ov-stat4-icon--blue"><i class="fa-solid fa-clock"></i></div>
              <div class="ov-stat4-header-text">
                <span class="ov-stat4-label">${t('hoursWorked')}</span>
                <span class="ov-stat4-header-sub">${sampleMonth}</span>
              </div>
            </div>
            <div class="ov-stat4-hrs-row">
              <span class="ov-stat4-hrs-val">${sk('76px','20px')}</span>
              <span class="ov-stat4-hrs-target">/ 250${hu}</span>
            </div>
            <div class="ov-stat4-bar-wrap">
              <div class="ov-stat4-bar-track"><div class="ov-stat4-bar-fill ov-stat4-bar-fill--blue" style="width:57%"></div></div>
              <span class="ov-stat4-bar-pct">57%</span>
            </div>
            <div class="ov-stat4-foot">
              <div class="ov-stat4-secondary">${t('dayCount',18)}</div>
              <div class="ov-stat4-secondary ov-stat4-secondary--accent">108${hu} ${t('remainingLabel').toLowerCase()}</div>
            </div>
          </div>

          <!-- Avg Per Day -->
          <div class="ov-stat4-card ov-stat4-card--purple">
            <div class="ov-stat4-header">
              <div class="ov-stat4-icon ov-stat4-icon--purple"><i class="fa-solid fa-chart-line"></i></div>
              <div class="ov-stat4-header-text">
                <span class="ov-stat4-label">${t('ovAvgPerDay')}</span>
                <span class="ov-stat4-header-sub">${sampleMonth}</span>
              </div>
            </div>
            <div class="ov-stat4-val ov-stat4-val--white">${sk('96px','22px')}</div>
            <div class="ov-stat4-foot ov-stat4-foot--stack">
              <div class="ov-stat4-secondary">7.9${hu} ${t('hoursWorked').toLowerCase()}</div>
              <div class="ov-stat4-delta ov-stat4-delta--up">▲ 6% ${t('ovVsLastMonth')}</div>
            </div>
          </div>

          <!-- Best Month -->
          <div class="ov-stat4-card ov-stat4-card--gold">
            <div class="ov-stat4-header">
              <div class="ov-stat4-icon ov-stat4-icon--gold"><i class="fa-solid fa-trophy"></i></div>
              <div class="ov-stat4-header-text">
                <span class="ov-stat4-label">${t('ovBestMonth')}</span>
                <span class="ov-stat4-header-sub">${bestMonth}</span>
              </div>
            </div>
            <div class="ov-stat4-val ov-stat4-val--gold">${sk('104px','22px')}</div>
            <div class="ov-stat4-foot ov-stat4-foot--stack">
              <div class="ov-stat4-secondary">168${hu} ${t('ovHoursWorkedShort')}</div>
              <div class="ov-stat4-secondary">${t('dayCount',21)}</div>
              <div class="ov-stat4-delta ov-stat4-delta--up">▲ 12% ${t('ovVsPrevBest')}</div>
            </div>
          </div>

          <!-- Best Single Day -->
          <div class="ov-stat4-card ov-stat4-card--teal">
            <div class="ov-stat4-header">
              <div class="ov-stat4-icon ov-stat4-icon--teal"><i class="fa-solid fa-gem"></i></div>
              <div class="ov-stat4-header-text">
                <span class="ov-stat4-label">${t('ovHighestDay')}</span>
                <span class="ov-stat4-header-sub">${bestDayDs}</span>
              </div>
            </div>
            <div class="ov-stat4-val ov-stat4-val--teal">${sk('92px','22px')}</div>
            <div class="ov-stat4-foot ov-stat4-foot--stack">
              <div class="ov-stat4-secondary">13.5${hu} ${t('ovHoursWorkedShort')}</div>
              <div class="ov-stat4-delta ov-stat4-delta--up">▲ 64% ${t('ovAboveAvg')}</div>
            </div>
          </div>

        </div>

        <!-- Recent Shifts + Monthly Breakdown — same bottom row as the live view -->
        <div class="ov-bottom-row">
          <div class="ov-panel card">
            <div class="ov-panel-hdr">
              <div class="ov-panel-title">${t('recentShifts')}</div>
              <span class="ov-view-all-link">${t('viewAll')}</span>
            </div>
            <div class="rs-list">${recentHTML}</div>
          </div>
          <div class="ov-panel card">
            <div class="ov-panel-title">${t('monthlyBreakdown')||'DAILY BREAKDOWN'} · ${t('mn')[new Date().getMonth()]} ${new Date().getFullYear()}</div>
            <div class="tm-chart-wrap"><div class="ovb-skel-bars">${skelBars}</div></div>
            <div class="ov-breakdown-footer">
              <div class="ov-breakdown-stat">
                <span class="ov-breakdown-stat-label">${t('hoursWorked')}</span>
                <span class="ov-breakdown-stat-val">${sk('56px','16px')}</span>
              </div>
              <div class="ov-breakdown-stat">
                <span class="ov-breakdown-stat-label">${t('targetHours')}</span>
                <span class="ov-breakdown-stat-val">250${hu}</span>
              </div>
              <div class="ov-breakdown-stat">
                <span class="ov-breakdown-stat-label">${t('daysWorkedLabel')}</span>
                <span class="ov-breakdown-stat-val">${t('dayCount',18)}</span>
              </div>
              <div class="ov-breakdown-stat">
                <span class="ov-breakdown-stat-label">${t('remainingLabel')}</span>
                <span class="ov-breakdown-stat-val ov-breakdown-stat-val--blue">${sk('56px','16px')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Lightweight hero — no card chrome, no badge, no scrim. It sits within
         the page over the ghosted dashboard; the dashboard stays the star. -->
    <div class="ovb-hero">
      <h2 class="ovb-title">${ot('title')}</h2>
      <p class="ovb-sub">${ot('sub')}</p>
      <button class="ovb-cta" id="ov-onboard-cta">
        <span class="ovb-cta-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
        <span>${ot('cta')}</span>
        <svg class="ovb-cta-arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  </div>`;
}

// Wire the first-run Overview hero: the primary CTA opens today's log entry,
// routing through the Calendar so closing the modal lands on a usable view.
function wireOverviewEmpty(){
  const root=document.getElementById('ov-onboard');
  if(!root) return;
  document.getElementById('ov-onboard-cta')?.addEventListener('click',()=>{
    switchTab('calendar');
    const ds=today();
    S.modal={date:ds,existing:getLogs()[ds]||null};
    buildModal(modalCtx());
  });
}

// ── Overview number choreography ─────────────────────────────────────────────
// Drives every .ov-num count-up and [data-ov-bar] sweep on the Overview tab,
// using the same critically-damped spring as the header hero (animateStatsHero)
// so all motion in the app shares one physical character.
//
// Two situations, distinguished by the .ov-enter class buildOverview() stamps
// once per session:
//
//   FIRST-LOAD ENTRANCE (.ov-enter present) — cards and their numbers reveal as
//     they SCROLL INTO VIEW. An IntersectionObserver watches every card; when
//     one crosses into the viewport it gets .ov-in (triggering the CSS rise)
//     and its numbers begin counting. On desktop the whole dashboard is usually
//     on screen at once, so everything fires together in the staggered order;
//     on mobile the bottom panels wait until the user scrolls to them. Plays
//     ONlY this once — see _ovEntranceDone.
//
//   DATA CHANGE (no .ov-enter, signature differs) — a value changed while the
//     tab was already settled (logged a shift, tweaked tax). Numbers tween from
//     the previously shown figure straight to the new one; no reveal, no scroll
//     gating. Unchanged signature = redundant re-render → snap, no motion.
let _ovEntranceDone=false;   // latched true after the one session entrance
let _ovPrevNums={};          // key → last shown value, so data-change tweens old→new
let _ovAnimSig=null;         // signature last committed to screen
let _ovRAF=0;                // active count-up loop handle
let _ovIO=null;              // IntersectionObserver for scroll reveal
const _ovSpring=x=>{ if(x>=1)return 1; const l=5.5; return 1-Math.exp(-l*x)*(1+l*x); };
const OV_DUR=950;

// Count up a set of {el,target,from,dp,pre,suf,delay,kind} items on one shared
// rAF clock. Returns nothing; cancels any previous loop first.
function _ovRunCountup(items){
  if(_ovRAF){ cancelAnimationFrame(_ovRAF); _ovRAF=0; }
  if(!items.length) return;
  const fmt=(it,v)=>it.pre+(it.dp?v.toFixed(it.dp):Math.round(v).toLocaleString())+it.suf;
  const paint=(it,v)=>{
    if(it.kind==='bar') it.el.style.width=Math.max(0,Math.min(100,v)).toFixed(2)+'%';
    else it.el.textContent=fmt(it,v);
  };
  // Suspend bar CSS width-transitions for the sweep so the spring owns the frame.
  items.forEach(it=>{ if(it.kind==='bar') it.el.style.transition='none'; paint(it,it.from); });
  let start=0;
  const step=ts=>{
    if(!start)start=ts;
    let done=true;
    for(const it of items){
      const raw=(ts-start-(it.delay||0))/OV_DUR;
      if(raw<0){ done=false; continue; }
      if(raw>=1){ paint(it,it.target); continue; }
      paint(it, it.from+(it.target-it.from)*_ovSpring(raw));
      done=false;
    }
    if(done){ _ovRAF=0; items.forEach(it=>{ if(it.kind==='bar') it.el.style.transition=''; }); return; }
    _ovRAF=requestAnimationFrame(step);
  };
  _ovRAF=requestAnimationFrame(step);
}

// Read the animated targets attached to a card (or the whole wrap).
function _ovCollect(root){
  const nums=[...root.querySelectorAll('.ov-num')].map(el=>({
    el, key:el.dataset.k, target:parseFloat(el.dataset.t)||0,
    dp:parseInt(el.dataset.dp)||0, pre:el.dataset.pre||'', suf:el.dataset.suf||'',
    delay:parseInt(el.dataset.delay)||0, kind:'num'
  }));
  const bars=[...root.querySelectorAll('[data-ov-bar]')].map(el=>({
    el, key:'bar:'+el.dataset.ovBar, target:parseFloat(el.dataset.t)||0,
    delay:parseInt(el.dataset.delay)||0, kind:'bar'
  }));
  return nums.concat(bars);
}

function initOverviewMotion(){
  if(_ovRAF){ cancelAnimationFrame(_ovRAF); _ovRAF=0; }
  if(_ovIO){ _ovIO.disconnect(); _ovIO=null; }
  const wrap=document.querySelector('#tab-content .ov-wrap');
  if(!wrap) return;

  const sig=wrap.dataset.ovsig||'';
  const entering=wrap.classList.contains('ov-enter');
  const all=_ovCollect(wrap);
  const commit=()=>{
    const p={}; all.forEach(it=>p[it.key]=it.target);
    _ovPrevNums=p; _ovAnimSig=sig;
  };

  const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Scroll-triggered first-load reveal ──────────────────────────────────────
  if(entering && !reduce && 'IntersectionObserver' in window){
    // Cards animate the FIRST time each scrolls into view. Numbers inside a card
    // start counting from 0 in that same moment. Everything begins at rest
    // (opacity 0 via CSS, numbers painted to 0) so nothing flashes its final
    // state before its reveal.
    _ovBatch=[]; // fresh entrance run — drop any stale batch items
    const cards=[...wrap.querySelectorAll('.ov-proj-card, .ov-stat4-card, .ov-bottom-row .ov-panel')];
    // Paint every animated number/bar to its zero state up front (synchronously,
    // before the browser paints the freshly injected DOM) so no final figure
    // flashes before its card is revealed.
    all.forEach(it=>{
      if(it.kind==='bar'){ it.el.style.transition='none'; it.el.style.width='0%'; }
      else it.el.textContent=it.pre+(it.dp?(0).toFixed(it.dp):'0')+it.suf;
    });
    commit(); // targets are known; the loop from here is purely visual

    const reveal=card=>{
      if(card.dataset.ovIn) return;
      card.dataset.ovIn='1';
      card.classList.add('ov-in');
      // Count up just this card's numbers, preserving their per-element stagger
      // delays so values within a card still land in sequence with its CSS rise.
      const items=_ovCollect(card).map(it=>({...it, from:0}));
      if(items.length) _ovAppendCountup(items);
    };

    _ovIO=new IntersectionObserver((entries,obs)=>{
      // Cards crossing in together (the common desktop case, where the whole
      // dashboard is on screen at once) get a small incremental delay so they
      // still cascade in reading order rather than all snapping in at once.
      // On mobile, entries typically arrive one-at-a-time as the user scrolls,
      // so this stagger collapses to ~0 and each reveals on arrival.
      let i=0;
      entries.forEach(e=>{
        if(!e.isIntersecting) return;
        const card=e.target;
        obs.unobserve(card);
        const wait=i++*70;
        if(wait) setTimeout(()=>reveal(card), wait);
        else reveal(card);
      });
    }, { root:null, threshold:0.15, rootMargin:'0px 0px -8% 0px' });

    // Any card already in the viewport on mount reveals immediately (observer
    // fires for those on the next tick); off-screen ones wait for scroll.
    cards.forEach(c=>_ovIO.observe(c));
    return;
  }

  // ── No entrance (data change or reduced motion) ──────────────────────────────
  if(reduce){ commit(); return; }
  // Same data, tab just re-rendered/returned: leave numbers settled.
  if(sig===_ovAnimSig){ commit(); return; }
  // Data changed while settled: tween each value from its last shown figure.
  const items=all.map(it=>({...it, from:(it.key in _ovPrevNums ? _ovPrevNums[it.key] : it.target)}));
  commit();
  _ovRunCountup(items);
}

// Merge a fresh batch of count-up items into the running loop instead of
// replacing it, so cards revealed at different scroll positions each animate
// without cancelling one another. Falls back to starting the loop if idle.
let _ovBatch=[];
function _ovAppendCountup(items){
  const now=performance.now();
  const fmt=(it,v)=>it.pre+(it.dp?v.toFixed(it.dp):Math.round(v).toLocaleString())+it.suf;
  const paint=(it,v)=>{
    if(it.kind==='bar') it.el.style.width=Math.max(0,Math.min(100,v)).toFixed(2)+'%';
    else it.el.textContent=fmt(it,v);
  };
  // Prep each incoming item BEFORE checking whether a loop is running: rebase
  // its clock to now (so a card revealed later still respects its internal
  // per-number stagger from its own reveal), suspend bar width-transitions, and
  // paint its start value so nothing flashes final before counting.
  const fresh=items.map(it=>({...it,_active:true,_base:now}));
  fresh.forEach(it=>{ if(it.kind==='bar') it.el.style.transition='none'; paint(it,it.from); });
  _ovBatch=_ovBatch.filter(it=>it._active).concat(fresh);
  if(_ovRAF) return; // loop already running; it reads the reassigned _ovBatch

  const step=ts=>{
    let done=true;
    for(const it of _ovBatch){
      if(!it._active) continue;
      const raw=(performance.now()-it._base-(it.delay||0))/OV_DUR;
      if(raw<0){ done=false; continue; }
      if(raw>=1){ paint(it,it.target); if(it.kind==='bar') it.el.style.transition=''; it._active=false; continue; }
      paint(it, it.from+(it.target-it.from)*_ovSpring(raw));
      done=false;
    }
    if(done){ _ovRAF=0; _ovBatch=[]; return; }
    _ovRAF=requestAnimationFrame(step);
  };
  _ovRAF=requestAnimationFrame(step);
}

// ── Trend chart (Chart.js, lazy-loaded) ──────────────────────────────────────
// A single module-level ref so we can destroy before re-creating on each render.
let _trendChart = null;
// Populated by buildOverview() so renderTrendChart() shares the same numbers.
let _trendChartData = null;

let _trendChartRenderSeq=0;
async function renderTrendChart(){
  const canvas = document.getElementById('ov-trend-chart');
  if(!canvas) return;

  // Guard overlapping invocations: a fast range-toggle (or a re-render landing
  // during the CDN import) can call this again before the previous run reaches
  // `new Chart`. Each call claims a sequence number; after any await we bail if
  // a newer call has since started, so only the latest wins and we never build
  // two charts on one canvas (which left the animation half-applied).
  const seq=++_trendChartRenderSeq;

  // Lazy-load Chart.js from CDN — cached after first load
  if(!window.Chart){
    try{
      await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js');
    }catch(e){
      console.warn('[chart] Chart.js load failed:', e);
      return;
    }
  }
  if(seq!==_trendChartRenderSeq) return; // superseded during import

  // Destroy previous instance to prevent memory leaks on re-render
  if(_trendChart){ _trendChart.destroy(); _trendChart=null; }

  // Use the data already computed by buildOverview() — single source of truth.
  // This guarantees chart bars match the Calendar tab totals exactly.
  if(!_trendChartData) return;
  const {months: allMonths, values: allValues, mnames} = _trendChartData;

  // ── Single-month state ──────────────────────────────────────────────────────
  // With only one month logged there's no trend to draw yet, but we keep the SAME
  // line/area chart so users always recognise this component: the one real month
  // is a solid point + area fill, then a faint dashed line trails off into a few
  // ghosted future-month slots (hollow markers). A caption in the panel explains
  // the state. This reads as an early version of the chart, not a different widget.
  if(allMonths.length<2){
    const isDark=S.theme==='dark';
    const lineColor = isDark?'#7c93ff':'rgba(58,95,255,1)';
    const lastColor = isDark?'#a78bfa':'#7c69d4';
    const labelColor= isDark?'rgba(107,117,153,0.85)':'rgba(99,112,160,0.9)';
    const gridColor = isDark?'rgba(255,255,255,0.04)':'rgba(99,115,177,0.06)';
    const ghostColor= isDark?'rgba(124,147,255,0.30)':'rgba(99,115,177,0.32)';

    const realYM=allMonths[0]||`${new Date().getFullYear()}-${pad(new Date().getMonth()+1)}`;
    const realVal=allValues[0]||0;
    const [ry,rm]=realYM.split('-').map(Number);
    // Ghost future months continue the timeline so the axis reads as "waiting to
    // fill", not a lone dot floating in space.
    const GHOST=3;
    const labels=[mnames[rm-1]];
    for(let i=1;i<=GHOST;i++){ const d=new Date(ry,rm-1+i,1); labels.push(mnames[d.getMonth()]); }

    const ctx=canvas.getContext('2d');
    const h=canvas.offsetHeight||200;
    const grad=ctx.createLinearGradient(0,0,0,h);
    if(isDark){ grad.addColorStop(0,'rgba(124,147,255,0.35)'); grad.addColorStop(1,'rgba(124,147,255,0)'); }
    else{ grad.addColorStop(0,'rgba(58,95,255,0.16)'); grad.addColorStop(1,'rgba(58,95,255,0)'); }

    function fmtYAxisWonSolo(v){
      if(Math.abs(v)>=1000000) return '₩'+(v/1000000).toFixed(1)+(t('millionSuffix')||'M');
      if(Math.abs(v)>=1000)    return '₩'+(v/1000).toFixed(0)+(t('thousandSuffix')||'K');
      return '₩'+v;
    }

    _trendChart = new window.Chart(ctx,{
      type:'line',
      data:{
        labels,
        datasets:[
          // Ghost trail — a gently curved dashed line trailing off into the future
          // month slots, with faint hollow markers. Values follow a subtle wave (not
          // flat) so the curve reads as a placeholder timeline, not a real forecast.
          {
            data:[realVal, realVal*1.20, realVal*0.95, realVal*1.18],
            borderColor:ghostColor,
            borderWidth:1.5,
            borderDash:[5,5],
            pointBackgroundColor:'transparent',
            pointBorderColor:ghostColor,
            pointBorderWidth:1.5,
            pointRadius:[0,3.5,3.5,3.5],
            pointHoverRadius:[0,3.5,3.5,3.5],
            tension:0.45,
            fill:false,
          },
          // The one real month — solid point + area fill, exactly like live data.
          {
            data:[realVal,null,null,null],
            borderColor:lineColor,
            borderWidth:2.5,
            pointBackgroundColor:[lastColor],
            pointBorderColor:[lastColor],
            pointRadius:[7,0,0,0],
            pointHoverRadius:[9,0,0,0],
            pointBorderWidth:0,
            tension:0,
            fill:true,
            backgroundColor:grad,
          },
        ]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:{ duration:700, easing:'easeInOutQuart' },
        layout:{ padding:{ top:20, left:4, right:16, bottom:10 } },
        plugins:{ legend:{ display:false }, tooltip:{ enabled:false } },
        scales:{
          x:{ grid:{ display:false }, border:{ display:false }, ticks:{ color:labelColor, font:{ size:11, weight:'600' }, maxRotation:0 } },
          y:{
            display:true, position:'left',
            grid:{ color:gridColor, drawBorder:false },
            border:{ display:false, dash:[3,3] },
            ticks:{ color:labelColor, font:{ size:10, weight:'500' }, maxTicksLimit:5, callback:v=>fmtYAxisWonSolo(v) },
            min:0,
            suggestedMax: realVal>0 ? realVal*1.5 : 100000,
          }
        },
        interaction:{ intersect:false, mode:'index' },
      }
    });
    return;
  }

  // Slice to the selected range
  const sliceCount = S.chartRange==='1y' ? 12 : S.chartRange==='6m' ? 6 : 3;
  const months = allMonths.slice(-sliceCount);
  const values = allValues.slice(-sliceCount);

  // Smart year suffix: only add " 'YY" when the slice spans more than one calendar year
  const years = new Set(months.map(ym=>ym.slice(0,4)));
  const showYear = years.size > 1;
  const labels = months.map(ym=>{
    const [y,m] = ym.split('-');
    return showYear ? `${mnames[parseInt(m)-1]} '${y.slice(2)}` : mnames[parseInt(m)-1];
  });

  // Theme-aware colours
  const isDark=S.theme==='dark';
  const lineColor  = isDark ? '#7c93ff'                : 'rgba(58,95,255,1)';
  const dotColor   = isDark ? '#7c93ff'                : '#3a5fff';
  const lastColor  = isDark ? '#a78bfa'                : '#7c69d4';
  const labelColor = isDark ? 'rgba(107,117,153,0.85)' : 'rgba(99,112,160,0.9)';
  const gridColor  = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(99,115,177,0.06)';

  // Point colors: last point is magenta/highlighted, rest are blue
  const pointBg  = values.map((_,i)=>i===values.length-1?lastColor:dotColor);
  const pointBdr = values.map((_,i)=>i===values.length-1?lastColor:dotColor);
  const pointR   = values.map((_,i)=>i===values.length-1?7:3);
  const pointHR  = values.map((_,i)=>i===values.length-1?9:5);

  // Strong purple gradient fill
  const ctx=canvas.getContext('2d');
  const h=canvas.offsetHeight||200;
  const grad=ctx.createLinearGradient(0,0,0,h);
  if(isDark){
    grad.addColorStop(0,'rgba(124,147,255,0.45)');
    grad.addColorStop(0.5,'rgba(167,139,250,0.2)');
    grad.addColorStop(1,'rgba(124,147,255,0.0)');
  }else{
    grad.addColorStop(0,'rgba(58,95,255,0.18)');
    grad.addColorStop(1,'rgba(58,95,255,0)');
  }

  // Y-axis formatter: ₩1.0M, ₩1.5M etc.
  function fmtYAxisWon(v){
    if(Math.abs(v)>=1000000) return '₩'+(v/1000000).toFixed(1)+(t('millionSuffix')||'M');
    if(Math.abs(v)>=1000)    return '₩'+(v/1000).toFixed(0)+(t('thousandSuffix')||'K');
    return '₩'+v;
  }

  _trendChart = new window.Chart(ctx,{
    type:'line',
    data:{
      labels,
      datasets:[{
        data: values,
        borderColor: lineColor,
        borderWidth: 2.5,
        pointBackgroundColor: pointBg,
        pointBorderColor: pointBdr,
        pointRadius: pointR,
        pointHoverRadius: pointHR,
        pointBorderWidth: 0,
        tension: 0.42,
        fill: true,
        backgroundColor: grad,
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:{
        // Progressive line-draw + fade that replays on every (re)creation —
        // so switching 3m/6m/1y visibly re-animates rather than snapping. The
        // chart is destroyed and rebuilt on each toggle, so this entry
        // animation runs fresh each time.
        duration:700,
        easing:'easeInOutQuart',
        y:{ from:(ctx)=>{ const s=ctx.chart.scales.y; return s?s.getPixelForValue(s.min):undefined; } },
      },
      layout:{ padding:{ top:20, left:4, right:16, bottom:10 } },
      plugins:{
        legend:{ display:false },
        tooltip:{
          backgroundColor: isDark?'rgba(10,14,40,0.97)':'rgba(255,255,255,0.97)',
          borderColor: isDark?'rgba(120,150,255,0.2)':'rgba(99,115,177,0.15)',
          borderWidth:1,
          titleColor: isDark?'#f0f2ff':'#0d1033',
          bodyColor: isDark?'#6b7599':'#6370a0',
          titleFont:{ weight:'700', size:13 },
          bodyFont:{ size:12 },
          padding:12,
          cornerRadius:10,
          displayColors:false,
          callbacks:{
            label: ctx=>'₩'+ctx.parsed.y.toLocaleString(),
          }
        },
      },
      scales:{
        x:{
          grid:{ display:false },
          border:{ display:false },
          ticks:{ color:labelColor, font:{ size:11, weight:'600' }, maxRotation:0 },
        },
        y:{
          display:true,
          position:'left',
          grid:{ color:gridColor, drawBorder:false },
          border:{ display:false, dash:[3,3] },
          ticks:{
            color:labelColor,
            font:{ size:10, weight:'500' },
            maxTicksLimit:5,
            callback: v=>fmtYAxisWon(v),
          },
          beginAtZero:false,
        }
      },
      interaction:{ intersect:false, mode:'index' },
    }
  });
}

// ── Monthly bar chart (This Month panel in Overview) ──────────────────────────
let _monthBarChart = null;

async function renderMonthBarChart(){
  const canvas = document.getElementById('ov-month-bar-chart');
  if(!canvas) return;
  if(!window.Chart){
    try{ await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js'); }
    catch(e){ return; }
  }
  if(_monthBarChart){ _monthBarChart.destroy(); _monthBarChart=null; }

  const logs=getLogs(),todayStr=today();
  const now=new Date(),curY=now.getFullYear(),curMo=now.getMonth();
  const daysInCur=new Date(curY,curMo+1,0).getDate();
  const labels=[],values=[];
  // First pass: collect every worked/credited day this month (bar per day).
  const bars=[]; // { day, value }
  for(let d=1;d<=daysInCur;d++){
    const ds=mkds(curY,curMo,d);
    if(ds>todayStr) break;
    const g=autoGross(ds,logs);
    if(g>0||(logs[ds]&&isZeroDay(logs[ds]))){
      bars.push({day:d, value:applyTax(g)});
    }
  }
  if(!bars.length) return;

  // Second pass: decide label density from the NUMBER OF BARS, not the calendar
  // date. With only a few bars there's ample room, so label them all; once bars
  // get dense, thin them to ~6 evenly-spaced labels (always incl. first & last)
  // so they never overlap.
  const mLabel=t('mn')[curMo].slice(0,3);
  const n=bars.length;
  const MAX_LABELS=6;               // most labels we ever show at once
  const LABEL_ALL_THRESHOLD=8;      // at/under this many bars, label every one
  let showAt;
  if(n<=LABEL_ALL_THRESHOLD){
    showAt=()=>true;
  }else{
    const step=Math.ceil((n-1)/(MAX_LABELS-1)); // gap between labelled bars
    showAt=(i)=> i===0 || i===n-1 || i%step===0;
  }
  const allLabels=[], allValues=[];
  bars.forEach((b,i)=>{
    allLabels.push(showAt(i) ? `${mLabel} ${b.day}` : '');
    allValues.push(b.value);
  });

  const isDark=S.theme==='dark';

  // Gradient bar fill: indigo → violet (both modes use the same primary gradient)
  const ctx=canvas.getContext('2d');
  const h=canvas.offsetHeight||180;
  const barGrad=ctx.createLinearGradient(0,0,0,h);
  if(isDark){
    barGrad.addColorStop(0,'rgba(139,120,255,0.95)');
    barGrad.addColorStop(1,'rgba(108,134,255,0.35)');
  }else{
    barGrad.addColorStop(0,'rgba(139,92,246,0.90)');
    barGrad.addColorStop(1,'rgba(73,119,253,0.40)');
  }
  const barHoverGrad=ctx.createLinearGradient(0,0,0,h);
  if(isDark){
    barHoverGrad.addColorStop(0,'rgba(167,139,250,1)');
    barHoverGrad.addColorStop(1,'rgba(124,147,255,0.6)');
  }else{
    barHoverGrad.addColorStop(0,'rgba(139,92,246,1)');
    barHoverGrad.addColorStop(1,'rgba(73,119,253,0.7)');
  }

  const labelColor=isDark?'rgba(107,117,153,0.75)':'rgba(99,112,160,0.75)';
  const gridColor =isDark?'rgba(255,255,255,0.035)':'rgba(99,115,177,0.055)';

  function fmtY(v){
    if(v>=1000000) return '₩'+(v/1000000).toFixed(1)+(t('millionSuffix')||'M');
    if(v>=1000)    return '₩'+(v/1000).toFixed(0)+(t('thousandSuffix')||'K');
    return '₩'+v;
  }

  _monthBarChart=new window.Chart(ctx,{
    type:'bar',
    data:{
      labels: allLabels,
      datasets:[{
        data: allValues,
        backgroundColor: barGrad,
        hoverBackgroundColor: barHoverGrad,
        borderRadius: 6,
        borderSkipped: false,
        borderWidth: 0,
        barPercentage: 0.55,
        categoryPercentage: 0.75,
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:{duration:600,easing:'easeInOutQuart'},
      layout:{ padding:{ top:8, right:4, bottom:0, left:0 } },
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:isDark?'rgba(10,12,28,0.97)':'rgba(255,255,255,0.97)',
          borderColor:isDark?'rgba(139,120,255,0.25)':'rgba(99,115,177,0.15)',
          borderWidth:1,
          titleColor:isDark?'#f0f2ff':'#0d1033',
          bodyColor:isDark?'#6b7599':'#6370a0',
          titleFont:{weight:'700',size:12},
          bodyFont:{size:11},
          padding:10,cornerRadius:10,displayColors:false,
          callbacks:{
            title: items => {
              // Reuse the bars array so the tooltip day always matches the bar,
              // even for bars whose axis label was thinned out.
              const b=bars[items[0].dataIndex];
              return b ? `${mLabel} ${b.day}` : '';
            },
            label: ctx=>'₩'+ctx.parsed.y.toLocaleString(),
          }
        }
      },
      scales:{
        x:{
          display:true,
          grid:{display:false},
          border:{display:false},
          ticks:{
            color:labelColor,
            font:{size:10,weight:'600'},
            maxRotation:0,
            // only render non-empty labels
            callback(val,i){ return allLabels[i]||null; }
          }
        },
        y:{
          display:true,
          position:'left',
          grid:{color:gridColor,drawBorder:false},
          border:{display:false,dash:[3,4]},
          ticks:{
            color:labelColor,
            font:{size:10,weight:'500'},
            maxTicksLimit:4,
            callback: v=>fmtY(v),
          },
          beginAtZero:true,
        }
      },
      interaction:{intersect:false,mode:'index'},
    }
  });
}

// ── Rules rows (Settings card + import preview) ──────────────────────────────
// Icons are keyed by the rule KIND buildRulesRows tags each row with — never
// by row position, which shifts as optional rules (Saturday, Sunday credit…)
// drop out of the profile. Module-scope so the workplace-import preview
// (Phase 6.3) renders a candidate profile with the exact same card rows.
const RULE_ICONS={
  // Day — gold sun (matches the app's day-shift ☀ convention)
  day:    {color:'#fbbf24',glow:'rgba(251,191,36,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`},
  // Night — purple moon (matches the app's night-shift convention)
  night:  {color:'#a78bfa',glow:'rgba(138,100,255,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`},
  // Double — teal rotate (matches the app's double-shift convention)
  double: {color:'#00d2be',glow:'rgba(0,210,190,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`},
  // Sunday rest credit — pink sparkle
  sunday: {color:'#f472b6',glow:'rgba(244,114,182,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/></svg>`},
  // Holiday credit — red alert circle
  holiday:{color:'#f87171',glow:'rgba(248,113,113,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`},
  // Tax/deduction — yellow percent
  tax:    {color:'#fbbf24',glow:'rgba(251,191,36,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`},
};
function ruleRowsHTML(rows){
  return rows.map(([type,rule,kind])=>{
    const ic=RULE_ICONS[kind]||RULE_ICONS.tax;
    return`<div class="sr-row">
      <div class="sr-icon-wrap" style="--ic:${ic.color};--ig:${ic.glow};">${ic.svg}</div>
      <div class="sr-name">${type}</div>
      <div class="sr-desc">${rule}</div>
    </div>`;
  }).join('');
}

function buildSettings(){
  const wages=getWages();
  const taxPct=getTaxPct();
  const rules=rulesRows();
  const holA=isHolAuto();
  const currentWage=getWage();

  // ── Wage timeline rows (newest first, up to 4) ────────────────────────────
  const LANG_LOCALE={en:'en-US',ko:'ko-KR',id:'id-ID',th:'th-TH',ru:'ru-RU',zh:'zh-CN',fr:'fr-FR',ne:'ne-NP'};
  const fmtWageDate=ds=>{const[y,m,d]=ds.split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString(LANG_LOCALE[S.lang]||'en-US',{month:'short',day:'2-digit',year:'numeric'});};
  // The "current" row is the entry active today (last one with date ≤ today),
  // matching wageFor()/getWage(). This may not be the newest row if a future-
  // dated wage change exists.
  const activeIdx=activeWageIdx(wages, today());
  const wageRows=wages.slice().reverse().slice(0,4).map((w,i)=>{
    const realIdx=wages.length-1-i;
    const isFirst=realIdx===0;
    const isCurrent=realIdx===activeIdx;
    return`<div class="sw-row${isCurrent?' sw-row--current':''}">
      <div class="sw-dot-col">
        <div class="sw-dot${isCurrent?' sw-dot--active':''}"></div>
      </div>
      <div class="sw-row-glass">
        <div class="sw-date">${fmtWageDate(w.date)}</div>
        ${isCurrent?`<span class="sw-current-badge sw-current-badge--mobile-only">${t('wageBadgeCurrent')}</span>`:''}
        <div class="sw-amount">₩${w.amount.toLocaleString()}</div>
        <button class="sw-three-dot" data-wage-menu="${realIdx}" aria-label="Options" title="Edit or delete">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>`;
  }).join('');

  const wageFormHTML='';

  // ── Deductions (tax vs 4대 보험 insurance mode) ────────────────────────────
  const dedMode=getDeductionMode();          // 'tax' | 'insurance'
  const ins=getInsurance();
  const insCarePct=careRateOfGross(ins);      // long-term care as % of gross
  const insTotalPct=insuranceRate(ins)*100;   // combined employee %

  // ── Deduction rings ─────────────────────────────────────────────────────────
  // Tax and insurance now live in separate cards, each with its own ring showing
  // that card's own rate (independent of which one is the active deduction).
  const TR_R=48,TR_C=60,TR_SW=9;
  const trCirc=2*Math.PI*TR_R;
  const taxDash=Math.round((Math.min(taxPct,100)/100)*trCirc);

  // ── Target ring + data ────────────────────────────────────────────────────
  const tgt=S.targetHrs||250;
  const nowD=new Date(),curY=nowD.getFullYear(),curMo=nowD.getMonth();
  const todayStr2=today(),logs2=getLogs();
  let curHrs=0;
  const dInM2=new Date(curY,curMo+1,0).getDate();
  for(let d=1;d<=dInM2;d++){const ds=mkds(curY,curMo,d);if(ds>todayStr2)break;curHrs+=autoEff(ds,logs2);}
  const tgtPct=Math.min(100,Math.round((curHrs/tgt)*100));
  const TG_R=46,TG_C=56,TG_SW=9;
  const tgCirc=2*Math.PI*TG_R;
  const tgDash=Math.round((tgtPct/100)*tgCirc);

  const rulesHTML=ruleRowsHTML(rules);

  return`
  <!-- ── Row 1: three equal cards ── -->
  <div class="s3-row">

    <!-- HOURLY WAGE -->
    <div class="s3-card">
      <div class="s3-eyebrow">
        <div class="s3-icon-badge s3-icon-badge--purple s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <span>${t('wageCardTitle').toUpperCase()}</span>
      </div>
      <div class="s3-sub-label">${t('wageCurrentLabel')}</div>
      <div class="s3-big-val">₩${currentWage.toLocaleString()}<span class="s3-big-unit">${t('perHourUnit')}</span></div>
      <div class="s3-sub-label" style="margin-top:14px;margin-bottom:8px;">${t('wageHistoryLabel')}</div>
      <div class="sw-timeline-scroll${wages.length>3?' sw-timeline-scroll--scrollable':''}"><div class="sw-timeline">${wageRows}</div></div>
      <button class="sw-add-btn" id="show-wage-add-form">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('wageAddNew')}
      </button>
    </div>

    <!-- MONTHLY TARGET -->
    <div class="s3-card">
      <div class="s3-eyebrow">
        <div class="s3-icon-badge s3-icon-badge--teal s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <span>${t('monthlyTarget').toUpperCase()}</span>
      </div>

      <!-- Hero: label+number left, ring right — aligned on same baseline row -->
      <div class="s3-target-hero">
        <div class="s3-target-left">
          <div class="s3-sub-label" style="margin-bottom:6px;">${t('monthlyTargetHoursLabel')}</div>
          <div class="s3-target-val" id="tgt-display-val" style="font-size:${tgt.toString().length+t('hoursUnit').length<=4?'34px':tgt.toString().length+t('hoursUnit').length<=6?'26px':'20px'}">${tgt}${t('hoursUnit')}</div>
        </div>
        <div class="s3-target-ring">
          <svg id="tgt-ring-svg" viewBox="0 0 ${TG_C*2} ${TG_C*2}" width="${TG_C*2}" height="${TG_C*2}" style="filter:drop-shadow(0 0 12px rgba(108,134,255,0.3))">
            <defs>
              <linearGradient id="stgt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#6c86ff"/>
                <stop offset="100%" stop-color="#a78bfa"/>
              </linearGradient>
            </defs>
            <circle cx="${TG_C}" cy="${TG_C}" r="${TG_R}" fill="none" stroke="var(--ring-track)" stroke-width="${TG_SW}"/>
            <circle id="tgt-ring-arc" cx="${TG_C}" cy="${TG_C}" r="${TG_R}" fill="none" stroke="url(#stgt-grad)" stroke-width="${TG_SW}"
              stroke-dasharray="${tgDash} ${tgCirc-tgDash}" stroke-dashoffset="${tgCirc*0.25}" stroke-linecap="round"
              style="transition:stroke-dasharray 0.55s cubic-bezier(0.4,0,0.2,1);"/>
            <text id="tgt-ring-txt" x="${TG_C}" y="${TG_C+1}" text-anchor="middle" dominant-baseline="middle"
              fill="var(--text)" font-size="18" font-weight="700" font-family="inherit">${tgtPct}%</text>
          </svg>
          <div class="s3-target-sub" id="tgt-ring-sub">${curHrs.toFixed(1)} / ${tgt}${t('hoursUnit')}</div>
        </div>
      </div>

      <!-- Quick presets: 3 in a row -->
      <div class="s3-sub-label s3-presets-label">${t('monthlyTargetPresets')}</div>
      <div class="s3-pill-grid s3-pill-grid--3" style="margin-bottom:10px;">
        ${[180,250,300].map(h=>`<button class="s3-pill${(S.targetHrs||250)===h?' s3-pill--active':''}" data-target-preset="${h}">${h}${t('hoursUnit')}</button>`).join('')}
      </div>

      <!-- Custom input: full-width below the 3 presets -->
      <div class="s3-custom-row--full s3-custom-row" style="margin-bottom:10px;">
        <input class="s3-inp s3-inp--full" id="target-hrs-in" type="number" value="${tgt}" min="1" max="500" step="1" placeholder="${t('monthlyTargetCustom')}">
        <span class="s3-inp-unit">${t('hoursUnit')}</span>
      </div>

      <button class="s3-full-btn" id="save-target-hrs">${t('monthlyTargetSave')}</button>
    </div>

    <!-- INCOME TAX RATE -->
    <div class="s3-card ded-card${dedMode==='tax'?' ded-card--active':' ded-card--inactive'}" id="ded-card-tax">
      <div class="s3-eyebrow">
        <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg" style="font-size:15px;font-weight:800;color:#5ba8ff;">%</div>
        <span>${t('deductionsLabel').toUpperCase()}</span>
        <button class="ded-pick${dedMode==='tax'?' ded-pick--on':''}" id="ded-pick-tax" data-ded-mode="tax"
          role="switch" aria-checked="${dedMode==='tax'}" aria-label="${t('deductionModeTax')}">
          <span class="ded-pick-dot"></span>
          <span class="ded-pick-txt">${dedMode==='tax'?t('deductionActive'):t('deductionUse')}</span>
        </button>
      </div>

      <div class="s3-sub-label">${t('taxRateCurrentLabel')}</div>
      <div class="s3-ring-center">
        <svg viewBox="0 0 ${TR_C*2} ${TR_C*2}" width="${TR_C*2}" height="${TR_C*2}" style="filter:drop-shadow(0 0 12px rgba(108,134,255,0.35))">
          <defs>
            <linearGradient id="stax-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#6c86ff"/>
              <stop offset="100%" stop-color="#a78bfa"/>
            </linearGradient>
          </defs>
          <circle cx="${TR_C}" cy="${TR_C}" r="${TR_R}" fill="none" stroke="var(--ring-track)" stroke-width="${TR_SW}"/>
          <circle id="tax-ring-arc" cx="${TR_C}" cy="${TR_C}" r="${TR_R}" fill="none" stroke="url(#stax-grad)" stroke-width="${TR_SW}"
            stroke-dasharray="${taxDash} ${trCirc-taxDash}" stroke-dashoffset="${trCirc*0.25}" stroke-linecap="round"
            style="transition:stroke-dasharray 0.55s cubic-bezier(0.4,0,0.2,1);"/>
          <text id="tax-ring-txt" x="${TR_C}" y="${TR_C+2}" text-anchor="middle" dominant-baseline="middle"
            fill="var(--text)" font-size="18" font-weight="700" font-family="inherit">${(Math.round(taxPct*100)/100)}%</text>
        </svg>
      </div>

      <div class="ded-body" id="ded-body-tax">
        <div class="s3-hint">${t('taxRateRange')}</div>
        <div class="s3-pill-grid s3-pill-grid--3" style="margin-bottom:8px;">
          ${[3.3,5,10].map(p=>`<button class="s3-pill${Math.abs(taxPct-p)<0.001?' s3-pill--active':''}" data-tax-preset="${p}"${dedMode!=='tax'?' disabled':''}>${p}%</button>`).join('')}
        </div>
        <div class="s3-custom-row s3-custom-row--full" style="margin-bottom:10px;">
          <input class="s3-inp s3-inp--full" id="tax-rate-in" type="number" value="${taxPct}" min="0" max="45" step="0.1" placeholder="${t('taxRatePlaceholder')}"${dedMode!=='tax'?' disabled':''}>
          <span class="s3-inp-unit">%</span>
        </div>
        <button class="s3-full-btn" id="save-tax-rate"${dedMode!=='tax'?' disabled':''}>${t('taxRateSave')}</button>
      </div>
    </div>

  </div><!-- /s3-row -->

  <!-- ── Insurance (4대 보험) — own full-width row, mutually exclusive with Tax ── -->
  <div class="s1-row">
    <div class="s3-card ded-card${dedMode==='insurance'?' ded-card--active':' ded-card--inactive'}" id="ded-card-ins">
      <div class="s3-eyebrow">
        <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <span>${t('deductionModeInsurance').toUpperCase()}</span>
        <button class="ded-pick${dedMode==='insurance'?' ded-pick--on':''}" id="ded-pick-insurance" data-ded-mode="insurance"
          role="switch" aria-checked="${dedMode==='insurance'}" aria-label="${t('deductionModeInsurance')}">
          <span class="ded-pick-dot"></span>
          <span class="ded-pick-txt">${dedMode==='insurance'?t('deductionActive'):t('deductionUse')}</span>
        </button>
      </div>

      <div class="ded-body ded-ins-body" id="ded-body-ins">
        <!-- Hero: total contribution as the answer-first number -->
        <div class="ins-hero">
          <div class="ins-hero-figure">
            <div class="s3-sub-label">${t('insuranceTotalLabel')}</div>
            <div class="ins-hero-total" id="ins-total-val">${(Math.round(insTotalPct*100)/100)}%</div>
          </div>
        </div>

        <!-- Breakdown: four components in a scannable row. Each is a self-contained
             tile — colored icon, label, inline-editable value, and a proportional
             bar whose width = this component's share of the total. -->
        <div class="ins-breakdown">
          <div class="ins-comp" data-comp="pension">
            <div class="ins-comp-head">
              <div class="s3-icon-badge s3-icon-badge--warning">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M4 21V10l8-6 8 6v11M9 21v-6h6v6"/></svg>
              </div>
              <span class="ins-comp-label">${t('insPension')}</span>
            </div>
            <div class="ins-comp-input"><input class="s3-inp ins-inp" id="ins-pension" type="number" value="${ins.pension}" min="0" max="30" step="0.01"${dedMode!=='insurance'?' disabled':''}><span class="s3-inp-unit">%</span></div>
            <div class="ins-comp-bar"><span class="ins-comp-bar-fill" id="ins-bar-pension"></span></div>
          </div>

          <div class="ins-comp" data-comp="health">
            <div class="ins-comp-head">
              <div class="s3-icon-badge s3-icon-badge--danger">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
              </div>
              <span class="ins-comp-label">${t('insHealth')}</span>
            </div>
            <div class="ins-comp-input"><input class="s3-inp ins-inp" id="ins-health" type="number" value="${ins.health}" min="0" max="30" step="0.01"${dedMode!=='insurance'?' disabled':''}><span class="s3-inp-unit">%</span></div>
            <div class="ins-comp-bar"><span class="ins-comp-bar-fill" id="ins-bar-health"></span></div>
          </div>

          <div class="ins-comp" data-comp="employment">
            <div class="ins-comp-head">
              <div class="s3-icon-badge s3-icon-badge--blue">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </div>
              <span class="ins-comp-label">${t('insEmployment')}</span>
            </div>
            <div class="ins-comp-input"><input class="s3-inp ins-inp" id="ins-employment" type="number" value="${ins.employment}" min="0" max="30" step="0.01"${dedMode!=='insurance'?' disabled':''}><span class="s3-inp-unit">%</span></div>
            <div class="ins-comp-bar"><span class="ins-comp-bar-fill" id="ins-bar-employment"></span></div>
          </div>

          <div class="ins-comp ins-comp--derived" data-comp="care">
            <div class="ins-comp-head">
              <div class="s3-icon-badge s3-icon-badge--purple">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
              </div>
              <span class="ins-comp-label">${t('insCare')}</span>
            </div>
            <div class="ins-comp-input"><span class="ins-derived-val" id="ins-care-val">${(Math.round(insCarePct*1000)/1000)}</span><span class="s3-inp-unit">%</span><span class="ins-derived-tag">${t('insCareDerived')}</span></div>
            <div class="ins-comp-bar"><span class="ins-comp-bar-fill" id="ins-bar-care"></span></div>
          </div>
        </div>

        <div class="ins-divider"></div>

        <button class="s3-full-btn" id="save-insurance"${dedMode!=='insurance'?' disabled':''}>${t('insuranceSave')}</button>
      </div>
    </div>
  </div><!-- /s1-row -->

  <!-- ── Row 2: Holiday Credit | Export ── -->
  <div class="s2-row">

    <!-- AUTO HOLIDAY CREDIT -->
    <div class="s3-card s3-card--hol">

      <!-- ── Header ── -->
      <div class="s3-hol-header">
        <div class="s3-eyebrow" style="margin-bottom:0;">
          <div class="s3-icon-badge s3-icon-badge--purple s3-icon-badge--lg">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none"/></svg>
          </div>
          <span class="s3-hol-title">${t('holAutoTitle')}</span>
        </div>
        <div class="s3-hol-onbadge${holA?' s3-hol-onbadge--on':' s3-hol-onbadge--off'}">
          <span class="s3-hol-onbadge-dot"></span>
          <span>${holA?'ON':'OFF'}</span>
        </div>
      </div>

      <!-- ── Description ── -->
      <p class="s3-hol-desc-top">${t('holAutoSub')}</p>

      <!-- ── Gradient divider ── -->
      <div class="s3-hol-divider"></div>

      <!-- ── Three feature tiles ── -->
      <div class="s3-hol-features">

        <div class="s3-hol-feat">
          <div class="s3-hol-feat-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          </div>
          <div class="s3-hol-feat-title">${t('holFeatAutoTitle')}</div>
          <div class="s3-hol-feat-sub">${t('holFeatAutoSub')}</div>
        </div>

        <div class="s3-hol-feat">
          <div class="s3-hol-feat-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="s3-hol-feat-title">${t('holFeat8hTitle')}</div>
          <div class="s3-hol-feat-sub">${t('holFeat8hSub')}</div>
        </div>

        <div class="s3-hol-feat">
          <div class="s3-hol-feat-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
          </div>
          <div class="s3-hol-feat-title">${t('holFeatAlwaysTitle')}</div>
          <div class="s3-hol-feat-sub">${t('holFeatAlwaysSub')}</div>
        </div>

      </div>

      <!-- ── Upcoming Holiday Credits ── -->
      ${(()=>{
        const upcoming = getUpcomingHolidays(3);
        if(!upcoming.length) return '';
        const tr2 = TR[S.lang] || TR.en;
        const rows = upcoming.map(({ds, name, diffDays}, i) => {
          const d = pd(ds);
          const dow = (tr2.dh||TR.en.dh)[d.getDay()];
          const mo  = (tr2.mn||TR.en.mn)[d.getMonth()];
          return `<div class="s3-hol-upc-row${i < upcoming.length-1 ? '' : ' s3-hol-upc-row--last'}">
            <div class="s3-hol-upc-timeline">
              <div class="s3-hol-upc-dot"></div>
              ${i < upcoming.length-1 ? '<div class="s3-hol-upc-line"></div>' : ''}
            </div>
            <div class="s3-hol-upc-info">
              <div class="s3-hol-upc-name">${name}</div>
              <div class="s3-hol-upc-date">${dow}, ${mo} ${d.getDate()}</div>
            </div>
            <div class="s3-hol-upc-right">
              
              <span class="s3-hol-upc-pill">${t('holInDays', diffDays)}</span>
            </div>
          </div>`;
        }).join('');
        return `<div class="s3-hol-upc-section">
          <div class="s3-hol-upc-eyebrow">${t('holUpcomingCredits')}</div>
          <div class="s3-hol-upc-list">${rows}</div>
          <button class="s3-hol-view-all" id="hol-view-all-btn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            ${t('holViewUpcoming')}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>`;
      })()}

      <!-- ── Gradient divider ── -->
      <div class="s3-hol-divider"></div>

      <!-- ── Status row ── -->
      <div class="s3-hol-status-row${holA?'':' s3-hol-status-row--off'}">
        <div class="s3-hol-status-check${holA?' s3-hol-status-check--on':' s3-hol-status-check--off'}">
          <svg class="s3-hol-ic s3-hol-ic--check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <svg class="s3-hol-ic s3-hol-ic--x" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </div>
        <div class="s3-hol-status-text">
          <div class="${holA?'s3-hol-enabled':'s3-hol-disabled'}">${holA?t('holStatusEnabled'):t('holStatusDisabled')}</div>
          <div class="s3-hol-status-txt">${holA?t('holStatusOnTxt'):t('holStatusOffTxt')}</div>
        </div>
        <button id="${holA?'hol-auto-off':'hol-auto-on'}" class="s3-toggle${holA?' s3-toggle--on':''}">
          <div class="s3-toggle-knob"></div>
        </button>
      </div>

      <!-- hidden button for event wiring compatibility -->
      <button id="${holA?'hol-auto-on':'hol-auto-off'}" style="display:none;"></button>
    </div>

    <!-- EXPORT DATA -->
    <div class="s3-card s3-card--export" id="export-card">
      ${buildExportCardInline()}
    </div>

  </div><!-- /s2-row -->

  <!-- ── Row 3: Wage Calculation Rules ── -->
  <div class="s3-card s3-card--rules${S.rulesCollapsed?' s3-card--rules-collapsed':''}">
    <div class="sr-header" id="sr-header" role="button" tabindex="0" aria-controls="sr-list" aria-expanded="${S.rulesCollapsed?'false':'true'}">
      <div class="sr-header-left">
        <div class="s3-icon-badge s3-icon-badge--purple s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        </div>
        <div>
          <div class="sr-header-title">${t('wageCalcRulesTitle')}</div>
          <div class="sr-header-sub">${t('wageCalcRulesSub')}</div>
        </div>
      </div>
      <button class="sr-collapse-btn" id="sr-collapse-btn" aria-label="${t('wageCalcRulesToggle')}" title="${t('wageCalcRulesToggle')}" aria-expanded="${S.rulesCollapsed?'false':'true'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
      </button>
    </div>
    <div class="sr-list" id="sr-list">${rulesHTML}
      <button type="button" class="sw-add-btn" id="pr-edit-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        ${wizT(S.lang,'edit')}
      </button>
      <!-- Phase 6.3: workplace sharing — a code sets up these exact pay rules
           on a coworker's phone; import replaces this workplace via preview. -->
      <div class="pr-btn-row">
        <button type="button" class="sw-add-btn" id="pr-share-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          ${wizT(S.lang,'shareBtn')}
        </button>
        <button type="button" class="sw-add-btn" id="pr-import-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          ${wizT(S.lang,'importBtn')}
        </button>
      </div>
    </div>
  </div>

  <!-- ── Row 4: Danger Zone ── -->
  <div class="s3-card s3-card--danger">
    <div class="s3-danger-left">
      <div class="s3-danger-shield">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div>
        <div class="s3-danger-title">${t('dangerZone')}</div>
        <div class="s3-danger-sub">${t('resetTitle')}.</div>
        <div class="s3-danger-sub">${t('resetSub')}</div>
      </div>
    </div>
    <button class="s3-danger-btn" id="open-reset-modal">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      ${t('resetBtn')}
    </button>
  </div>

  ${appFooter()}`;
}

// ── Inline export card ────────────────────────────────────────────────────────
function buildExportCardInline(){
  const logs=getLogs();
  const months=[...new Set(Object.keys(logs).filter(ds=>{const e=logs[ds];return(e.regHrs||e.hrs||0)>0;}).map(ds=>ds.slice(0,7)))].sort();

  const now=new Date();
  const curYM=`${now.getFullYear()}-${pad(now.getMonth()+1)}`;
  const prevYM=now.getMonth()===0?`${now.getFullYear()-1}-12`:`${now.getFullYear()}-${pad(now.getMonth())}`;

  if(!months.length){
    // ── Premium onboarding empty state ──────────────────────────────────────
    // Shown to first-run users with no logged shifts. A layered-glass hero with
    // a document-stack illustration, an inline explanation of what becomes
    // exportable, and three intentional actions: Start logging (primary),
    // a locked Export affordance, and a "What you can export" disclosure.
    const eLang=getLang();
    const EE={
      en:{
        head:'Your export starts here',
        desc:'Log a few shifts and Shiftr turns your hours, pay and holidays into a clean spreadsheet or a polished PDF — ready to download or share.',
        start:'Start logging work',
        locked:'Export',
        lockedHint:'Locked',
        learn:'What you can export',
        earnT:'Earnings',        earnS:'Gross, deductions & net pay, day by day',
        holT:'Public holidays',  holS:'Auto-credited holiday pay included',
        monthT:'Monthly summary', monthS:'Totals and hours rolled up per month',
        formats:'Arrives as CSV & PDF — 100% private, generated on your device',
      },
      ko:{
        head:'내보내기가 여기서 시작돼요',
        desc:'근무를 몇 번만 기록하면 근무 시간·급여·공휴일이 깔끔한 스프레드시트나 세련된 PDF로 정리돼 언제든 내보내거나 공유할 수 있어요.',
        start:'근무 기록 시작하기',
        locked:'내보내기',
        lockedHint:'잠김',
        learn:'무엇을 내보낼 수 있나요',
        earnT:'급여',          earnS:'일별 총급여·공제·실수령액',
        holT:'공휴일',          holS:'자동 반영된 공휴일 수당 포함',
        monthT:'월별 요약',      monthS:'월 단위 합계와 근무 시간',
        formats:'CSV와 PDF로 제공 — 기기에서 생성되는 100% 비공개 파일',
      },
      id:{
        head:'Ekspor Anda dimulai di sini',
        desc:'Catat beberapa shift dan Shiftr mengubah jam kerja, gaji, dan hari libur Anda menjadi spreadsheet yang rapi atau PDF yang elegan — siap diunduh atau dibagikan.',
        start:'Mulai catat kerja',
        locked:'Ekspor',
        lockedHint:'Terkunci',
        learn:'Yang bisa diekspor',
        earnT:'Penghasilan',       earnS:'Kotor, potongan & gaji bersih per hari',
        holT:'Hari libur nasional', holS:'Termasuk upah libur otomatis',
        monthT:'Ringkasan bulanan', monthS:'Total dan jam kerja per bulan',
        formats:'Tersedia dalam CSV & PDF — 100% privat, dibuat di perangkat Anda',
      },
      th:{
        head:'การส่งออกของคุณเริ่มต้นที่นี่',
        desc:'บันทึกกะการทำงานสักสองสามครั้ง แล้ว Shiftr จะเปลี่ยนชั่วโมงทำงาน ค่าจ้าง และวันหยุดของคุณให้เป็นสเปรดชีตที่เป็นระเบียบหรือรายงาน PDF ที่สวยงาม — พร้อมดาวน์โหลดหรือแชร์',
        start:'เริ่มบันทึกงาน',
        locked:'ส่งออก',
        lockedHint:'ล็อก',
        learn:'สิ่งที่ส่งออกได้',
        earnT:'รายได้',            earnS:'ค่าจ้างรวม รายการหัก และสุทธิ รายวัน',
        holT:'วันหยุดราชการ',       holS:'รวมค่าจ้างวันหยุดอัตโนมัติ',
        monthT:'สรุปรายเดือน',      monthS:'ยอดรวมและชั่วโมงต่อเดือน',
        formats:'มีให้ในรูปแบบ CSV และ PDF — เป็นส่วนตัว 100% สร้างบนอุปกรณ์ของคุณ',
      },
      ru:{
        head:'Ваш экспорт начинается здесь',
        desc:'Отметьте несколько смен, и Shiftr превратит ваши часы, зарплату и праздники в аккуратную таблицу или изящный PDF-отчёт — готовый к загрузке или отправке.',
        start:'Начать учёт работы',
        locked:'Экспорт',
        lockedHint:'Заблокировано',
        learn:'Что можно экспортировать',
        earnT:'Заработок',          earnS:'Начисления, вычеты и «на руки» по дням',
        holT:'Государственные праздники', holS:'С автоначислением за праздники',
        monthT:'Сводка по месяцам', monthS:'Итоги и часы по каждому месяцу',
        formats:'Доступно в CSV и PDF — на 100% приватно, создаётся на вашем устройстве',
      },
      zh:{
        head:'你的导出从这里开始',
        desc:'记录几次班次，Shiftr 就会把你的工时、工资和假日整理成清晰的表格或精美的 PDF 报告——随时可下载或分享。',
        start:'开始记录工作',
        locked:'导出',
        lockedHint:'已锁定',
        learn:'可导出的内容',
        earnT:'收入',              earnS:'每日的税前、扣除与实发工资',
        holT:'法定节假日',          holS:'含自动计入的节假日工资',
        monthT:'月度汇总',          monthS:'按月汇总的合计与工时',
        formats:'提供 CSV 和 PDF 格式——100% 私密，在你的设备上生成',
      },
      fr:{
        head:'Votre export commence ici',
        desc:'Enregistrez quelques services et Shiftr transforme vos heures, votre salaire et vos jours fériés en un tableur soigné ou un PDF élégant — prêt à télécharger ou à partager.',
        start:'Commencer le suivi',
        locked:'Exporter',
        lockedHint:'Verrouillé',
        learn:'Ce que vous pouvez exporter',
        earnT:'Revenus',            earnS:'Brut, déductions et net, jour par jour',
        holT:'Jours fériés',        holS:'Paie des jours fériés incluse automatiquement',
        monthT:'Récapitulatif mensuel', monthS:'Totaux et heures regroupés par mois',
        formats:'Disponible en CSV et PDF — 100 % privé, généré sur votre appareil',
      },
      ne:{
        head:'तपाईंको निर्यात यहाँबाट सुरु हुन्छ',
        desc:'केही शिफ्टहरू रेकर्ड गर्नुहोस्, अनि Shiftr ले तपाईंको काम गरेको घण्टा, तलब र बिदाहरूलाई सफा स्प्रेडसिट वा राम्रो PDF रिपोर्टमा बदल्छ — डाउनलोड वा सेयर गर्न तयार।',
        start:'काम रेकर्ड सुरु गर्नुहोस्',
        locked:'निर्यात',
        lockedHint:'बन्द',
        learn:'के निर्यात गर्न सकिन्छ',
        earnT:'कमाइ',              earnS:'दैनिक कुल, कटौती र खुद तलब',
        holT:'सार्वजनिक बिदा',      holS:'स्वतः गणना गरिएको बिदा तलब समावेश',
        monthT:'मासिक सारांश',      monthS:'महिना अनुसार जम्मा र घण्टा',
        formats:'CSV र PDF मा उपलब्ध — १००% निजी, तपाईंकै यन्त्रमा बनाइन्छ',
      },
    };
    const et=k=>(EE[eLang]||EE.en)[k]||EE.en[k];
    const eItem=(icon,title,sub)=>`
      <div class="sexp-empty-item">
        <div class="sexp-empty-item-ico">${icon}</div>
        <div class="sexp-empty-item-txt">
          <div class="sexp-empty-item-t">${title}</div>
          <div class="sexp-empty-item-s">${sub}</div>
        </div>
        <svg class="sexp-empty-item-chk" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>`;
    return`<div class="sexp-empty" id="sexp-empty">
      <div class="sexp-header">
        <div class="s3-eyebrow" style="margin-bottom:0;">
          <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <span class="sexp-title">${t('exportTitle').toUpperCase()}</span>
        </div>
        <div class="sexp-privacy-badge">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          ${t('expPrivate')}
        </div>
      </div>

      <div class="s3-hol-divider"></div>

      <div class="sexp-empty-hero">
        <div class="sexp-empty-art" aria-hidden="true">
          <span class="sexp-art-glow"></span>
          <span class="sexp-art-doc sexp-art-doc--b"></span>
          <span class="sexp-art-doc sexp-art-doc--m"></span>
          <span class="sexp-art-doc sexp-art-doc--f">
            <span class="sexp-art-bar"></span>
            <span class="sexp-art-line"></span>
            <span class="sexp-art-line sexp-art-line--short"></span>
            <span class="sexp-art-line"></span>
            <span class="sexp-art-line sexp-art-line--short"></span>
          </span>
          <span class="sexp-art-badge">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>
          </span>
        </div>
        <div class="sexp-empty-title">${et('head')}</div>
        <p class="sexp-empty-desc">${et('desc')}</p>
      </div>

      <button class="sexp-empty-cta" id="sexp-empty-start">
        <span class="sexp-empty-cta-ico">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </span>
        <span>${et('start')}</span>
        <svg class="sexp-empty-cta-arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>

      <div class="sexp-empty-foot">
        <div class="sexp-empty-locked" title="${et('lockedHint')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span>${et('locked')}</span>
          <span class="sexp-empty-locked-tag">${et('lockedHint')}</span>
        </div>
        <button class="sexp-empty-learn" id="sexp-empty-learn" aria-expanded="false" aria-controls="sexp-empty-more">
          <span>${et('learn')}</span>
          <svg class="sexp-empty-learn-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>

      <div class="sexp-empty-more" id="sexp-empty-more">
        <div class="sexp-empty-more-inner">
          <div class="sexp-empty-list">
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',et('earnT'),et('earnS'))}
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',et('holT'),et('holS'))}
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',et('monthT'),et('monthS'))}
          </div>
          <div class="sexp-empty-formats">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
            <span>${et('formats')}</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  const firstM=months[0],lastM=months[months.length-1];
  function clamp(ym){return ym<firstM?firstM:ym>lastM?lastM:ym;}
  function threeAgo(){let y=now.getFullYear(),m=now.getMonth()-3;if(m<0){m+=12;y--;}return clamp(`${y}-${pad(m+1)}`);}
  function sixAgo(){let y=now.getFullYear(),m=now.getMonth()-6;if(m<0){m+=12;y--;}return clamp(`${y}-${pad(m+1)}`);}

  const mnames=t('mn');
  function optLabel(ym){const[y,m]=ym.split('-');return`${mnames[parseInt(m)-1]} ${y}`;}

  const totalEntries=Object.keys(logs).length;
  function fmtSize(kb){return kb>=1024?`${(kb/1024).toFixed(1)} MB`:`${Math.round(kb)} KB`;}

  const curLang=getLang();
  const savedFmt=localStorage.getItem('wt4_exp_format')||'csv';
  const csvActive=savedFmt==='csv';

  const defaultFrom=clamp(prevYM);
  const defaultTo  =clamp(prevYM);

  const allLangMeta=getReportLanguageOptions();
  const reportLangs=curLang==='ko'
    ?[{code:'ko',label:'한국어'}]
    :[allLangMeta.find(l=>l.code===curLang)||{code:'en',label:'English'},{code:'ko',label:'한국어'}];
  const defaultLang=reportLangs[0];

  const chevSVG=`<svg class="asm-sort-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const checkSVG=`<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const rangeDisplayLabel=defaultFrom===defaultTo?optLabel(defaultFrom):`${optLabel(defaultFrom)} – ${optLabel(defaultTo)}`;

  const thisYearFrom=`${now.getFullYear()}-01`;
  const thisYearTo  =`${now.getFullYear()}-12`;

  // Desktop preset pills
  const presets=[
    {label:t('exportPresetThisMonth'),from:clamp(curYM),  to:clamp(curYM)},
    {label:t('exportPresetLastMonth'),from:clamp(prevYM), to:clamp(prevYM)},
    {label:t('exportPresetLast3'),    from:threeAgo(),    to:clamp(prevYM)},
    {label:t('exportPresetAllTime'),  from:firstM,        to:lastM},
  ].filter((p,i,arr)=>arr.findIndex(x=>x.from+x.to===p.from+p.to)===i);

  const bsPresets=[
    {key:'thisMonth',label:t('exportPresetThisMonth'),from:clamp(curYM),       to:clamp(curYM)},
    {key:'lastMonth',label:t('exportPresetLastMonth'),from:clamp(prevYM),      to:clamp(prevYM)},
    {key:'last3',    label:t('exportPresetLast3'),    from:threeAgo(),          to:clamp(prevYM)},
    {key:'last6',    label:t('exportPresetLast6'),   from:sixAgo(),            to:clamp(prevYM)},
    {key:'thisYear', label:t('exportPresetThisYear'), from:clamp(thisYearFrom), to:clamp(thisYearTo)},
    {key:'allTime',  label:t('exportPresetAllTime'),  from:firstM,              to:lastM},
    {key:'custom',   label:t('expCustomRange'),       from:'',                  to:''},
  ];

  function presetSub(p){
    if(p.key==='allTime') return t('expPresetSubAllTime');
    if(p.key==='custom')  return t('expPresetSubCustom');
    if(p.from===p.to)     return optLabel(p.from);
    return`${optLabel(p.from)} – ${optLabel(p.to)}`;
  }

  function monthItems(selectedYM){
    return months.map(ym=>`<li class="asm-sort-opt sexp-month-opt${ym===selectedYM?' asm-sort-opt--active':''}" data-ym="${ym}">${optLabel(ym)}${ym===selectedYM?checkSVG:''}</li>`).join('');
  }

  const presetIcons={
    thisMonth:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    lastMonth:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    last3:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    last6:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    thisYear: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    allTime:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="4.93" y1="4.93" x2="9.17" y2="9.17"/><line x1="14.83" y1="14.83" x2="19.07" y2="19.07"/><line x1="14.83" y1="9.17" x2="19.07" y2="4.93"/><line x1="4.93" y1="19.07" x2="9.17" y2="14.83"/></svg>`,
    custom:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>`,
  };
  const presetColors={thisMonth:'#4977fd',lastMonth:'#4977fd',last3:'#22c55e',last6:'#22c55e',thisYear:'#f59e0b',allTime:'#22d3ee',custom:'#ef4444'};

  return`
    <div class="sexp-header">
      <div class="s3-eyebrow" style="margin-bottom:0;">
        <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>
        <span class="sexp-title">${t('exportTitle').toUpperCase()}</span>
      </div>
      <div class="sexp-privacy-badge">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        ${t('expPrivate')}
      </div>
    </div>

    <p class="sexp-desc">${t('exportSub')}</p>
    <div class="s3-hol-divider"></div>
    <div class="sexp-chips">
      <div class="sexp-chip">
        <div class="sexp-chip-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        </div>
        <div class="sexp-chip-body">
          <div class="sexp-chip-val" id="sexp-kpi-records">${totalEntries.toLocaleString()}</div>
          <div class="sexp-chip-lbl">${t('expStatRecords')||'Records'}</div>
        </div>
      </div>
      <div class="sexp-chip-divider"></div>
      <div class="sexp-chip">
        <div class="sexp-chip-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </div>
        <div class="sexp-chip-body">
          <div class="sexp-chip-val" id="sexp-kpi-months">1</div>
          <div class="sexp-chip-lbl" id="sexp-kpi-range">${t('expStatMonths')||'Months'}</div>
        </div>
      </div>
      <div class="sexp-chip-divider"></div>
      <div class="sexp-chip">
        <div class="sexp-chip-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="9" y2="17"/><line x1="15" y1="13" x2="15" y2="17"/><line x1="12" y1="13" x2="12" y2="17"/></svg>
        </div>
        <div class="sexp-chip-body">
          <div class="sexp-chip-val" id="sexp-kpi-size">—</div>
          <div class="sexp-chip-lbl" id="sexp-kpi-size-sub">${t('expStatSize')||'Est. size'}</div>
        </div>
      </div>
    </div>
    
    <div class="sexp-section-label">1. ${t('expSectionFormat')}</div>
    <div class="sexp-btns">
      <button class="sexp-tile sexp-tile--csv${csvActive?' sexp-tile--active':''}" id="exp-csv" data-format="csv">
        <div class="sexp-tile-icon sexp-tile-icon--csv">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        </div>
        <div class="sexp-tile-text">
          <div class="sexp-tile-label">${t('expCsvLabel')}</div>
          <div class="sexp-tile-sub">${t('expCsvSub')}</div>
        </div>
        <div class="sexp-tile-radio${csvActive?' sexp-tile-radio--on':''}" id="sexp-radio-csv"></div>
      </button>
      <button class="sexp-tile sexp-tile--pdf${!csvActive?' sexp-tile--active':''}" id="exp-pdf" data-format="pdf">
        <div class="sexp-tile-icon sexp-tile-icon--pdf">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M10 12v6"/><path d="M14 12v6"/><path d="M10 15h4"/></svg>
        </div>
        <div class="sexp-tile-text">
          <div class="sexp-tile-label">${t('expPdfLabel')}</div>
          <div class="sexp-tile-sub">${t('expPdfSub')}</div>
        </div>
        <div class="sexp-tile-radio${!csvActive?' sexp-tile-radio--on':''}" id="sexp-radio-pdf"></div>
      </button>
    </div>

    <div class="sexp-section-label">2. ${t('expSectionInclude')}</div>
    <div class="sexp-pill-row">
      <button class="sexp-pill sexp-pill--on" id="sexp-opt-hol" data-opt="hol">
        <svg class="sexp-pill-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        ${t('expIncHol')}
      </button>
      <button class="sexp-pill sexp-pill--on" id="sexp-opt-earn" data-opt="earn">
        <svg class="sexp-pill-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        ${t('expIncEarn')}
      </button>
      <button class="sexp-pill sexp-pill--on" id="sexp-opt-monthly" data-opt="monthly">
        <svg class="sexp-pill-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        ${t('expIncMonthly')}
      </button>
      </button>
    </div>

    <div class="sexp-section-label">3. ${t('expSectionDateRange')}</div>
    <!-- DESKTOP: two-dropdown layout (hidden on mobile) -->
    <div class="sexp-range-control sexp-desktop-only">
      <div class="sexp-range-left">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-muted);"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <div class="sexp-range-selects">
          <div class="asm-sort-dropdown sexp-month-drop" id="sexp-from-wrap">
            <button class="asm-sort-trigger sexp-month-trigger" id="sexp-from-trigger" aria-haspopup="listbox" aria-expanded="false">
              <span class="asm-sort-value sexp-month-val" id="sexp-from-val">${optLabel(defaultFrom)}</span>
              ${chevSVG}
            </button>
            <ul class="asm-sort-menu sexp-month-menu" id="sexp-from-menu" role="listbox" data-role="from">
              ${monthItems(defaultFrom)}
            </ul>
          </div>
          <span class="sexp-range-dash">–</span>
          <div class="asm-sort-dropdown sexp-month-drop" id="sexp-to-wrap">
            <button class="asm-sort-trigger sexp-month-trigger" id="sexp-to-trigger" aria-haspopup="listbox" aria-expanded="false">
              <span class="asm-sort-value sexp-month-val" id="sexp-to-val">${optLabel(defaultTo)}</span>
              ${chevSVG}
            </button>
            <ul class="asm-sort-menu sexp-month-menu" id="sexp-to-menu" role="listbox" data-role="to">
              ${monthItems(defaultTo)}
            </ul>
          </div>
        </div>
      </div>
      <div class="sexp-range-divider"></div>
      <div class="sexp-range-right">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-muted);"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <div class="asm-sort-dropdown sexp-lang-drop" id="sexp-lang-wrap">
          <button class="asm-sort-trigger sexp-lang-trigger" id="sexp-lang-trigger" aria-haspopup="listbox" aria-expanded="false">
            <span class="asm-sort-value sexp-lang-val" id="sexp-lang-val">${defaultLang.label}</span>
            ${chevSVG}
          </button>
          <ul class="asm-sort-menu sexp-lang-menu" id="sexp-lang-menu" role="listbox">
            ${reportLangs.map(l=>`<li class="asm-sort-opt sexp-lang-opt${l.code===defaultLang.code?' asm-sort-opt--active':''}" data-lang="${l.code}">${l.label}${l.code===defaultLang.code?checkSVG:''}</li>`).join('')}
          </ul>
        </div>
      </div>
    </div>
    <!-- preset row (desktop only) -->
    <div class="exp-preset-row sexp-desktop-only" style="margin-top:8px;flex-wrap:wrap;gap:6px;">
      ${presets.map((p,i)=>`<button class="exp-preset${i===1?' exp-preset--active':''}" data-from="${p.from}" data-to="${p.to}">${p.label}</button>`).join('')}
    </div>

    <!-- MOBILE: single date range field + bottom sheet (hidden on desktop) -->
    <div class="sexp-dr-row sexp-mobile-only">
      <button class="sexp-dr-field" id="sexp-dr-trigger" aria-label="Select date range">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="sexp-dr-cal-icon"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span class="sexp-dr-label" id="sexp-dr-label">${rangeDisplayLabel}</span>
        ${chevSVG}
      </button>
      <div class="asm-sort-dropdown sexp-lang-drop sexp-dr-lang" id="sexp-lang-wrap-mob">
        <button class="asm-sort-trigger sexp-lang-trigger sexp-dr-lang-trigger" id="sexp-lang-trigger-mob" aria-haspopup="listbox" aria-expanded="false">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-muted);"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span class="asm-sort-value sexp-lang-val" id="sexp-lang-val-mob">${defaultLang.label}</span>
          ${chevSVG}
        </button>
        <ul class="asm-sort-menu sexp-lang-menu" id="sexp-lang-menu-mob" role="listbox">
          ${reportLangs.map(l=>`<li class="asm-sort-opt sexp-lang-opt-mob${l.code===defaultLang.code?' asm-sort-opt--active':''}" data-lang="${l.code}">${l.label}${l.code===defaultLang.code?checkSVG:''}</li>`).join('')}
        </ul>
      </div>
    </div>
    <!-- ── Bottom-sheet: date range picker (mobile) ── -->
    <div class="sexp-bs-overlay" id="sexp-bs-overlay" hidden>
      <div class="sexp-bs-backdrop" id="sexp-bs-backdrop"></div>
      <div class="sexp-bs" id="sexp-bs">
        <div class="sexp-bs-handle"></div>
        <!-- VIEW 1: Preset list -->
        <div class="sexp-bs-view" id="sexp-bs-view-presets">
          <div class="sexp-bs-header">
            <span class="sexp-bs-title">${t('expBsSelectRange')}</span>
            <button class="sexp-bs-close" id="sexp-bs-close" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="sexp-bs-presets">
            ${bsPresets.map(p=>`
            <button class="sexp-bs-preset${p.key==='lastMonth'?' sexp-bs-preset--active':''}" data-key="${p.key}" data-from="${p.from}" data-to="${p.to}">
              <div class="sexp-bs-preset-icon" style="--preset-color:${presetColors[p.key]||'#4977fd'}">
                ${presetIcons[p.key]||presetIcons.custom}
              </div>
              <div class="sexp-bs-preset-text">
                <span class="sexp-bs-preset-label">${p.label}</span>
                <span class="sexp-bs-preset-sub">${presetSub(p)}</span>
              </div>
              ${p.key==='custom'?`<svg class="sexp-bs-preset-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`:''}
            </button>`).join('')}
          </div>
        </div>
        <!-- VIEW 2: Custom range -->
        <div class="sexp-bs-view sexp-bs-view--hidden" id="sexp-bs-view-custom">
          <div class="sexp-bs-header">
            <button class="sexp-bs-back" id="sexp-bs-back" aria-label="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span class="sexp-bs-title">${t('expBsCustomRange')}</span>
            <button class="sexp-bs-close sexp-bs-close--custom" id="sexp-bs-close2" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="sexp-bs-custom-dates">
            <div class="sexp-bs-date-field" id="sexp-cust-from-field">
              <span class="sexp-bs-date-lbl">${t('expBsStartDate')}</span>
              <div class="sexp-bs-date-val-row">
                <span class="sexp-bs-date-val" id="sexp-cust-from-val">${optLabel(defaultFrom)}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </div>
            </div>
            <span class="sexp-bs-date-dash">–</span>
            <div class="sexp-bs-date-field sexp-bs-date-field--end" id="sexp-cust-to-field">
              <span class="sexp-bs-date-lbl">${t('expBsEndDate')}</span>
              <div class="sexp-bs-date-val-row">
                <span class="sexp-bs-date-val" id="sexp-cust-to-val">${optLabel(defaultTo)}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </div>
            </div>
          </div>
          <div class="sexp-bs-custom-lists">
            <div class="sexp-bs-custom-col">
              <div class="sexp-bs-custom-col-label">${t('exportFrom')}</div>
              <ul class="sexp-bs-month-list" id="sexp-cust-from-list" data-role="from">
                ${monthItems(defaultFrom)}
              </ul>
            </div>
            <div class="sexp-bs-custom-col">
              <div class="sexp-bs-custom-col-label">${t('exportTo')}</div>
              <ul class="sexp-bs-month-list" id="sexp-cust-to-list" data-role="to">
                ${monthItems(defaultTo)}
              </ul>
            </div>
          </div>
          <div class="sexp-bs-custom-actions">
            <button class="sexp-bs-apply" id="sexp-bs-apply">${t('expBsApply')}</button>
            <button class="sexp-bs-clear" id="sexp-bs-clear">${t('expBsClear')}</button>
          </div>
        </div>
      </div>
    </div>

    <div id="exp-range-err" style="display:none;font-size:11px;color:var(--danger);margin-top:6px;">${t('exportRangeErr')}</div>
    <div class="s3-hol-divider sexp-export-divider"></div>
    <button class="sexp-export-btn" id="sexp-do-export">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      ${t('expExportBtn')}
    </button>
    <div class="sexp-security-note">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      ${t('expSecNote')}
    </div>`;
}
function getLang(){return S?.lang||localStorage.getItem('wt4_lang')||'en';}
function getReportLanguageOptions(){
  return[{code:'en',label:'English'},{code:'ko',label:'한국어'},{code:'id',label:'Indonesia'},{code:'th',label:'ภาษาไทย'},{code:'ru',label:'Русский'},{code:'zh',label:'中文'},{code:'fr',label:'Français'},{code:'ne',label:'नेपाली'}];
}

// ── Modal ─────────────────────────────────────────────────────────────────────
// Fully self-contained: no render() calls. All DOM updates happen in-place.
// State is kept in a local `ms` object attached to the overlay element.

// ── Wage modal (add / edit / delete) ─────────────────────────────────────────

// ── Workplace modal (Settings → Edit workplace) ──────────────────────────────
// A premium configuration panel: pinned glass header + footer with the shared
// workplace form scrolling between them, over the app's standard blurred
// backdrop. Settings underneath never re-renders or shifts while it's open.
// Fixed-day users (every shift anchor is 'day') get the day-pattern form:
// no night question, no night panel, day-relevant preview probes.
function storedPatternIsFixedDay(){
  // Mirrors shiftFor()'s fixed-mode rule for the current week: the two most
  // recent anchors share a value → fixed pattern. A single anchor is rotation
  // parity (its value alone says nothing about the pattern).
  return recentAnchorsFixedDay(ld('wt4_shifts',{}), getMonday(today()));
}


// ── Reset all data modal ─────────────────────────────────────────────────────
// Destructive action: clears all wt4_* localStorage keys (app data + settings),
// optionally deletes the user's Firestore document, then reloads so onboarding
// runs fresh. Requires typing a confirmation word to enable the final button.



// ── Listeners ─────────────────────────────────────────────────────────────────
// _headerBound guards listeners on nodes that survive a tab switch (the header
// controls, portals, and document-level handlers). Those must bind exactly once
// per full render; otherwise switchTab()'s re-attach would stack duplicates.
let _headerBound=false;
function attachListeners(){
  // Render charts if overview tab is active (async, non-blocking).
  // initOverviewMotion() runs first: on a first-load entrance it paints every
  // animated number to its zero state synchronously (before the browser paints
  // the freshly injected DOM, so finals never flash) and arms an
  // IntersectionObserver that reveals each card as it scrolls into view.
  if(S.tab==='overview'){ initOverviewMotion(); renderTrendChart(); renderMonthBarChart(); wireOverviewEmpty(); }
  updateHolSeps();

  // Animate the net-pay hero (amount count-up + ring sweep + % count), but only
  // on a full render — NOT on tab switches. switchTab() calls attachListeners()
  // too, and the hero (in the always-present header) survives that swap, so
  // replaying here would re-animate it on every tab change. _tabSwitching is set
  // by switchTab() for exactly this window.
  if(!_tabSwitching) requestAnimationFrame(animateStatsHero);

  // Desktop glass-card tilt/glare — idempotent (data-tilt-bound guard), so safe
  // on both full renders and tab switches.
  initCardTilt();

  // Place the sliding tab indicator. On a fresh render, snap it under the active
  // tab without animating. Skip during an animated tab switch (switchTab already
  // kicked off the slide) so we don't snap-override it.
  requestAnimationFrame(()=>{ if(!_tabSwitching) positionTabUnderline(false); });
  // Reposition on viewport changes (labels can wrap/reflow) — attach once.
  if(!window._tabUnderlineResizeBound){
    window._tabUnderlineResizeBound=true;
    let rt=0;
    window.addEventListener('resize',()=>{
      clearTimeout(rt);
      rt=setTimeout(()=>positionTabUnderline(false),120);
    });
  }
  // Re-measure once web fonts finish loading — attach once. The first placement
  // above runs before Inter swaps in, so the cells reflow slightly afterward and
  // the bar would otherwise keep its pre-font (narrower) width. Snap it to the
  // settled full-cell width once fonts are ready.
  if(!window._tabUnderlineFontsBound && document.fonts && document.fonts.ready){
    window._tabUnderlineFontsBound=true;
    document.fonts.ready.then(()=>{ if(!_tabSwitching) positionTabUnderline(false); });
  }

  // Chart range toggle — update state and re-render chart in-place (no full render)
  document.querySelectorAll('.ov-range-btn').forEach(btn=>btn.addEventListener('click',()=>{
    S.chartRange=btn.dataset.range;
    document.querySelectorAll('.ov-range-btn').forEach(b=>b.classList.toggle('ov-range-btn--active',b===btn));
    renderTrendChart();
  }));

  // ── All Shifts modal trigger ─────────────────────────────────────────────────
  const rsViewAll = document.getElementById('rs-view-all');
  if(rsViewAll) rsViewAll.addEventListener('click', e => {
    e.stopPropagation();
    buildAllShiftsModal(modalCtx());
  });

  // Calendar tab listeners (month nav, week flips, day cells, quick-log).
  if(S.tab==='calendar') wireCalendar(calendarCtx());

  // ── Header + portal + document-level listeners: bind once per full render ─────
  if(!_headerBound){
    _headerBound=true;
    attachHeaderListeners();
  }

  // Content-scoped listeners that live inside the swappable region — these must
  // re-bind on every tab switch because their nodes are recreated.
  attachContentListeners();
}

// Header controls, auth, portals, and the outside-click closer. Nodes here
// persist across tab switches, so this runs only once per full render.
function attachHeaderListeners(){
  document.getElementById('theme-toggle').addEventListener('click',()=>{
    S.theme=S.theme==='dark'?'light':'dark';sv('wt4_theme',S.theme);scheduleSync();render();
  });
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{
    if(b.dataset.tab===S.tab)return;      // already active — do nothing
    switchTab(b.dataset.tab);
  }));

  // ── Auth ────────────────────────────────────────────────────────────────────
  const loginBtn=document.getElementById('auth-login');
  if(loginBtn)loginBtn.addEventListener('click',()=>signInWithGoogle());
  const logoutBtn=document.getElementById('auth-logout');
  if(logoutBtn)logoutBtn.addEventListener('click',()=>signOutUser());

  // ── Portal dropdown system ────────────────────────────────────────────────────
  // Dropdowns are appended directly to <body> so they are never clipped by
  // backdrop-filter or overflow:hidden on ancestor elements (like .hdr, .card).
  document.querySelectorAll('.portal-dropdown').forEach(el=>el.remove());

  function createPortalDropdown(id, html){
    const el=document.createElement('div');
    el.id=id;
    el.className='hdr-dropdown portal-dropdown';
    el.innerHTML=html;
    document.body.appendChild(el);
    return el;
  }

  function positionDropdown(menu, trigger){
    const r=trigger.getBoundingClientRect();
    menu.style.position='fixed';
    menu.style.top=(r.bottom+6)+'px';
    // Align right edge of menu to right edge of trigger
    const menuW=menu.offsetWidth||200;
    let left=r.right-menuW;
    if(left<8)left=8; // don't go off-screen left
    menu.style.left=left+'px';
    menu.style.right='auto';
  }

  function closeAllPortals(){
    document.querySelectorAll('.portal-dropdown').forEach(m=>m.classList.remove('open'));
  }

  // ── Language portal ──────────────────────────────────────────────────────────
  const langBtn=document.getElementById('lang-btn');
  if(langBtn){
    const langPortal=createPortalDropdown('lang-menu',
      ['en','ko','id','th','ru','zh','fr','ne'].map(l=>{
        const names={en:'English',ko:'한국어',id:'Indonesia',th:'ภาษาไทย',ru:'Русский',zh:'中文',fr:'Français',ne:'नेपाली'};
        return `<button class="hdr-dropdown-item${S.lang===l?' hdr-dropdown-item--active':''}" data-lang="${l}">${flagImg(l,'flag-ico')}${names[l]}</button>`;
      }).join(''));
    // Wire language buttons inside portal
    langPortal.querySelectorAll('[data-lang]').forEach(b=>b.addEventListener('click',e=>{
      e.stopPropagation();
      S.lang=b.dataset.lang;sv('wt4_lang',S.lang);scheduleSync();
      closeAllPortals();
      render();
    }));
    langBtn.addEventListener('click',e=>{
      e.stopPropagation();
      const wasOpen=langPortal.classList.contains('open');
      closeAllPortals();
      if(!wasOpen){langPortal.classList.add('open');positionDropdown(langPortal,langBtn);}
    });
  }

  // ── Account portal ───────────────────────────────────────────────────────────
  const accountBtn=document.getElementById('account-btn');
  if(accountBtn&&CURRENT_USER){
    const accountPortal=createPortalDropdown('account-menu',
      `<div class="hdr-dropdown-user">
        <div class="hdr-dropdown-name">${CURRENT_USER.displayName||''}</div>
        <div class="hdr-dropdown-email">${CURRENT_USER.email||''}</div>
       </div>
       <div class="hdr-dropdown-divider"></div>
       <button class="hdr-dropdown-item hdr-dropdown-item--danger" id="auth-logout-portal">${t('signOut')}</button>`);
    accountPortal.querySelector('#auth-logout-portal')?.addEventListener('click',()=>signOutUser());
    accountBtn.addEventListener('click',e=>{
      e.stopPropagation();
      const wasOpen=accountPortal.classList.contains('open');
      closeAllPortals();
      if(!wasOpen){accountPortal.classList.add('open');positionDropdown(accountPortal,accountBtn);}
    });
  }

  // Close portals on outside click (document-level — bind once)
  document.addEventListener('click',closeAllPortals);
}

// Listeners for nodes inside #tab-content (recreated on every tab switch).
function attachContentListeners(){
  // Toggle fade mask on timeline scroll wrapper
  const swScroll=document.querySelector('.sw-timeline-scroll');
  if(swScroll){
    const checkFull=()=>swScroll.classList.toggle('sw-timeline-scroll--full',swScroll.scrollHeight<=swScroll.clientHeight+2);
    checkFull();
    swScroll.addEventListener('scroll',checkFull,{passive:true});
  }

  // Show wage add modal
  const showWageAddBtn=document.getElementById('show-wage-add-form');
  if(showWageAddBtn)showWageAddBtn.addEventListener('click',()=>{
    S.wageModal={mode:'add'};render();
  });

  // Three-dot menus on wage rows
  document.querySelectorAll('[data-wage-menu]').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const existing=document.querySelector('.sw-ctx-menu');
      if(existing){
        const wasThisBtn=existing.dataset.forBtn===btn.dataset.wageMenu;
        existing.remove();
        if(wasThisBtn)return;
      }
      const idx=parseInt(btn.dataset.wageMenu);
      const wages=getWages();
      const isFirst=idx===0;
      const menu=document.createElement('div');
      menu.className='sw-ctx-menu';
      menu.dataset.forBtn=btn.dataset.wageMenu;
      menu.innerHTML=`<button class="sw-ctx-item" id="wctx-edit">${t('edit')}</button>${!isFirst?`<button class="sw-ctx-item sw-ctx-item--danger" id="wctx-del">${t('del')}</button>`:''}`;
      document.body.appendChild(menu);
      requestAnimationFrame(()=>{
        const btnR=btn.getBoundingClientRect();
        const menuW=130;
        const menuH=menu.getBoundingClientRect().height;
        const spaceBelow=window.innerHeight-btnR.bottom;
        const top=spaceBelow>=menuH+6?btnR.bottom+4:btnR.top-menuH-4;
        const left=Math.min(btnR.right-menuW,window.innerWidth-menuW-8);
        menu.style.top=top+'px';
        menu.style.left=Math.max(8,left)+'px';
      });
      const editBtn=document.getElementById('wctx-edit');
      const delBtn=document.getElementById('wctx-del');
      if(editBtn)editBtn.addEventListener('click',e2=>{
        e2.stopPropagation();
        menu.remove();
        S.wageModal={mode:'edit',idx};render();
      });
      if(delBtn)delBtn.addEventListener('click',e2=>{
        e2.stopPropagation();
        menu.remove();
        S.wageModal={mode:'delete',idx};render();
      });
      setTimeout(()=>document.addEventListener('click',()=>menu.remove(),{once:true}),0);
    });
  });

  // ── Wage Calc Rules — collapse/expand ───────────────────────────────────────
  // Toggle locally (animate height) without a full render(); persist the choice.
  (function(){
    const card=document.querySelector('.s3-card--rules');
    const header=document.getElementById('sr-header');
    const btn=document.getElementById('sr-collapse-btn');
    const list=document.getElementById('sr-list');
    if(!card||!header||!list)return;

    function setExpanded(state){ // state: true=expanded
      header.setAttribute('aria-expanded',String(state));
      btn?.setAttribute('aria-expanded',String(state));
    }

    function toggle(){
      const willCollapse=!card.classList.contains('s3-card--rules-collapsed');
      // Animate from explicit pixel height so the transition has something to tween.
      const full=list.scrollHeight;
      if(willCollapse){
        list.style.height=full+'px';
        // force reflow so the browser registers the starting height
        void list.offsetHeight;
        card.classList.add('s3-card--rules-collapsed');
        list.style.height='0px';
      }else{
        card.classList.remove('s3-card--rules-collapsed');
        list.style.height='0px';
        void list.offsetHeight;
        list.style.height=full+'px';
        // After the open animation, clear the inline height so the list can
        // reflow naturally (e.g. on language change or window resize).
        list.addEventListener('transitionend',function clear(e){
          if(e.propertyName!=='height')return;
          list.style.height='';
          list.removeEventListener('transitionend',clear);
        });
      }
      S.rulesCollapsed=willCollapse;
      sv('wt4_rules_collapsed',willCollapse);
      scheduleSync();
      setExpanded(!willCollapse);
    }

    // If the card mounted already collapsed, lock the list height to 0.
    if(card.classList.contains('s3-card--rules-collapsed')) list.style.height='0px';

    btn?.addEventListener('click',e=>{e.stopPropagation();toggle();});
    header.addEventListener('click',toggle);

    // Phase 6: "Edit workplace" opens the workplace configuration modal —
    // no inline expansion, no page reflow underneath.
    const editBtn=card.querySelector('#pr-edit-btn');
    if(editBtn) editBtn.addEventListener('click',e=>{
      e.stopPropagation();
      buildWorkplaceModal(wpShareCtx());
    });
    // Phase 6.3: share/import this workplace by code.
    const shareBtn=card.querySelector('#pr-share-btn');
    if(shareBtn) shareBtn.addEventListener('click',e=>{
      e.stopPropagation();
      buildShareModal(wpShareCtx());
    });
    const importBtn=card.querySelector('#pr-import-btn');
    if(importBtn) importBtn.addEventListener('click',e=>{
      e.stopPropagation();
      buildImportModal(wpShareCtx());
    });
    header.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}
    });
  })();

  // Tax rate save
  // Animate tax ring arc smoothly given a 0-45 value
  function animateRing(pct,idBase){
    const arc=document.getElementById(idBase+'-arc');
    const txt=document.getElementById(idBase+'-txt');
    if(!arc)return;
    const TR_R=48;
    const circ=2*Math.PI*TR_R;
    const dash=Math.round((Math.min(pct,100)/100)*circ);
    arc.setAttribute('stroke-dasharray',dash+' '+(circ-dash));
    arc.setAttribute('stroke-dashoffset', circ*0.25);
    if(txt)txt.textContent=(Math.round(pct*100)/100)+'%';
  }
  // Back-compat: the tax card's ring keeps its original driver name.
  function animateTaxRing(pct){ animateRing(pct,'tax-ring'); }

  // Preview only — updates the ring + active pill highlight, does NOT persist.
  // Used while the user is still choosing a rate (typing or clicking a preset).
  function previewTaxRate(v){
    animateTaxRing(v);
    document.querySelectorAll('[data-tax-preset]').forEach(b=>{
      b.classList.toggle('s3-pill--active', Math.abs(parseFloat(b.dataset.taxPreset)-v)<0.001);
    });
  }

  // Persists the rate. Only called when the user explicitly clicks Save.
  function applyTaxRate(v){
    v=Math.min(45,Math.max(0,parseFloat(v.toFixed(2))));
    previewTaxRate(v);
    // Persist
    S.taxRate=v;sv('wt4_tax_rate',v);scheduleSync();
  }

  // Save button — reads input and applies
  const saveTaxBtn=document.getElementById('save-tax-rate');
  if(saveTaxBtn)saveTaxBtn.addEventListener('click',()=>{
    const inp=document.getElementById('tax-rate-in');
    if(!inp)return;
    const v=parseFloat(inp.value);
    if(isNaN(v)||v<0||v>45)return;
    applyTaxRate(v);
    showSuccess('taxRate');
  });

  // Tax rate presets — preview on the ring only; nothing is saved until Save is clicked
  document.querySelectorAll('[data-tax-preset]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const v=parseFloat(btn.dataset.taxPreset);
      const inp=document.getElementById('tax-rate-in');
      if(inp)inp.value=v;
      previewTaxRate(v);
    });
  });
  // Custom input — preview on the ring only; nothing is saved until Save is clicked
  const taxInp=document.getElementById('tax-rate-in');
  if(taxInp){
    taxInp.addEventListener('input',()=>{
      const v=parseFloat(taxInp.value);
      if(isNaN(v)||v<0||v>45)return;
      previewTaxRate(v);
    });
  }

  // ── Deduction mode switch (Tax ↔ 4대 보험) ─────────────────────────────────
  // Recompute the live insurance total from the current input values.
  function insCareLive(){
    const health=parseFloat(document.getElementById('ins-health')?.value)||0;
    return health*(DEFAULT_INSURANCE.careOfHealth/100);
  }
  function insTotalLive(){
    const p=parseFloat(document.getElementById('ins-pension')?.value)||0;
    const h=parseFloat(document.getElementById('ins-health')?.value)||0;
    const e=parseFloat(document.getElementById('ins-employment')?.value)||0;
    return p+h+insCareLive()+e;
  }
  // Set each component's share bar. Width = component / total, so the four bars
  // visually encode relative magnitude at a glance (the reference's key idea).
  function setInsBars(pension,health,care,employment,total){
    const t100=total>0?total:1;
    const set=(id,val)=>{
      const el=document.getElementById(id);
      if(el)el.style.width=Math.max(0,Math.min(100,(val/t100)*100))+'%';
    };
    set('ins-bar-pension',pension);
    set('ins-bar-health',health);
    set('ins-bar-care',care);
    set('ins-bar-employment',employment);
  }
  function refreshInsPreview(){
    const p=parseFloat(document.getElementById('ins-pension')?.value)||0;
    const h=parseFloat(document.getElementById('ins-health')?.value)||0;
    const e=parseFloat(document.getElementById('ins-employment')?.value)||0;
    const care=insCareLive(), total=insTotalLive();
    const cv=document.getElementById('ins-care-val');
    const tv=document.getElementById('ins-total-val');
    if(cv)cv.textContent=Math.round(care*1000)/1000;
    if(tv)tv.textContent=(Math.round(total*100)/100)+'%';
    setInsBars(p,h,care,e,total);
  }

  // Activate exactly one deduction card (tax XOR insurance). The other card
  // stays visible but dimmed/disabled — mutual exclusivity is preserved because
  // wt4_deduction_mode remains the single source of truth read by deductionRate().
  function setDeductionMode(mode){
    sv('wt4_deduction_mode',mode);
    scheduleSync();
    const taxOn=mode==='tax', insOn=mode==='insurance';

    const taxCard=document.getElementById('ded-card-tax');
    const insCard=document.getElementById('ded-card-ins');
    taxCard?.classList.toggle('ded-card--active',taxOn);
    taxCard?.classList.toggle('ded-card--inactive',!taxOn);
    insCard?.classList.toggle('ded-card--active',insOn);
    insCard?.classList.toggle('ded-card--inactive',!insOn);

    // Update each card's selector pill (state + label)
    const pickTax=document.getElementById('ded-pick-tax');
    const pickIns=document.getElementById('ded-pick-insurance');
    if(pickTax){
      pickTax.classList.toggle('ded-pick--on',taxOn);
      pickTax.setAttribute('aria-checked',String(taxOn));
      const tx=pickTax.querySelector('.ded-pick-txt');
      if(tx)tx.textContent=taxOn?t('deductionActive'):t('deductionUse');
    }
    if(pickIns){
      pickIns.classList.toggle('ded-pick--on',insOn);
      pickIns.setAttribute('aria-checked',String(insOn));
      const ix=pickIns.querySelector('.ded-pick-txt');
      if(ix)ix.textContent=insOn?t('deductionActive'):t('deductionUse');
    }

    // Actually disable (not just visually dim) every input/button inside the
    // inactive card. pointer-events:none alone still leaves them focusable
    // and editable via keyboard (Tab + type, or Enter on a focused button),
    // so the real `disabled` attribute is required to make the inactive
    // card genuinely non-selectable/non-editable, not just grayed out.
    ['tax-rate-in','save-tax-rate'].forEach(id=>{
      const el=document.getElementById(id);
      if(el)el.disabled=!taxOn;
    });
    document.querySelectorAll('[data-tax-preset]').forEach(btn=>{btn.disabled=!taxOn;});
    ['ins-pension','ins-health','ins-employment','save-insurance'].forEach(id=>{
      const el=document.getElementById(id);
      if(el)el.disabled=!insOn;
    });
  }
  document.querySelectorAll('[data-ded-mode]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(getDeductionMode()===btn.dataset.dedMode)return; // already active — no-op
      setDeductionMode(btn.dataset.dedMode);
      // Refresh ONLY the stats hero so earnings reflect the new mode. A full
      // render() would rebuild the settings screen too, destroying the other
      // card's grayed-out CSS transition (and re-flashing its ring animation).
      // setDeductionMode() already updated both cards' active/inactive state.
      const hero=document.querySelector('.stats-hero');
      if(hero){
        const tmp=document.createElement('div');
        tmp.innerHTML=buildStats();
        const fresh=tmp.firstElementChild;
        if(fresh){ hero.replaceWith(fresh); requestAnimationFrame(animateStatsHero); }
      }
      // Refresh just the deduction row (last row) in the Wage Calculation
      // Rules card so it reflects Tax vs 4 Insurances instantly — no need to
      // rebuild the whole rules list or reload the page.
      const srList=document.getElementById('sr-list');
      const lastRow=srList?.querySelector('.sr-row:last-child');
      if(lastRow){
        const freshRules=rulesRows();
        const [dedType,dedRule]=freshRules[freshRules.length-1];
        const nameEl=lastRow.querySelector('.sr-name');
        const descEl=lastRow.querySelector('.sr-desc');
        if(nameEl)nameEl.textContent=dedType;
        if(descEl)descEl.textContent=dedRule;
      }
    });
  });

  // The inactive deduction card must appear grayed the instant the Settings tab
  // mounts — with no fade-in. The dim transitions are gated behind
  // `.ded-cards--armed` (see style.css); arm it two frames after mount so the
  // initial dimmed state paints un-transitioned, then later mode switches still
  // animate smoothly. Scoped to the deduction cards' shared ancestor.
  const dedHost=document.getElementById('ded-card-tax')?.parentElement;
  if(dedHost && !dedHost.classList.contains('ded-cards--armed')){
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      dedHost.classList.add('ded-cards--armed');
    }));
  }

  // Live-preview insurance total as the user edits any rate
  ['ins-pension','ins-health','ins-employment'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',refreshInsPreview);
  });
  // Paint the proportional bars on first render (they start at 0% in CSS, so
  // this triggers the fill animation from empty → each component's share).
  if(document.getElementById('ins-breakdown')||document.getElementById('ins-bar-pension')){
    requestAnimationFrame(refreshInsPreview);
  }

  // Save insurance rates
  const saveInsBtn=document.getElementById('save-insurance');
  if(saveInsBtn)saveInsBtn.addEventListener('click',()=>{
    const clamp=v=>Math.min(30,Math.max(0,parseFloat(v)||0));
    const payload={
      pension:    clamp(document.getElementById('ins-pension')?.value),
      health:     clamp(document.getElementById('ins-health')?.value),
      employment: clamp(document.getElementById('ins-employment')?.value),
      careOfHealth: DEFAULT_INSURANCE.careOfHealth, // derived ratio, not user-set
    };
    sv('wt4_insurance',payload);
    scheduleSync();
    showSuccess('insurance');
  });

  // ── Target hours ring animation (mirrors tax ring pattern) ──────────────────
  function animateTargetRing(newTgt){
    const arc=document.getElementById('tgt-ring-arc');
    const txt=document.getElementById('tgt-ring-txt');
    const sub=document.getElementById('tgt-ring-sub');
    const disp=document.getElementById('tgt-display-val');
    if(!arc)return;
    // Re-compute progress against the new target value (curHrs unchanged)
    const nowD2=new Date(),curY2=nowD2.getFullYear(),curMo2=nowD2.getMonth();
    const tStr2=today(),logs3=getLogs();
    let cHrs=0;
    const dInM3=new Date(curY2,curMo2+1,0).getDate();
    for(let d=1;d<=dInM3;d++){const ds=mkds(curY2,curMo2,d);if(ds>tStr2)break;cHrs+=autoEff(ds,logs3);}
    const TG_R2=46,TG_SW2=9;
    const circ2=2*Math.PI*TG_R2;
    const pct2=Math.min(100,Math.round((cHrs/newTgt)*100));
    const dash2=Math.round((pct2/100)*circ2);
    arc.setAttribute('stroke-dasharray',dash2+' '+(circ2-dash2));
    arc.setAttribute('stroke-dashoffset',circ2*0.25);
    if(txt)txt.textContent=pct2+'%';
    if(sub)sub.textContent=cHrs.toFixed(1)+' / '+newTgt+t('hoursUnit');
    if(disp){
      const label=newTgt+t('hoursUnit');
      const len=label.length;
      disp.style.fontSize=len<=4?'34px':len<=6?'26px':'20px';
      disp.textContent=label;
    }
  }
  function previewTargetHrs(v){
    animateTargetRing(v);
    document.querySelectorAll('[data-target-preset]').forEach(b=>{
      b.classList.toggle('s3-pill--active', parseInt(b.dataset.targetPreset)===v);
    });
  }
  // Target hours save
  const saveTargetBtn=document.getElementById('save-target-hrs');
  if(saveTargetBtn)saveTargetBtn.addEventListener('click',()=>{
    const inp=document.getElementById('target-hrs-in');
    if(!inp)return;
    let v=parseInt(inp.value);
    if(isNaN(v)||v<1)return;
    v=Math.min(500,Math.max(1,v));
    inp.value=v;
    previewTargetHrs(v);
    S.targetHrs=v;sv('wt4_target_hrs',v);scheduleSync();showSuccess('targetHrs');
  });
  // Target hours presets — preview ring immediately on click
  document.querySelectorAll('[data-target-preset]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const v=parseInt(btn.dataset.targetPreset);
      const inp=document.getElementById('target-hrs-in');
      if(inp)inp.value=v;
      previewTargetHrs(v);
    });
  });
  // Custom input — preview ring live as user types
  const targetInp=document.getElementById('target-hrs-in');
  if(targetInp)targetInp.addEventListener('input',()=>{
    const v=parseInt(targetInp.value);
    if(isNaN(v)||v<1||v>500)return;
    previewTargetHrs(v);
  });
  document.getElementById('hol-view-all-btn')?.addEventListener('click', () => {
    buildAllHolidaysModal({ t, holName, todayStr: today, holidays: HOLIDAYS, lang: S.lang });
  });
  const holOnBtn=document.getElementById('hol-auto-on');
  const holOffBtn=document.getElementById('hol-auto-off');

  // Animate the switch in place by flipping the class on the LIVE element so the
  // CSS knob-slide transition actually plays. Also update the status label live
  // so the text tracks the knob. The full render() (for hero stats) is deferred
  // by the caller until the slide finishes, so it doesn't recreate the knob
  // mid-animation and make it snap.
  const HOL_TOGGLE_MS=380; // clear of the knob slide (0.22s) and colour fades (0.3s)
  function smoothHolToggle(turnOn){
    const tog=document.querySelector('.s3-toggle');
    if(tog) tog.classList.toggle('s3-toggle--on',turnOn);
    // Top-of-card ON/OFF badge (colour transitions via CSS; text flips instantly)
    const ob=document.querySelector('.s3-hol-onbadge');
    if(ob){
      ob.classList.toggle('s3-hol-onbadge--on',turnOn);
      ob.classList.toggle('s3-hol-onbadge--off',!turnOn);
      const obTxt=ob.querySelector('span:not(.s3-hol-onbadge-dot)');
      if(obTxt) obTxt.textContent=turnOn?'ON':'OFF';
    }
    // Status row tint (green ↔ gray)
    const row=document.querySelector('.s3-hol-status-row');
    if(row) row.classList.toggle('s3-hol-status-row--off',!turnOn);
    // Check badge colour + icon cross-fade (check ↔ X handled by CSS)
    const badge=document.querySelector('.s3-hol-status-check');
    if(badge){
      badge.classList.toggle('s3-hol-status-check--on',turnOn);
      badge.classList.toggle('s3-hol-status-check--off',!turnOn);
    }
    // Status label (colour transitions via CSS)
    const lbl=document.querySelector('.s3-hol-enabled,.s3-hol-disabled');
    if(lbl){
      lbl.className=turnOn?'s3-hol-enabled':'s3-hol-disabled';
      lbl.textContent=turnOn?t('holStatusEnabled'):t('holStatusDisabled');
    }
    const sub=document.querySelector('.s3-hol-status-txt');
    if(sub) sub.textContent=turnOn?t('holStatusOnTxt'):t('holStatusOffTxt');
  }

  if(holOnBtn)holOnBtn.addEventListener('click',()=>{
    smoothHolToggle(true);                          // slide the knob now
    S.holAuto=true;sv('wt4_hol_auto',true);scheduleSync();
    showExportToast(t('holAutoSaved'));             // toast without an immediate re-render
    setTimeout(render,HOL_TOGGLE_MS);               // refresh stats after the slide
  });
  if(holOffBtn)holOffBtn.addEventListener('click',()=>{
    smoothHolToggle(false);                         // slide the knob now
    // Before turning holAuto off, bake any past auto-credited holidays into real
    // log entries so they don't silently disappear. Two cases:
    //
    // 1. No log entry at all — create one with holCreditOverride:true.
    // 2. Existing log entry but no explicit holCreditOverride (was stored without
    //    it because it matched the global default at save time, line 1376) — set
    //    holCreditOverride:true and recalculate so the credit is preserved.
    const logs = getLogs();
    const todayStr = today();
    let changed = false;
    Object.keys(HOLIDAYS).forEach(ds => {
      if(ds >= todayStr) return;                          // skip today and future
      const w = wageFor(ds);
      const sf = shiftFor(ds);
      if(!logs[ds]) {
        // Case 1: no entry — bake in as a pure holiday credit day.
        // Saturday holidays are never auto-credited (they follow the 50% Saturday
        // pay rule), so there's no phantom credit to preserve — skip them.
        if(isSat(ds)) return;
        const c = calcWage(ds, 0, 0, w, sf, true);
        logs[ds] = {regHrs:0, otHrs:0, hrs:0, gross:c.gross, net:c.net, eff:c.eff,
          holCreditOverride:true};
        changed = true;
      } else if(logs[ds].holCreditOverride === undefined) {
        // Case 2: entry exists but no explicit override — the credit was implied
        // by holAuto being ON, so bake it in now before the setting changes
        const l = logs[ds];
        const c = calcWage(ds, l.regHrs||0, l.otHrs||0, w, l.shiftOverride||sf, true);
        logs[ds] = {...l, holCreditOverride:true, gross:c.gross, net:c.net, eff:c.eff};
        changed = true;
      }
    });
    if(changed) saveLogs(logs);
    S.holAuto=false;sv('wt4_hol_auto',false);scheduleSync();
    showExportToast(t('holAutoSaved'));             // toast without an immediate re-render
    setTimeout(render,HOL_TOGGLE_MS);               // refresh stats after the slide
  });

  // Danger Zone — open reset confirmation modal
  const openResetBtn=document.getElementById('open-reset-modal');
  if(openResetBtn)openResetBtn.addEventListener('click',()=>{
    S.resetModal=true;render();
  });

  // Export card — wire premium UI with live summary, filtered export, persistence
  if(S.tab==='settings'){
    const card=document.getElementById('export-card');
    if(!card)return;

    // ── Empty state (no logged shifts yet) ───────────────────────────────────
    // The onboarding empty state has its own actions and none of the export
    // controls below, so wire it and bail before the populated-card refs.
    const emptyRoot=document.getElementById('sexp-empty');
    if(emptyRoot){
      document.getElementById('sexp-empty-start')?.addEventListener('click',()=>switchTab('calendar'));
      const learnBtn=document.getElementById('sexp-empty-learn');
      learnBtn?.addEventListener('click',()=>{
        const open=emptyRoot.classList.toggle('sexp-empty--open');
        learnBtn.setAttribute('aria-expanded',open?'true':'false');
      });
      return;
    }

    // ── Gather DOM refs ──────────────────────────────────────────────────────
    const csvTile   =document.getElementById('exp-csv');
    const pdfTile   =document.getElementById('exp-pdf');
    const radioCsv  =document.getElementById('sexp-radio-csv');
    const radioPdf  =document.getElementById('sexp-radio-pdf');
    const doExportBtn=document.getElementById('sexp-do-export');
    if(!doExportBtn)return;

    // ── Range state ───────────────────────────────────────────────────────────────────────────────────────
    const allMonths=expMonthsWithData();
    if(!allMonths.length)return;

    const now=new Date();
    const prevM=now.getMonth()===0?`${now.getFullYear()-1}-12`:`${now.getFullYear()}-${pad(now.getMonth())}`;
    function clampM(ym){return ym<allMonths[0]?allMonths[0]:ym>allMonths[allMonths.length-1]?allMonths[allMonths.length-1]:ym;}

    let _from=clampM(prevM);
    let _to  =clampM(prevM);
    let _lang=(()=>{
      const active=card.querySelector('.sexp-lang-opt.asm-sort-opt--active');
      return active?.dataset.lang||getLang();
    })();
    let _exporting=false;
    let _expFormat=localStorage.getItem('wt4_exp_format')||'csv';

    const mnames=t('mn');
    function ymLabel(ym){const[y,m]=ym.split('-');return`${mnames[parseInt(m)-1]} ${y}`;}

    // ── Update the main date range trigger label ──────────────────────────────────────
    function refreshDrLabel(){
      const el=card.querySelector('#sexp-dr-label');
      if(!el)return;
      el.textContent=_from===_to?ymLabel(_from):`${ymLabel(_from)} – ${ymLabel(_to)}`;
    }

    // ── Live summary chips refresh ─────────────────────────────────────────────────────────
    function fmtSz(kb){return kb>=1024?`${(kb/1024).toFixed(1)} MB`:`${Math.round(kb)} KB`;}

    function refreshExpSummary(){
      let rows=[];
      try{rows=buildRows(_from,_to);}catch(e){}
      const incHol    =card.querySelector('#sexp-opt-hol')?.classList.contains('sexp-pill--on')!==false;
      const incEarn   =card.querySelector('#sexp-opt-earn')?.classList.contains('sexp-pill--on')!==false;
      const incMonthly=card.querySelector('#sexp-opt-monthly')?.classList.contains('sexp-pill--on')!==false;
      let filtered=rows;
      if(!incHol) filtered=filtered.filter(r=>!(r.holiday&&r.autoCredit&&r.regHrs===0&&r.otHrs===0));
      const count=filtered.length;
      // CSV: measured ~0.074 KB/row base; earnings cols add ~3 extra fields ≈ 30% more
      const csvKB=Math.max(0.5,count*(incEarn?0.096:0.074));
      // PDF: measured ~520 KB/page at scale:2, JPEG 0.92
      // earnings cols widen the table slightly (~+10%), monthly grid adds ~0.5 pages worth
      const ROWS_PER_PDF_PAGE=28;
      const dataPages=Math.max(1,Math.ceil(count/ROWS_PER_PDF_PAGE));
      const perPageKB=incEarn?520:470;
      const monthlyKB=incMonthly?260:0; // monthly summary grid is roughly half a page
      const pdfKB=Math.max(200,(dataPages+1)*perPageKB+monthlyKB);
      const fromY=parseInt(_from.split('-')[0]),fromMo=parseInt(_from.split('-')[1]);
      const toY=parseInt(_to.split('-')[0]),toMo=parseInt(_to.split('-')[1]);
      const monthSpan=(toY-fromY)*12+(toMo-fromMo)+1;
      const elRec=card.querySelector('#sexp-kpi-records');
      const elMonths=card.querySelector('#sexp-kpi-months');
      const elSize=card.querySelector('#sexp-kpi-size');
      if(elRec)    elRec.textContent=count.toLocaleString();
      if(elMonths) elMonths.textContent=monthSpan;
      if(elSize)   elSize.textContent=fmtSz(_expFormat==='pdf'?pdfKB:csvKB);
      if(doExportBtn&&!_exporting) doExportBtn.disabled=count===0;
    }

    // ── Format toggle ──────────────────────────────────────────────────────────────────────────────
    function setFormat(fmt){
      _expFormat=fmt;
      localStorage.setItem('wt4_exp_format',fmt);
      csvTile?.classList.toggle('sexp-tile--active',fmt==='csv');
      pdfTile?.classList.toggle('sexp-tile--active',fmt==='pdf');
      if(radioCsv) radioCsv.classList.toggle('sexp-tile-radio--on',fmt==='csv');
      if(radioPdf) radioPdf.classList.toggle('sexp-tile-radio--on',fmt==='pdf');
      refreshExpSummary();
    }
    setFormat(_expFormat);
    csvTile?.addEventListener('click',()=>setFormat('csv'));
    pdfTile?.addEventListener('click',()=>setFormat('pdf'));

    // ── Pill toggles ──────────────────────────────────────────────────────────────────────────────
    card.querySelectorAll('.sexp-pill').forEach(btn=>{
      btn.addEventListener('click',()=>{btn.classList.toggle('sexp-pill--on');refreshExpSummary();});
    });

    // ── Range validation ──────────────────────────────────────────────────────────────────────────────
    const errEl=document.getElementById('exp-range-err');
    function validateRange(){
      const valid=_from<=_to;
      if(errEl) errEl.style.display=valid?'none':'block';
      return valid;
    }

    // ── Desktop: month dropdowns (from / to) ────────────────────────────────────────────────────────
    function refreshMonthDrop(role,ym){
      const valEl2=card.querySelector(`#sexp-${role}-val`);
      const menu2 =card.querySelector(`#sexp-${role}-menu`);
      if(!valEl2||!menu2)return;
      const checkSVGd=`<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      valEl2.textContent=ymLabel(ym);
      menu2.querySelectorAll('.sexp-month-opt').forEach(li=>{
        const isActive=li.dataset.ym===ym;
        li.classList.toggle('asm-sort-opt--active',isActive);
        const ex=li.querySelector('.asm-sort-check');
        if(isActive&&!ex) li.insertAdjacentHTML('beforeend',checkSVGd);
        if(!isActive&&ex) ex.remove();
      });
    }
    // ── Shared: close all desktop dropdowns ──────────────────────────────────────────────────────────────
    const _allDropIds=[
      {menu:'#sexp-from-menu', trigger:'#sexp-from-trigger'},
      {menu:'#sexp-to-menu',   trigger:'#sexp-to-trigger'},
      {menu:'#sexp-lang-menu', trigger:'#sexp-lang-trigger'},
    ];
    function closeAllDropdowns(){
      _allDropIds.forEach(({menu:mSel,trigger:tSel})=>{
        card.querySelector(mSel)?.classList.remove('asm-sort-menu--open');
        card.querySelector(tSel)?.setAttribute('aria-expanded','false');
      });
    }

        function wireMonthDrop(role){
      const trigger=card.querySelector(`#sexp-${role}-trigger`);
      const menu   =card.querySelector(`#sexp-${role}-menu`);
      if(!trigger||!menu)return;
      const otherRole=role==='from'?'to':'from';
      function close(){menu.classList.remove('asm-sort-menu--open');trigger.setAttribute('aria-expanded','false');}
      function closeOther(){
        const otherMenu=card.querySelector(`#sexp-${otherRole}-menu`);
        const otherTrigger=card.querySelector(`#sexp-${otherRole}-trigger`);
        otherMenu?.classList.remove('asm-sort-menu--open');
        otherTrigger?.setAttribute('aria-expanded','false');
      }
      function open() {closeAllDropdowns();menu.classList.add('asm-sort-menu--open');trigger.setAttribute('aria-expanded','true');}
      trigger.addEventListener('click',e=>{e.stopPropagation();menu.classList.contains('asm-sort-menu--open')?close():open();});
      menu.querySelectorAll('.sexp-month-opt').forEach(li=>{
        li.addEventListener('click',e=>{
          e.stopPropagation();
          const chosen=li.dataset.ym;
          close();
          if(role==='from'){_from=chosen;if(_from>_to){_to=_from;refreshMonthDrop('to',_to);}}
          else{_to=chosen;if(_to<_from){_from=_to;refreshMonthDrop('from',_from);}}
          refreshMonthDrop(role,chosen);
          card.querySelectorAll('.exp-preset').forEach(b=>b.classList.remove('exp-preset--active'));
          validateRange();refreshExpSummary();refreshDrLabel();
        });
      });
      document.addEventListener('click',()=>close());
    }
    wireMonthDrop('from');
    wireMonthDrop('to');

    // ── Desktop: preset pills ─────────────────────────────────────────────────────────────────────────────────
    card.querySelectorAll('.exp-preset').forEach(btn=>{
      btn.addEventListener('click',()=>{
        _from=btn.dataset.from;_to=btn.dataset.to;
        refreshMonthDrop('from',_from);refreshMonthDrop('to',_to);
        if(errEl) errEl.style.display='none';
        card.querySelectorAll('.exp-preset').forEach(b=>b.classList.remove('exp-preset--active'));
        btn.classList.add('exp-preset--active');
        refreshDrLabel();refreshExpSummary();
      });
    });

    // ── Language dropdown (desktop) ────────────────────────────────────────────────────────────────────────────
    function wireLangDrop(triggerId,menuId,valId,optClass){
      const trigger=card.querySelector(triggerId);
      const menu   =card.querySelector(menuId);
      const valEl  =card.querySelector(valId);
      if(!trigger||!menu)return;
      const checkSVG2=`<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      function close(){menu.classList.remove('asm-sort-menu--open');trigger.setAttribute('aria-expanded','false');}
      trigger.addEventListener('click',e=>{e.stopPropagation();menu.classList.contains('asm-sort-menu--open')?close():(closeAllDropdowns(),menu.classList.add('asm-sort-menu--open'),trigger.setAttribute('aria-expanded','true'));});
      document.addEventListener('click',()=>close());
      menu.querySelectorAll(optClass).forEach(li=>{
        li.addEventListener('click',e=>{
          e.stopPropagation();
          _lang=li.dataset.lang;
          if(valEl) valEl.textContent=li.textContent.trim().replace(/[✓✔]/g,'').trim();
          menu.querySelectorAll(optClass).forEach(o=>{
            const isActive=o.dataset.lang===_lang;
            o.classList.toggle('asm-sort-opt--active',isActive);
            const ex=o.querySelector('.asm-sort-check');
            if(isActive&&!ex) o.insertAdjacentHTML('beforeend',checkSVG2);
            if(!isActive&&ex) ex.remove();
          });
          close();
        });
      });
    }
    wireLangDrop('#sexp-lang-trigger','#sexp-lang-menu','#sexp-lang-val','.sexp-lang-opt');
    wireLangDrop('#sexp-lang-trigger-mob','#sexp-lang-menu-mob','#sexp-lang-val-mob','.sexp-lang-opt-mob');

    // ── Bottom-sheet wiring ─────────────────────────────────────────────────────────────────────────────
    // Move overlay to body so position:fixed covers the full viewport
    const staleOverlay=document.body.querySelector(':scope > #sexp-bs-overlay');
    if(staleOverlay) staleOverlay.remove();
    const bsOverlay=card.querySelector('#sexp-bs-overlay');
    if(bsOverlay) document.body.appendChild(bsOverlay);
    const bs       =document.getElementById('sexp-bs');
    const viewPresets=document.getElementById('sexp-bs-view-presets');
    const viewCustom =document.getElementById('sexp-bs-view-custom');
    let _custFrom=_from;
    let _custTo  =_to;

    function openBS(){
      if(!bsOverlay)return;
      bsOverlay.removeAttribute('hidden');
      requestAnimationFrame(()=>{requestAnimationFrame(()=>{
        bs?.classList.add('sexp-bs--open');
        bsOverlay?.classList.add('sexp-bs-overlay--open');
      });});
      document.body.style.overflow='hidden';
      showPresetView();
    }

    function closeBS(){
      bs?.classList.remove('sexp-bs--open');
      bsOverlay?.classList.remove('sexp-bs-overlay--open');
      document.body.style.overflow='';
      setTimeout(()=>bsOverlay?.setAttribute('hidden',''),300);
    }

    // ── Drag-to-dismiss on handle ───────────────────────────────────────────────────────────
    (function wireDragDismiss(){
      const handle=document.querySelector('.sexp-bs-handle');
      if(!handle||!bs)return;
      let startY=0, currentY=0, dragging=false;
      const DISMISS_THRESHOLD=80; // px down to trigger close

      function onStart(e){
        dragging=true;
        startY=e.touches?e.touches[0].clientY:e.clientY;
        currentY=0;
        // Disable transition while dragging so sheet follows finger exactly
        bs.style.transition='none';
      }

      function onMove(e){
        if(!dragging)return;
        e.preventDefault(); // prevent page scroll while dragging handle
        const y=(e.touches?e.touches[0].clientY:e.clientY)-startY;
        if(y<0)return; // don't allow dragging up
        currentY=y;
        bs.style.transform=`translateY(${y}px)`;
        // Fade backdrop proportionally
        const progress=Math.min(y/(bs.offsetHeight*0.5),1);
        const backdrop=document.getElementById('sexp-bs-backdrop');
        if(backdrop) backdrop.style.background=`rgba(0,0,0,${0.55*(1-progress)})`;
      }

      function onEnd(){
        if(!dragging)return;
        dragging=false;
        bs.style.transition=''; // restore CSS transition
        if(currentY>=DISMISS_THRESHOLD){
          // Snap closed
          bs.style.transform='';
          const backdrop=document.getElementById('sexp-bs-backdrop');
          if(backdrop) backdrop.style.background='';
          closeBS();
        }else{
          // Snap back open
          bs.style.transform='';
          const backdrop=document.getElementById('sexp-bs-backdrop');
          if(backdrop) backdrop.style.background='';
        }
      }

      handle.addEventListener('touchstart',onStart,{passive:false});
      document.addEventListener('touchmove',onMove,{passive:false});
      document.addEventListener('touchend',onEnd);
      // Mouse fallback for desktop testing
      handle.addEventListener('mousedown',onStart);
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onEnd);
    })();

    function showPresetView(){
      viewPresets?.classList.remove('sexp-bs-view--hidden');
      viewCustom?.classList.add('sexp-bs-view--hidden');
    }

    function showCustomView(){
      viewPresets?.classList.add('sexp-bs-view--hidden');
      viewCustom?.classList.remove('sexp-bs-view--hidden');
      _custFrom=_from;_custTo=_to;
      refreshCustomDates();refreshCustomLists();
    }

    function refreshCustomDates(){
      const fromEl=document.getElementById('sexp-cust-from-val');
      const toEl  =document.getElementById('sexp-cust-to-val');
      if(fromEl) fromEl.textContent=ymLabel(_custFrom);
      if(toEl)   toEl.textContent  =ymLabel(_custTo);
    }

    function refreshCustomLists(){
      const checkSVG=`<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      ['from','to'].forEach(role=>{
        const selYm=role==='from'?_custFrom:_custTo;
        const list=document.getElementById(`sexp-cust-${role}-list`);
        if(!list)return;
        list.querySelectorAll('.sexp-month-opt').forEach(li=>{
          const isActive=li.dataset.ym===selYm;
          li.classList.toggle('asm-sort-opt--active',isActive);
          const ex=li.querySelector('.asm-sort-check');
          if(isActive&&!ex) li.insertAdjacentHTML('beforeend',checkSVG);
          if(!isActive&&ex) ex.remove();
        });
        const activeEl=list.querySelector('.asm-sort-opt--active');
        if(activeEl) activeEl.scrollIntoView({block:'nearest'});
      });
    }

    card.querySelector('#sexp-dr-trigger')?.addEventListener('click',()=>openBS());
    document.getElementById('sexp-bs-close')?.addEventListener('click',()=>closeBS());
    document.getElementById('sexp-bs-close2')?.addEventListener('click',()=>closeBS());
    document.getElementById('sexp-bs-backdrop')?.addEventListener('click',()=>closeBS());
    document.getElementById('sexp-bs-back')?.addEventListener('click',()=>showPresetView());

    document.querySelectorAll('.sexp-bs-preset').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const key=btn.dataset.key;
        if(key==='custom'){showCustomView();return;}
        _from=btn.dataset.from;
        _to  =btn.dataset.to;
        document.querySelectorAll('.sexp-bs-preset').forEach(b=>b.classList.remove('sexp-bs-preset--active'));
        btn.classList.add('sexp-bs-preset--active');
        refreshDrLabel();validateRange();refreshExpSummary();
        setTimeout(()=>closeBS(),180);
      });
    });

    ['from','to'].forEach(role=>{
      const list=document.getElementById(`sexp-cust-${role}-list`);
      if(!list)return;
      list.querySelectorAll('.sexp-month-opt').forEach(li=>{
        li.addEventListener('click',()=>{
          const chosen=li.dataset.ym;
          if(role==='from'){_custFrom=chosen;if(_custFrom>_custTo)_custTo=_custFrom;}
          else{_custTo=chosen;if(_custTo<_custFrom)_custFrom=_custTo;}
          refreshCustomDates();refreshCustomLists();
        });
      });
    });

    document.getElementById('sexp-bs-apply')?.addEventListener('click',()=>{
      _from=_custFrom;_to=_custTo;
      document.querySelectorAll('.sexp-bs-preset').forEach(b=>b.classList.remove('sexp-bs-preset--active'));
      refreshDrLabel();validateRange();refreshExpSummary();closeBS();
    });

    document.getElementById('sexp-bs-clear')?.addEventListener('click',()=>{
      _custFrom=allMonths[0];_custTo=allMonths[allMonths.length-1];
      refreshCustomDates();refreshCustomLists();
    });

    // ── Error toast ─────────────────────────────────────────────────────────────────────────────────
    function showErrToast(msg){
      document.getElementById('exp-toast-err')?.remove();
      const el=document.createElement('div');
      el.id='exp-toast-err';
      el.style.cssText='position:fixed;bottom:24px;left:50%;transform:translate(-50%,12px);background:var(--danger-bg);border:1px solid var(--danger);color:var(--danger);padding:10px 16px;border-radius:12px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;z-index:9999;opacity:0;transition:opacity 0.2s,transform 0.2s;pointer-events:none;max-width:88vw;';
      el.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>${msg}</span>`;
      document.body.appendChild(el);
      requestAnimationFrame(()=>{el.style.opacity='1';el.style.transform='translate(-50%,0)';});
      setTimeout(()=>{el.style.opacity='0';setTimeout(()=>el.remove(),220);},3200);
    }

    // ── Unified export button ────────────────────────────────────────────────────────────────────────────
    const EXPORT_BTN_INNER=doExportBtn.innerHTML;
    doExportBtn.addEventListener('click',async()=>{
      if(_exporting)return;
      if(!validateRange())return;
      const opts={
        includeHol:     card.querySelector('#sexp-opt-hol')?.classList.contains('sexp-pill--on')!==false,
        includeEarnings:card.querySelector('#sexp-opt-earn')?.classList.contains('sexp-pill--on')!==false,
        includeMonthly: card.querySelector('#sexp-opt-monthly')?.classList.contains('sexp-pill--on')!==false,
      };
      if(_expFormat==='csv'){
        _exporting=true;doExportBtn.disabled=true;
        try{ exportCSV(_from,_to,opts); }
        catch(e){ console.warn('[export] CSV failed:',e); showErrToast(t('exportPDFError')||'Export failed. Please try again.'); }
        finally{ _exporting=false; doExportBtn.disabled=false; }
      }else{
        _exporting=true;doExportBtn.disabled=true;
        doExportBtn.innerHTML=`<svg class="exp-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-9-9"/></svg>${t('exportPDFGenerating')||'Generating PDF…'}`;
        try{ await exportPDF(_from,_to,_lang,opts); }
        catch(err){ console.warn('[export] PDF failed:',err); showErrToast(t('exportPDFError')||"Couldn't generate PDF. Check your connection and try again."); }
        finally{ _exporting=false; doExportBtn.disabled=false; doExportBtn.innerHTML=EXPORT_BTN_INNER; }
      }
    });

    // ── Initial render ──────────────────────────────────────────────────────────────────────────────────
    refreshMonthDrop('from',_from);
    refreshMonthDrop('to',_to);
    refreshDrLabel();
    refreshExpSummary();
  }
}

applyTheme();
// Seed cache into HOLIDAYS synchronously (already done above), then render.
// prefetchHolidays runs in the background and re-renders if new data arrives.

// ── Onboarding ────────────────────────────────────────────────────────────────
// Fullscreen first-run experience. Shown only to genuinely new users; existing
// users (any saved data) are auto-flagged as onboarded so they never see it.
//
// Flow (6 screens; the Night Schedule one is conditional):
//   1 Welcome   — brand hero, language, and a "restore from Google" fast path
//   2 Pattern   — rotation / fixed day / fixed night (+ inline "which week?")
//   3 Workplace — preset picker + pay-rule steppers under Customize (the WHAT)
//   4 Night     — shift times, premium window, breaks, live preview (the WHEN);
//                 skipped for day-only users and non-schedule-driven rules
//   5 Pay       — wage + tax + holiday auto-credit, with a live net-pay preview
//   6 Finish    — celebration, optional cloud backup, enter the app
//
// A returning user who restores on screen 1 jumps straight to screen 6 —
// zero setup questions. Their cloud pull already rehydrated localStorage.
initOnboarding(onboardingCtx());

// ── One-time migration: pin existing users to the Iljitech preset ──────────────
// The selectable preset system ships with this release. Before it, every user's
// pay math WAS the hardcoded factory rulebook — DEFAULT_PROFILE, id
// 'kr-factory-2shift', which is exactly the Iljitech preset (compile.js verifies
// the preset compiles to DEFAULT_PROFILE bit-for-bit). Grandfathered users have
// no explicit wt4_profile, so on opening the new "Edit pay rules" editor,
// rulesStateFromProfile() would fall back to WIZ_DEFAULT_RULES() and pre-select
// the kr-statutory-5plus default — visually wrong, and a save would silently
// switch their math off Iljitech. Pin the Iljitech preset explicitly so the
// editor reflects each existing user's actual (unchanged) rules.
//
// Runs once (guarded by wt4_mig_factory_default). Only existing users — those
// who already completed onboarding — are touched; a genuinely new user is still
// mid-flow (wt4_onboarding !== 'done') and chooses a preset in onboarding itself.
// Placed AFTER initOnboarding so grandfathered users are already flagged 'done',
// and BEFORE the startup render() below so the first paint uses the pinned profile.
(function pinIljitechForExistingUsers(){
  if(localStorage.getItem('wt4_mig_factory_default') === 'done') return;
  if(localStorage.getItem('wt4_onboarding') === 'done'){
    const p = ld('wt4_profile', null);
    const alreadyPinned = !!(p && p.source && p.source.kind === 'preset'
                             && p.source.presetId === 'kr-factory-2shift');
    if(!alreadyPinned){
      try{ sv('wt4_profile', wizardProfileFrom({ ...WIZ_DEFAULT_RULES(), preset:'kr-factory-2shift' }, null)); }
      catch(e){ console.warn('[mig] Iljitech-default pin failed — grandfathered rules apply', e); }
    }
  }
  localStorage.setItem('wt4_mig_factory_default', 'done');
})();

// Normal startup (only reached if onboarding is already done)
render();
prefetchHolidays();
startSyncTicker();
