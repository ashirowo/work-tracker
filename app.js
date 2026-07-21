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
import { showExportToast } from './export.js';
import { pad, mkds, pd, dowOf, isSun, isSat, getMonday } from './core/dates.js';
import { isZeroDay } from './domain/log-entries.js';
import { shiftForIn, applyAnchor, recentAnchorsFixedDay } from './domain/shift-pattern.js';
import { normalizeWages, wageForIn } from './domain/wage-history.js';
import { DEFAULT_INSURANCE, careRateOfGross as careRateOf, insuranceRate as insRateOf, applyDeductionRate } from './domain/deductions.js';
import { calcWageIn, liveGrossIn, autoEffIn, allWeekdaysLoggedIn, probeHoursIn, engineDayClassIn, baseEffForIn, bucketKeysIn, bucketForIn, bucketDeterministicEffIn } from './domain/earnings.js';
import { defaultLogForIn, buildQuickLogEntryIn } from './domain/quick-log.js';
import { createHolidayService, translateHolidayName, getUpcomingIn, upcomingHolCutoff } from './data/holidays.js';
import { wizT as wizTCore, WIZ_DEFAULT_RULES as WIZ_DEFAULT_RULES_Core,
         wizardAnswersFrom as wizardAnswersFromCore, wizardProfileFrom as wizardProfileFromCore,
         rulesStateFromProfile as rulesStateFromProfileCore } from './domain/wizard-core.js';
import { WZI, SHM_IC_CHECK, SHM_IC_SEARCH, ruleRowsHTML } from './ui/icons.js';
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
import { buildOverview, wireOverview } from './ui/views/overview.js';
import { buildSettings, wireSettings } from './ui/views/settings.js';

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
// The Overview view's surface (Phase 8d). `env` is APP_ENV — the earnings
// capability record domain/projections.js computes over.
function overviewCtx(){
  return { S, t, env:APP_ENV, today, getLogs, shiftFor, applyTax, liveGross,
           autoGross, appFooter, switchTab,
           openDayModal, openAllShifts: () => buildAllShiftsModal(modalCtx()) };
}
// The onboarding flow's surface (Phase 7f). openImportModal wraps the
// grandfathered-user join link so onboarding needn't know wpShareCtx.
function onboardingCtx(){
  return { S, render, ld, sv, today, prefetchHolidays, flagImg, DEFAULT_WAGE, DEFAULT_TAX,
           currentUser: () => CURRENT_USER,
           openImportModal: (prefill, opts) => buildImportModal(wpShareCtx(), prefill, opts) };
}
// The Settings view's surface (Phase 8e). Storage/state + app helpers pass as
// stable refs; modal opens route through ctx openers (no modal imports in the
// view). HOLIDAYS is the live app-owned map (mutated in place by the service).
function settingsCtx(){
  return { S, t, render, sv, scheduleSync, today,
           getWages, getLogs, saveLogs, wageFor, shiftFor, calcWage, autoEff,
           getTaxPct, isHolAuto, getWage,
           getDeductionMode, getInsurance, careRateOfGross, insuranceRate,
           rulesRows, getUpcomingHolidays, buildStats, wizT,
           HOLIDAYS, appFooter, showSuccess, switchTab,
           openWorkplace: () => buildWorkplaceModal(wpShareCtx()),
           openShare:     () => buildShareModal(wpShareCtx()),
           openImport:    () => buildImportModal(wpShareCtx()),
           openAllHolidays: () => buildAllHolidaysModal({ t, holName, todayStr: today, holidays: HOLIDAYS, lang: S.lang }) };
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
  return S.tab==='calendar'?buildCal(calendarCtx()):S.tab==='overview'?buildOverview(overviewCtx()):buildSettings(settingsCtx());
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

// ── Overview tab ─────────────────────────────────────────────────────────────
// The full Overview surface (live dashboard render, first-run empty state,
// count-up/entrance motion, both Chart.js renderers, and the tab's listeners)
// lives in ui/views/overview.js since Phase 8d; its math lives in
// domain/projections.js (Phase 8c). app.js supplies the surface via
// overviewCtx() and calls buildOverview()/wireOverview() from the shell.

// ── Settings tab → ui/views/settings.js (Phase 8e) ───────────────────────────
// buildSettings + buildExportCardInline + getLang + getReportLanguageOptions and
// the settings wiring (wireSettings) live in the view module; RULE_ICONS /
// ruleRowsHTML moved to ui/icons.js. app.js supplies the surface via
// settingsCtx() and calls buildSettings()/wireSettings() from the shell.

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
  // Overview tab: entrance/count-up motion, both charts, and the tab's
  // listeners (range toggle, view-all, empty-state CTA) — ui/views/overview.js.
  if(S.tab==='overview') wireOverview(overviewCtx());
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

  // Calendar tab listeners (month nav, week flips, day cells, quick-log).
  if(S.tab==='calendar') wireCalendar(calendarCtx());

  // ── Header + portal + document-level listeners: bind once per full render ─────
  if(!_headerBound){
    _headerBound=true;
    attachHeaderListeners();
  }

  // Settings-tab content listeners re-bind on every tab switch (their nodes are
  // recreated). Calendar/Overview wire above; only Settings needs it here.
  if(S.tab==='settings') wireSettings(settingsCtx());
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

// (Settings-tab content listeners live in ui/views/settings.js — wireSettings.)

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
