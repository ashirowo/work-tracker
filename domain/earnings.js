// ─────────────────────────────────────────────────────────────────────────────
// domain/earnings.js — the display-layer earnings truth (Phase 4).
//
// Every function computes over an ENV: a capability record of the caller's own
// READ FUNCTIONS, never data snapshots —
//   { getLogs(), wageFor(ds), shiftFor(ds), isHol(ds), isHolAuto(),
//     applyTax(gross), getProfile(), tr(), todayStr() }
// app.js binds its state/storage (APP_ENV); export.js binds its own reads
// inside buildRows. Late binding preserves read-per-call semantics
// byte-identically (wageFor re-reads storage per call; the golden oracle
// re-pins today()).
//
// Bodies are verbatim from app.js. Two quirks preserved on purpose:
//  • autoEffIn's holiday branch refetches env.getLogs()[ds] (ignoring a
//    passed logsArg) exactly as the original did;
//  • the 8h auto-credit for UNLOGGED holidays/Sundays is hardcoded — a known,
//    documented display-layer limitation (see profile.js: engine credits are
//    profile-driven; this display gate is not yet). Making it profile-driven
//    is a product decision — do not slip it into a refactor.
// ─────────────────────────────────────────────────────────────────────────────

import { calcWage as calcWageCore, calcDay as calcDayCore, classifyDay as classifyDayCore } from '../calc.js';
import { pd, mkds, getMonday, isSun, isSat } from '../core/dates.js';
import { entryHours } from './log-entries.js';

// The calc.js engine call with the env packaged into its ctx (the adapter
// formerly in app.js).
export function calcWageIn(env, dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride){
  return calcWageCore(
    { tr: env.tr(), holAuto: env.isHolAuto(), isHol: env.isHol, shiftFor: env.shiftFor, applyTax: env.applyTax, profile: env.getProfile() },
    dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride
  );
}

// Sunday auto-credit gate: all Mon–Fri of that week logged (or holidays).
export function allWeekdaysLoggedIn(env, s){
  const logs = env.getLogs();
  const ws = getMonday(s);
  for(let i = 0; i <= 4; i++){
    const d = pd(ws);
    d.setDate(d.getDate() + i);
    const ds = mkds(d.getFullYear(), d.getMonth(), d.getDate());
    if(!logs[ds] && !env.isHol(ds)){
      return false;
    }
  }
  return true;
}

// Gross for a date: logged days recompute from stored hours × current wage;
// unlogged holidays/Sundays may auto-credit 8h; everything else is 0.
export function liveGrossIn(env, ds, logsArg){
  const logs = logsArg !== undefined ? logsArg : env.getLogs();
  const w = env.wageFor(ds);
  if(logs[ds]){
    const l = logs[ds];
    const { reg, ot } = entryHours(l);
    return calcWageIn(env, ds, reg, ot, w, l.shiftOverride, l.holCreditOverride).gross;
  }
  const todayStr = env.todayStr();
  // Holiday auto-credit is suppressed when the holiday falls on a Saturday —
  // Saturdays follow the separate 50% Saturday pay rule, not the 8h credit.
  if(env.isHol(ds) && !isSat(ds) && ds <= todayStr){
    const logEntry=logs[ds];
    const credit = logEntry?.holCreditOverride !== undefined ? logEntry.holCreditOverride : env.isHolAuto();
    if(credit && !logEntry) return Math.round(8 * w); // auto-credit, no manual log
  }
  if(isSun(ds) && !env.isHol(ds) && ds <= todayStr && allWeekdaysLoggedIn(env, ds)) return Math.round(8 * w);
  return 0;
}

// Effective hours for a date — same branch structure as liveGrossIn.
export function autoEffIn(env, ds, logsArg){
  const logs = logsArg !== undefined ? logsArg : env.getLogs();
  if(logs[ds]){
    const l = logs[ds];
    const { reg, ot } = entryHours(l);
    return calcWageIn(env, ds, reg, ot, env.wageFor(ds), l.shiftOverride, l.holCreditOverride).eff;
  }
  const todayStr = env.todayStr();
  if(env.isHol(ds) && !isSat(ds) && ds <= todayStr){
    const logEntry=env.getLogs()[ds];   // verbatim quirk: refetches, ignores logsArg
    const credit = logEntry?.holCreditOverride !== undefined ? logEntry.holCreditOverride : env.isHolAuto();
    if(credit && !logEntry) return 8;
  }
  if(isSun(ds) && !env.isHol(ds) && ds <= todayStr && allWeekdaysLoggedIn(env, ds)) return 8;
  return 0;
}

// ── Projection primitives (Phase 4 of the original engine work) — every
// number comes from an engine probe of the active profile.
export function probeHoursIn(p){
  return (p.composites&&p.composites.double&&p.composites.double.parts[0].hours)||8;
}
export function engineDayClassIn(env, ds){ return classifyDayCore(ds, env.isHol(ds), env.getProfile()); }
// Plain-base effective hours for a day (OT excluded), for the overtime split:
// doubles use the full composite for the day's class; single shifts use the
// WEEKDAY table regardless of day class — deliberately preserving the
// historical definition of "base pay" the OT split has always used.
export function baseEffForIn(env, ds, sh){
  const profile=env.getProfile();
  if(sh==='double')
    return calcDayCore(profile,{dayClass:engineDayClassIn(env, ds),shift:'double',regHrs:0,otHrs:0,holCredit:env.isHolAuto()}).eff;
  return calcDayCore(profile,{dayClass:'weekday',shift:sh,regHrs:probeHoursIn(profile),otHrs:0,holCredit:false}).eff;
}
// Projection buckets: one per (shift × own-table class) + restday + holiday.
export function bucketKeysIn(p){
  const keys=[];
  for(const cls of ['weekday','saturday']) if(!p.rates[cls].workedAs)
    for(const sh of p.shifts) keys.push(sh+'|'+cls);
  keys.push('restday','holiday'); return keys;
}
export function bucketForIn(env, ds){
  const p=env.getProfile(); const cls=engineDayClassIn(env, ds);
  if(cls==='restday'||cls==='holiday') return cls;
  const pooled=(p.rates[cls].workedAs)||cls;
  return env.shiftFor(ds)+'|'+pooled;
}
// Deterministic projection floor: a representative plain day of this bucket.
export function bucketDeterministicEffIn(env, bucket){
  const profile=env.getProfile();
  if(bucket==='restday')
    return calcDayCore(profile,{dayClass:'restday',shift:profile.shifts[0],regHrs:0,otHrs:0,holCredit:false}).eff;
  if(bucket==='holiday')
    return calcDayCore(profile,{dayClass:'holiday',shift:profile.shifts[0],regHrs:0,otHrs:0,holCredit:env.isHolAuto()}).eff;
  const i=bucket.indexOf('|');
  return calcDayCore(profile,{dayClass:bucket.slice(i+1),shift:bucket.slice(0,i),regHrs:probeHoursIn(profile),otHrs:0,holCredit:true}).eff;
}
