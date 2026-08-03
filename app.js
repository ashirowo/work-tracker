import { scheduleSync, deleteCloudData,
         createShare, deleteShare, listMyShares } from './firebase.js';
import { packShare, unpackShare, normalizeShareCode, formatShareCode } from './share.js';
import { TR, normLang } from './translations.js';
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
import { WZI, NAV, SHM_IC_CHECK, SHM_IC_SEARCH, ruleRowsHTML, flagImg } from './ui/icons.js';
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
import { initTabPager, pagerSwitch } from './ui/tab-pager.js';
import { buildCal, wireCalendar, updateHolSeps } from './ui/views/calendar.js';
import { buildOverview, wireOverview, dropOverview } from './ui/views/overview.js';
import { buildSettings, wireSettings } from './ui/views/settings.js';
import { initHeader, buildHeaderHTML, buildStats, attachHeaderListeners, updateSyncUI, updateOfflineBanner, startSyncTicker } from './ui/header.js';

// ── App signature footer ─────────────────────────────────────────────────────
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
// Expose to window so firebase.js (a separate ES module) can call these.
// ES modules have isolated scopes — window is the only shared global.
window._appBridge = { setCURRENT_USER, updateSyncUI, get render(){ return render; } };

// ── Dynamic Korean Public Holidays ───────────────────────────────────────────
// The fetch/cache/cooldown lifecycle lives in data/holidays.js. The
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

const DEFAULT_WAGE=10320,DEFAULT_TAX=3.3;

