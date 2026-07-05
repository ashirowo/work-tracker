// ─────────────────────────────────────────────────────────────────────────────
// core/constants.js
// Single source of truth for localStorage keys and app-wide defaults.
//
// Before this module existed, the `wt4_*` key strings were duplicated as raw
// literals across app.js, export.js and firebase.js (firebase.js kept a partial
// third copy in its SYNC_KEYS map). That is exactly how a renamed key silently
// desyncs one module from the others. Every module now imports from here.
// ─────────────────────────────────────────────────────────────────────────────

// ── localStorage keys ────────────────────────────────────────────────────────
export const LS = {
  logs:          'wt4_logs',
  shifts:        'wt4_shifts',
  wages:         'wt4_wages',
  wageLegacy:    'wt4_wage',          // legacy scalar; migrated into `wages`
  lang:          'wt4_lang',
  theme:         'wt4_theme',
  taxRate:       'wt4_tax_rate',
  holAuto:       'wt4_hol_auto',
  deductionMode: 'wt4_deduction_mode',
  insurance:     'wt4_insurance',
  targetHrs:     'wt4_target_hrs',
  expFormat:     'wt4_exp_format',
  rulesCollapsed:'wt4_rules_collapsed',
  onboarding:    'wt4_onboarding',
  obState:       'wt4_ob_state',
  synced:        'wt4_synced',
  cloudPulled:   'wt4_cloud_pulled',
  // Prefixed families (suffixed with a year at the call site):
  govPrefix:     'wt4_gov_',          // wt4_gov_<year>  → { ko, en } holiday maps
  holPrefix:     'wt4_hol_',          // wt4_hol_<year>
  holKoPrefix:   'wt4_hol_ko_',       // wt4_hol_ko_<year>
};

// ── Wage / tax defaults ──────────────────────────────────────────────────────
export const DEFAULT_WAGE = 10320;   // 2026 Korean minimum hourly wage (₩)
export const DEFAULT_TAX  = 3.3;     // freelancer withholding %, out-of-the-box
// The date from which the initial wage entry is considered effective. Also used
// as the migration target for the legacy 2000-01-01 placeholder origin date.
export const WAGE_EPOCH_DATE = '2026-01-01';

// ── 4대 보험 (insurance) defaults ────────────────────────────────────────────
// 2026 statutory employee-side percentages. 산재 (industrial-accident) is 100%
// employer-paid and intentionally excluded. Long-term care (careOfHealth) is a
// percentage OF the health premium (13.14%), not of gross, so it is derived from
// the health rate and stays correct if health changes.
export const DEFAULT_INSURANCE = {
  pension:      4.75,   // 국민연금 — employee half of 9.5%
  health:       3.595,  // 건강보험 — employee half of 7.19%
  careOfHealth: 13.14,  // 장기요양 — % OF the health premium (not of gross)
  employment:   0.9,    // 고용보험 — employee share (frozen for 2026)
};

// ── One-tap default inference tunables ───────────────────────────────────────
export const QUICK_LOG_MIN_SAMPLES    = 3;    // need at least this many same-type logs
export const QUICK_LOG_MIN_CONFIDENCE = 0.7;  // ≥70% must share the modal hours value
