// ─────────────────────────────────────────────────────────────────────────────
// domain/log-entries.js — the stored log-entry shape (Phase 2).
//
// A wt4_logs entry is { regHrs, otHrs, hrs, gross, net, eff, shiftOverride?,
// holCreditOverride?, note? }. LEGACY entries (pre wage-history) carried a
// single {hrs} field; every reader must fall back to it. That fallback used
// to be inlined at five call sites (app.js ×4, export.js ×1) — this is its
// single home now. The stored shape is frozen API: entries written years ago
// must keep computing identically (pinned by the golden liveDisplay suite's
// legacy-entry invariant).
// ─────────────────────────────────────────────────────────────────────────────

// Regular/overtime hours of an entry, with the legacy {hrs} fallback.
export function entryHours(l){
  return {
    reg: l.regHrs !== undefined ? l.regHrs : (l.hrs || 0),
    ot:  l.otHrs  !== undefined ? l.otHrs  : 0,
  };
}

// An explicit zero-hour entry (a deliberately logged day off). Legacy {hrs}
// entries are never zero-days (their regHrs is undefined) — identical to the
// inline checks this replaces.
export function isZeroDay(l){ return l.regHrs===0 && l.otHrs===0; }
