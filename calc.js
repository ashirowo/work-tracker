// ─────────────────────────────────────────────────────────────────────────────
// calc.js — THE single wage calculator for Shiftr.
//
// Phase 1 consolidated the app.js and export.js calculators here, verbatim.
// Phase 2a rewrote the internals to interpret a WORKPLACE PROFILE (profile.js):
// every number that used to be hardcoded policy — the 5.68h night boundary,
// the ×1.5/×2 multipliers, the 8h credits, the double-shift composition — now
// flows from profile data through one fixed pipeline. The default profile
// reproduces historical behavior bit-for-bit (gated by tests/golden-check.mjs).
//
// LAYERING (Phase 2a):
//   calcDay(profile, c)  — the ENGINE. Pure and MONEY-FREE: computes effective
//                          hours + notes. Never sees wages, currency, or taxes.
//   grossFor(eff, wage)  — the money edge: Math.round(eff × wage), unchanged.
//   calcWage(ctx, …)     — compatibility wrapper with the Phase 1 signature:
//                          classifies the day, resolves the holiday credit,
//                          calls the engine, applies the money edge. app.js and
//                          export.js adapters are untouched by this phase.
//
// PURITY CONTRACT (unchanged): this module reads no global state. Environment
// arrives via ctx = { tr, holAuto, isHol, shiftFor, applyTax, profile? }.
//
// ⚠ ROUNDING TOPOLOGY IS BEHAVIOR — verified by the golden suite:
//   • A bracket result consumed entirely at ×1 is returned UNROUNDED (raw h) —
//     this is how the original weekday formulas behaved (eff=regHrs;
//     nightWeekdayEff returns h as-is below the threshold). Any other bracket
//     result gets ONE toFixed(2) over the running float sum, matching the
//     original single-expression formulas' operation order exactly.
//   • Overtime is rounded PER TERM, then the sum is rounded again:
//       e=+(ot*mult).toFixed(2); eff=+(eff+e).toFixed(2)
//     For ×1.5 this is NOT equivalent to rounding once (ot=1.33 → 2.00 vs 1.995).
//   • Credits join via +(credit + workedEff).toFixed(2), as before.
//
// PHASE 3: calcDay emits SEGMENTS (machine-readable breakdown); renderNotes()
// turns them into per-language text via the tr.seg templates in
// translations.js. Every number in a note comes from the engine, so notes are
// correct for ANY profile — the 2a limitation (notes showing default-profile
// conversions) is resolved, unblocking profile-editing UI in later phases.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_PROFILE } from './profile.js';
import { normalizeProfile } from './profile-v2.js';

