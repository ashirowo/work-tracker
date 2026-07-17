// ─────────────────────────────────────────────────────────────────────────────
// core/dates.js — pure calendar-string helpers (Phase 2 of the structural
// refactor). One home for the date math that lived in app.js and was
// byte-duplicated in export.js. Bodies are verbatim from app.js.
//
// PURITY CONTRACT: no storage, no DOM, and deliberately NO today() — "today"
// stays with each consumer (app.js's is reassigned by the golden oracle to a
// pinned fixture date; export.js's todayStr is pinned via the global Date in
// the export suite). calc.js keeps its own private pd/dowOf on purpose
// (engine purity) — that duplication is deliberate; do not "fix" it here.
// ─────────────────────────────────────────────────────────────────────────────

export function pad(n){return String(n).padStart(2,'0');}
export function mkds(y,m,d){return`${y}-${pad(m+1)}-${pad(d)}`;}
export function pd(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
export function dowOf(s){return pd(s).getDay();}
export function isSun(s){return dowOf(s)===0;}
export function isSat(s){return dowOf(s)===6;}
// Monday of the week containing date-string s (weeks run Mon–Sun).
export function getMonday(s){
  const d=pd(s),day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);
  const m=new Date(d);m.setDate(diff);
  return mkds(m.getFullYear(),m.getMonth(),m.getDate());
}