// ── Deductions ───────────────────────────────────────────────────────────────
// Two mutually-exclusive modes decide what's subtracted from gross pay:
//   'tax'       → a single flat withholding % (default; Korea's 3.3% freelancer
//                 withholding is the out-of-the-box value)
//   'insurance' → Korea's 4대 보험 employee-side contributions, summed
// Only ONE mode is ever active, so net = gross × (1 − activeRate) in both cases;
// only the source of activeRate differs. Mode defaults to 'tax' so existing
// users see zero change until they opt in.
//
// The rates, statutory defaults, and math live in domain/deductions.js;
// these adapters bind stored settings (the ins||getInsurance()
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
// today() stays HERE (not imported from core/dates.js): the golden oracle
// reassigns it to a pinned fixture date, which an imported binding cannot be.
function today(){const d=new Date();return mkds(d.getFullYear(),d.getMonth(),d.getDate());}
function getLogs(){return ld('wt4_logs',{});}
function saveLogs(l){sv('wt4_logs',l);scheduleSync();}
function defaultLogFor(dateStr){ return defaultLogForIn(APP_ENV, dateStr); }
function buildQuickLogEntry(dateStr){ return buildQuickLogEntryIn(APP_ENV, dateStr); }
function getShifts(){return ld('wt4_shifts',{});}
function saveShifts(s){sv('wt4_shifts',s);scheduleSync();}
// ── Wage history ──────────────────────────────────────────────────────────────
// Stored as wt4_wages: [{date:'YYYY-MM-DD', amount:number}, ...] sorted by date.
// wageFor(dateStr) returns the wage active on that date (most recent entry ≤ date).
// Migration: if the old scalar wt4_wage key is present, import it as the
// initial entry dated '2000-01-01' so all historical logs keep their value.
// Timeline resolution + both read-migrations live in domain/wage-history.js;
// this adapter persists when a migration dirtied the data.
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
// Two parallel maps from the gov API: HOL_KO_DYN holds the Korean name
// (localName — the source of truth for translation), HOLIDAYS the English name.
function holName(s){
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
// The inference algorithm lives in domain/shift-pattern.js.
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
// The calculator is profile-driven. getProfile() reads wt4_profile
// and falls back WHOLESALE to the default (today's rulebook) when absent or
// unrecognized — every existing user is grandfathered with zero change.
// wt4_profile does not sync yet; it joins SYNC_KEYS a release after the
// merge:true fix in firebase.js has rolled out (see that file).
function getProfile(){
  const p = ld('wt4_profile', null);
  return isUsableProfile(p) ? p : DEFAULT_PROFILE;
}
// The projection primitives live in domain/earnings.js —
// every number the Overview projections use comes from an engine probe of the
// ACTIVE profile, through these env-bound adapters.
function probeHours(){ return probeHoursIn(getProfile()); }
function engineDayClass(ds){ return engineDayClassIn(APP_ENV, ds); }
function baseEffFor(ds, sh){ return baseEffForIn(APP_ENV, ds, sh); }
function bucketKeys(){ return bucketKeysIn(getProfile()); }
function bucketFor(ds){ return bucketForIn(APP_ENV, ds); }
function bucketDeterministicEff(bucket){ return bucketDeterministicEffIn(APP_ENV, bucket); }

// The wizard's pure layer lives in domain/wizard-core.js; these adapters keep
// their names because the golden oracle slices declarations by name.
function wizT(lang,k){ return wizTCore(lang,k); }
function WIZ_DEFAULT_RULES(){ return WIZ_DEFAULT_RULES_Core(); }
function wizardAnswersFrom(rules){ return wizardAnswersFromCore(rules); }
function wizardProfileFrom(rules, pattern){ return wizardProfileFromCore(rules, pattern); }
function rulesStateFromProfile(profile){ return rulesStateFromProfileCore(profile); }

// The "Wage Calculation Rules" card is generated from the ACTIVE profile via
// engine probes — correct for any custom profile, not just the factory default.
function rulesRows(){
  return buildRulesRows(getProfile(), TR[S.lang].seg,
    { holAuto: isHolAuto(), dedPct: getActiveDeductionPct(), dedNoun: getDeductionNoun() });
}
// The app's capability record for the domain layer. Members are the
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
  // 'ko', not 'en' — the app's default language (see detectLang in
  // onboarding/onboarding.js). Reached only when no preference is stored yet.
  lang:normLang(ld('wt4_lang','ko')),theme:ld('wt4_theme','dark'),holAuto:ld('wt4_hol_auto',true),
  taxRate:ld('wt4_tax_rate',DEFAULT_TAX),
  targetHrs:ld('wt4_target_hrs',250),
  tab:'calendar',calY:new Date().getFullYear(),calM:new Date().getMonth(),
  modal:null,
  chartRange:'3m',   // '3m' | '6m' | '1y'
  wageModal:null,   // transient: {mode:'add'|'edit'|'delete', idx?:number} or null
  resetModal:false, // transient: whether the "Reset all data" confirmation modal is open
  rulesCollapsed:ld('wt4_rules_collapsed',false), // settings: Wage Calc Rules card collapsed?
};
// Write the clamped language back, so a code this build dropped is gone for
// good rather than re-clamped on every load. Without this the stale value
// survives in wt4_lang and pushToCloud keeps syncing it to every other device.
if(S.lang!==ld('wt4_lang',S.lang)) sv('wt4_lang',S.lang);
// S.lang is clamped above, so TR[S.lang] is always a real pack — the `|| TR.en`
// here covers the paths that reassign S.lang afterwards from storage the cloud
// has since rewritten (see completeRestored in onboarding). A missing pack must
// degrade to English strings; it must never throw, because t() runs before the
// first paint and taking it down takes down the whole app with it.
function t(k,...a){const fn=(TR[S.lang]||TR.en)[k];return typeof fn==='function'?fn(...a):(fn||k);}
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

// liveGross recomputes gross from stored hours and the wage active on that date,
// so wage-history edits reflect everywhere immediately; rules live in domain/earnings.js.
function liveGross(ds, logsArg){ return liveGrossIn(APP_ENV, ds, logsArg); }

// autoGross / autoEff: wrappers used throughout the render layer.
// autoGross delegates entirely to liveGross — one definition, no divergence.
function autoGross(ds, logsArg){
  return liveGross(ds, logsArg);
}
function autoEff(ds, logsArg){ return autoEffIn(APP_ENV, ds, logsArg); }