// ── Pure date helpers (verbatim from app.js; no state) ───────────────────────
function pd(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
function dowOf(s){return pd(s).getDay();}

// ── Day classification ────────────────────────────────────────────────────────
// Precedence (matches the original calcWage flag logic exactly for restDow=0):
// holiday > restday > saturday > weekday.
export function classifyDay(dateStr, holDay, profile){
  profile = normalizeProfile(profile);
  if(holDay) return 'holiday';
  const dow = dowOf(dateStr);
  if(dow === ((profile && profile.restDow) ?? 0)) return 'restday';
  if(dow === 6) return 'saturday';
  return 'weekday';
}

// ── Bracket evaluation ────────────────────────────────────────────────────────
// Brackets: [{upTo?: absolute hours threshold, mult}] applied to marginal hours
// in order. Float operation order deliberately mirrors the original formulas
// (acc = t1*m1; acc = acc + t2*m2; …) so results are bit-identical.
export function evalBrackets(brackets, h){ return evalBracketsEx(brackets, h).eff; }
function evalBracketsEx(brackets, h){
  // Two distinct notions of "plain", both load-bearing:
  //  • consumedPlain — did the ENTERED hours only touch ×1 brackets? Governs the
  //    raw-h eff rule (legacy night formula returns h unrounded below 5.68).
  //  • structPlain   — is the CELL all-×1 by structure? Governs the note FORM:
  //    legacy always shows "→ Xh effective" for mixed cells, even at h=0.
  let acc=0, consumed=0, consumedPlain=true;
  for(const b of brackets){
    const cap = (b.upTo === undefined || b.upTo === null) ? Infinity : b.upTo;
    const take = Math.min(h, cap) - consumed;
    if(take > 0){
      if(b.mult !== 1) consumedPlain = false;
      acc = acc + take * b.mult;
      consumed += take;
    }
    if(consumed >= h) break;
  }
  const structPlain = brackets.every(b => b.mult === 1);
  return { eff: consumedPlain ? h : +(acc).toFixed(2), plain: structPlain };
}

// ── Cell resolution ───────────────────────────────────────────────────────────
// mathClass: the class whose TABLES apply (follows a single workedAs alias hop:
// worked Sundays/holidays use Saturday math). Labels stay with the day's own
// class — that split is exactly the old calcSatLike(mode) behavior.
function mathClassOf(profile, dayClass){
  const entry = profile.rates[dayClass];
  return (entry && entry.workedAs) ? entry.workedAs : dayClass;
}
function cellFor(profile, mathClass, shift){
  return profile.rates[mathClass][shift];
}

// One cell of work: base hours through the brackets, then per-term-rounded OT.
// Emits SEGMENTS — machine-readable breakdown; note text is rendered from
// these by renderNotes() using the per-language seg templates.
function evalCell(profile, mathClass, labelClass, shift, regHrs, otHrs){
  const cell = cellFor(profile, mathClass, shift);
  const b = evalBracketsEx(cell.reg, regHrs);
  let eff = b.eff;
  const segments = [{ kind:'base', labelClass, shift, hours: regHrs, eff: b.eff, plain: b.plain }];
  if(otHrs > 0){
    const e = +(otHrs * cell.ot).toFixed(2);
    eff = +(eff + e).toFixed(2);
    segments.push({ kind:'ot', shift, hours: otHrs, mult: cell.ot, eff: e });
  }
  return { eff, segments };
}

// Composite shift (the double): credit (per day class) + Σ parts, one rounding,
// then per-term-rounded OT at the composite's multiplier.
function calcComposite(profile, comp, dayClass, otHrs, holCredit){
  const mc = mathClassOf(profile, dayClass);
  let credit = 0;
  if(dayClass === 'restday') credit = profile.credits.restday.hours;
  else if(dayClass === 'holiday' && holCredit) credit = profile.credits.holiday.hours;

  let eff = credit;
  for(const part of comp.parts){
    const cls = part.table === 'inherit' ? mc : part.table;
    eff = eff + evalBrackets(cellFor(profile, cls, part.shift).reg, part.hours);
  }
  eff = +(eff).toFixed(2);

  const variant = (dayClass === 'restday' || dayClass === 'holiday')
    ? (credit > 0 ? 'holsun' : 'holsunNoAuto')
    : dayClass === 'saturday' ? 'saturday' : 'weekday';
  const segments = [{ kind:'composite', variant, autoHours: credit,
    parts: comp.parts.map(p => ({ shift: p.shift, hours: p.hours })), eff }];
  if(otHrs > 0){
    const e = +(otHrs * comp.ot).toFixed(2);
    eff = +(eff + e).toFixed(2);
    segments.push({ kind:'ot', shift:'night', hours: otHrs, mult: comp.ot, eff: e });
  }
  return { eff, segments };
}

// ── THE ENGINE — pure, money-free ─────────────────────────────────────────────
// c = { dayClass, shift, regHrs, otHrs, holCredit (resolved bool), tr }
// Returns { eff, notes }. Wages, currency, and deductions never enter here.
export function calcDay(profile, c){
  profile = normalizeProfile(profile);
  const { dayClass, shift, regHrs, otHrs, holCredit } = c;

  const comp = profile.composites && profile.composites[shift];
  if(comp) return calcComposite(profile, comp, dayClass, otHrs, holCredit);

  if(dayClass === 'restday'){
    const creditH = profile.credits.restday.hours;
    if(regHrs > 0 || otHrs > 0){
      // credit base + worked hours (Saturday math, rest-day labels), one rounding
      const worked = evalCell(profile, mathClassOf(profile, 'restday'), 'restday', shift, regHrs, otHrs);
      return { eff: +(creditH + worked.eff).toFixed(2),
               segments: [{ kind:'credit', creditClass:'restday', hours: creditH, worked: true }, ...worked.segments] };
    }
    return { eff: creditH, segments: [{ kind:'credit', creditClass:'restday', hours: creditH, worked: false }] };
  }

  if(dayClass === 'holiday'){
    let eff = 0, segments = [];
    if(holCredit){ eff = profile.credits.holiday.hours;
      segments.push({ kind:'credit', creditClass:'holiday', hours: eff, worked: (regHrs > 0 || otHrs > 0) }); }
    if(regHrs > 0 || otHrs > 0){
      const worked = evalCell(profile, mathClassOf(profile, 'holiday'), 'holiday', shift, regHrs, otHrs);
      eff = +(eff + worked.eff).toFixed(2);
      segments = segments.concat(worked.segments);
    }
    return { eff, segments };
  }

  // saturday / weekday — a direct cell
  return evalCell(profile, mathClassOf(profile, dayClass), dayClass, shift, regHrs, otHrs);
}

// ── Money edge ────────────────────────────────────────────────────────────────
export function grossFor(eff, wage){ return Math.round(eff * wage); }

// ── Note rendering (Phase 3) ──────────────────────────────────────────────────
// Segments → per-language text via tr.seg (translations.js). Numbers in notes
// come FROM THE ENGINE's segments — never recomputed here or in translations —
// so notes are correct for any profile, not just the default. tr.seg.num
// applies each language's static-number styling (e.g. Devanagari digits,
// comma decimals) exactly where the legacy strings did.
export function renderNotes(tr, segments){
  const g = tr.seg;
  return segments.map(s => {
    if(s.kind === 'base'){
      const p = g.labels[s.labelClass][s.shift];
      // Legacy display formats, preserved: night conversions always 2dp
      // ("0.00h"), day conversions zero-stripped ("12h", "4.5h").
      const eStr = s.shift === 'night' ? s.eff.toFixed(2) : String(s.eff);
      return s.plain ? g.base(p, s.hours) : g.baseConv(p, s.hours, eStr);
    }
    if(s.kind === 'ot') return g.ot(s.hours, g.num(s.mult), s.eff);
    if(s.kind === 'credit')
      return (s.creditClass === 'restday' && !s.worked) ? g.creditSun(g.num(s.hours)) : g.creditHol(g.num(s.hours));
    // composite
    const d = g.num(s.parts[0].hours), n = g.num(s.parts[1].hours), e = g.num(s.eff);
    if(s.variant === 'weekday')  return g.dblWeekday(d, n, e);
    if(s.variant === 'saturday') return g.dblSaturday(d, n, e);
    if(s.variant === 'holsun')   return g.dblHolSun(g.num(s.autoHours), d, n, e);
    return g.dblHolSunNoAuto(d, n, e);
  });
}

// ── Rules card (Phase 3b) — the "Wage Calculation Rules" table, FROM PROFILE ──
// Replaces the per-language hardcoded rules arrays: labels come verbatim from
// tr.seg.rule (mechanically lifted from the legacy strings), every number is
// an engine probe of the ACTIVE profile. Returns [name, desc, kind][] rows,
// deduction row last. The KIND ('day'|'night'|'double'|'sunday'|'holiday'|
// 'tax') identifies the rule type so consumers can key icons/styling off it —
// row POSITION shifts as optional rules (Saturday, rest day…) drop out.
export function buildRulesRows(profile, g, opts){
  profile = normalizeProfile(profile);
  const R = g.rule, num = g.num;
  const comp = profile.composites && profile.composites.double;
  const probe = (comp && comp.parts[0].hours) || 8;
  const cellRow = (label, dayClass, shift) => {
    const cell = cellFor(profile, mathClassOf(profile, dayClass), shift);
    const b = evalBracketsEx(cell.reg, probe);
    const effStr = num(+(b.eff).toFixed(2)), otStr = num(cell.ot);
    return [label, b.plain ? R.rowPlain(num(probe), effStr, otStr)
                           : R.rowConv(num(probe), effStr, otStr), shift];
  };
  const dblEff = (dayClass, holCredit) =>
    num(calcDay(profile, { dayClass, shift: 'double', regHrs: 0, otHrs: 0, holCredit }).eff);
  const d = num(comp.parts[0].hours), n = num(comp.parts[1].hours);

  // Context-aware (Phase 5.4): emit a row only when the feature is active for
  // THIS profile. Feature detection is structural — a class aliased to weekday
  // has no distinct premium, a zero/never credit is off, etc. The factory
  // default profile activates every feature, so its full table (and the frozen
  // rules-replay snapshot) is unchanged.
  const hasNight   = profile.shifts && profile.shifts.includes('night');
  const satEntry   = profile.rates.saturday;
  const hasSaturday= !(satEntry && satEntry.workedAs === 'weekday');   // Saturday is special
  const hasDouble  = !!comp;
  const restC      = profile.credits && profile.credits.restday;
  const holC       = profile.credits && profile.credits.holiday;
  const hasRest    = !!(restC && restC.when !== 'never' && restC.hours > 0);
  const hasHolCred = !!(holC && holC.when !== 'never' && holC.hours > 0);

  const rows = [];
  rows.push(cellRow(R.labels[0], 'weekday', 'day'));
  if(hasSaturday) rows.push(cellRow(R.labels[1], 'saturday', 'day'));
  if(hasNight){
    rows.push(cellRow(R.labels[2], 'weekday', 'night'));
    if(hasSaturday) rows.push(cellRow(R.labels[3], 'saturday', 'night'));
  }
  if(hasDouble){
    rows.push([R.labels[4], R.dbl(d, n, dblEff('weekday', true)), 'double']);
    if(hasSaturday) rows.push([R.labels[5], R.dbl(d, n, dblEff('saturday', true)), 'double']);
    rows.push(opts.holAuto
      ? [R.labels[6], R.dblAuto(num((holC&&holC.hours)||0), d, n, dblEff('holiday', true)), 'double']
      : [R.labels[6], R.dblNoAuto(d, n, dblEff('holiday', false)), 'double']);
  }
  if(hasRest) rows.push([R.labels[7], R.sunday(num(restC.hours)), 'sunday']);
  if(hasHolCred) rows.push(opts.holAuto
    ? [R.labels[8], R.holOn(num(holC.hours)), 'holiday']
    : [R.labels[8], R.holOff, 'holiday']);
  rows.push([opts.dedNoun, R.ded(String(opts.dedPct)), 'tax']);
  return rows;
}

// ── Compatibility wrapper (Phase 1 public signature — adapters unchanged) ────
export function calcWage(ctx, dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride){
  const profile = normalizeProfile(ctx.profile || DEFAULT_PROFILE);
  const shift = shiftOverride || ctx.shiftFor(dateStr);
  const dayClass = classifyDay(dateStr, ctx.isHol(dateStr), profile);
  // Holiday credit: per-day override > global setting (unchanged precedence)
  const holCredit = holCreditOverride !== undefined ? holCreditOverride : ctx.holAuto;
  const { eff, segments } = calcDay(profile, { dayClass, shift, regHrs, otHrs, holCredit });
  const g = grossFor(eff, wage);
  return { gross: g, net: ctx.applyTax(g), eff, notes: renderNotes(ctx.tr, segments), segments };
}

// ── Effective-hours formulas — now DERIVED from the default profile ──────────
// Kept for translations.js's note templates (and re-exported there). These are
// views of DEFAULT_PROFILE's brackets; the standalone formula bodies are gone.
export function nightWeekdayEff(h){ return evalBrackets(DEFAULT_PROFILE.rates.weekday.night.reg, h); }
export function satNightEff(h){ return evalBrackets(DEFAULT_PROFILE.rates.saturday.night.reg, h); }
export function satDayEff(h){ return evalBrackets(DEFAULT_PROFILE.rates.saturday.day.reg, h); }

// ── calcSatLike — compatibility (old public API; Saturday math + mode labels) ─
export function calcSatLike(shift, regHrs, otHrs, tr, mode){
  const labelClass = mode === 'holiday' ? 'holiday' : mode === 'sunday' ? 'restday' : 'saturday';
  const { eff, segments } = evalCell(DEFAULT_PROFILE, 'saturday', labelClass, shift, regHrs, otHrs);
  return { eff, notes: renderNotes(tr, segments) };
}
