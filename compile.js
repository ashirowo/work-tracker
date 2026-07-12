// ─────────────────────────────────────────────────────────────────────────────
// compile.js — the authoring-layer compiler (Phase 2b).
//
// Turns plain wizard ANSWERS ("do nights pay extra? from 22:00? +50%?") into
// the execution profile that calc.js interprets (see profile.js for that
// schema). This is the second half of the two-layer design: users author
// answers; the runtime only ever reads compiled tables.
//
// Nothing in the shipped app imports this module yet — the onboarding wizard
// (Phase 5) is its consumer. It ships silently, fully tested by
// tests/compiler.test.mjs, whose first assertion is the DOGFOODING INVARIANT:
//   compileProfile(PRESET_ANSWERS['kr-factory-2shift']) === DEFAULT_PROFILE
// deep-equal, byte for byte of meaning. If the compiler can't express the
// app's own historical rulebook, it doesn't ship.
//
// ── ANSWER SCHEMA (v1) ────────────────────────────────────────────────────────
// {
//   v: 1,
//   pattern: 'rotation' | 'fixedDay' | 'fixedNight',   // consumed by the wizard
//                                                       // UI (seeds wt4_shifts);
//                                                       // not an execution field
//   shiftHours: 8,                    // standard shift length (composite parts)
//   night: {
//     extra: boolean,                 // do nights pay more at all?
//     premium: 0.5,                   // additional multiplier on premium hours
//     // exactly ONE of the two shapes below when extra:
//     direct: { plainHours: 5.68 },   // escape hatch: "my first X night hours
//                                     // are plain rate" — how thresholds that
//                                     // don't derive from clock times (like the
//                                     // factory's 5.68) are expressed
//     window: {                       // OR derive the threshold from times:
//       start: '22:00', end: '06:00', //   the legal/company premium window
//       schedule: { start: '20:30', end: '05:30', breakMin: 60 },
//     },
//   },
//   saturday: { extra: boolean, mult: 1.5 },        // day-shift Saturday rate
//   holiday:  { paidCredit: boolean, creditHours: 8, workedMult?: number },
//   overtime: { day: 1.5, night: 2 },               // per-shift OT multipliers
//   restDay:  { dow: 0, paidCredit: boolean, hours: 8 },
// }
//
// ── COMPILE RULES (all documented behavior, all tested) ──────────────────────
// • Night brackets: [{upTo: plainHours, mult: 1}, {mult: 1 + premium}] from the
//   direct path, or ordered plain/premium runs from the window path. Runs are
//   ABSOLUTE thresholds over the user's entered regular hours.
// • Window→brackets: the shift span is walked chronologically (cross-midnight
//   handled); paid time excludes breaks. ASSUMPTIONS (v1, stated): hours accrue
//   in schedule order; when the user logs fewer hours than scheduled they drop
//   from the tail; break minutes are deducted from PLAIN segments first
//   (tail-most plain first), then from premium — deterministic and simple; the
//   direct path exists for rulebooks this doesn't fit.
// • Saturday stacking is ADDITIVE, matching Korean statutory practice and the
//   factory rulebook: saturday-night mult = night mult + (saturdayMult − 1).
//   (×1→×1.5, ×1.5→×2 for saturdayMult 1.5 — NOT multiplicative, which would
//   give 2.25.)
// • Canonical aliases: when a worked rest-day/holiday/Saturday resolves to the
//   same tables as another class, the compiler emits { workedAs } instead of
//   duplicating tables — byte-compatible with DEFAULT_PROFILE and friendlier
//   to diff/sync.
// • OT multipliers are per SHIFT and apply across all day classes (matches the
//   factory rulebook: Saturday OT = weekday OT).
// • The double composite is derived: day part (shiftHours, 'inherit') + night
//   part (shiftHours, pinned to 'saturday' when Saturday pays extra — the
//   verified quirk — else 'inherit'), OT at the night multiplier.
// • Computed multipliers are normalized to 4 decimals, hours to 2, so float
//   dust (1 + 0.3 = 1.3000000000000000444) never reaches stored profiles.
// ─────────────────────────────────────────────────────────────────────────────

import { PROFILE_SCHEMA_V } from './profile.js';
import { PROFILE_SCHEMA_V2 } from './profile-v2.js';

export const ANSWERS_SCHEMA_V = 1;

const r4 = x => +(+x).toFixed(4);
const r2 = x => +(+x).toFixed(2);

