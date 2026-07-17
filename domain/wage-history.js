// ─────────────────────────────────────────────────────────────────────────────
// domain/wage-history.js — the wt4_wages timeline (Phase 3).
//
// wt4_wages is [{date:'YYYY-MM-DD', amount}] sorted ascending; the entry
// active on a date is the LAST one dated ≤ it. normalizeWages carries both
// migrations app.js has always applied on read:
//   • legacy scalar wt4_wage → a single initial entry (fromLegacy:true tells
//     the caller to remove the old key);
//   • placeholder 2000-01-01 origin dates → the real 2026-01-01 effective date.
// PURE: callers persist when dirty. app.js writes; export.js reads only — in a
// running app the app path has always migrated before any export runs, so the
// read-only path never observes unmigrated data in practice.
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeWages(raw, legacyScalar, defaultWage){
  if(raw){
    let dirty = false;
    raw.forEach(e=>{ if(e.date==='2000-01-01'){e.date='2026-01-01';dirty=true;} });
    return { wages: raw, dirty, fromLegacy: false };
  }
  return {
    wages: [{date:'2026-01-01', amount: legacyScalar !== null ? legacyScalar : defaultWage}],
    dirty: true,
    fromLegacy: true,
  };
}

// The wage active on dateStr (last entry dated ≤ it), verbatim app.js wageFor.
export function wageForIn(wages, dateStr, defaultWage){
  let active = defaultWage;
  for(const {date, amount} of wages){
    if(date <= dateStr) active = amount;
    else break;
  }
  return active;
}

// Index of the entry active today — may not be the newest row when a
// future-dated wage change exists (same rule as wageForIn).
export function activeWageIdx(wages, todayStr){
  let idx = 0;
  wages.forEach((w,i)=>{ if(w.date<=todayStr) idx=i; });
  return idx;
}
