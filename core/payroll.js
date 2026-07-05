// ─────────────────────────────────────────────────────────────────────────────
// core/payroll.js
// THE wage-calculation engine — the single source of truth for how a shift
// becomes effective hours, gross pay and net pay.
//
// Before this module existed, calcWage / calcSatLike / shiftFor / applyTax and
// the whole deduction stack lived TWICE: once in app.js (which builds a
// localized notes[] array) and once in export.js (which dropped notes and took
// `holidays` as a parameter). The two copies produced the same numbers today
// but were maintained independently — so a user's on-screen pay and their
// exported-PDF pay were computed by two different functions. That divergence
// risk is the reason this module exists.
//
// The engine is pure: it reads nothing global. Everything environmental is
// passed in via an explicit `ctx`:
//   ctx.isHol(dateStr) → boolean   is this date a public holiday?
//   ctx.holAuto        → boolean   does an *unworked* holiday auto-credit 8h?
//   ctx.tr             → object    translation table (TR[lang]) for note labels
// app.js builds a ctx from its globals (S.lang, isHol, isHolAuto); export.js
// builds one from its per-report `holidays` map. Same function, same result.
// ─────────────────────────────────────────────────────────────────────────────

import { nightWeekdayEff, satNightEff, satDayEff } from '../translations.js';
import { pd, isSun, isSat, getMonday } from './datetime.js';
import { getShifts, getInsurance, getDeductionMode, getTaxRatePct } from './storage.js';

// ── Deduction math ───────────────────────────────────────────────────────────
// Two mutually-exclusive modes decide what's subtracted from gross:
//   'tax'       → a single flat withholding % (default; 3.3%)
//   'insurance' → Korea's 4대 보험 employee-side contributions, summed
// net = gross × (1 − activeRate) in both cases; only the source of the rate
// differs. Long-term care is a % OF the health premium, not of gross.

// Effective long-term-care rate as a % of GROSS = health × (careOfHealth/100).
export function careRateOfGross(ins) {
  ins = ins || getInsurance();
  return ins.health * (ins.careOfHealth / 100);
}
// Combined employee insurance deduction as a PERCENTAGE of gross (e.g. 9.2).
export function insuranceRatePct(ins) {
  ins = ins || getInsurance();
  return ins.pension + ins.health + careRateOfGross(ins) + ins.employment;
}
// Combined employee insurance deduction as a FRACTION of gross (0..1).
export function insuranceRate(ins) {
  return insuranceRatePct(ins) / 100;
}
// The single active deduction fraction (0..1), per current mode.
export function deductionRate() {
  return getDeductionMode() === 'insurance' ? insuranceRate() : getTaxRatePct() / 100;
}
// The single active deduction as a percentage (e.g. 3.3 or 9.2), per current mode.
export function deductionPct() {
  return getDeductionMode() === 'insurance' ? insuranceRatePct() : getTaxRatePct();
}
// Display-facing active percentage, rounded to 2dp.
export function getActiveDeductionPct() {
  return Math.round(deductionRate() * 100 * 100) / 100;
}
// Apply whichever deduction mode is active. (Historically named applyTax; kept
// under that name because every call site says applyTax and the math is the same
// whether the active mode is tax or insurance.)
export function applyTax(g) { return Math.round(g * (1 - deductionRate())); }

// ── Shift rotation ───────────────────────────────────────────────────────────
// Anchor-based propagation: the most recent anchor ≤ this week decides the base
// shift; unless the two most recent anchors agree (a fixed pattern), the shift
// alternates day/night every week.
export function shiftFor(s) {
  const sh = getShifts(), ws = getMonday(s);
  const keys = Object.keys(sh).filter(k => k <= ws).sort();
  if (!keys.length) return 'day';
  const anchor = keys[keys.length - 1];
  const anchorShift = sh[anchor];
  if (keys.length >= 2 && sh[keys[keys.length - 2]] === anchorShift) return anchorShift;
  const msPerWeek = 7 * 24 * 3600 * 1000;
  const weeks = Math.round((pd(ws) - pd(anchor)) / msPerWeek);
  return weeks % 2 === 0 ? anchorShift : (anchorShift === 'day' ? 'night' : 'day');
}

// True when the user works a single fixed shift (day-only or night-only) rather
// than an alternating rotation. Fixed mode is ≥2 anchors that are all the same.
export function isFixedShiftPattern() {
  const sh = getShifts();
  const vals = Object.values(sh).filter(v => v === 'day' || v === 'night');
  if (vals.length < 2) return false;
  return vals.every(v => v === vals[0]);
}

