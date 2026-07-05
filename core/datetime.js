// ─────────────────────────────────────────────────────────────────────────────
// core/datetime.js
// Pure date helpers operating on 'YYYY-MM-DD' local-date strings.
//
// These were byte-for-byte duplicated in app.js and export.js. They have no
// dependencies and no side effects, so they live here and are imported by both.
// All functions treat the string as a *local* calendar date (never UTC), which
// is what the rest of the app assumes.
// ─────────────────────────────────────────────────────────────────────────────

export function pad(n) { return String(n).padStart(2, '0'); }

// (year, monthIndex0, day) → 'YYYY-MM-DD'. Note month is 0-based, matching Date.
export function mkds(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }

// 'YYYY-MM-DD' → local Date at midnight.
export function pd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }

// Today as 'YYYY-MM-DD' (local).
export function today() { const d = new Date(); return mkds(d.getFullYear(), d.getMonth(), d.getDate()); }

// Day-of-week for a date string: 0=Sun … 6=Sat.
export function dowOf(s) { return pd(s).getDay(); }

export function isSun(s) { return dowOf(s) === 0; }
export function isSat(s) { return dowOf(s) === 6; }

// The Monday (as 'YYYY-MM-DD') of the ISO week containing `s`.
export function getMonday(s) {
  const d = pd(s), day = d.getDay(), diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const m = new Date(d); m.setDate(diff);
  return mkds(m.getFullYear(), m.getMonth(), m.getDate());
}