// Modal context — the app-owned surface the extracted modal modules receive
// (they can't import app.js). Stable refs pass directly; CURRENT_USER is
// reassigned, so it arrives as the currentUser() accessor.
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
// Rebuild ONLY the net-pay hero + mini stats. Every figure it shows is scoped
// to S.calY/S.calM, so month navigation has to refresh it — but a full render()
// would tear down the calendar card mid-transition, taking the animation and
// its listeners with it. Replacing this one block leaves the header glass, the
// tab row and the calendar untouched. animateStatsHero() then tweens from the
// numbers already on screen to the new month's (see _statsHeroPrev), so the
// figures travel with the grid rather than snapping when it lands.
function refreshStats(){
  const hero=document.querySelector('.stats-hero');
  if(!hero)return;
  const tmp=document.createElement('div');
  tmp.innerHTML=buildStats();
  const fresh=tmp.firstElementChild;
  if(!fresh)return;
  hero.replaceWith(fresh);
  requestAnimationFrame(animateStatsHero);
  initCardTilt();   // idempotent; the cards it was bound to are gone
}
// The Calendar view's surface.
function calendarCtx(){
  return { S, t, render, today, getLogs, saveLogs, getShifts, saveShifts, shiftFor,
           toggleShift, isHol, holName, isHolAuto, allWeekdaysLogged, defaultLogFor,
           buildQuickLogEntry, autoEff, ensureHolidays, HOLIDAYS,
           showUndoToast, openDayModal, refreshStats };
}
// The Overview view's surface. `env` is APP_ENV — the earnings
// capability record domain/projections.js computes over.
function overviewCtx(){
  return { S, t, env:APP_ENV, today, getLogs, shiftFor, applyTax, liveGross,
           autoGross, switchTab,
           openDayModal, openAllShifts: () => buildAllShiftsModal(modalCtx()) };
}
// The onboarding flow's surface. openImportModal wraps the
// grandfathered-user join link so onboarding needn't know wpShareCtx.
function onboardingCtx(){
  return { S, render, ld, sv, today, prefetchHolidays, flagImg, DEFAULT_WAGE, DEFAULT_TAX,
           currentUser: () => CURRENT_USER,
           openImportModal: (prefill, opts) => buildImportModal(wpShareCtx(), prefill, opts) };
}
// The Settings view's surface. Storage/state + app helpers pass as
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
// The header/stats surface. Bound ONCE at boot via initHeader — its
// sync helpers run outside the render cycle. All members are stable refs; the
// reassigned CURRENT_USER passes as the currentUser() accessor.
function headerCtx(){
  return { S, t, render, sv, switchTab, currentUser: () => CURRENT_USER,
           getLogs, autoGross, autoEff, applyTax, getActiveDeductionPct, getDeductionNoun };
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(){
  applyTheme();
  document.title = t('pageTitle');
  // Keep <html lang> honest. It was a static "en" that nothing ever updated, so
  // it mislabelled the page for seven of the eight locales — and making Korean
  // the default would only have moved which group it lied to. A screen reader
  // picks its pronunciation rules from this attribute, so it has to follow the
  // language actually on screen, exactly like the title above it.
  document.documentElement.lang = S.lang;
  // If a modal is open, don't rebuild #app — the modal is self-contained.
  // Rebuilding #app while a modal is open re-stacks event listeners and
  // causes the page to visually flash behind the overlay.
  const modalOpen = !!(S.modal || S.wageModal || S.resetModal || document.getElementById('all-shifts-ov'));
  if(!modalOpen){
    _headerBound=false;   // header nodes are about to be recreated
    // A full render outranks a swipe in flight: the pages it was moving are
    // about to leave the document, so the flag they would have cleared has to
    // be cleared here instead (initTabPager drops the rest of that state).
    _tabSwitching=false; _tuCells=null;
    document.getElementById('app').innerHTML=buildApp();
    attachListeners();
  }
  if(S.modal)buildModal(modalCtx());
  if(S.wageModal)buildWageModal(modalCtx());
  if(S.resetModal)buildResetModal(modalCtx());
  updateOfflineBanner();
}

// One cell of the tab row. The icon only shows below 540px, where the row is a
// floating bottom bar and the label alone would be too light to carry it; above
// that it's display:none and the row stays a text tab strip.
//
// aria-current (not aria-selected) because the row has no role="tablist": these
// read as the app's three top-level destinations, and switchTab() keeps the
// attribute in sync with the .on class.
function tabButton(id,key,icon){
  const on=S.tab===id;
  return `<button class="tab${on?' on':''}" data-tab="${id}"${on?' aria-current="page"':''}>`
    +`<span class="tab-ic" aria-hidden="true">${icon}</span>`
    +`<span class="tab-lb">${t(key)}</span></button>`;
}

function buildApp(){
  return`${buildHeaderHTML()}
  ${buildStats()}
  <div class="tab-row" id="tab-row">
    ${tabButton('calendar','tabCal',NAV.calendar)}
    ${tabButton('overview','tabOverview',NAV.overview)}
    ${tabButton('settings','tabSet',NAV.settings)}
    <span class="tab-underline" id="tab-underline" aria-hidden="true"></span>
  </div>
  <div id="tab-content" class="tabvp">
    <div class="tabvp-track" id="tab-track">
      <div class="tabpane" data-pane="${S.tab}">${buildTabContent(S.tab)}</div>
    </div>
  </div>`;
}

// The order the tabs sit in, and therefore which way each one is from any other
// — the bottom bar's reading order and the pager's geometry are the same fact.
const TAB_ORDER=['calendar','overview','settings'];

// One tab's content. Takes the tab explicitly rather than reading S.tab: the
// pager builds the page it is sliding IN while S.tab still names the one being
// left, and only commits the state change once that page has landed.
function buildTabContent(tab){
  return tab==='calendar'?buildCal(calendarCtx()):tab==='overview'?buildOverview(overviewCtx()):buildSettings(settingsCtx());
}

// Everything a freshly mounted tab needs to become live. Also takes the tab
// explicitly, for the same reason buildTabContent does — a staged page is wired
// the moment it is mounted, so what slides in is the real thing.
function wireTabContent(tab){
  if(tab==='overview') wireOverview(overviewCtx());
  else if(tab==='calendar') wireCalendar(calendarCtx());
  else wireSettings(settingsCtx());
  updateHolSeps();
  // Desktop glass-card tilt/glare — idempotent (data-tilt-bound guard).
  initCardTilt();
}

// The other half of buildTabContent: a page the pager staged for a swipe that
// was then put back, thrown away without ever having been shown. Only the
// Overview latches anything at build time (its one-per-session entrance), so
// only the Overview has anything to give back.
function dropTabContent(tab,el){
  if(tab==='overview') dropOverview(el);
}

// Paint the bar's active states. Called while a swipe is still in flight (at the
// half-way point) as well as on a tap, so it has to be idempotent.
//
// aria-current (not aria-selected) because the row has no role="tablist": these
// read as the app's three top-level destinations.
function setActiveTabButton(tab){
  document.querySelectorAll('.tab[data-tab]').forEach(b=>{
    const on=b.dataset.tab===tab;
    b.classList.toggle('on', on);
    if(on) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
  });
}

// Switch tabs WITHOUT rebuilding the header/stats. Only the page inside
// #tab-content is replaced, so the header's glass, glow, sync dot animation and
// portal listeners stay intact (no flicker, no re-mount). The pager owns the
// swap — on mobile it slides, everywhere else it cuts — and calls commitTab()
// back once the new page is in place.
function switchTab(tab){
  // Choosing the already-active tab must be a no-op: re-mounting identical
  // content would needlessly replay the Overview entrance choreography.
  if(S.tab===tab) return;
  _tabSwitching=true;
  // Only a missing region gets here; the pager handles every other case itself.
  if(!pagerSwitch(tab)){ S.tab=tab; _tabSwitching=false; render(); }
}

// The page has landed (or a swipe was put back, and `tab` is the one we never
// left). This is the single point where the app's idea of the current tab
// changes — nothing reads S.tab mid-flight and gets a half-finished answer.
function commitTab(tab){
  S.tab=tab;
  setActiveTabButton(tab);
  _tabSwitching=false;
}
let _tabSwitching=false;

// Measure one tab cell in the coordinates --tu-x/--tu-w are expressed in.
// getBoundingClientRect() reports the row's BORDER box, but the indicator is
// absolutely positioned and therefore placed from the row's PADDING box.
// clientLeft (the left border width) reconciles the two: 0 on the desktop row,
// which has no left border, and 1 on the mobile bar, which is fully bordered.
// Without it the bar sits a border-width off on mobile.
function tabCellMetrics(row,cell){
  const rowRect=row.getBoundingClientRect();
  const r=cell.getBoundingClientRect();
  return { x:Math.round((r.left-rowRect.left-row.clientLeft)*100)/100,
           w:Math.round(r.width*100)/100 };
}
function paintTabUnderline(bar,x,w){
  bar.style.setProperty('--tu-x', x+'px');
  bar.style.setProperty('--tu-w', w+'px');
  bar.style.setProperty('--tu-o', '1');
}

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
  const {x,w}=tabCellMetrics(row,active);
  // On first placement (or when explicitly non-animated), disable the transition
  // for one frame so the bar appears in position instead of sliding in from 0.
  if(!animate){
    const prevTransition=bar.style.transition;
    bar.style.transition='none';
    paintTabUnderline(bar,x,w);
    // force style flush, then restore the transition
    void bar.offsetWidth;
    bar.style.transition=prevTransition;
  }else{
    paintTabUnderline(bar,x,w);
  }
}