// ── calcSatLike ──────────────────────────────────────────────────────────────
// Shared formula for Saturday, worked-Holiday and worked-Sunday hours.
// `mode` ('saturday' | 'holiday' | 'sunday') only picks note labels — the
// numeric formulas are identical across all three.
function calcSatLike(shift, regHrs, otHrs, tr, mode) {
  let eff = 0, notes = [];
  const labelBase = mode === 'holiday' ? (shift === 'day' ? tr.nHolDay : tr.nHolNight)
                  : mode === 'sunday'  ? (shift === 'day' ? tr.nSunDay : tr.nSunNight)
                  :                      (shift === 'day' ? tr.nSatDay : tr.nSatNight);
  const labelOT   = mode === 'holiday' ? (shift === 'day' ? tr.nHolDayOT : tr.nHolNightOT)
                  : mode === 'sunday'  ? (shift === 'day' ? tr.nSunDayOT : tr.nSunNightOT)
                  :                      (shift === 'day' ? tr.nSatDayOT : tr.nSatNightOT);
  if (shift === 'day') {
    eff = satDayEff(regHrs); notes.push(labelBase(regHrs));
    if (otHrs > 0) { const e = +(otHrs * 1.5).toFixed(2); eff = +(eff + e).toFixed(2); notes.push(labelOT(otHrs)); }
  } else {
    eff = satNightEff(regHrs); notes.push(labelBase(regHrs));
    if (otHrs > 0) { const e = +(otHrs * 2).toFixed(2); eff = +(eff + e).toFixed(2); notes.push(labelOT(otHrs)); }
  }
  return { eff, notes };
}

// ── calcWage ─────────────────────────────────────────────────────────────────
// Returns { gross, net, eff, notes }. `notes` is a localized explanation array;
// callers that don't need it (e.g. export) simply ignore it.
//
// ctx = { isHol(dateStr)→bool, holAuto→bool, tr→TR[lang] }
export function calcWage(dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride, ctx) {
  const shift = shiftOverride || shiftFor(dateStr);
  const holDay = ctx.isHol(dateStr);
  const sun = isSun(dateStr) && !holDay;
  const sat = isSat(dateStr) && !holDay;
  const tr = ctx.tr;
  let eff = 0, notes = [];
  // Resolve whether an unworked holiday gets the 8h auto-base:
  // priority is per-day override (holCreditOverride) > global setting (ctx.holAuto).
  const holCredit = holCreditOverride !== undefined ? holCreditOverride : ctx.holAuto;

  // ── Double shift ───────────────────────────────────────────────────────────
  // Fixed formula regardless of day type; no regHrs input (OT still applies).
  //   weekday=21.16, sat=25.16, sun/hol(auto)=33.16, hol(no-auto)=25.16
  if (shift === 'double') {
    const nightEff = +(satNightEff(8)).toFixed(2); // 13.16
    const dayWeekdayEff = 8;
    const daySatEff = +(8 / 8 * 12).toFixed(2);    // 12
    if (sun || holDay) {
      const hasAutoBase = sun || (holDay && holCredit);
      if (hasAutoBase) {
        eff = +(8 + daySatEff + nightEff).toFixed(2);  // 33.16
        notes.push(tr.nDoubleHolSun);
      } else {
        eff = +(daySatEff + nightEff).toFixed(2);      // 25.16
        notes.push(tr.nDoubleHolSunNoAuto || tr.nDoubleSat);
      }
    } else if (sat) {
      eff = +(daySatEff + nightEff).toFixed(2);        // 25.16
      notes.push(tr.nDoubleSat);
    } else {
      eff = +(dayWeekdayEff + nightEff).toFixed(2);    // 21.16
      notes.push(tr.nDoubleWeekday);
    }
    if (otHrs > 0) { const e = +(otHrs * 2).toFixed(2); eff = +(eff + e).toFixed(2); notes.push(tr.nNightOT(otHrs)); }
    const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff, notes };
  }

  // ── Sunday: auto 8h base always; if worked, calc worked hours like Saturday ──
  if (sun) {
    const hasWork = (regHrs > 0 || otHrs > 0);
    if (hasWork) {
      notes.push(tr.nHolBase); // reuse "8h auto-credited" note
      const worked = calcSatLike(shift, regHrs, otHrs, tr, 'sunday');
      eff = +(8 + worked.eff).toFixed(2);
      notes.push(...worked.notes);
    } else {
      notes.push(tr.nSun);
      eff = 8;
    }
    const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff, notes };
  }

  // ── Public holiday: auto 8h base only when holCredit; worked hours like Sat ──
  if (holDay) {
    if (holCredit) { notes.push(tr.nHolBase); eff = 8; }
    if (regHrs > 0 || otHrs > 0) {
      const worked = calcSatLike(shift, regHrs, otHrs, tr, 'holiday');
      eff = +(eff + worked.eff).toFixed(2);
      notes.push(...worked.notes);
    }
    const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff, notes };
  }

  // ── Saturday ─────────────────────────────────────────────────────────────────
  if (sat) {
    const r = calcSatLike(shift, regHrs, otHrs, tr, 'saturday');
    eff = r.eff; notes = r.notes;
    const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff, notes };
  }

  // ── Normal weekday ───────────────────────────────────────────────────────────
  if (shift === 'day') {
    eff = regHrs; notes.push(tr.nDay(regHrs));
    if (otHrs > 0) { const e = +(otHrs * 1.5).toFixed(2); eff = +(eff + e).toFixed(2); notes.push(tr.nDayOT(otHrs)); }
  } else {
    eff = nightWeekdayEff(regHrs); notes.push(tr.nNight(regHrs));
    if (otHrs > 0) { const e = +(otHrs * 2).toFixed(2); eff = +(eff + e).toFixed(2); notes.push(tr.nNightOT(otHrs)); }
  }
  const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff, notes };
}
