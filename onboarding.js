// ─────────────────────────────────────────────────────────────────────────────
// onboarding.js — first-run onboarding flow, extracted from app.js.
//
// A self-contained sub-app: it owns its own session state (OB), its own
// translator (ot), and its own lifecycle (mount → step transitions → complete).
// It was already an IIFE with a bounded set of dependencies on app.js; those are
// now passed in explicitly via initOnboarding({ S, render, getCurrentUser }):
//   • S              — the app's live settings object (read AND mutated on finish)
//   • render         — the app's top-level re-render
//   • getCurrentUser — getter for the current Firebase user (may change over time)
// Everything else (storage, payroll, holidays, firebase, translations) is
// imported directly, exactly like app.js imports it.
//
// initOnboarding() early-returns when the user is already onboarded, so app.js
// can call it unconditionally at startup and only fall through to the normal
// render path when onboarding does not take over.
// ─────────────────────────────────────────────────────────────────────────────

import { ld, sv } from './core/storage.js';
import { getMonday, today, pd } from './core/datetime.js';
import { DEFAULT_WAGE, DEFAULT_TAX, DEFAULT_INSURANCE } from './core/constants.js';
import { insuranceRate } from './core/payroll.js';
import { prefetchHolidays } from './core/holidays.js';
import { signInWithGoogle, scheduleSync } from './firebase.js';
import { TR } from './translations.js';