// Drive the pill straight from a swipe, so it crosses the bar in step with the
// pages rather than announcing where they are about to end up. .is-dragging
// takes the 0.46s spring off for the duration — a transition here would make the
// pill lag the finger by the whole length of the spring.
//
// The two cells are measured once per gesture and kept: they cannot move while
// the finger is down, and re-reading a rect after every transform write is a
// forced layout on the one frame budget that cannot afford it.
let _tuCells=null;
function dragTabUnderline(from,to,p){
  const row=document.getElementById('tab-row');
  const bar=document.getElementById('tab-underline');
  if(!row||!bar) return;
  if(!_tuCells){ row.classList.add('is-dragging'); _tuCells={}; }
  const cell=id=>_tuCells[id]||(()=>{
    const el=row.querySelector(`.tab[data-tab="${id}"]`);
    return el ? (_tuCells[id]=tabCellMetrics(row,el)) : null;
  })();
  const a=cell(from), b=cell(to)||a;
  if(!a) return;
  paintTabUnderline(bar, a.x+(b.x-a.x)*p, a.w+(b.w-a.w)*p);
}

// Hand the pill back its spring and let it finish the journey on its own — the
// same 0.46s slide a tap has always used, from wherever the finger left it.
function restTabUnderline(){
  _tuCells=null;
  document.getElementById('tab-row')?.classList.remove('is-dragging');
  positionTabUnderline(true);
}

