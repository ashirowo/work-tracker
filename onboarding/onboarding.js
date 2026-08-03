// ─────────────────────────────────────────────────────────────────────────────
// onboarding/onboarding.js — the fullscreen first-run experience (Phase 7f).
//
// A 6-screen flow (Welcome / Pattern / Workplace / Night / Pay / Finish; the
// Night screen is conditional) shown only to genuinely new users; existing
// users with saved data are silently grandfathered. Also owns the #join= deep
// link, the OB-state v1->v5 session migrations, the cloud-restore fast path,
// and the workplace-code join flow. Was a boot-time IIFE in app.js; now
// initOnboarding(ctx) called at the same point (its internal returns exit the
// function exactly as before, and app.js's pinIljitech + render + prefetch +
// startSyncTicker still run after it — behavior byte-identical).
//
// Bodies verbatim except: the reassigned CURRENT_USER arrives as currentUser(),
// and the grandfathered-user join link opens via ctx.openImportModal (no
// dependency on app.js's wpShareCtx). ctx supplies the app-owned surface; the
// wizard/form/share components are direct imports.
// ─────────────────────────────────────────────────────────────────────────────

import { normalizeShareCode, formatShareCode } from '../share.js';
import { signInWithGoogle, scheduleSync } from '../firebase.js';
import { needsNightSchedule } from '../profile-v2.js';
import { wizardProfileFrom, WIZ_DEFAULT_RULES, wizT } from '../domain/wizard-core.js';
import { insuranceRate, DEFAULT_INSURANCE } from '../domain/deductions.js';
import { pd, getMonday } from '../core/dates.js';
import { obxWorkplaceHTML, obxWireWorkplace, obxNightHTML, obxWireNight, obxNeedsSchedPage } from '../ui/workplace-form.js';
import { wireShareCodeInput, shareLookupByCode, shmEmptyHTML, shmFoundHeadHTML } from '../ui/share-widgets.js';
import { WZI, SHM_IC_SEARCH } from '../ui/icons.js';
import { escHTML } from '../ui/dom.js';
import { TR } from '../translations.js';