// ── Onboarding ────────────────────────────────────────────────────────────────
// Fullscreen first-run experience. Shown only to genuinely new users; existing
// users (any saved data) are auto-flagged as onboarded so they never see it.
//
// Flow (4 screens):
//   1 Welcome  — brand hero, language, and a "restore from Google" fast path
//   2 Pattern  — rotation / fixed day / fixed night (+ inline "which week?")
//   3 Pay      — wage + tax + holiday auto-credit, with a live net-pay preview
//   4 Finish   — celebration, optional cloud backup, enter the app
//
// A returning user who restores on screen 1 jumps straight to screen 4 —
// zero setup questions. Their cloud pull already rehydrated localStorage.
export function initOnboarding({ S, render, getCurrentUser }){
  // Backward-compat: if user already has data BUT onboarding was never explicitly
  // completed, mark them as onboarded silently — they pre-date this flow.
  // IMPORTANT: we only do this when there is NO active in-progress onboarding session
  // (wt4_ob_state). Otherwise a mid-session refresh would wrongly skip onboarding.
  const hasActiveSession = localStorage.getItem('wt4_ob_state') !== null;
  if(!hasActiveSession){
    const hasData = (
      Object.keys(ld('wt4_logs',{})).length > 0 ||
      Object.keys(ld('wt4_shifts',{})).length > 0 ||
      ld('wt4_wages', null) !== null ||
      ld('wt4_wage', null) !== null
    );
    if(hasData && localStorage.getItem('wt4_onboarding') === null){
      localStorage.setItem('wt4_onboarding','done');
    }
  }
  if(localStorage.getItem('wt4_onboarding') === 'done'){
    // Grandfathered/returning user — clear the first-run guard the inline script
    // may have set (its cheap heuristic can't run the full hasData check) so the
    // app shell and splash resolve correctly.
    document.documentElement.removeAttribute('data-onboarding');
    document.getElementById('ob-splash')?.remove();
    return false; // already onboarded — onboarding did NOT take over
  }

  // ── Session state ────────────────────────────────────────────────────────────
  // Restored from localStorage on refresh so the user resumes at their screen.
  // Nothing is persisted to the app's real keys until complete*() runs.
  function loadOBState(){
    try{
      const raw=localStorage.getItem('wt4_ob_state');
      if(!raw) return null;
      const s=JSON.parse(raw);
      // Migrate a session saved by the previous 8-step flow (it had no version
      // field): 1→welcome, 2–3→pattern, 4–6→pay, 7–8→finish.
      if(s && s.v !== 2){
        const map=[,1,2,2,3,3,3,4,4];
        s.step = map[s.step] || 1;
        s.v = 2;
      }
      return s;
    }catch(e){}
    return null;
  }
  function saveOBState(){
    try{
      localStorage.setItem('wt4_ob_state', JSON.stringify({
        v:2,
        step: OB.step,
        lang: OB.lang,
        pattern: OB.pattern,
        currentShift: OB.currentShift,
        wage: OB.wage,
        taxRate: OB.taxRate,
        dedMode: OB.dedMode,
        holAuto: OB.holAuto,
        restored: OB.restored,
      }));
    }catch(e){}
  }

  const OB_LANGS=[
    {code:'en',flag:'🇺🇸',label:'English'},
    {code:'ko',flag:'🇰🇷',label:'한국어'},
    {code:'id',flag:'🇮🇩',label:'Indonesia'},
    {code:'th',flag:'🇹🇭',label:'ภาษาไทย'},
    {code:'ru',flag:'🇷🇺',label:'Русский'},
    {code:'zh',flag:'🇨🇳',label:'中文'},
    {code:'fr',flag:'🇫🇷',label:'Français'},
    {code:'ne',flag:'🇳🇵',label:'नेपाली'},
  ];
  // Best-guess language from the browser so screen 1 usually needs zero taps.
  function detectLang(){
    const cands=navigator.languages||[navigator.language||'en'];
    for(const c of cands){
      const p=String(c).toLowerCase().slice(0,2);
      if(OB_LANGS.some(l=>l.code===p)) return p;
    }
    return 'en';
  }

  const saved = loadOBState();
  const OB = {
    step:         saved?.step         ?? 1,
    lang:         saved?.lang         ?? (ld('wt4_lang',null) ?? detectLang()),
    pattern:      saved?.pattern      ?? null,
    currentShift: saved?.currentShift ?? null,
    wage:         saved?.wage         ?? DEFAULT_WAGE,
    taxRate:      saved?.taxRate      !== undefined ? saved.taxRate : DEFAULT_TAX,
    // Deduction mode: 'tax' (flat %) or 'insurance' (Korea's 4대 보험). Defaults
    // to 'tax' to match the app; individual insurance rates stay editable in Settings.
    dedMode:      saved?.dedMode      ?? ld('wt4_deduction_mode','tax'),
    holAuto:      saved?.holAuto      !== undefined ? saved.holAuto : true, // default: auto-credit ON
    restored:     saved?.restored === true, // cloud fast path — skip setup screens
    signingIn:    false, // transient — never persisted
  };
  // Combined employee insurance % (statutory defaults) — for the live preview
  // and the "4 Insurances" total chip. Uses the app's own insuranceRate().
  const OB_INS_PCT = Math.round(insuranceRate(DEFAULT_INSURANCE)*100*100)/100;

  // Restored sessions: the cloud pull already wrote the user's real language —
  // prefer it over whatever the session captured (covers a refresh mid-finale).
  if(OB.restored) OB.lang = ld('wt4_lang', OB.lang);
  // Sync app language to whatever OB has (so ot() works correctly on resume)
  S.lang = OB.lang;

  function ot(k){ const fn=TR[OB.lang]?TR[OB.lang][k]:undefined; return typeof fn==='function'?fn():(fn||k); }
  const OB_REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ── Icons — the app's stroke-SVG vocabulary, not emoji ───────────────────────
  const oi=(paths,size=18,sw=2)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const OI={
    back:   oi('<path d="M15 18l-6-6 6-6"/>',18,2.2),
    arrow:  oi('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',17,2.2),
    cycle:  oi('<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>',19),
    sun:    oi('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',19),
    moon:   oi('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',18),
    check:  oi('<path d="M20 6L9 17l-5-5"/>',13,3),
    cal:    oi('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M9 15.5l2 2 4-4"/>',18),
    cloud:  oi('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',18), // same glyph as the app's sync badge
    google: `<svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
    spin:   '<span class="obx-spin" aria-hidden="true"></span>',
  };
  // The Shiftr wordmark — identical path to the header logo, unique gradient id
  // so it doesn't collide with the header's <defs> rendered behind the overlay.
  // Monogram tile (logo direction "2e") — a single-letter "S" in the wordmark's
  // own type, set in a rounded dark-glass tile. Built as an SVG path (the "S"
  // glyph lifted straight from the wordmark, re-centred into a 72×72 tile) so it
  // needs no extra webfont and renders identically offline. Reused by the
  // first-run splash so both brand moments match.
  const OB_MARK_S=`M8.034 21.684Q5.928 21.684 4.316 20.93Q2.704 20.176 1.794 18.772Q0.884 17.368 0.884 15.392V14.664H4.264V15.392Q4.264 17.03 5.278 17.849Q6.292 18.668 8.034 18.668Q9.802 18.668 10.673 17.966Q11.544 17.264 11.544 16.172Q11.544 15.418 11.115 14.95Q10.686 14.482 9.867 14.183Q9.048 13.884 7.878 13.624L7.28 13.494Q5.408 13.078 4.069 12.441Q2.73 11.804 2.015 10.764Q1.3 9.724 1.3 8.06Q1.3 6.396 2.093 5.213Q2.886 4.03 4.329 3.393Q5.772 2.756 7.722 2.756Q9.672 2.756 11.193 3.419Q12.714 4.082 13.585 5.395Q14.456 6.708 14.456 8.684V9.464H11.076V8.684Q11.076 7.644 10.673 7.007Q10.27 6.37 9.516 6.071Q8.762 5.772 7.722 5.772Q6.162 5.772 5.421 6.357Q4.68 6.942 4.68 7.956Q4.68 8.632 5.031 9.1Q5.382 9.568 6.084 9.88Q6.786 10.192 7.878 10.426L8.476 10.556Q10.426 10.972 11.869 11.622Q13.312 12.272 14.118 13.338Q14.924 14.404 14.924 16.068Q14.924 17.732 14.079 18.993Q13.234 20.254 11.687 20.969Q10.14 21.684 8.034 21.684Z`;
  // 72×72 tile. Glyph bbox ≈ x0.884–14.924 (w14.04) / y2.756–21.684 (h18.93).
  // Scale 2.05× → 28.8×38.8; centre via translate so the S sits dead-centre.
  const OB_MONOGRAM=`<span class="obx-mark" aria-hidden="true">
    <svg viewBox="0 0 72 72" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="obmk-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7c93ff"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>
      <path d="${OB_MARK_S}" fill="url(#obmk-g)" transform="translate(19.4 10.75) scale(2.05)"/>
    </svg>
  </span>`;

  const OB_WORDMARK=`<svg class="obx-logo" viewBox="0 0 71.9 29.9" role="img" aria-label="Shiftr" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="obwm-g" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#7c93ff"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>
    <path fill="url(#obwm-g)" d="M8.033999999999999 21.684Q5.928 21.684 4.316 20.93Q2.7039999999999997 20.176000000000002 1.7939999999999998 18.772000000000002Q0.884 17.368000000000002 0.884 15.392V14.664000000000001H4.264V15.392Q4.264 17.03 5.2780000000000005 17.849Q6.292 18.668 8.033999999999999 18.668Q9.802 18.668 10.672999999999998 17.966Q11.543999999999999 17.264 11.543999999999999 16.172Q11.543999999999999 15.418 11.114999999999998 14.95Q10.686 14.482 9.867 14.183Q9.048 13.884 7.877999999999999 13.624L7.279999999999999 13.494Q5.4079999999999995 13.078000000000001 4.069 12.441Q2.73 11.804 2.015 10.764Q1.3 9.724 1.3 8.06Q1.3 6.396000000000001 2.093 5.213000000000001Q2.8859999999999997 4.030000000000001 4.329 3.3930000000000007Q5.771999999999999 2.7560000000000002 7.7219999999999995 2.7560000000000002Q9.671999999999999 2.7560000000000002 11.192999999999998 3.4190000000000005Q12.713999999999999 4.082000000000001 13.584999999999999 5.3950000000000005Q14.456 6.708 14.456 8.684000000000001V9.464H11.075999999999999V8.684000000000001Q11.075999999999999 7.644 10.672999999999998 7.007000000000001Q10.27 6.370000000000001 9.516 6.071000000000001Q8.762 5.772 7.7219999999999995 5.772Q6.162 5.772 5.420999999999999 6.357Q4.68 6.942 4.68 7.956000000000001Q4.68 8.632000000000001 5.031 9.100000000000001Q5.382 9.568000000000001 6.084 9.88Q6.786 10.192 7.877999999999999 10.426L8.475999999999999 10.556000000000001Q10.426 10.972000000000001 11.869 11.622Q13.312 12.272 14.117999999999999 13.338000000000001Q14.924 14.404 14.924 16.068Q14.924 17.732 14.079 18.993000000000002Q13.234 20.254 11.687 20.969Q10.139999999999999 21.684 8.033999999999999 21.684Z M17.575999999999997 21.32V3.120000000000001H20.851999999999997V10.010000000000002H21.32Q21.528 9.594000000000001 21.97 9.178Q22.412 8.762 23.153 8.489Q23.894 8.216000000000001 25.037999999999997 8.216000000000001Q26.546 8.216000000000001 27.677 8.905000000000001Q28.808 9.594000000000001 29.432 10.803Q30.055999999999997 12.012 30.055999999999997 13.624V21.32H26.779999999999998V13.884Q26.779999999999998 12.428 26.064999999999998 11.700000000000001Q25.349999999999998 10.972000000000001 24.023999999999997 10.972000000000001Q22.516 10.972000000000001 21.683999999999997 11.973Q20.851999999999997 12.974 20.851999999999997 14.768V21.32Z M33.592 21.32V8.424000000000001H36.867999999999995V21.32ZM35.23 6.916Q34.346 6.916 33.735 6.344Q33.123999999999995 5.772 33.123999999999995 4.836000000000002Q33.123999999999995 3.900000000000002 33.735 3.328000000000001Q34.346 2.7560000000000002 35.23 2.7560000000000002Q36.13999999999999 2.7560000000000002 36.738 3.328000000000001Q37.336 3.900000000000002 37.336 4.836000000000002Q37.336 5.772 36.738 6.344Q36.13999999999999 6.916 35.23 6.916Z M42.63999999999999 21.32V11.128H39.364V8.424000000000001H42.63999999999999V6.032000000000002Q42.63999999999999 4.7059999999999995 43.43299999999999 3.9130000000000003Q44.22599999999999 3.120000000000001 45.49999999999999 3.120000000000001H48.879999999999995V5.824000000000002H46.64399999999999Q45.916 5.824000000000002 45.916 6.604000000000001V8.424000000000001H49.29599999999999V11.128H45.916V21.32Z M56.78399999999999 21.32Q55.50999999999999 21.32 54.71699999999999 20.527Q53.92399999999999 19.734 53.92399999999999 18.408V11.128H50.699999999999996V8.424000000000001H53.92399999999999V4.420000000000002H57.199999999999996V8.424000000000001H60.73599999999999V11.128H57.199999999999996V17.836Q57.199999999999996 18.616 57.928 18.616H60.42399999999999V21.32Z M63.699999999999996 21.32V8.424000000000001H66.92399999999999V9.88H67.392Q67.678 9.100000000000001 68.341 8.736Q69.00399999999999 8.372000000000002 69.88799999999999 8.372000000000002H71.448V11.284H69.836Q68.588 11.284 67.782 11.947000000000001Q66.976 12.610000000000001 66.976 13.988V21.32Z"/>
  </svg>`;

  // ── Small helpers ─────────────────────────────────────────────────────────────
  function obWaitFor(cond,timeout){
    return new Promise(res=>{
      const t0=Date.now();
      (function poll(){
        if(cond()) return res(true);
        if(Date.now()-t0>timeout) return res(false);
        setTimeout(poll,160);
      })();
    });
  }
  function obCanProceed(){
    if(OB.step===2) return !!(OB.pattern && (OB.pattern!=='rotation' || OB.currentShift));
    return true;
  }
  function obDeductPct(){
    // The active deduction as a plain percentage, per the chosen mode.
    return OB.dedMode==='insurance' ? OB_INS_PCT : (OB.taxRate||0);
  }
  function obPreviewNet(){
    // Net pay for a plain 8-hour day shift — a tangible "here's what the app
    // will do for you" moment. Weekend/night multipliers come later, in-app.
    return Math.max(0, Math.round(8 * (OB.wage||0) * (1 - obDeductPct()/100)));
  }

  // ── Step body HTML ────────────────────────────────────────────────────────────
  function buildStepHTML(){
    if(OB.step===1){
      return `
        <div class="obx-hero" style="--i:0">
          ${OB_MONOGRAM}
          ${OB_WORDMARK}
          <p class="obx-tagline">${ot('obTagline')}</p>
        </div>
        <div class="obx-langs" style="--i:1" role="group" aria-label="${ot('obStep1Title')}">
          ${OB_LANGS.map(l=>`
            <button type="button" class="obx-lang${OB.lang===l.code?' obx-lang--active':''}" data-lang="${l.code}" aria-pressed="${OB.lang===l.code}">
              <span class="obx-lang-flag" aria-hidden="true">${l.flag}</span>
              <span class="obx-lang-label">${l.label}</span>
            </button>`).join('')}
        </div>
        <button type="button" class="btn-pri obx-cta obx-start" style="--i:2">${ot('obDoneBtn')} ${OI.arrow}</button>
        <button type="button" class="obx-ghost obx-restore" style="--i:3">${OI.google} <span>${ot('obRestoreLink')}</span></button>`;
    }

    if(OB.step===2){
      const opts=[
        {val:'rotation',cls:'',      ico:OI.cycle,title:ot('obStep2Rotation'), sub:ot('obStep2RotationSub')},
        {val:'day',     cls:' obx-opt--day',  ico:OI.sun,  title:ot('obStep2DayOnly'),  sub:ot('obStep2DayOnlySub')},
        {val:'night',   cls:' obx-opt--night',ico:OI.moon, title:ot('obStep2NightOnly'),sub:ot('obStep2NightOnlySub')},
      ];
      const rotOpen=OB.pattern==='rotation';
      return `
        <div class="obx-eyebrow" style="--i:0">1 ${ot('obOf')} 3</div>
        <h2 class="obx-title" style="--i:1">${ot('obStep2Title')}</h2>
        <div class="obx-options" style="--i:2" role="group" aria-label="${ot('obStep2Title')}">
          ${opts.map(o=>`
            <button type="button" class="obx-opt${o.cls}${OB.pattern===o.val?' obx-opt--active':''}" data-pattern="${o.val}" aria-pressed="${OB.pattern===o.val}">
              <span class="obx-opt-ico">${o.ico}</span>
              <span class="obx-opt-txt">
                <span class="obx-opt-title">${o.title}</span>
                <span class="obx-opt-sub">${o.sub}</span>
              </span>
              <span class="obx-opt-check">${OI.check}</span>
            </button>`).join('')}
        </div>
        <div class="obx-rotsub${rotOpen?' obx-rotsub--open':''}" id="ob-rot-sub" style="--i:3" aria-hidden="${rotOpen?'false':'true'}">
          <div class="obx-rotsub-in">
            <div class="obx-rotsub-card">
              <div class="obx-rotsub-q">${ot('obStep3Title')}</div>
              <div class="obx-week">
                <button type="button" class="obx-week-btn obx-week-btn--day${OB.currentShift==='day'?' obx-week-btn--active':''}" data-curshift="day" ${rotOpen?'':'tabindex="-1"'}>${OI.sun} <span>${ot('dayShift')}</span></button>
                <button type="button" class="obx-week-btn obx-week-btn--night${OB.currentShift==='night'?' obx-week-btn--active':''}" data-curshift="night" ${rotOpen?'':'tabindex="-1"'}>${OI.moon} <span>${ot('nightShift')}</span></button>
              </div>
            </div>
          </div>
        </div>
        <button type="button" class="btn-pri obx-cta obx-next" style="--i:4" ${obCanProceed()?'':'disabled'}>${ot('obNext')} ${OI.arrow}</button>`;
    }

    if(OB.step===3){
      const insMode=OB.dedMode==='insurance';
      return `
        <div class="obx-eyebrow" style="--i:0">2 ${ot('obOf')} 3</div>
        <h2 class="obx-title" style="--i:1">${ot('obPayTitle')}</h2>
        <p class="obx-sub-text" style="--i:2">${ot('obStep4Sub')}</p>
        <div class="obx-field obx-field--wage" style="--i:3">
          <label class="obx-field-label" for="ob-wage-in">${ot('obWageLabel')}</label>
          <div class="obx-input-wrap">
            <span class="obx-input-affix">₩</span>
            <input class="obx-input obx-input--wage" id="ob-wage-in" type="number" inputmode="numeric" value="${OB.wage}" min="0" step="100">
          </div>
        </div>
        <div class="obx-field" style="--i:4">
          <span class="obx-field-label">${ot('deductionsLabel')}</span>
          <div class="ded-seg obx-ded-seg" role="radiogroup" aria-label="${ot('deductionsLabel')}">
            <div class="ded-seg-pill ded-seg-pill--${OB.dedMode}" id="ob-ded-pill" style="--seg-pos:${insMode?1:0};" aria-hidden="true"></div>
            <button type="button" class="ded-tog${insMode?'':' ded-tog-on'}" role="radio" aria-checked="${!insMode}" data-ded-mode="tax">${ot('deductionModeTax')}</button>
            <button type="button" class="ded-tog${insMode?' ded-tog-on':''}" role="radio" aria-checked="${insMode}" data-ded-mode="insurance">${ot('deductionModeInsurance')}</button>
          </div>
          <!-- Tax body: a single flat % input -->
          <div class="obx-ded-body${insMode?' obx-ded-body--hidden':''}" id="ob-ded-tax">
            <div class="obx-input-wrap">
              <input class="obx-input obx-input--tax" id="ob-tax-in" type="number" inputmode="decimal" value="${OB.taxRate}" min="0" max="45" step="0.1">
              <span class="obx-input-affix">%</span>
            </div>
            <span class="obx-field-hint">${ot('taxRateRange')}</span>
          </div>
          <!-- Insurance body: statutory 4대 보험 total; details editable later in Settings -->
          <div class="obx-ded-body${insMode?'':' obx-ded-body--hidden'}" id="ob-ded-ins">
            <div class="obx-ins-summary">
              <span class="obx-ins-total-label">${ot('insuranceTotalLabel')}</span>
              <span class="obx-ins-total-val">${OB_INS_PCT}%</span>
            </div>
            <span class="obx-field-hint">${ot('obInsHint')}</span>
          </div>
        </div>
        <div class="obx-toggle-row" style="--i:5">
          <span class="obx-toggle-ico">${OI.cal}</span>
          <span class="obx-toggle-txt">
            <span class="obx-toggle-title">${ot('obStep5HolTitle')}</span>
            <span class="obx-toggle-sub">${ot('obHolShort')}</span>
          </span>
          <button type="button" class="s3-toggle${OB.holAuto?' s3-toggle--on':''}" id="ob-hol-toggle" role="switch" aria-checked="${OB.holAuto?'true':'false'}" aria-label="${ot('obStep5HolTitle')}"><span class="s3-toggle-knob"></span></button>
        </div>
        <div class="obx-preview" style="--i:6">
          <span class="obx-preview-label">${ot('obPreviewLabel')}</span>
          <span class="obx-preview-val" id="ob-preview-val">≈ ₩${obPreviewNet().toLocaleString()}</span>
        </div>
        <button type="button" class="btn-pri obx-cta obx-next" style="--i:7">${ot('obNext')} ${OI.arrow}</button>`;
    }

    // Step 4 — finish (normal or cloud-restored)
    const checkSVG=`
      <div class="obx-check" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <defs><linearGradient id="obx-check-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8a9bff"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>
          <circle class="obx-check-ring" cx="32" cy="32" r="28"/>
          <path class="obx-check-tick" d="M21 33.5l7.5 7.5L43 25.5"/>
        </svg>
      </div>`;
    const signedRow=getCurrentUser()
      ?`<div class="obx-signedin" style="--i:2">
          ${getCurrentUser().photoURL?`<img src="${getCurrentUser().photoURL}" class="avatar" alt="">`:''}
          <span>${ot('obStep5Done')} <strong>${getCurrentUser().displayName||getCurrentUser().email}</strong></span>
        </div>`
      :'';
    if(OB.restored){
      return `
        <div class="obx-finale" style="--i:0">
          ${getCurrentUser()?.photoURL?`<img src="${getCurrentUser().photoURL}" class="obx-avatar" alt="">`:checkSVG}
          <h2 class="obx-title" style="--i:0">${ot('obWelcomeBackTitle')}</h2>
          <p class="obx-sub-text" style="--i:1">${ot('obWelcomeBackSub')}</p>
        </div>
        ${signedRow}
        <button type="button" class="btn-pri obx-cta obx-finish" style="--i:3">${ot('obDoneBtn')} ${OI.arrow}</button>`;
    }
    const backupCard=getCurrentUser()
      ?signedRow
      :`<div class="obx-backup" style="--i:2">
          <div class="obx-backup-head">
            <span class="obx-backup-ico">${OI.cloud}</span>
            <span class="obx-backup-txt">
              <span class="obx-backup-title">${ot('obStep5Title')}</span>
              <span class="obx-backup-sub">${ot('obStep5Sub')}</span>
            </span>
          </div>
          <button type="button" class="obx-google ob-google-signin" ${OB.signingIn?'disabled':''}>${OB.signingIn?OI.spin:OI.google} <span>${ot('obStep5Signin')}</span></button>
        </div>`;
    return `
      <div class="obx-eyebrow" style="--i:0">3 ${ot('obOf')} 3</div>
      <div class="obx-finale" style="--i:1">
        ${checkSVG}
        <h2 class="obx-title">${ot('obDoneTitle')}</h2>
        <p class="obx-sub-text">${ot('obDoneSub')}</p>
      </div>
      ${backupCard}
      <button type="button" class="btn-pri obx-cta obx-finish" style="--i:3">${ot('obDoneBtn')} ${OI.arrow}</button>`;
  }

  // ── Top chrome: back button + tappable progress segments ─────────────────────
  function buildChromeHTML(){
    if(OB.step===1 || OB.restored) return '';
    const pos=OB.step-1; // 1..3 within the 3 setup screens
    const segs=[1,2,3].map(i=>{
      const st=i<pos?' obx-seg--done':i===pos?' obx-seg--active':'';
      return `<button type="button" class="obx-seg${st}" data-goto="${i+1}"${i<pos?'':' disabled tabindex="-1"'} aria-label="${i} ${ot('obOf')} 3"><i></i></button>`;
    }).join('');
    return `<button type="button" class="obx-back" aria-label="${ot('obBack')}">${OI.back}</button>
      <div class="obx-progress" role="group" aria-label="${pos} ${ot('obOf')} 3">${segs}</div>
      <span class="obx-chrome-spacer" aria-hidden="true"></span>`;
  }

  // ── Initial mount ─────────────────────────────────────────────────────────────
  function mountOB(){
    const ov=document.createElement('div');
    ov.className='ob-overlay';
    ov.id='ob-overlay';
    ov.innerHTML=`
      <div class="obx-ambient" aria-hidden="true"><i class="obx-orb obx-orb--a"></i><i class="obx-orb obx-orb--b"></i></div>
      <div class="obx-chrome" id="ob-chrome">${buildChromeHTML()}</div>
      <div class="obx-stage"><div class="obx-col" id="ob-body">${buildStepHTML()}</div></div>`;
    document.body.appendChild(ov);
    // The overlay is now painting over everything — retire the splash. The app
    // shell stays hidden (data-onboarding kept) so nothing shows through the
    // overlay's fade-in; complete*()/skip clears the attribute at the very end.
    document.getElementById('ob-splash')?.remove();
    wireChromeEvents();
    wireStepEvents();
  }

  // ── Screen transition: soft fade + scale with a whisper of direction ─────────
  function transitionTo(newStep, direction){
    const body=document.getElementById('ob-body');
    OB.step=newStep;
    saveOBState();
    if(!body){ mountOB(); return; }
    const swap=()=>{
      const chrome=document.getElementById('ob-chrome');
      if(chrome) chrome.innerHTML=buildChromeHTML();
      body.innerHTML=buildStepHTML();
      wireChromeEvents();
      wireStepEvents();
    };
    if(OB_REDUCED){ swap(); return; }
    body.style.setProperty('--dx',(direction>=0?14:-14)+'px');
    body.classList.add('obx-leave');
    let done=false;
    const finish=()=>{
      if(done) return; done=true;
      body.classList.remove('obx-leave');
      swap();
      body.classList.add('obx-enter');
      const clear=()=>body.classList.remove('obx-enter');
      body.addEventListener('animationend',clear,{once:true});
      setTimeout(clear,600); // safety
    };
    body.addEventListener('animationend',finish,{once:true});
    setTimeout(finish,240); // safety if animationend never fires
  }

  // ── Restore fast path (screen 1) ──────────────────────────────────────────────
  // Sign in → wait for firebase's pull to land → if the account has a real setup
  // (shift anchors in the cloud), jump straight to the finale as a welcome-back.
  function setRestoreState(mode){
    const btn=document.querySelector('.obx-restore');
    if(!btn) return;
    if(mode==='idle'){ btn.disabled=false; btn.innerHTML=`${OI.google} <span>${ot('obRestoreLink')}</span>`; }
    else if(mode==='busy'){ btn.disabled=true; btn.innerHTML=`${OI.spin} <span>${ot('obRestoreLink')}</span>`; }
    else{ btn.disabled=true; btn.innerHTML=`${OI.spin} <span>${ot('obRestoring')}</span>`; }
  }
  async function restoreFlow(){
    if(OB.signingIn) return;
    if(!navigator.onLine){ await signInWithGoogle(); return; } // fires its own offline alert
    OB.signingIn=true;
    setRestoreState('busy');
    const syncedAt0=Number(localStorage.getItem('wt4_syncedAt')||0);
    if(!getCurrentUser()) await signInWithGoogle();
    // onAuthStateChanged is async — give it a moment to hand us the user.
    await obWaitFor(()=>!!getCurrentUser(), 3500);
    if(!getCurrentUser()){ OB.signingIn=false; setRestoreState('idle'); return; } // popup dismissed
    setRestoreState('restoring');
    // pullFromCloud either merges cloud data (sets wt4_cloud_pulled) or, for a
    // brand-new account, pushes local up (bumps wt4_syncedAt). Wait for either.
    await obWaitFor(()=>ld('wt4_cloud_pulled',false)===true
        || Number(localStorage.getItem('wt4_syncedAt')||0)>syncedAt0, 9000);
    OB.signingIn=false;
    const hasCloudSetup = ld('wt4_cloud_pulled',false)===true
        && Object.keys(ld('wt4_shifts',{})).length>0;
    if(hasCloudSetup){
      // Returning user: everything is already in localStorage. No questions.
      OB.lang=ld('wt4_lang',OB.lang);
      S.lang=OB.lang;
      OB.restored=true;
      saveOBState();
      transitionTo(4,1);
    }else{
      // Signed in but nothing to restore — continue setup; choices back up automatically.
      transitionTo(2,1);
    }
  }

  // ── Wire chrome events (back + progress) ─────────────────────────────────────
  function wireChromeEvents(){
    const chrome=document.getElementById('ob-chrome');
    if(!chrome) return;
    chrome.querySelector('.obx-back')?.addEventListener('click',()=>{
      transitionTo(OB.step-1,-1);
    });
    chrome.querySelectorAll('.obx-seg--done').forEach(seg=>{
      seg.addEventListener('click',()=>{
        const target=parseInt(seg.dataset.goto);
        if(target && target<OB.step) transitionTo(target,-1);
      });
    });
  }

  // ── Wire step-level events (called after every body swap) ────────────────────
  function wireStepEvents(){
    const body=document.getElementById('ob-body');
    if(!body) return;

    // Step 1: language chips — rebuild the body so every label retranslates live
    body.querySelectorAll('[data-lang]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.lang=btn.dataset.lang;
        S.lang=OB.lang;
        saveOBState();
        body.innerHTML=buildStepHTML();
        wireStepEvents();
      });
    });
    body.querySelector('.obx-start')?.addEventListener('click',()=>transitionTo(2,1));
    body.querySelector('.obx-restore')?.addEventListener('click',restoreFlow);

    // Step 2: pattern cards — in-place selection so the press never flashes
    const syncNext=()=>{
      const nx=body.querySelector('.obx-next');
      if(nx) nx.disabled=!obCanProceed();
    };
    body.querySelectorAll('[data-pattern]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.pattern=btn.dataset.pattern;
        if(OB.pattern!=='rotation') OB.currentShift=null;
        saveOBState();
        body.querySelectorAll('[data-pattern]').forEach(b=>{
          const on=b.dataset.pattern===OB.pattern;
          b.classList.toggle('obx-opt--active',on);
          b.setAttribute('aria-pressed',on?'true':'false');
        });
        const sub=document.getElementById('ob-rot-sub');
        if(sub){
          const open=OB.pattern==='rotation';
          sub.classList.toggle('obx-rotsub--open',open);
          sub.setAttribute('aria-hidden',open?'false':'true');
          sub.querySelectorAll('[data-curshift]').forEach(b=>{
            b.tabIndex=open?0:-1;
            if(!open) b.classList.remove('obx-week-btn--active');
          });
        }
        syncNext();
      });
    });
    body.querySelectorAll('[data-curshift]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.currentShift=btn.dataset.curshift;
        saveOBState();
        body.querySelectorAll('[data-curshift]').forEach(b=>{
          b.classList.toggle('obx-week-btn--active',b.dataset.curshift===OB.currentShift);
        });
        syncNext();
      });
    });

    // Step 3: wage input — live-sync + preview
    const updatePreview=()=>{
      const el=document.getElementById('ob-preview-val');
      if(!el) return;
      el.textContent='≈ ₩'+obPreviewNet().toLocaleString();
      el.classList.remove('obx-pop');
      void el.offsetWidth; // restart the pop animation
      el.classList.add('obx-pop');
    };
    const wageIn=document.getElementById('ob-wage-in');
    if(wageIn){
      wageIn.addEventListener('input',()=>{
        const v=parseInt(wageIn.value);
        if(!isNaN(v)&&v>=0){ OB.wage=v; saveOBState(); updatePreview(); }
      });
    }
    // Deduction-mode switch: Tax ↔ 4 Insurances (mirrors Settings)
    body.querySelectorAll('[data-ded-mode]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const mode=btn.getAttribute('data-ded-mode');
        OB.dedMode=mode;
        saveOBState();
        body.querySelectorAll('[data-ded-mode]').forEach(b=>{
          const on=b.getAttribute('data-ded-mode')===mode;
          b.classList.toggle('ded-tog-on',on);
          b.setAttribute('aria-checked',on?'true':'false');
        });
        const pill=document.getElementById('ob-ded-pill');
        if(pill){ pill.style.setProperty('--seg-pos',mode==='insurance'?1:0); pill.className='ded-seg-pill ded-seg-pill--'+mode; }
        document.getElementById('ob-ded-tax')?.classList.toggle('obx-ded-body--hidden',mode==='insurance');
        document.getElementById('ob-ded-ins')?.classList.toggle('obx-ded-body--hidden',mode!=='insurance');
        updatePreview();
      });
    });
    // Tax rate input — live-sync with clamping
    const taxIn=document.getElementById('ob-tax-in');
    if(taxIn){
      taxIn.addEventListener('input',()=>{
        let v=parseFloat(taxIn.value);
        if(!isNaN(v)){ v=Math.min(45,Math.max(0,parseFloat(v.toFixed(2)))); OB.taxRate=v; saveOBState(); updatePreview(); }
      });
      taxIn.addEventListener('blur',()=>{
        let v=parseFloat(taxIn.value);
        if(isNaN(v))v=DEFAULT_TAX;
        v=Math.min(45,Math.max(0,parseFloat(v.toFixed(2))));
        taxIn.value=v; OB.taxRate=v; saveOBState(); updatePreview();
      });
    }
    // Holiday auto-credit switch
    const hol=document.getElementById('ob-hol-toggle');
    if(hol){
      hol.addEventListener('click',()=>{
        OB.holAuto=!OB.holAuto;
        saveOBState();
        hol.classList.toggle('s3-toggle--on',OB.holAuto);
        hol.setAttribute('aria-checked',OB.holAuto?'true':'false');
      });
    }

    // Step 4: Google sign-in (backup card)
    body.querySelector('.ob-google-signin')?.addEventListener('click',async()=>{
      if(OB.signingIn) return;
      OB.signingIn=true;
      const btn=body.querySelector('.ob-google-signin');
      if(btn){ btn.disabled=true; btn.innerHTML=`${OI.spin} <span>${ot('obStep5Signin')}</span>`; }
      await signInWithGoogle();
      await obWaitFor(()=>!!getCurrentUser(), 3500); // let onAuthStateChanged land
      OB.signingIn=false;
      body.innerHTML=buildStepHTML(); // refresh in place to show signed-in state
      wireStepEvents();
    });

    // Next / continue
    body.querySelector('.obx-next')?.addEventListener('click',()=>{
      if(OB.step===2 && !obCanProceed()) return;
      if(OB.step===3){
        const wIn=document.getElementById('ob-wage-in');
        if(wIn){ const v=parseInt(wIn.value); if(!isNaN(v)&&v>=0) OB.wage=v; }
        const tIn=document.getElementById('ob-tax-in');
        if(tIn){ let v=parseFloat(tIn.value); if(!isNaN(v)){ v=Math.min(45,Math.max(0,v)); OB.taxRate=v; } }
      }
      transitionTo(OB.step+1,1);
    });

    // Finish
    body.querySelector('.obx-finish')?.addEventListener('click',()=>{
      if(OB.restored) completeRestored();
      else completeOnboarding();
    });
  }

  // ── Apply onboarding choices and finish ─────────────────────────────────────
  function completeOnboarding(){
    // 1. Save language
    sv('wt4_lang', OB.lang);
    S.lang = OB.lang;

    // 2. Initialize shift pattern — write directly to wt4_shifts.
    //    Anchors must cover ALL historical weeks (not just current/future),
    //    otherwise shiftFor() defaults to 'day' for any week before the anchor.
    const ws = getMonday(today());
    const sh = {};

    if(OB.pattern==='rotation'){
      // Write a single far-past anchor (2000-01-03 is a Monday) whose shift value
      // is chosen so that week-parity from that anchor correctly yields OB.currentShift
      // for this week — and alternates correctly for every past and future week.
      // We do NOT write a second anchor for the current week: two anchors with the
      // same value would falsely trigger fixed-mode detection in shiftFor().
      const EPOCH = '2000-01-03'; // a known Monday
      const msPerWeek = 7*24*3600*1000;
      const weeksFromEpoch = Math.round((pd(ws) - pd(EPOCH)) / msPerWeek);
      // If distance is even → epoch shift = currentShift (0 alternations = same)
      // If distance is odd  → epoch shift = opposite    (1 alternation = flipped)
      const epochShift = weeksFromEpoch % 2 === 0
        ? OB.currentShift
        : (OB.currentShift === 'day' ? 'night' : 'day');
      sh[EPOCH] = epochShift;

    }else{
      // Fixed day or night: write two consecutive-week anchors with the same shift.
      // shiftFor() detects two adjacent same-value anchors → fixed mode (no alternation).
      // Place them far in the past so every historical week is covered.
      const fixedShift = OB.pattern === 'day' ? 'day' : 'night';
      const EPOCH  = '2000-01-03'; // Monday
      const EPOCH2 = '2000-01-10'; // Monday, 1 week later
      sh[EPOCH]  = fixedShift;
      sh[EPOCH2] = fixedShift;
    }

    // 3. Save shifts and wages, but only if this is a new user.
    // For returning users who logged in during onboarding, cloud data is already
    // in localStorage — don't overwrite shifts (would corrupt historical anchors)
    // or wages (would lose all but the latest entry).
    const cloudWasPulled = ld('wt4_cloud_pulled', false);
    if (cloudWasPulled) {
      // Returning user: shifts stay untouched. Only write wages if cloud had none.
      const existingWages = ld('wt4_wages', null);
      if (!existingWages || existingWages.length <= 1) sv('wt4_wages', [{date:'2026-01-01', amount:OB.wage}]);
    } else {
      // New user: write freshly computed shifts and the onboarding wage.
      sv('wt4_shifts', sh);
      sv('wt4_wages', [{date:'2026-01-01', amount:OB.wage}]);
    }

    // 4. Save tax rate — always (it's the fallback the user can switch back to)
    const taxVal = (OB.taxRate !== undefined && !isNaN(OB.taxRate))
      ? Math.min(45, Math.max(0, OB.taxRate)) : DEFAULT_TAX;
    sv('wt4_tax_rate', taxVal);
    S.taxRate = taxVal;

    // 4b. Save deduction mode (tax vs 4대 보험). When insurance is chosen and the
    // user has no saved insurance rates yet, seed the statutory defaults so the
    // net figures are correct immediately; individual rates stay editable in Settings.
    const dedMode = OB.dedMode === 'insurance' ? 'insurance' : 'tax';
    sv('wt4_deduction_mode', dedMode);
    if(dedMode === 'insurance' && ld('wt4_insurance', null) === null){
      sv('wt4_insurance', { ...DEFAULT_INSURANCE });
    }

    // 5. Save holiday auto-credit preference (default true if user skipped without choosing)
    sv('wt4_hol_auto', OB.holAuto !== null ? OB.holAuto : true);
    S.holAuto = OB.holAuto !== null ? OB.holAuto : true;

    // 6. Mark onboarding complete — ONLY here, never earlier
    localStorage.setItem('wt4_onboarding', 'done');
    // Clean up in-progress session key and cloud-pull flag
    localStorage.removeItem('wt4_ob_state');
    localStorage.removeItem('wt4_cloud_pulled');

    // 7. Dismiss overlay and render the full app
    document.documentElement.removeAttribute('data-onboarding');
    document.getElementById('ob-overlay')?.remove();
    render();
    prefetchHolidays();
    if(getCurrentUser()) scheduleSync();
  }

  // ── Finish for cloud-restored users ──────────────────────────────────────────
  // The pull already rehydrated every synced key (shifts, wages, lang, theme,
  // tax, holiday preference). We only hydrate S from those values and mark done —
  // writing OB defaults here would clobber the restored settings.
  function completeRestored(){
    S.lang    = ld('wt4_lang', OB.lang);
    S.theme   = ld('wt4_theme', S.theme);
    S.taxRate = ld('wt4_tax_rate', DEFAULT_TAX);
    S.holAuto = ld('wt4_hol_auto', true);

    localStorage.setItem('wt4_onboarding', 'done');
    localStorage.removeItem('wt4_ob_state');
    localStorage.removeItem('wt4_cloud_pulled');

    document.documentElement.removeAttribute('data-onboarding');
    document.getElementById('ob-overlay')?.remove();
    render();
    prefetchHolidays();
    if(getCurrentUser()) scheduleSync();
  }

  // ── Show onboarding ─────────────────────────────────────────────────────────
  // Seed wt4_ob_state NOW (before render() is called) so that on any subsequent
  // page load — even before the user has clicked anything — hasActiveSession is
  // true and the backward-compat hasData check is skipped. This is belt-and-
  // suspenders: getWages() is now a pure read and no longer writes wt4_wages as a
  // side-effect (migrateWages only persists for users with real pre-existing
  // data), so a fresh visitor stays a clean slate. Seeding the session here keeps
  // the guard robust even if a future change reintroduces an incidental write.
  saveOBState();
  // Render a minimal shell behind the overlay. Do NOT call prefetchHolidays() here —
  // that would fire 48 concurrent API requests (12 months × 4 years) immediately on
  // first visit, causing 429 rate-limit errors. Holidays are fetched in
  // completeOnboarding() after the user has finished the flow.
  render();
  mountOB();
  // Onboarding has taken over: signal the caller to skip the normal startup path.
  return true;
}
