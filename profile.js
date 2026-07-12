// ─────────────────────────────────────────────────────────────────────────────
// profile.js — the workplace pay profile (execution schema, v1). Phase 2a.
//
// A profile is PURE DATA that parameterizes the fixed calculation pipeline in
// calc.js. Everything that used to be hardcoded company policy — the 5.68h
// night boundary, the ×1.5/×2 multipliers, the 8h credits, the double-shift
// composition — lives in this object. calc.js interprets it; it contains no
// code and can therefore sync through Firestore exactly like wage history.
//
// STORAGE: localStorage key 'wt4_profile'. When absent or unrecognized,
// consumers fall back to DEFAULT_PROFILE below, which reproduces the app's
// historical behavior bit-for-bit (verified by tests/golden-check.mjs) — so
// every existing user is grandfathered with zero visible change.
//
// SCHEMA (v1 — only fields the engine consumes; authoring fields such as
// wizard answers arrive with the compiler in a later phase):
//
//   v          schema version (number). Unrecognized versions → default.
//   id         stable identifier of the rule set (provenance/debugging).
//   shifts     the shift ids a day can be logged as (the UI's toggle).
//   restDow    weekly rest/credit day, 0=Sunday … 6=Saturday.
//   rates      dayClass → shiftId → { reg: Bracket[], ot: multiplier }
//              A dayClass may instead be { workedAs: otherClass } — an alias:
//              worked hours use the other class's MATH while keeping its own
//              display labels (exactly how Sundays/holidays reuse the
//              Saturday formulas today). Aliases are single-hop.
//   Bracket    { upTo?: hours, mult } applied to the marginal hours in order;
//              the last bracket omits upTo (open-ended). upTo is an ABSOLUTE
//              threshold of the day's regular hours, not a bracket width.
//   credits    phantom effective hours granted without work:
//                restday: { hours, when:'always' }   — engine-level: calcWage
//                          has always credited the rest day unconditionally;
//                          the "all weekdays logged" gate applies only to
//                          UNLOGGED rest days at the display layer (liveGross)
//                          and is generalized in a later phase.
//                holiday: { hours, when:'holAuto' }  — resolved per call from
//                          the holCreditOverride > holAuto precedence.
//   composites shiftId → { parts:[{shift, hours, table:'inherit'|class}], ot }
//              A composite (the double shift) sums its parts' bracket tables;
//              'inherit' means "this day's (aliased) class", a named class
//              pins the table — the night half of a double always uses the
//              Saturday-night table, even on weekdays (verified quirk).
// ─────────────────────────────────────────────────────────────────────────────

export const PROFILE_SCHEMA_V = 1;

export const DEFAULT_PROFILE = {
  v: 1,
  id: 'kr-factory-2shift',
  shifts: ['day', 'night'],
  restDow: 0,
  rates: {
    weekday: {
      day:   { reg: [{ mult: 1 }],                              ot: 1.5 },
      night: { reg: [{ upTo: 5.68, mult: 1 },   { mult: 1.5 }], ot: 2 },
    },
    saturday: {
      day:   { reg: [{ mult: 1.5 }],                            ot: 1.5 },
      night: { reg: [{ upTo: 5.68, mult: 1.5 }, { mult: 2 }],   ot: 2 },
    },
    restday: { workedAs: 'saturday' },
    holiday: { workedAs: 'saturday' },
  },
  credits: {
    restday: { hours: 8, when: 'always' },
    holiday: { hours: 8, when: 'holAuto' },
  },
  composites: {
    double: {
      parts: [
        { shift: 'day',   hours: 8, table: 'inherit' },
        { shift: 'night', hours: 8, table: 'saturday' },
      ],
      ot: 2,
    },
  },
};

// Minimal recognition check used by getProfile() fallbacks in app.js/export.js.
// Deliberately shallow: an unrecognized or partial object must never half-run —
// it falls back to the default wholesale.
export function isUsableProfile(p) {
  // Accept both v1 (execution form) and v2 (authoring form, lowered at calc
  // time by normalizeProfile). Rejecting v2 here would silently drop every
  // wizard-authored workplace back to the default — a critical regression.
  return !!(p && (p.v === PROFILE_SCHEMA_V || p.v === 2) && p.rates && p.rates.weekday &&
            p.rates.saturday && p.credits && p.composites);
}