function fail(msg){ throw new Error('compileProfile: ' + msg); }

function parseHM(s){
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if(!m) fail('bad time "' + s + '" (expected HH:MM)');
  const h = +m[1], min = +m[2];
  if(h > 24 || min > 59) fail('bad time "' + s + '"');
  return h * 60 + min;
}

// ── Window path: derive plain/premium runs from shift schedule + window ──────
// Returns brackets: ordered runs with ABSOLUTE upTo thresholds in hours.
export function windowToBrackets(window, premiumMult){
  const sched = window.schedule || fail('night.window.schedule required');
  let s = parseHM(sched.start), e = parseHM(sched.end);
  if(e <= s) e += 24 * 60;                      // cross-midnight shift
  let ws = parseHM(window.start), we = parseHM(window.end);
  if(we <= ws) we += 24 * 60;                   // cross-midnight window

  // Project the window onto the shift's absolute timeline (it may apply
  // shifted by ±24h — e.g. a 20:00→07:00 shift meets the 22:00→30:00 window).
  const spans = [];
  for(const off of [-24 * 60, 0, 24 * 60]){
    const a = Math.max(s, ws + off), b = Math.min(e, we + off);
    if(b > a) spans.push([a, b]);
  }
  spans.sort((a, b) => a[0] - b[0]);

  // Chronological runs of {premium: bool, minutes}
  const runs = [];
  let cur = s;
  for(const [a, b] of spans){
    if(a > cur) runs.push({ premium: false, min: a - cur });
    runs.push({ premium: true, min: b - a });
    cur = b;
  }
  if(cur < e) runs.push({ premium: false, min: e - cur });

  // Break deduction: plain runs first (tail-most plain first), then premium
  // (tail-most first). Deterministic v1 rule — see header.
  let brk = (sched.breakMin || 0);
  const eat = wantPremium => {
    for(let i = runs.length - 1; i >= 0 && brk > 0; i--){
      if(runs[i].premium !== wantPremium) continue;
      const take = Math.min(runs[i].min, brk);
      runs[i].min -= take; brk -= take;
    }
  };
  eat(false); eat(true);
  if(brk > 0) fail('break longer than the shift');

  // Merge adjacent equal-rate runs, drop empties, emit absolute thresholds.
  const merged = [];
  for(const r of runs){
    if(r.min <= 0) continue;
    const mult = r.premium ? r4(1 + premiumMult) : 1;
    const last = merged[merged.length - 1];
    if(last && last.mult === mult) last.min += r.min;
    else merged.push({ mult, min: r.min });
  }
  if(!merged.length) fail('empty schedule');

  const brackets = [];
  let acc = 0;
  for(let i = 0; i < merged.length; i++){
    acc += merged[i].min;
    brackets.push(i === merged.length - 1
      ? { mult: merged[i].mult }                    // last bracket open-ended
      : { upTo: r2(acc / 60), mult: merged[i].mult });
  }
  return brackets;
}

// ── Bracket helpers ───────────────────────────────────────────────────────────
function nightBrackets(night){
  if(!night || !night.extra) return [{ mult: 1 }];
  const prem = night.premium;
  if(typeof prem !== 'number' || prem <= 0) fail('night.premium required when night.extra');
  if(night.direct){
    const ph = night.direct.plainHours;
    if(typeof ph !== 'number' || ph < 0) fail('night.direct.plainHours must be a number');
    if(ph === 0) return [{ mult: r4(1 + prem) }];  // all-premium shift
    return [{ upTo: r2(ph), mult: 1 }, { mult: r4(1 + prem) }];
  }
  if(night.window) return windowToBrackets(night.window, prem);
  fail('night needs either .direct or .window when extra');
}

// Additive class premium: every bracket's mult gains (classMult − 1).
function stack(brackets, classMult){
  const add = classMult - 1;
  return brackets.map(b => b.upTo !== undefined
    ? { upTo: b.upTo, mult: r4(b.mult + add) }
    : { mult: r4(b.mult + add) });
}

