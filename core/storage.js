// ─────────────────────────────────────────────────────────────────────────────
// core/storage.js
// The localStorage access layer: the low-level get/set primitives plus the
// typed accessors (logs, shifts, wages, insurance, deduction mode…).
//
// These were duplicated across app.js and export.js. Consolidating them removes
// the risk of the two modules reading a key with different defaults or parse
// semantics. This module has NO dependency on firebase — the sync side-effect
// (scheduleSync) stays in app.js's thin save wrappers, so importing storage
// here can never create a circular import with the sync layer.
// ─────────────────────────────────────────────────────────────────────────────

import { LS, DEFAULT_WAGE, DEFAULT_INSURANCE, WAGE_EPOCH_DATE } from './constants.js';

// ── Primitives ───────────────────────────────────────────────────────────────
// ld: JSON-parse a key, returning `d` on miss or any error (blocked storage,
// corrupt JSON). sv: JSON-stringify and write. Identical to the originals.
export function ld(k, d) {
  try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : d; }
  catch { return d; }
}
export function sv(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

// ── Simple typed reads ───────────────────────────────────────────────────────
export function getLogs()   { return ld(LS.logs, {}); }
export function getShifts() { return ld(LS.shifts, {}); }

export function getDeductionMode() { return ld(LS.deductionMode, 'tax'); }
export function getInsurance() {
  const s = ld(LS.insurance, null);
  return s ? { ...DEFAULT_INSURANCE, ...s } : { ...DEFAULT_INSURANCE };
}
export function getTaxRatePct() { return ld(LS.taxRate, 3.3); } // percentage, e.g. 3.3
export function isHolAuto()     { return ld(LS.holAuto, true) !== false; }

// ── Wages ────────────────────────────────────────────────────────────────────
// Stored as wt4_wages: [{date:'YYYY-MM-DD', amount:number}, …] ascending by date.
//
// getWages() is a pure read: it never writes (this matches how export.js has
// always consumed it, and is safe to call from any context). The one-time
// legacy migrations that app.js performed inside its getWages() are split out
// into migrateWages(), which app.js calls explicitly via a persist callback so
// the write side-effect stays where it belongs.
export function getWages() {
  const wages = ld(LS.wages, null);
  if (wages) return wages;
  const legacy = ld(LS.wageLegacy, null);
  return [{ date: WAGE_EPOCH_DATE, amount: legacy !== null ? legacy : DEFAULT_WAGE }];
}

// Perform the legacy → current migrations and persist ONLY when there is real
// pre-existing data to migrate. Crucially, this must NOT fabricate-and-write a
// default wages entry for a brand-new user: onboarding's "has this user any
// data?" check reads wt4_wages, so writing it here would make a first-ever
// visitor look like a returning user and wrongly skip onboarding. A fresh user
// gets their wt4_wages written later, the first time saveWages() runs (or lazily
// via getWages()'s in-memory default until then).
// `persist(key, value)` and `remove(key)` are injected so this module stays free
// of any direct coupling to the sync layer. Returns the wages array in memory.
export function migrateWages(persist, remove) {
  const existing = ld(LS.wages, null);
  if (existing) {
    // Replace the historical 2000-01-01 placeholder origin with the real epoch.
    let dirty = false;
    existing.forEach(e => { if (e.date === '2000-01-01') { e.date = WAGE_EPOCH_DATE; dirty = true; } });
    if (dirty) persist(LS.wages, existing);
    return existing;
  }
  const legacy = ld(LS.wageLegacy, null);
  if (legacy !== null) {
    // A legacy scalar wage exists → migrate it to the array form and drop the old key.
    const initial = [{ date: WAGE_EPOCH_DATE, amount: legacy }];
    persist(LS.wages, initial);
    remove(LS.wageLegacy);
    return initial;
  }
  // Brand-new user: no wages, no legacy key. Return the in-memory default WITHOUT
  // writing, so onboarding's hasData check still sees a clean slate.
  return [{ date: WAGE_EPOCH_DATE, amount: DEFAULT_WAGE }];
}

// The wage active on `dateStr` — the most recent entry whose date ≤ dateStr.
export function wageFor(dateStr) {
  const wages = getWages();
  let active = DEFAULT_WAGE;
  for (const { date, amount } of wages) {
    if (date <= dateStr) active = amount;
    else break;
  }
  return active;
}
