// ─────────────────────────────────────────────────────────────────────────────
// domain/deductions.js — deduction math for both modes (Phase 3).
//
// Insurance rates are employee-side percentages. Defaults are the 2026
// statutory employee shares (산재/industrial-accident is 100% employer-paid,
// so it is intentionally excluded). Long-term care (care) is legally a
// percentage OF the health premium (13.14%), not of gross — so it's stored as
// that ratio and derived from the health rate, staying correct if health
// changes.
//
// PURE: `ins` is always required here — the "default to stored rates" fallback
// (ins || getInsurance()) is app/export storage glue and stays with callers.
// ⚠ FLOAT ORDER IS BEHAVIOR (golden deductions suite): the percentage sum is
// computed once (pension + health + care + employment) and only then divided
// by 100 — exactly the operation order app.js has always used.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_INSURANCE = {
  pension:    4.75,    // 국민연금 — employee half of 9.5%
  health:     3.595,   // 건강보험 — employee half of 7.19%
  careOfHealth: 13.14, // 장기요양 — % OF the health premium (not of gross)
  employment: 0.9,     // 고용보험 — employee share (frozen for 2026)
};

// Effective long-term-care rate as a % of GROSS = health × (careOfHealth/100).
export function careRateOfGross(ins){
  return ins.health * (ins.careOfHealth/100);
}

// Combined employee deduction as a PERCENTAGE of gross (export.js's form).
export function insuranceRatePct(ins){
  return ins.pension + ins.health + careRateOfGross(ins) + ins.employment;
}

// The same as a FRACTION of gross, 0..1 (app.js's form). Sum, then /100.
export function insuranceRate(ins){
  return insuranceRatePct(ins)/100;
}

// net = round(gross × (1 − rate)) — the single rounding both sides always used.
export function applyDeductionRate(gross, rate){
  return Math.round(gross*(1-rate));
}
