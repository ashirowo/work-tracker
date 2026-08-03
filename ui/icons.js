// ─────────────────────────────────────────────────────────────────────────────
// ui/icons.js — shared inline-SVG icon constants (Phase 6).
//
// WZI: the pay-rules wizard / workplace-form glyph set (shared by the form and
// onboarding). SHM_IC_*: the share/import code-entry glyphs (shared by the
// share-widgets and the modals/onboarding that use them). Pure data — SVG
// strings and nothing else. More icon families (header strokes, FLAGS,
// RULE_ICONS) join here as their consumers move in later phases.
// ─────────────────────────────────────────────────────────────────────────────

export const WZI={
  factory:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>',
  std:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
  custom:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  check:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  moon:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  prem:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>',
  info:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  coffee:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>',
  spark:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  cal:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  sun:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  clock:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  rest:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 12a11.05 11.05 0 0 0-22 0zm-5 7a3 3 0 0 1-6 0v-7"/></svg>',
  minus:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  plus:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  // Split-onboarding additions: preset-card + section glyphs
  users:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  gear:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  restore:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  office:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>',
  shield:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  cycle:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>',
  lock:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  arrowR:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>',
};

// ── Bottom-nav / tab-row glyphs ─────────────────────────────────────────────
// The three top-level destinations. Same 24-unit grid, same round caps and
// joins as WZI, so they sit in the app's existing stroke family — `calendar`
// and `settings` are literally WZI.cal and WZI.gear at nav size.
//
// stroke-width is deliberately NOT set here: the bar animates it (1.85 idle →
// 2.15 active) and a presentation attribute would be dead weight under the CSS
// that drives it. The glyphs are decorative — the tab's text label names the
// destination — so they carry aria-hidden and the width/height only exist as a
// pre-CSS fallback; --nav-icon is the real size.
export const NAV={
  calendar:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  // Ascending bars — the Overview tab's own content (earnings trend, monthly
  // breakdown) rather than a generic chart. Three strokes carry far less
  // optical weight than the calendar's 18-unit rect or the gear's ring, so the
  // glyph is drawn to a wider 14×17 footprint than Feather's bar-chart-2 to
  // hold its own between them.
  overview:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="20" x2="5" y2="14"/><line x1="12" y1="20" x2="12" y2="8.5"/><line x1="19" y1="20" x2="19" y2="3"/></svg>',
  settings:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

export const SHM_IC_CHECK='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
export const SHM_IC_SEARCH='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

// ── Rules rows (Settings card + import preview) ──────────────────────────────
// Icons are keyed by the rule KIND buildRulesRows tags each row with — never
// by row position, which shifts as optional rules (Saturday, Sunday credit…)
// drop out of the profile. Module-scope so the workplace-import preview
// (Phase 6.3) renders a candidate profile with the exact same card rows.
// (Moved here from app.js in Phase 8e; consumed by ui/views/settings.js and,
// via wpShareCtx.ruleRowsHTML, by the workplace-share import preview.)
const RULE_ICONS={
  // Day — gold sun (matches the app's day-shift ☀ convention)
  day:    {color:'#fbbf24',glow:'rgba(251,191,36,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`},
  // Night — purple moon (matches the app's night-shift convention)
  night:  {color:'#a78bfa',glow:'rgba(138,100,255,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`},
  // Double — teal rotate (matches the app's double-shift convention)
  double: {color:'#00d2be',glow:'rgba(0,210,190,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`},
  // Sunday rest credit — pink sparkle
  sunday: {color:'#f472b6',glow:'rgba(244,114,182,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/></svg>`},
  // Holiday credit — red alert circle
  holiday:{color:'#f87171',glow:'rgba(248,113,113,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`},
  // Tax/deduction — yellow percent
  tax:    {color:'#fbbf24',glow:'rgba(251,191,36,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`},
};
export function ruleRowsHTML(rows){
  return rows.map(([type,rule,kind])=>{
    const ic=RULE_ICONS[kind]||RULE_ICONS.tax;
    return`<div class="sr-row">
      <div class="sr-icon-wrap" style="--ic:${ic.color};--ig:${ic.glow};">${ic.svg}</div>
      <div class="sr-name">${type}</div>
      <div class="sr-desc">${rule}</div>
    </div>`;
  }).join('');
}

// ── Header icons ──────────────────────────────────────────────────────────────
// Inline SVGs so header controls match the app's stroked iconography instead of
// emoji (which render inconsistently across platforms and clash with the UI).
// All share: 16px box, currentColor, stroke-width 2, round caps/joins.
const _svg=(inner,w=16)=>`<svg class="hdr-svg" width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
export const ICON_SUN   =_svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>');
export const ICON_MOON  =_svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');
export const ICON_GLOBE =_svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>');
// Google "G" — multicolor, matches the OAuth provider. Fixed colors (not currentColor).
export const ICON_GOOGLE=`<svg class="hdr-svg" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>`;
export const ICON_OFFLINE=_svg('<path d="M18 10h-1.26a8 8 0 0 0-3.4-4.5"/><path d="M6.3 6.3A8 8 0 0 0 9 20h9a5 5 0 0 0 1.9-.37"/><path d="M2 2l20 20"/>',15);
// Sync states — cloud (synced), cloud with arrows (pending), cloud-off (offline)
export const SYNC_ICONS={
  synced:  _svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',15),
  pending: _svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><path d="M9.5 14.5l1.6 1.6 3-3.2"/>',15),
  offline: _svg('<path d="M18 10h-1.26a8 8 0 0 0-3.4-4.5"/><path d="M6.3 6.3A8 8 0 0 0 9 20h9a5 5 0 0 0 1.9-.37"/><path d="M2 2l20 20"/>',15),
  idle:    '',
};

// ── Language flag icons ────────────────────────────────────────────────────────
// Emoji flags (🇺🇸 etc.) are regional-indicator pairs, and Windows ships no flag
// glyphs — every Windows browser falls back to rendering the bare letters ("US",
// "KR", …). These inline SVG data-URIs (flag-icons, MIT) render identically on
// every platform and stay offline-safe (no CDN, cached with the shell). Keyed by
// language code, so en→US, ko→KR, zh→CN, ja→JP, vi→VN.
const FLAGS={
    ko:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20id%3D%22flag-icons-kr%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3CclipPath%20id%3D%22kr-a%22%3E%3Cpath%20fill-opacity%3D%22.7%22%20d%3D%22M-95.8-.4h682.7v512H-95.8z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3Cg%20fill-rule%3D%22evenodd%22%20clip-path%3D%22url(%23kr-a)%22%20transform%3D%22translate(89.8%20.4)scale(.9375)%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M-95.8-.4H587v512H-95.8Z%22%2F%3E%3Cg%20transform%3D%22rotate(-56.3%20361.6%20-101.3)scale(10.66667)%22%3E%3Cg%20id%3D%22kr-c%22%3E%3Cpath%20id%3D%22kr-b%22%20fill%3D%22%23000001%22%20d%3D%22M-6-26H6v2H-6Zm0%203H6v2H-6Zm0%203H6v2H-6Z%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23kr-b%22%20width%3D%22100%25%22%20height%3D%22100%25%22%20y%3D%2244%22%2F%3E%3C%2Fg%3E%3Cpath%20stroke%3D%22%23fff%22%20d%3D%22M0%2017v10%22%2F%3E%3Cpath%20fill%3D%22%23cd2e3a%22%20d%3D%22M0-12a12%2012%200%200%201%200%2024Z%22%2F%3E%3Cpath%20fill%3D%22%230047a0%22%20d%3D%22M0-12a12%2012%200%200%200%200%2024A6%206%200%200%200%200%200Z%22%2F%3E%3Ccircle%20cy%3D%22-6%22%20r%3D%226%22%20fill%3D%22%23cd2e3a%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22rotate(-123.7%20191.2%2062.2)scale(10.66667)%22%3E%3Cuse%20xlink%3Ahref%3D%22%23kr-c%22%20width%3D%22100%25%22%20height%3D%22100%25%22%2F%3E%3Cpath%20stroke%3D%22%23fff%22%20d%3D%22M0-23.5v3M0%2017v3.5m0%203v3%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    en:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-us%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23bd3d44%22%20d%3D%22M0%200h640v480H0%22%2F%3E%3Cpath%20stroke%3D%22%23fff%22%20stroke-width%3D%2237%22%20d%3D%22M0%2055.3h640M0%20129h640M0%20203h640M0%20277h640M0%20351h640M0%20425h640%22%2F%3E%3Cpath%20fill%3D%22%23192f5d%22%20d%3D%22M0%200h364.8v258.5H0%22%2F%3E%3Cmarker%20id%3D%22us-a%22%20markerHeight%3D%2230%22%20markerWidth%3D%2230%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22m14%200%209%2027L0%2010h28L5%2027z%22%2F%3E%3C%2Fmarker%3E%3Cpath%20fill%3D%22none%22%20marker-mid%3D%22url(%23us-a)%22%20d%3D%22m0%200%2016%2011h61%2061%2061%2061%2060L47%2037h61%2061%2060%2061L16%2063h61%2061%2061%2061%2060L47%2089h61%2061%2060%2061L16%20115h61%2061%2061%2061%2060L47%20141h61%2061%2060%2061L16%20166h61%2061%2061%2061%2060L47%20192h61%2061%2060%2061L16%20218h61%2061%2061%2061%2060z%22%2F%3E%3C%2Fsvg%3E',
    zh:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20id%3D%22flag-icons-cn%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3Cpath%20id%3D%22cn-a%22%20fill%3D%22%23ff0%22%20d%3D%22M-.6.8%200-1%20.6.8-1-.3h2z%22%2F%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%22%23ee1c25%22%20d%3D%22M0%200h640v480H0z%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(71.9991%200%200%2072%20120%20120)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(-12.33562%20-20.5871%2020.58684%20-12.33577%20240.3%2048)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(-3.38573%20-23.75998%2023.75968%20-3.38578%20288%2095.8)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(6.5991%20-23.0749%2023.0746%206.59919%20288%20168)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(14.9991%20-18.73557%2018.73533%2014.99929%20240%20216)%22%2F%3E%3C%2Fsvg%3E',
    ja:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-jp%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3CclipPath%20id%3D%22jp-a%22%3E%3Cpath%20fill-opacity%3D%22.7%22%20d%3D%22M-88%2032h640v480H-88z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3Cg%20fill-rule%3D%22evenodd%22%20stroke-width%3D%221pt%22%20clip-path%3D%22url(%23jp-a)%22%20transform%3D%22translate(88%20-32)%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M-128%2032h720v480h-720z%22%2F%3E%3Ccircle%20cx%3D%22523.1%22%20cy%3D%22344.1%22%20r%3D%22194.9%22%20fill%3D%22%23bc002d%22%20transform%3D%22translate(-168.4%208.6)scale(.76554)%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    id:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-id%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23e70011%22%20d%3D%22M0%200h640v240H0Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%20240h640v240H0Z%22%2F%3E%3C%2Fsvg%3E',
    ru:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-ru%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%230039a6%22%20d%3D%22M0%20160h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%23d52b1e%22%20d%3D%22M0%20320h640v160H0z%22%2F%3E%3C%2Fsvg%3E',
    th:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-th%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cg%20fill-rule%3D%22evenodd%22%3E%3Cpath%20fill%3D%22%23f4f5f8%22%20d%3D%22M0%200h640v480H0z%22%2F%3E%3Cpath%20fill%3D%22%232d2a4a%22%20d%3D%22M0%20162.5h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%23a51931%22%20d%3D%22M0%200h640v82.5H0zm0%20400h640v80H0z%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    vi:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-vn%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3CclipPath%20id%3D%22vn-a%22%3E%3Cpath%20fill-opacity%3D%22.7%22%20d%3D%22M-85.3%200h682.6v512H-85.3z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3Cg%20fill-rule%3D%22evenodd%22%20clip-path%3D%22url(%23vn-a)%22%20transform%3D%22translate(80)scale(.9375)%22%3E%3Cpath%20fill%3D%22%23da251d%22%20d%3D%22M-128%200h768v512h-768z%22%2F%3E%3Cpath%20fill%3D%22%23ff0%22%20d%3D%22M349.6%20381%20260%20314.3l-89%2067.3L204%20272l-89-67.7%20110.1-1%2034.2-109.4L294%20203.1l110.1.4-88.5%2068.4%2033.9%20109.2z%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
};
// Renders a language flag as an isolated <img> (data-URI SVG), so each flag's
// internal element ids can't collide when the same flag appears more than once.
export const flagImg=(code,cls)=>`<img class="${cls}" src="${FLAGS[code]||''}" alt="" aria-hidden="true" draggable="false">`;