function sameBrackets(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

// ── The compiler ──────────────────────────────────────────────────────────────
export function compileProfile(answers, opts = {}){
  if(!answers || answers.v !== ANSWERS_SCHEMA_V) fail('unsupported answers version');
  const { night, saturday, holiday, overtime, restDay } = answers;
  if(!overtime || typeof overtime.day !== 'number' || typeof overtime.night !== 'number')
    fail('overtime.day and overtime.night are required');
  const shiftHours = answers.shiftHours ?? 8;

  // Weekday cells
  const wkDay   = { reg: [{ mult: 1 }], ot: r4(overtime.day) };
  const wkNight = { reg: nightBrackets(night), ot: r4(overtime.night) };

  // Saturday cells (additive stacking) — or alias to weekday when no premium
  const satExtra = !!(saturday && saturday.extra);
  const satMult = satExtra ? r4(saturday.mult) : 1;
  if(satExtra && !(satMult > 1)) fail('saturday.mult must exceed 1 when saturday.extra');
  const satDayCell   = { reg: [{ mult: satMult }], ot: r4(overtime.day) };
  const satNightCell = { reg: stack(wkNight.reg, satMult), ot: r4(overtime.night) };

  // Worked holidays / rest days: which class's tables apply?
  // v1 rule: a distinct holiday.workedMult builds explicit holiday tables;
  // otherwise holidays and rest days follow the premium day (saturday when it
  // pays extra, weekday when it doesn't) — emitted as canonical aliases.
  const premiumClass = satExtra ? 'saturday' : 'weekday';
  let holidayEntry = { workedAs: premiumClass };
  if(holiday && typeof holiday.workedMult === 'number' && r4(holiday.workedMult) !== satMult){
    const hm = r4(holiday.workedMult);
    if(!(hm >= 1)) fail('holiday.workedMult must be ≥ 1');
    holidayEntry = {
      day:   { reg: [{ mult: hm }], ot: r4(overtime.day) },
      night: { reg: stack(wkNight.reg, hm), ot: r4(overtime.night) },
    };
  }

  const rates = {
    weekday: { day: wkDay, night: wkNight },
    ...(satExtra
      ? { saturday: { day: satDayCell, night: satNightCell } }
      : { saturday: { workedAs: 'weekday' } }),
    restday: { workedAs: premiumClass },
    holiday: holidayEntry,
  };
  // Degenerate guard: if explicit saturday tables equal weekday's, alias them.
  if(satExtra && satMult === 1 && sameBrackets(satNightCell.reg, wkNight.reg)){
    rates.saturday = { workedAs: 'weekday' };
  }

  const credits = {
    restday: (restDay && restDay.paidCredit)
      ? { hours: r2(restDay.hours ?? shiftHours), when: 'always' }
      : { hours: 0, when: 'never' },
    holiday: (holiday && holiday.paidCredit)
      ? { hours: r2(holiday.creditHours ?? shiftHours), when: 'holAuto' }
      : { hours: 0, when: 'never' },
  };

  // The double composite: day part inherits the day's class; the night part is
  // pinned to Saturday tables when Saturday pays extra (the factory quirk).
  const composites = {
    double: {
      parts: [
        { shift: 'day',   hours: r2(shiftHours), table: 'inherit' },
        { shift: 'night', hours: r2(shiftHours), table: satExtra ? 'saturday' : 'inherit' },
      ],
      ot: r4(overtime.night),
    },
  };

  return {
    v: PROFILE_SCHEMA_V,
    id: opts.id || 'custom',
    shifts: ['day', 'night'],
    restDow: (restDay && restDay.dow !== undefined) ? restDay.dow : 0,
    rates,
    credits,
    composites,
  };
}

export const ANSWERS_SCHEMA_V2 = 2;

// compileProfileV2 — authors the v2 ADDITIVE execution form (profile-v2.js),
// which normalizeProfile() lowers to v1 tables at calc time. Night premium is
// expressed once (night.prem + mode), not baked into per-cell bracket tables.
//
// v2 ANSWERS (only what differs from v1):
//   nightModel: 'none' | 'threshold' | 'overlap'
//     none      → no night premium (day-type night shift paid like day)
//     threshold → first `plainHours` paid hours plain, rest get the adder
//                 (the negotiated/factory model). plainHours in answers.
//     overlap   → premium on hours in the 22:00–06:00 window; the user's
//                 schedule (asked once) supplies the cap. NOT in the preset.
//   nightPrem:  additive adder (default 0.5 = +50%, statutory)
//   nightWindow:{ start, end }  (default KR statutory 22:00–06:00)
//   otDay, otNight: overtime multipliers (day/night contexts)
//   saturday/holiday/restDay: as v1
//   schedule: { night:{start,end,breakMin} }  — USER config, optional; only
//     meaningful for overlap. Passed through to the profile, not the preset.
export function compileProfileV2(answers, opts = {}){
  if(!answers || answers.v !== ANSWERS_SCHEMA_V2) fail('unsupported v2 answers version');
  const { saturday, holiday, restDay } = answers;
  const shiftHours = answers.shiftHours ?? 8;
  const otDay   = r4(answers.otDay   != null ? answers.otDay   : 1.5);
  const otNight = r4(answers.otNight != null ? answers.otNight : otDay);
  const nightModel = answers.nightModel || 'none';
  const nightPrem  = nightModel === 'none' ? 0 : r4(answers.nightPrem != null ? answers.nightPrem : 0.5);
  if(nightModel === 'threshold' && nightPrem){
    const ph = answers.plainHours;
    if(typeof ph !== 'number' || ph < 0) fail('threshold nightModel requires numeric plainHours');
  }
  const satExtra = !!(saturday && saturday.extra);
  const satMult  = satExtra ? r4(saturday.mult) : 1;
  if(satExtra && !(satMult > 1)) fail('saturday.mult must exceed 1 when saturday.extra');

  // v2 rate cells: { base, ot, plainHours? } — NOT bracket tables. The night
  // adder is applied by normalizeProfile from night.prem; plainHours (threshold)
  // rides on the night cell.
  const nightCell = base => {
    const c = { base: r4(base), ot: otNight };
    if(nightModel === 'threshold' && nightPrem) c.plainHours = r2(answers.plainHours);
    return c;
  };
  const rates = {
    weekday: { day: { base: 1, ot: otDay }, night: nightCell(1) },
    ...(satExtra
      ? { saturday: { day: { base: satMult, ot: otDay }, night: nightCell(satMult) } }
      : { saturday: { workedAs: 'weekday' } }),
    restday: { workedAs: satExtra ? 'saturday' : 'weekday' },
    holiday: (holiday && typeof holiday.workedMult === 'number' && r4(holiday.workedMult) !== satMult)
      ? { day: { base: r4(holiday.workedMult), ot: otDay }, night: nightCell(r4(holiday.workedMult)) }
      : { workedAs: satExtra ? 'saturday' : 'weekday' },
  };

  const credits = {
    restday: (restDay && restDay.paidCredit)
      ? { hours: r2(restDay.hours ?? shiftHours), when: 'always' }
      : { hours: 0, when: 'never' },
    holiday: (holiday && holiday.paidCredit)
      ? { hours: r2(holiday.creditHours ?? shiftHours), when: 'holAuto' }
      : { hours: 0, when: 'never' },
  };

  const composites = {
    double: {
      parts: [
        { shift: 'day',   hours: r2(shiftHours), table: 'inherit' },
        { shift: 'night', hours: r2(shiftHours), table: satExtra ? 'saturday' : 'inherit' },
      ],
      ot: otNight,
    },
  };

  const profile = {
    v: PROFILE_SCHEMA_V2,
    id: opts.id || 'custom',
    shifts: ['day', 'night'],
    restDow: (restDay && restDay.dow !== undefined) ? restDay.dow : 0,
    night: {
      window: answers.nightWindow || { start: '22:00', end: '06:00' },
      prem: nightPrem,
      mode: nightModel === 'overlap' ? 'overlap' : 'threshold',
    },
    rates, credits, composites,
  };
  // Schedule is USER config: attach only when provided (overlap needs it).
  // Deep-copy the anchored break so stored profiles never share state with
  // the wizard's live answers object.
  if(answers.schedule && answers.schedule.night){
    const n = answers.schedule.night;
    profile.schedule = { night: { ...n, ...(n.break ? { break: { ...n.break } } : {}) } };
  }
  return profile;
}

// ── Preset answer sets — presets are ANSWERS, not maintained tables ──────────
export const PRESET_ANSWERS = {
  // The app's historical rulebook. The compiler test suite asserts this
  // compiles to EXACTLY profile.js's DEFAULT_PROFILE (the dogfooding invariant).
  'kr-factory-2shift': {
    v: 1,
    pattern: 'rotation',
    shiftHours: 8,
    night:    { extra: true, premium: 0.5, direct: { plainHours: 5.68 } },
    saturday: { extra: true, mult: 1.5 },
    holiday:  { paidCredit: true, creditHours: 8 },
    overtime: { day: 1.5, night: 2 },
    restDay:  { dow: 0, paidCredit: true, hours: 8 },
  },
  // Statutory-baseline fixed-day job: nights (22:00–06:00) +50%, OT 1.5×,
  // Saturday unpaid premium, rest-day and holiday credits on.
  'kr-statutory-day': {
    v: 1,
    pattern: 'fixedDay',
    shiftHours: 8,
    night:    { extra: true, premium: 0.5,
                window: { start: '22:00', end: '06:00',
                          schedule: { start: '22:00', end: '07:00', breakMin: 60 } } },
    saturday: { extra: false },
    holiday:  { paidCredit: true, creditHours: 8, workedMult: 1.5 },
    overtime: { day: 1.5, night: 1.5 },
    restDay:  { dow: 0, paidCredit: true, hours: 8 },
  },
  // Simple part-time: flat rate, no premiums, no credits.
  'kr-parttime-flat': {
    v: 1,
    pattern: 'fixedDay',
    shiftHours: 8,
    night:    { extra: false },
    saturday: { extra: false },
    holiday:  { paidCredit: false },
    overtime: { day: 1.5, night: 1.5 },
    restDay:  { dow: 0, paidCredit: false },
  },
};

// ── v2 preset answer sets (researched; §56 statutory unless noted) ───────────
// Each is COMPILE INPUT for compileProfileV2 — pay rules only, no user schedule.
// Tier is documented per preset; UI labels live in translations (Phase 5.3).
export const PRESET_ANSWERS_V2 = {
  // WORKPLACE AGREEMENT — Iljitech. Negotiated 5.68h plain-night threshold,
  // Saturday +50%, holiday/rest credits. Labeled "Recommended for Iljitech
  // employees" (not a legal standard). Compiles+lowers to the golden default.
  'kr-factory-2shift': {
    v: 2, shiftHours: 8,
    nightModel: 'threshold', nightPrem: 0.5, plainHours: 5.68,
    saturday: { extra: true, mult: 1.5 },
    holiday:  { paidCredit: true, creditHours: 8 },
    otDay: 1.5, otNight: 2,
    restDay:  { dow: 0, paidCredit: true, hours: 8 },
  },
  // STANDARD KOREAN WORKPLACE, 5+ employees. Common-practice setup for a
  // full-time shift worker: OT +50%, night +50% by clock overlap, holiday
  // +50%/+100%, 주휴수당 on, and SATURDAY 1.5×. Saturday 1.5× is not a
  // statutory "Saturday rate" — it's what a full-time worker actually earns,
  // because Mon–Fri exhausts the 40h week so Saturday work is overtime (+50%),
  // per MOEL guidance and manufacturing collective-agreement practice. We adopt
  // it as the sensible default for Shiftr's audience (researched, not guessed).
  'kr-statutory-5plus': {
    v: 2, shiftHours: 8,
    nightModel: 'overlap', nightPrem: 0.5, nightWindow: { start: '22:00', end: '06:00' },
    saturday: { extra: true, mult: 1.5 },       // common practice (overtime past 40h/week)
    holiday:  { paidCredit: true, creditHours: 8, workedMult: 1.5 },
    otDay: 1.5, otNight: 1.5,                   // night OT stacks the night adder additively
    restDay:  { dow: 0, paidCredit: true, hours: 8 },
  },
  // LEGAL MINIMUM, 5+ employees — the theoretical floor for the edge case where
  // Saturday is paid at plain rate until 40h/week is provably exceeded. Surfaced
  // only inside Customize; most users want kr-statutory-5plus above.
  'kr-legal-minimum': {
    v: 2, shiftHours: 8,
    nightModel: 'overlap', nightPrem: 0.5, nightWindow: { start: '22:00', end: '06:00' },
    saturday: { extra: false },                 // Saturday not a premium day at the pure floor
    holiday:  { paidCredit: true, creditHours: 8, workedMult: 1.5 },
    otDay: 1.5, otNight: 1.5,
    restDay:  { dow: 0, paidCredit: true, hours: 8 },
  },
  // STATUTORY, under 5 employees (§11 exemption): NO OT/night/holiday premium;
  // only ordinary wage + 주휴수당. Surfaced inside "Customize", not a top chip.
  'kr-small-under5': {
    v: 2, shiftHours: 8,
    nightModel: 'none',
    saturday: { extra: false },
    holiday:  { paidCredit: false },            // worked holiday = ordinary wage
    otDay: 1, otNight: 1,                       // no OT premium
    restDay:  { dow: 0, paidCredit: true, hours: 8 },  // 주휴수당 still applies (≥15h/wk)
  },
};

