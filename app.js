// ── firebase.js integration ──────────────────────────────────────────────────
// scheduleSync() is called after every data mutation so changes automatically
// propagate to Firestore when the user is signed in. If not signed in or offline,
// the call is a no-op and localStorage continues working as usual.
import { scheduleSync, deleteCloudData,
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
import { WZI, SHM_IC_CHECK, SHM_IC_SEARCH, ruleRowsHTML, flagImg } from './ui/icons.js';
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
import { initHeader, buildHeaderHTML, buildStats, attachHeaderListeners, updateSyncUI, updateOfflineBanner, startSyncTicker } from './ui/header.js';

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
// Sync-badge + last-synced helpers live in ui/header.js (Phase 8f).
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

// FLAGS + flagImg moved to ui/icons.js (Phase 8f); flagImg imported above.

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

// Header stroke-icons + SYNC_ICONS moved to ui/icons.js (Phase 8f).

// greeting + lastSyncedLabel + t2 live in ui/header.js (Phase 8f).

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
// The header/stats surface (Phase 8f). Bound ONCE at boot via initHeader — its
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
  return`${buildHeaderHTML()}
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

// buildStats (the net-pay stats hero) lives in ui/header.js (Phase 8f).

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

// attachHeaderListeners lives in ui/header.js (Phase 8f).

// (Settings-tab content listeners live in ui/views/settings.js — wireSettings.)

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