export function initOnboarding(ctx){
  const { S, render, ld, sv, today, prefetchHolidays, flagImg,
          DEFAULT_WAGE, DEFAULT_TAX, currentUser, openImportModal } = ctx;
  // Phase 6.4: #join=CODE deep link (share links, Phase 6.3's shareLink()).
  // Captured before any routing decision and stripped from the URL so a
  // refresh doesn't re-trigger it; the code itself persists via OB state
  // (pendingJoin) for the not-yet-onboarded path.
  let PENDING_JOIN_CODE=null;
  try{
    const jm=/[#&]join=([^&\s]+)/.exec(location.hash||'');
    if(jm){
      PENDING_JOIN_CODE=normalizeShareCode(decodeURIComponent(jm[1]));
      history.replaceState(null,'',location.pathname+location.search);
    }
  }catch(e){}

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
    // A share link opened by an already-onboarded user → the Settings import
    // modal, prefilled and auto-looked-up (imports replace, so it previews +
    // warns exactly like a manual import).
    if(PENDING_JOIN_CODE){
      const code=PENDING_JOIN_CODE;
      setTimeout(()=>{ try{ openImportModal(formatShareCode(code),{auto:true}); }catch(e){ console.warn('[share] join-link modal failed',e); } },400);
    }
    return;
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
      // field): 1→welcome, 2–3→pattern, 4–6→pay, 7–8→finish. Only UNVERSIONED
      // sessions qualify — matching `v !== 2` also caught current v3 sessions
      // and silently regressed a mid-flow refresh by one step.
      if(s && s.v === undefined){
        const map=[,1,2,2,3,3,3,4,4];
        s.step = map[s.step] || 1;
        s.v = 2;
      }
      // v2 → v3: the pay-rules step was inserted at position 3.
      if(s && s.v === 2){
        if(s.step >= 3) s.step += 1;
        s.v = 3;
      }
      // v3 → v4: the workplace step was split in two — the Night Schedule
      // screen now lives at position 4, pushing pay/finish to 5/6.
      if(s && s.v === 3){
        if(s.step >= 4) s.step += 1;
        s.v = 4;
      }
      // v4 → v5: Phase 6.4 adds importedShare/pendingJoin (workplace-by-code).
      // No step positions changed — pure field addition.
      if(s && s.v === 4){ s.v = 5; }
      return s;
    }catch(e){}
    return null;
  }
  function saveOBState(){
    try{
      localStorage.setItem('wt4_ob_state', JSON.stringify({
        v:5,
        step: OB.step,
        rules: OB.rules,
        lang: OB.lang,
        pattern: OB.pattern,
        currentShift: OB.currentShift,
        wage: OB.wage,
        taxRate: OB.taxRate,
        dedMode: OB.dedMode,
        holAuto: OB.holAuto,
        restored: OB.restored,
        importedShare: OB.importedShare,   // {code,name,profile} or null
        pendingJoin: OB.pendingJoin,       // deep-linked code awaiting lookup
      }));
    }catch(e){}
  }

  const OB_LANGS=[
    {code:'ko',label:'한국어'},
    {code:'en',label:'English'},
    {code:'zh',label:'中文'},
    {code:'ja',label:'日本語'},
    {code:'id',label:'Indonesia'},
    {code:'ru',label:'Русский'},
    {code:'th',label:'ภาษาไทย'},
    {code:'vi',label:'Tiếng Việt'},
  ];
  // Best-guess language from the browser so screen 1 usually needs zero taps.
  // Korean is the fallback, not English: this app is Korean labour law end to
  // end — won wages, the gov holiday API, 4대 보험 — so a browser we cannot
  // place is far likelier to belong to someone who reads Korean than someone
  // who reads English. The other seven locales are here for the migrant
  // workforce those workplaces employ, which is exactly why the DETECTION
  // stays: a Vietnamese or Thai phone still selects its own language on sight.
  function detectLang(){
    const cands=navigator.languages||[navigator.language||'ko'];
    for(const c of cands){
      const p=String(c).toLowerCase().slice(0,2);
      if(OB_LANGS.some(l=>l.code===p)) return p;
    }
    return 'ko';
  }

  const saved = loadOBState();
  const OB = {
    step:         saved?.step         ?? 1,
    lang:         saved?.lang         ?? (ld('wt4_lang',null) ?? detectLang()),
    pattern:      saved?.pattern      ?? null,
    rules:        saved?.rules        ?? WIZ_DEFAULT_RULES(),
    currentShift: saved?.currentShift ?? null,
    wage:         saved?.wage         ?? DEFAULT_WAGE,
    taxRate:      saved?.taxRate      !== undefined ? saved.taxRate : DEFAULT_TAX,
    // Deduction mode: 'tax' (flat %) or 'insurance' (Korea's 4대 보험). Defaults
    // to 'tax' to match the app; individual insurance rates stay editable in Settings.
    dedMode:      saved?.dedMode      ?? ld('wt4_deduction_mode','tax'),
    holAuto:      saved?.holAuto      !== undefined ? saved.holAuto : true, // default: auto-credit ON
    restored:     saved?.restored === true, // cloud fast path — skip setup screens
    importedShare:saved?.importedShare ?? null, // Phase 6.4: confirmed workplace code {code,name,profile}
    pendingJoin:  saved?.pendingJoin   ?? null, // Phase 6.4: deep-linked code awaiting lookup
    signingIn:    false, // transient — never persisted
  };
  // A #join= deep link captured at boot pre-opens the code panel on the
  // workplace step (unless a code was already confirmed this session).
  if(typeof PENDING_JOIN_CODE==='string' && PENDING_JOIN_CODE && !OB.importedShare){
    OB.pendingJoin=PENDING_JOIN_CODE;
  }
  // Combined employee insurance % (statutory defaults) — for the live preview
  // and the "4 Insurances" total chip. Uses the app's own insuranceRate().
  const OB_INS_PCT = Math.round(insuranceRate(DEFAULT_INSURANCE)*100*100)/100;

  // ── Step sequence ─────────────────────────────────────────────────────────────
  // Steps: 1 welcome · 2 pattern · 3 workplace & pay rules · 4 night schedule ·
  // 5 pay · 6 finish. The Night Schedule step exists only when the chosen rules
  // are schedule-driven (overlap-mode night premium) AND the user isn't
  // day-only — otherwise the flow runs 2 → 3 → 5 and shows one fewer segment.
  // Phase 6.4: an imported workplace code decides the schedule question from
  // the IMPORTED profile (the share stripped the sharer's schedule, so overlap
  // workplaces still need this user's own times); wizard flows keep deciding
  // from the chip state as before.
  function obNeedsSched(){
    if(OB.importedShare)
      return OB.pattern!=='day' && needsNightSchedule(OB.importedShare.profile);
    return obxNeedsSchedPage(OB.rules,OB.pattern);
  }
  function obSeq(){
    return obNeedsSched() ? [1,2,3,4,5,6] : [1,2,3,5,6];
  }
  function obTotal(){ return obSeq().length-1; }         // displayed setup steps
  function obStepIdx(step){                              // 1-based display index
    const i=obSeq().indexOf(step);
    return i<0?obSeq().indexOf(step+1):i;                // step 4 removed → show as 3's successor
  }
  function obNextStep(){
    const s=obSeq(), i=s.indexOf(OB.step);
    return i<0 ? 5 : (s[i+1] ?? 6);                      // orphaned step 4 → pay
  }
  function obPrevStep(){
    const s=obSeq(), i=s.indexOf(OB.step);
    return i<0 ? 3 : s[Math.max(0,i-1)];
  }
  // A saved session can sit on step 4 while the rules no longer need it (the
  // user changed presets and refreshed mid-flow) — resume on the pay step.
  if(OB.step===4 && !obNeedsSched()) OB.step=5;

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
              ${flagImg(l.code,'obx-lang-flag')}
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
        <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">1 ${ot('obOf')} ${obTotal()}</div>
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

    // Step 3 — Workplace & Pay Rules: WHAT the workplace pays. Two deliberate
    // paths (Phase 6.4): pick/author rules with the cards, OR flip into a
    // dedicated import mode via the entry card below them — a confirmed code
    // overrides the cards (dimmed until removed) and is stored verbatim at
    // completeOnboarding.
    if(OB.step===3){
      if(obJoinMode()) return objoinModeHTML();
      return `
        <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">2 ${ot('obOf')} ${obTotal()}</div>
        <h2 class="obx-title" style="--i:1">${wizT(OB.lang,'title')}</h2>
        <p class="obx-sub-text" style="--i:2">${wizT(OB.lang,'sub')}</p>
        <div style="--i:3"${OB.importedShare?' class="wpx-overridden" aria-disabled="true"':''}>${obxWorkplaceHTML(OB.rules, OB.lang, OB.pattern)}</div>
        <div style="--i:4">${objoinHTML()}</div>
        <button type="button" class="btn-pri obx-cta obx-next" style="--i:5">${ot('obNext')} ${OI.arrow}</button>
        <button type="button" class="obx-ghost obx-later" style="--i:6"${(OB.rules.preset||OB.importedShare)?' hidden':''}>${wizT(OB.lang,'laterBtn')}</button>
        <p class="obx-flownote" style="--i:7">${WZI.lock}<span>${wizT(OB.lang,'laterNote')}</span></p>`;
    }

    // Step 4 — Night Schedule: WHEN those rules apply. Exists only for
    // schedule-driven rules (see obSeq); day-only users never see it.
    if(OB.step===4){
      return `
        <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">3 ${ot('obOf')} ${obTotal()}</div>
        <h2 class="obx-title" style="--i:1">${wizT(OB.lang,'nsTitle')}</h2>
        <p class="obx-sub-text" style="--i:2">${wizT(OB.lang,'nsSub')}</p>
        <div style="--i:3">${obxNightHTML(OB.rules, OB.lang)}</div>
        <button type="button" class="btn-pri obx-cta obx-next" style="--i:4">${ot('obNext')} ${OI.arrow}</button>`;
    }

    if(OB.step===5){
      const insMode=OB.dedMode==='insurance';
      return `
        <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">${obTotal()-1} ${ot('obOf')} ${obTotal()}</div>
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

    // Step 6 — finish (normal or cloud-restored)
    const checkSVG=`
      <div class="obx-check" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <defs><linearGradient id="obx-check-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8a9bff"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>
          <circle class="obx-check-ring" cx="32" cy="32" r="28"/>
          <path class="obx-check-tick" d="M21 33.5l7.5 7.5L43 25.5"/>
        </svg>
      </div>`;
    const signedRow=currentUser()
      ?`<div class="obx-signedin" style="--i:2">
          ${currentUser().photoURL?`<img src="${currentUser().photoURL}" class="avatar" alt="">`:''}
          <span>${ot('obStep5Done')} <strong>${currentUser().displayName||currentUser().email}</strong></span>
        </div>`
      :'';
    if(OB.restored){
      return `
        <div class="obx-finale" style="--i:0">
          ${currentUser()?.photoURL?`<img src="${currentUser().photoURL}" class="obx-avatar" alt="">`:checkSVG}
          <h2 class="obx-title" style="--i:0">${ot('obWelcomeBackTitle')}</h2>
          <p class="obx-sub-text" style="--i:1">${ot('obWelcomeBackSub')}</p>
        </div>
        ${signedRow}
        <button type="button" class="btn-pri obx-cta obx-finish" style="--i:3">${ot('obDoneBtn')} ${OI.arrow}</button>`;
    }
    const backupCard=currentUser()
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
      <div class="obx-eyebrow" style="--i:0">${obTotal()} ${ot('obOf')} ${obTotal()}</div>
      <div class="obx-finale" style="--i:1">
        ${checkSVG}
        <h2 class="obx-title">${ot('obDoneTitle')}</h2>
        <p class="obx-sub-text">${ot('obDoneSub')}</p>
      </div>
      ${backupCard}
      <button type="button" class="btn-pri obx-cta obx-finish" style="--i:3">${ot('obDoneBtn')} ${OI.arrow}</button>`;
  }

  // ── Top chrome: back button + tappable progress segments ─────────────────────
  // Segments mirror the LIVE sequence (4 or 5 setup screens): each maps to an
  // actual step id, so jumping back lands on the right screen even when the
  // Night Schedule step doesn't exist for this user.
  function buildChromeHTML(){
    if(OB.step===1 || OB.restored) return '';
    const seq=obSeq(), total=obTotal();
    const pos=Math.max(1,obStepIdx(OB.step));
    const segs=seq.slice(1).map((stp,i)=>{
      const n=i+1;
      const cls=n<pos?' obx-seg--done':n===pos?' obx-seg--active':'';
      return `<button type="button" class="obx-seg${cls}" data-goto="${stp}"${n<pos?'':' disabled tabindex="-1"'} aria-label="${n} ${ot('obOf')} ${total}"><i></i></button>`;
    }).join('');
    return `<button type="button" class="obx-back" aria-label="${ot('obBack')}">${OI.back}</button>
      <div class="obx-progress" role="group" aria-label="${pos} ${ot('obOf')} ${total}">${segs}</div>
      <span class="obx-chrome-spacer" aria-hidden="true"></span>`;
  }

  // Refresh the chrome + eyebrow in place. Called when a choice made ON a step
  // changes the flow's shape (pattern picked, preset/night rule changed) so
  // the progress bar and "2 of 5" never lag behind the sequence.
  function syncFlowChrome(){
    const chrome=document.getElementById('ob-chrome');
    if(chrome){ chrome.innerHTML=buildChromeHTML(); wireChromeEvents(); }
    const eb=document.getElementById('ob-eyebrow');
    if(eb){
      const idx=OB.step===2?1:OB.step===3?2:OB.step===4?3:obTotal()-1;
      eb.textContent=`${idx} ${ot('obOf')} ${obTotal()}`;
    }
  }

  // ── Initial mount ─────────────────────────────────────────────────────────────
  function mountOB(){
    const ov=document.createElement('div');
    // The two configuration screens get a wider column (the preset grid and
    // the schedule panels breathe at 620px); every other screen keeps 470px.
    ov.className='ob-overlay'+(OB.step===3||OB.step===4?' ob-overlay--wide':'');
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
      document.getElementById('ob-overlay')?.classList.toggle('ob-overlay--wide',OB.step===3||OB.step===4);
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
    if(!currentUser()) await signInWithGoogle();
    // onAuthStateChanged is async — give it a moment to hand us the user.
    await obWaitFor(()=>!!currentUser(), 3500);
    if(!currentUser()){ OB.signingIn=false; setRestoreState('idle'); return; } // popup dismissed
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
      transitionTo(6,1); // straight to the welcome-back finale — zero questions
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
      transitionTo(obPrevStep(),-1);
    });
    chrome.querySelectorAll('.obx-seg--done').forEach(seg=>{
      seg.addEventListener('click',()=>{
        const target=parseInt(seg.dataset.goto);
        if(target && target<OB.step) transitionTo(target,-1);
      });
    });
  }

  // ── Wire step-level events (called after every body swap) ────────────────────
  // Phase 6.4: "I have a workplace code" — the coworker fast path on the
  // workplace step. A ghost toggle folds open the same lookup → preview →
  // confirm pipeline as the Settings import modal (same imm-* components,
  // same share.js gates); a confirmed code renders as an applied-chip and
  // overrides the preset cards until removed. Nothing touches real storage
  // here — the profile is held in OB.importedShare until completeOnboarding.
  function objoinHTML(){
    const W=k=>wizT(OB.lang,k);
    if(OB.importedShare){
      const s=OB.importedShare;
      return `<div class="objoin" id="ob-join">
        <div class="objoin-chip">
          <span class="objoin-chip-ic">${OI.check}</span>
          <span class="objoin-chip-txt">
            <span class="objoin-chip-t">${W('obCodeApplied')}</span>
            <span class="objoin-chip-s">${s.name?escHTML(s.name)+' · ':''}${formatShareCode(s.code)}</span>
          </span>
          <button type="button" class="objoin-remove" id="ob-join-remove">${W('obCodeRemove')}</button>
        </div>
      </div>`;
    }
    // The second path's door: an intentional entry card, not a fourth preset.
    return `<div class="objoin" id="ob-join">
      <button type="button" class="objoin-entry" id="ob-join-enter">
        <span class="objoin-entry-ic" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>
        <span class="objoin-entry-txt">
          <span class="objoin-entry-t">${W('obHaveCode')}</span>
          <span class="objoin-entry-s">${W('obCodeDesc')}</span>
        </span>
        <span class="objoin-entry-chev" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
      </button>
    </div>`;
  }

  // Import mode owns the whole step: the preset UI steps aside and the code
  // path gets a focused screen — the SAME mask/lookup/stage components as the
  // Settings import modal (wireShareCodeInput / shareLookupByCode / shm-*).
  function obJoinMode(){
    return OB.joinMode!==undefined?!!OB.joinMode:(!!OB.pendingJoin&&!OB.importedShare);
  }
  function objoinModeHTML(){
    const W=k=>wizT(OB.lang,k);
    const prefill=OB.pendingJoin?formatShareCode(OB.pendingJoin):(OB._joinDraft||'');
    return `
      <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">2 ${ot('obOf')} ${obTotal()}</div>
      <button type="button" class="objoin-back" id="ob-join-back" style="--i:1">${OI.back}${W('obBackPresets')}</button>
      <h2 class="obx-title" style="--i:2">${W('imTitle')}</h2>
      <p class="obx-sub-text" style="--i:3">${W('imSub')}</p>
      <div class="objoin-panel" id="ob-join" style="--i:4">
        <div class="imm-row">
          <input type="text" id="ob-join-code" class="imm-input" placeholder="${W('imPlaceholder')}"
                 autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="120"
                 value="${escHTML(prefill)}">
          <button type="button" class="btn-pri" id="ob-join-lookup" disabled>${W('imLookup')}</button>
        </div>
        <div class="imm-err" id="ob-join-err" hidden></div>
        <div class="imm-stage" id="ob-join-stage" aria-live="polite"></div>
      </div>
      <button type="button" class="btn-pri obx-cta" id="ob-join-confirm" style="--i:5" disabled>${W('imConfirm')} ${OI.arrow}</button>`;
  }
  function wireObJoin(root){
    const W=k=>wizT(OB.lang,k);
    const body=document.getElementById('ob-body');
    const rerender=()=>{ body.innerHTML=buildStepHTML(); wireStepEvents(); syncFlowChrome(); };

    // Applied chip → Remove re-enables the preset cards.
    const removeBtn=root.querySelector('#ob-join-remove');
    if(removeBtn){
      removeBtn.addEventListener('click',()=>{
        OB.importedShare=null;
        saveOBState();
        rerender();                       // cards re-enable; flow re-syncs
      });
      return;
    }

    // Default mode: the entry card is the door into import mode.
    const enter=root.querySelector('#ob-join-enter');
    if(enter){
      enter.addEventListener('click',()=>{
        OB.joinMode=true;
        rerender();
        document.getElementById('ob-join-code')?.focus({preventScroll:true});
      });
      return;
    }

    // Import mode — shared mask/lookup/stage; only the found-card CONTENT is
    // onboarding-specific (a high-level what's-included summary instead of
    // the full rules table a Settings user needs).
    const inp=root.querySelector('#ob-join-code');
    const errEl=root.querySelector('#ob-join-err');
    const stage=root.querySelector('#ob-join-stage');
    const lookupBtn=root.querySelector('#ob-join-lookup');
    const confirmBtn=document.getElementById('ob-join-confirm');
    let candidate=null;

    const renderIdle=()=>{stage.innerHTML=shmEmptyHTML(SHM_IC_SEARCH,W('objEmptyTitle'),W('objEmptyDesc'));};
    renderIdle();
    const showErr=msg=>{ errEl.hidden=false; errEl.textContent=msg; renderIdle(); confirmBtn.disabled=true; candidate=null; };

    const oii=p=>`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    const INC=[
      [oii('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>'),'objIncWage'],
      [oii('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),'objIncOt'],
      [oii('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),'objIncNight'],
      [oii('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),'objIncHol'],
    ];
    function presentResult(r,code){
      candidate={ code, name:r.name||null, profile:r.profile };
      errEl.hidden=true;
      stage.innerHTML=`<div class="shm-card">
        ${shmFoundHeadHTML(W('imFound'),`${r.name?`<b>${escHTML(r.name)}</b>`:formatShareCode(code)}<br>${W('objFoundSub')}`)}
        <div class="objoin-inc">${INC.map(([ic,k])=>`<span class="objoin-inc-it">${ic}${W(k)}</span>`).join('')}</div>
      </div>`;
      confirmBtn.disabled=false;
    }

    async function lookup(){
      errEl.hidden=true;
      const code=normalizeShareCode(inp.value);
      if(!code){ showErr(W('imErrFormat')); return; }
      const orig=lookupBtn.innerHTML;
      lookupBtn.disabled=true;
      lookupBtn.innerHTML=`<span class="obx-spin" aria-hidden="true"></span>${W('imChecking')}`;
      const res=await shareLookupByCode(code,W);
      lookupBtn.disabled=false;
      lookupBtn.innerHTML=orig;
      if(!res.ok){ showErr(res.msg); return; }
      presentResult(res.r,code);
    }

    wireShareCodeInput(inp,{
      onChange:(complete,changed)=>{
        lookupBtn.disabled=!complete;
        if(changed&&candidate){ candidate=null; confirmBtn.disabled=true; errEl.hidden=true; renderIdle(); }
      },
      onEnter:()=>{ if(!lookupBtn.disabled) lookup(); },
    });
    lookupBtn.addEventListener('click',lookup);

    document.getElementById('ob-join-back').addEventListener('click',()=>{
      OB._joinDraft=inp.value;            // a typed code survives the hop back
      OB.joinMode=false;
      rerender();
    });

    confirmBtn.addEventListener('click',()=>{
      if(!candidate)return;
      OB.importedShare=candidate;
      OB.pendingJoin=null;
      OB._joinDraft='';
      OB.joinMode=false;
      // Seed the chip state the imported rules imply so the Night Schedule
      // page (when the workplace needs one) previews with the workplace's
      // premium and shows its window — the STORED artifact stays the
      // verbatim imported profile, never a recompile of these chips.
      const nt=candidate.profile.night;
      if(nt&&nt.prem) OB.rules.night=+(1+nt.prem).toFixed(2);
      if(nt&&nt.window&&(nt.window.start!=='22:00'||nt.window.end!=='06:00')) OB.rules.window={...nt.window};
      saveOBState();
      rerender();
    });

    // Deep-linked code: run the prefilled lookup once, automatically.
    if(OB.pendingJoin && !OB._autoLooked && !lookupBtn.disabled){ OB._autoLooked=true; lookup(); }
  }

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
        syncFlowChrome(); // day-only trims the Night Schedule step → "1 of 4"
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

    // Step 5 (pay): wage input — live-sync + preview
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

    // Step 6 (finish): Google sign-in (backup card)
    body.querySelector('.ob-google-signin')?.addEventListener('click',async()=>{
      if(OB.signingIn) return;
      OB.signingIn=true;
      const btn=body.querySelector('.ob-google-signin');
      if(btn){ btn.disabled=true; btn.innerHTML=`${OI.spin} <span>${ot('obStep5Signin')}</span>`; }
      await signInWithGoogle();
      await obWaitFor(()=>!!currentUser(), 3500); // let onAuthStateChanged land
      OB.signingIn=false;
      body.innerHTML=buildStepHTML(); // refresh in place to show signed-in state
      wireStepEvents();
    });

    // Step 3 — Workplace & Pay Rules: renders once, updates itself surgically.
    // Choices here can reshape the flow (preset ↔ customize, night ×1), so the
    // chrome, eyebrow and the "I'll customize later" escape hatch re-sync too.
    const wpx=document.getElementById('ob-wpx');
    if(wpx){
      obxWireWorkplace(wpx, OB.rules, {lang:OB.lang, pattern:OB.pattern, onChange:()=>{
        saveOBState();
        syncFlowChrome();
        const later=body.querySelector('.obx-later');
        if(later) later.hidden=!!OB.rules.preset;
      }});
      // "I'll customize later" — bail out of Customize back to the standard
      // preset and move on; everything stays editable in Settings.
      body.querySelector('.obx-later')?.addEventListener('click',()=>{
        OB.rules.preset='kr-statutory-5plus';
        saveOBState();
        transitionTo(obNextStep(),1);
      });
    }
    // Step 3 — workplace code panel (Phase 6.4). Present whether or not a
    // code is already applied (the applied-chip wires its Remove button).
    const join=document.getElementById('ob-join');
    if(join) wireObJoin(join);

    // Step 4 — Night Schedule: times, window, breaks, live timeline preview.
    const nsx=document.getElementById('ob-nsx');
    if(nsx){
      obxWireNight(nsx, OB.rules, {lang:OB.lang, onChange:saveOBState});
    }

    // Next / continue
    body.querySelector('.obx-next')?.addEventListener('click',()=>{
      if(OB.step===2 && !obCanProceed()) return;
      if(OB.step===5){
        const wIn=document.getElementById('ob-wage-in');
        if(wIn){ const v=parseInt(wIn.value); if(!isNaN(v)&&v>=0) OB.wage=v; }
        const tIn=document.getElementById('ob-tax-in');
        if(tIn){ let v=parseFloat(tIn.value); if(!isNaN(v)){ v=Math.min(45,Math.max(0,v)); OB.taxRate=v; } }
      }
      transitionTo(obNextStep(),1);
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

    // 3b. Store the pay profile. An imported workplace code (Phase 6.4) wins
    // over BOTH the wizard chips and a cloud-pulled profile — it is the
    // user's most recent explicit choice. The share pipeline stripped the
    // sharer's schedule, so the importer's own times (collected on the Night
    // Schedule step) attach here; the profile is otherwise stored VERBATIM —
    // never recompiled from chips, which would corrupt source-less imports.
    if(OB.importedShare && OB.importedShare.profile){
      try{
        const p=structuredClone(OB.importedShare.profile);
        if(obNeedsSched()){
          if(OB.rules.schedule && OB.rules.schedule.night){
            p.schedule={night:{...OB.rules.schedule.night}};
            if(p.source&&p.source.answers) p.source.answers.schedule={night:{...OB.rules.schedule.night}};
          }
          if(OB.rules.window && p.night){    // user adjusted the window on step 4
            p.night.window={...OB.rules.window};
            if(p.source&&p.source.answers) p.source.answers.nightWindow={...OB.rules.window};
          }
        }
        sv('wt4_profile', p);
      }catch(e){ console.warn('[share] imported profile save failed — default rules apply', e); }
    }else if(!cloudWasPulled || ld('wt4_profile', null) === null){
      // Compile and store the pay profile from the wizard answers. Cloud
      // users keep their existing synced profile; a compile failure falls
      // back to the default rules and never blocks onboarding.
      try{ sv('wt4_profile', wizardProfileFrom(OB.rules, OB.pattern)); }
      catch(e){ console.warn('[wiz] profile compile failed — default rules apply', e); }
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
    if(currentUser()) scheduleSync();
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
    if(currentUser()) scheduleSync();
  }

  // ── Show onboarding ─────────────────────────────────────────────────────────
  // Seed wt4_ob_state NOW (before render() is called) so that on any subsequent
  // page load — even before the user has clicked anything — hasActiveSession is
  // true and the backward-compat hasData check is skipped. Without this, render()
  // calls getWages() which writes wt4_wages as a side-effect, making hasData=true
  // on the next load and wrongly auto-completing onboarding.
  saveOBState();
  // Render a minimal shell behind the overlay. Do NOT call prefetchHolidays() here —
  // that would fire 48 concurrent API requests (12 months × 4 years) immediately on
  // first visit, causing 429 rate-limit errors. Holidays are fetched in
  // completeOnboarding() after the user has finished the flow.
  render();
  mountOB();
  // Return early — normal startup render() below must not fire again.
  return;
}