function storedPatternIsFixedDay(){
  // Mirrors shiftFor()'s fixed-mode rule for the current week: the two most
  // recent anchors share a value → fixed pattern. A single anchor is rotation
  // parity (its value alone says nothing about the pattern).
  return recentAnchorsFixedDay(ld('wt4_shifts',{}), getMonday(today()));
}

// ── Listeners ─────────────────────────────────────────────────────────────────
// _headerBound guards listeners on nodes that survive a tab switch (the header
// controls, portals, and document-level handlers). Those must bind exactly once
// per full render; otherwise switchTab()'s re-attach would stack duplicates.
let _headerBound=false;
function attachListeners(){
  // The active page's own listeners and after-injection passes — the Overview's
  // entrance/count-up motion and charts, the Calendar's month nav and day cells,
  // or the Settings cards. The pager calls this same function for a page it is
  // sliding in, which is why it takes the tab rather than reading S.tab.
  wireTabContent(S.tab);

  // Animate the net-pay hero (amount count-up + ring sweep + % count), but only
  // on a full render — NOT on tab switches, which replace the page under a
  // header (and hero) that survive the swap; replaying here would re-animate it
  // on every tab change. _tabSwitching is set by switchTab() for that window.
  if(!_tabSwitching) requestAnimationFrame(animateStatsHero);

  // Hand the pager the freshly built region: the track it was holding left the
  // document with the old markup. Idempotent — it re-binds only on new nodes.
  initTabPager({
    tabs:TAB_ORDER,
    buildPane:buildTabContent, wirePane:wireTabContent, dropPane:dropTabContent,
    setActive:setActiveTabButton,
    dragPill:dragTabUnderline, restPill:restTabUnderline,
    onSettle:commitTab
  });

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

  // ── Header + portal + document-level listeners: bind once per full render ─────
  if(!_headerBound){
    _headerBound=true;
    attachHeaderListeners();
  }
}

applyTheme();
initHeader(headerCtx());   // bind the header module before the first render
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