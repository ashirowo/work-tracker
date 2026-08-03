// ─────────────────────────────────────────────────────────────────────────────
// ui/motion.js — the app's shared animation physics (Phase 8).
//
// The net-pay hero count-up/ring-sweep (animateStatsHero, driven by a
// critically-damped spring off buildStats()'s data-* targets), its completion
// pulse (heroSettlePulse), and the desktop glass-card tilt/glare (initCardTilt,
// a real spring integrator). Pure DOM + rAF — no S, no render, no storage; the
// animation registries are module-locals. app.js calls animateStatsHero /
// initCardTilt from attachListeners; heroSettlePulse is internal.
// ─────────────────────────────────────────────────────────────────────────────

let _statsHeroRAF=0;
let _statsHeroLastKey=null;
// Remembers the last values actually shown, so a data change (log today, tax
// tweak, month nav) tweens from the old figure to the new one instead of
// resetting to 0 and counting up again. Seeded null → first paint starts at 0.
let _statsHeroPrev=null;
// Timestamp the current run started at, and the key it's animating toward. When
// a re-render (e.g. auth resolving) rebuilds the cards mid-animation with the
// SAME target values, we resume on the fresh nodes from this elapsed point
// instead of snapping — otherwise the entrance appears to cut short. Null when
// nothing is animating.
let _statsHeroStartTS=0;
let _statsHeroRunKey=null;
export function animateStatsHero(){
  const valEl=document.getElementById('stat-pay-value');
  const arcEl=document.getElementById('stat-pay-arc');
  const pctEl=document.getElementById('stat-pay-pct');
  if(!valEl&&!arcEl&&!pctEl)return;

  // Cancel any in-flight loop: it's bound by closure to the PREVIOUS (now
  // detached) DOM nodes after a rebuild, so it can't keep driving the visible
  // cards. We may immediately restart it below on the fresh nodes — possibly
  // resuming from the same elapsed time so the motion is continuous.
  const wasRunning=!!_statsHeroRAF;
  if(_statsHeroRAF){ cancelAnimationFrame(_statsHeroRAF); _statsHeroRAF=0; }

  const netTarget=valEl?parseFloat(valEl.dataset.target)||0:0;
  const pctTarget=arcEl?parseFloat(arcEl.dataset.target)||0
                 :pctEl?parseFloat(pctEl.dataset.target)||0:0;
  const circ=arcEl?parseFloat(arcEl.dataset.circ)||0:0;

  // Mini-card counters (Days / Hours values) and their progress bars. Both the
  // desktop cards and the mobile compact strip carry .stat-count nodes; only
  // one set is visible at a time (CSS), but painting all of them is harmless
  // and keeps whichever is shown in sync. Each stores its own numeric target
  // and decimal-place count (data-dp) so Days stays integer and Hours keeps .1.
  const countEls=[...document.querySelectorAll('.stats-hero .stat-count')].map(el=>({
    el, target:parseFloat(el.dataset.target)||0, dp:parseInt(el.dataset.dp)||0
  }));
  const barEls=[...document.querySelectorAll('.stats-hero .stat-bar')].map(el=>({
    el, target:parseFloat(el.dataset.target)||0
  }));

  // Starting values for this run. On the very first animation (or after a full
  // reset) there's no history, so everything starts at 0 and counts up. On a
  // later data change we start from the previously-shown numbers, so the motion
  // reads as the value smoothly moving to its new amount — up OR down.
  const from = _statsHeroPrev || {
    net:0, pct:0,
    counts:countEls.map(()=>0),
    bars:barEls.map(()=>0)
  };
  // Guard against a stale history whose array lengths don't match the current
  // DOM (e.g. layout swapped between desktop cards and the compact strip): fall
  // back to that metric's target as its own start (no motion) rather than
  // indexing undefined.
  const fromCount=i=> (from.counts&&from.counts.length===countEls.length) ? from.counts[i] : countEls[i].target;
  const fromBar  =i=> (from.bars  &&from.bars.length  ===barEls.length)   ? from.bars[i]   : barEls[i].target;

  const lerp=(a,b,e)=>a+(b-a)*e;

  const paint=(prog)=>{
    const net=lerp(from.net,netTarget,prog);
    const pct=lerp(from.pct,pctTarget,prog);
    if(valEl)valEl.textContent='₩'+Math.round(net).toLocaleString();
    if(arcEl){
      const dash=(Math.min(pct,100)/100)*circ;
      arcEl.setAttribute('stroke-dasharray',dash+' '+(circ-dash));
    }
    if(pctEl)pctEl.textContent=Math.round(pct)+'%';
    for(let i=0;i<countEls.length;i++){
      const c=countEls[i];
      const v=lerp(fromCount(i),c.target,prog);
      c.el.textContent=c.dp?v.toFixed(c.dp):Math.round(v).toString();
    }
    for(let i=0;i<barEls.length;i++){
      const b=barEls[i];
      const v=lerp(fromBar(i),b.target,prog);
      b.el.style.width=v.toFixed(1)+'%';
    }
  };

  // Snapshot the final state so the NEXT run can start from here.
  const commit=()=>{ _statsHeroPrev={
    net:netTarget, pct:pctTarget,
    counts:countEls.map(c=>c.target),
    bars:barEls.map(b=>b.target)
  }; };

  // Replay only when the underlying DATA changed. An auth-triggered re-render
  // (setCURRENT_USER → render() when signed in) rebuilds the header + cards, but
  // the stats numbers are identical — CURRENT_USER never feeds buildStats(). So
  // an identical key snaps the freshly-rebuilt nodes (which render at 0) to
  // final rather than animating a second time. Same rule collapses the startup
  // double-render and redundant rAF batches.
  const miniKey=countEls.map(c=>c.target).join(',')+'#'+barEls.map(b=>b.target).join(',');
  const key=netTarget+'|'+pctTarget+'|'+miniKey;

  const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Was a run for THESE SAME targets already in progress when we got called
  // again (i.e. a rebuild interrupted it)? If so, resume on the fresh nodes from
  // the same elapsed time so the entrance plays through continuously rather than
  // being cut short and snapped. This is the common first-load case: the initial
  // render starts the tween, then auth resolves ~100-400ms later and rebuilds
  // the cards with identical numbers.
  const resuming = wasRunning && _statsHeroRunKey===key && !reduce;

  // Snap-to-final (no animation) only when the data is unchanged AND nothing was
  // mid-flight — e.g. a redundant re-render after the entrance already finished,
  // or the auth rebuild landing after completion. Paint the fresh nodes (which
  // render at 0) straight to final.
  if(!resuming && _statsHeroLastKey===key){ paint(1); commit(); return; }
  _statsHeroLastKey=key;

  if(reduce){ paint(1); commit(); return; }

  // Critically-damped spring step response: x(t)=1−e^(−λt)(1+λt). No
  // oscillation (so no bounce — this must read as precise, not playful) and,
  // unlike the previous under-damped curve, the motion is spread evenly across
  // the whole duration instead of front-loading ~90% into the first third and
  // crawling invisibly afterward. That front-loading was what made the old
  // animation FEEL near-instant despite its 900ms length. λ=5.5 lands at
  // ~99.6% by t=1; the final commit paint snaps the sub-pixel remainder.
  const DUR=1000;
  const spring=x=>{ if(x>=1)return 1; const l=5.5; return 1-Math.exp(-l*x)*(1+l*x); };
  // This run animates toward `key`; remember it so a mid-flight rebuild for the
  // same targets resumes rather than snaps.
  _statsHeroRunKey=key;
  // When resuming an interrupted run, keep the original start timestamp so the
  // elapsed progress carries over seamlessly; otherwise start a fresh clock.
  const carriedStart = resuming ? _statsHeroStartTS : 0;
  let start=carriedStart;
  // Paint the correct current state SYNCHRONOUSLY before yielding to rAF, so the
  // freshly-rebuilt nodes (which render at 0) never show a 0-frame. Fresh start
  // → progress 0; resume → the elapsed progress, so the rebuilt cards appear
  // exactly where the interrupted animation had reached and continue from there.
  if(resuming && start){
    paint(spring(Math.min((performance.now()-start)/DUR,1)));
  }else{
    paint(0);
  }
  const step=ts=>{
    if(!start){ start=ts; _statsHeroStartTS=ts; }
    const p=Math.min((ts-start)/DUR,1);
    const e=spring(p);
    // One eased progress drives every metric from its own start to its own
    // target (see paint/lerp), so the whole block moves as one coordinated
    // settle and the ring reads as filled by the number.
    paint(e);
    if(p<1)_statsHeroRAF=requestAnimationFrame(step);
    else{
      _statsHeroRAF=0;
      _statsHeroRunKey=null;
      paint(1); // snap exact final
      commit();
      heroSettlePulse();
    }
  };
  _statsHeroRAF=requestAnimationFrame(step);
}

// Completion micro-interaction for the net-pay hero: a single, restrained
// scale tick (1.00 → 1.02 → 1.00) with a soft glow swell that fades fast —
// a "value locked in" confirmation, not a celebration. Runs only when the
// full count-up actually played (the reduced-motion and identical-key snap
// paths never reach here). The keyframes animate the standalone `scale`
// property, not `transform`, so it composes cleanly with the pointer-tilt
// transform instead of fighting it.
function heroSettlePulse(){
  const card=document.querySelector('.stat-pay-card');
  if(!card)return;
  card.classList.remove('hero-settle');
  void card.offsetWidth; // restart if a previous pulse is mid-flight
  card.classList.add('hero-settle');
  card.addEventListener('animationend',function h(e){
    if(e.animationName!=='heroSettle')return;
    card.classList.remove('hero-settle');
    card.removeEventListener('animationend',h);
  });
}

// ── Glass-card tilt (desktop only) ────────────────────────────────────────────
// A physical hover interaction for the header glass cards: slight lift + scale,
// cursor-relative tilt (≤ ~3.5°), and a specular highlight that tracks the
// pointer across the glass. All motion is integrated through a real spring
// (semi-implicit Euler, ζ≈0.84 — softly damped, near-zero visible overshoot)
// so it eases toward the cursor and settles back to neutral on leave, rather
// than snapping via CSS transitions.
//
// Gating:
//  • (hover:hover) and (pointer:fine) only — never on touch devices, where the
//    CSS :active tap feedback takes over instead (see style.css).
//  • prefers-reduced-motion disables it entirely.
// Performance:
//  • Only `transform` and two custom props (glare position) are written —
//    compositor-only work, no layout, no paint on the card contents.
//  • The rAF loop runs solely while the card is moving; `will-change` is added
//    on pointerenter and removed once the card has fully settled at rest.
//  • The card rect is cached on pointerenter (cards don't move mid-hover).
// Idempotency: cards are rebuilt on every full render(), so this is re-run from
// attachListeners(); the data-tilt-bound flag prevents double-binding on the
// header cards that survive tab switches.
export function initCardTilt(){
  if(!(window.matchMedia&&window.matchMedia('(hover: hover) and (pointer: fine)').matches))return;
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;

  document.querySelectorAll('.stat-pay-card, .stat-mini-card, .ov-stat4-card, .ov-proj-card, .ov-panel').forEach(card=>{
    if(card.dataset.tiltBound)return;
    card.dataset.tiltBound='1';

    // Specular highlight layer — a soft radial gradient positioned via CSS
    // vars, faded in/out with the .card-tilting class.
    const glare=document.createElement('div');
    glare.className='card-glare';
    card.appendChild(glare);

    // Motion scales inversely with surface size: the wide Overview panels get
    // barely-perceptible dimensionality (a large plane visibly rotating reads
    // as gimmicky), the small stat cards a touch more, the header cards keep
    // their original tuning. All share the same spring, so the whole page
    // moves with one physical character.
    const isHero=card.classList.contains('stat-pay-card');
    const isWide=card.classList.contains('ov-proj-card')||card.classList.contains('ov-panel');
    const isOvStat=card.classList.contains('ov-stat4-card');
    const MAX_TILT=isHero?3.2:isWide?1.1:isOvStat?2.6:4;   // deg — bigger card, gentler angle
    const LIFT=isHero?-4:isWide?-2:-3;                     // px
    const SCALE=isWide?1.004:isOvStat?1.015:1.02;

    // Spring state per axis: rotX, rotY, translateY, scale
    const cur={rx:0,ry:0,ty:0,s:1};
    const vel={rx:0,ry:0,ty:0,s:0};
    const tgt={rx:0,ry:0,ty:0,s:1};
    const K=170,D=22;              // stiffness / damping → ζ = D/2√K ≈ 0.84
    let rect=null,raf=0,last=0,hovering=false;

    const settledAxis=k=>Math.abs(tgt[k]-cur[k])<0.0015&&Math.abs(vel[k])<0.0015;

    const step=ts=>{
      const dt=Math.min((ts-(last||ts))/1000,1/30);last=ts;
      let done=true;
      for(const k in cur){
        vel[k]+=(K*(tgt[k]-cur[k])-D*vel[k])*dt;
        cur[k]+=vel[k]*dt;
        if(!settledAxis(k))done=false;
      }
      card.style.transform=
        `perspective(900px) translateY(${cur.ty.toFixed(2)}px) `+
        `rotateX(${cur.rx.toFixed(3)}deg) rotateY(${cur.ry.toFixed(3)}deg) `+
        `scale(${cur.s.toFixed(4)})`;
      if(!done){raf=requestAnimationFrame(step);return;}
      raf=0;last=0;
      if(!hovering){
        // Fully at rest and un-hovered: return the card to a clean stylesheet
        // state so nothing composited lingers (battery / memory friendly).
        for(const k in cur){cur[k]=tgt[k];vel[k]=0;}
        card.style.transform='';
        card.style.willChange='';
      }
    };
    // Start the loop if it isn't already running. Crucially, this does NOT
    // reset `last` — the running loop owns the frame clock. Resetting it here
    // on every pointermove made each subsequent frame compute dt=0 (ts-ts),
    // which froze the integrator except on frames where the mouse was still.
    const kick=()=>{if(!raf)raf=requestAnimationFrame(step);};

    card.addEventListener('pointerenter',e=>{
      // Hybrid (touch+trackpad) devices pass the fine-pointer media query but
      // still emit touch pointer events — those must not trigger hover motion.
      if(e.pointerType==='touch')return;
      hovering=true;
      rect=card.getBoundingClientRect();
      card.style.willChange='transform';
      card.classList.add('card-tilting');
      // Seed the glow position from the entry point so it eases out from the
      // top-right rest spot to where the cursor actually is, rather than
      // jumping only once the first pointermove lands.
      if(rect){
        const nx=Math.max(-1,Math.min(1,((e.clientX-rect.left)/rect.width)*2-1));
        const ny=Math.max(-1,Math.min(1,((e.clientY-rect.top)/rect.height)*2-1));
        card.style.setProperty('--gx',(((nx+1)/2)*100).toFixed(1)+'%');
        card.style.setProperty('--gy',(((ny+1)/2)*100).toFixed(1)+'%');
      }
      tgt.ty=LIFT;tgt.s=SCALE;
      kick();
    });

    card.addEventListener('pointermove',e=>{
      if(!hovering||!rect)return;
      const nx=Math.max(-1,Math.min(1,((e.clientX-rect.left)/rect.width)*2-1));
      const ny=Math.max(-1,Math.min(1,((e.clientY-rect.top)/rect.height)*2-1));
      tgt.ry=nx*MAX_TILT;
      tgt.rx=-ny*MAX_TILT;
      // Glare tracks the raw cursor (not the spring) — light reacts instantly,
      // the glass mass follows behind it. Compositor-only var writes.
      card.style.setProperty('--gx',(((nx+1)/2)*100).toFixed(1)+'%');
      card.style.setProperty('--gy',(((ny+1)/2)*100).toFixed(1)+'%');
      kick();
    });

    card.addEventListener('pointerleave',()=>{
      hovering=false;
      card.classList.remove('card-tilting');
      tgt.rx=0;tgt.ry=0;tgt.ty=0;tgt.s=1;
      kick();
    });
  });
}

// ── Bottom-sheet drag gesture (mobile) ───────────────────────────────────────
// Below 540px the modals render as bottom sheets (see style.css §29). This adds
// the matching physical behaviour: drag the sheet down with a finger, release to
// either dismiss it or let it spring back.
//
// The hard part of a sheet gesture is not fighting the scroll container inside
// it. A drag is only allowed to begin when the scrollable body is already at the
// top; otherwise the touch belongs to the scroller and we stay out of its way.
// Once a drag owns the gesture we preventDefault so the page doesn't rubber-band
// underneath it.
//
// Dismissal follows the usual two-signal rule — either the sheet was dragged
// past a quarter of its height, or it was flicked hard enough (velocity) that
// distance stops mattering. Upward drags are resisted rather than blocked, so
// the sheet feels attached to the finger instead of hitting a wall.
//
// Idempotent: re-attaching to the same panel is a no-op.
export function attachSheetGestures(overlay, onDismiss){
  if(!overlay) return;
  const panel = overlay.querySelector('.modal');
  if(!panel || panel.dataset.sheetBound) return;
  if(!window.matchMedia || !window.matchMedia('(max-width: 540px)').matches) return;
  panel.dataset.sheetBound = '1';

  // Retire the entrance animation as soon as it has played — see the
  // .sheet-entered note in the stylesheet. Without this, the first time the
  // drag classes toggle `animation` back on, the sheet replays its slide-in.
  // The timeout covers the cases where animationend never arrives (reduced
  // motion, or a sheet opened while the tab is hidden).
  const markEntered = () => panel.classList.add('sheet-entered');
  panel.addEventListener('animationend', function onEnter(e){
    if(e.target !== panel || e.animationName !== 'sheet-in') return;
    panel.removeEventListener('animationend', onEnter);
    markEntered();
  });
  setTimeout(markEntered, 600);

  // The element that scrolls inside the sheet, if any. .wpm-body is the share
  // modals' scroller — it was missing here, so on those sheets `scroller` fell
  // back to the panel (overflow:hidden, scrollTop permanently 0) and a drag
  // begun halfway down a scrolled list read as a dismiss instead of a scroll.
  // .asm-body is All Shifts' scroller and .hol-modal-body is Upcoming
  // Holidays'; ".asm-scroll" was listed here but no such element exists in the
  // markup, so those two fell back to the panel (scrollTop permanently 0).
  const scroller = panel.querySelector('.wm-scroll, .asm-body, .hol-modal-body, .sexp-bs-body, .wpm-body') || panel;

  // Both constants come from the --sheet-* tokens so the stylesheet stays the
  // single source of truth for the sheet system. Matched to the date-range
  // sheet: a fixed pixel threshold and NO velocity term. The old rule was 25%
  // of panel height OR a flick above 0.55px/ms, and the flick test is what made
  // dismissal feel unpredictable — a short, brisk nudge cleared it easily and
  // threw the sheet away when the user meant to peek.
  const rootCS = getComputedStyle(document.documentElement);
  const tokenNum = (name, fallback) => {
    const v = parseFloat(rootCS.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const DISMISS_PX = tokenNum('--sheet-dismiss-px', 80);
  const SCRIM      = tokenNum('--sheet-scrim', 0.55);

  let startY = 0, dy = 0, dragging = false, decided = false, fromScroller = false;
  const backdrop = overlay;      // .modal-overlay paints the scrim itself

  // Writes are coalesced to one per frame. touchmove fires faster than the
  // display refreshes (and can burst several samples in a single frame), so
  // writing panel.style.transform straight from the handler queued redundant
  // style recalcs — each one re-rendering the panel's backdrop-filter blur
  // against a moving backdrop, which is what made the drag feel jittery rather
  // than slow. rAF collapses a burst into the single position that frame will
  // actually show.
  let pendingY = null, rafId = 0;
  const flush = () => {
    rafId = 0;
    if(pendingY === null) return;
    panel.style.transform = pendingY ? `translateY(${pendingY}px)` : '';
    pendingY = null;
  };
  const setY = y => {
    pendingY = y;
    if(!rafId) rafId = requestAnimationFrame(flush);
  };
  // The scrim lightens as the sheet is pulled down, so the drag reads as
  // "leaving" the whole time rather than only at the moment it's released.
  // Same proportion the date-range sheet uses: fully clear at half the panel's
  // height. Its own opacity is restored (to the stylesheet's) on release.
  const paintBackdrop = y => {
    const h = panel.offsetHeight || 1;
    const progress = Math.min(y / (h * 0.5), 1);
    backdrop.style.background = `rgba(0,0,0,${(SCRIM * (1 - progress)).toFixed(3)})`;
  };
  const restoreBackdrop = () => { backdrop.style.background = ''; };

  // Cancel a queued frame and write immediately — used on release so the
  // settle/dismiss never races a stale in-flight position.
  const setYNow = y => {
    if(rafId){ cancelAnimationFrame(rafId); rafId = 0; }
    pendingY = null;
    panel.style.transform = y ? `translateY(${y}px)` : '';
  };

  panel.addEventListener('touchstart', e => {
    if(e.touches.length !== 1) return;
    // Where the touch STARTS decides whether the body gets a say. The header,
    // handle and action bar are pinned siblings of the scroller — they never
    // scroll, so a drag begun there is always a sheet drag. Only a touch that
    // starts inside the scrolling body has to yield to it, and then only when
    // that body is actually scrolled down.
    //
    // This guard used to run against the whole panel, so once the body was
    // scrolled the handle went dead and the sheet could not be pulled down
    // until you scrolled back to the top first.
    fromScroller = scroller !== panel && scroller.contains(e.target);
    if(fromScroller && scroller.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    dy = 0; dragging = true; decided = false;
    panel.classList.remove('sheet-settling');
  }, { passive: true });

  panel.addEventListener('touchmove', e => {
    if(!dragging) return;
    const y = e.touches[0].clientY;
    const raw = y - startY;

    // First meaningful movement decides who owns the gesture. An upward drag,
    // or a downward one that started mid-scroll, is handed back to the scroller.
    if(!decided){
      if(Math.abs(raw) < 4) return;
      decided = true;
      // Same rule as touchstart: the body only gets to reclaim the gesture if
      // the touch began inside it.
      if(raw < 0 || (fromScroller && scroller.scrollTop > 0)){ dragging = false; return; }
      panel.classList.add('sheet-dragging');
    }

    // Hard clamp at the top, exactly like .sexp-bs ("if(y<0) return"): the
    // sheet is already at its open position, so there is nowhere up to go and
    // it simply stops. The old rubber-band (raw/3) let it ride above its own
    // top edge, which is the "swipes up past its size" that made the others
    // feel loose next to the date-range sheet.
    if(raw < 0){
      if(dy !== 0){ dy = 0; setY(0); paintBackdrop(0); }
      if(e.cancelable) e.preventDefault();
      return;
    }
    dy = raw;
    setY(dy);
    paintBackdrop(dy);
    if(e.cancelable) e.preventDefault();   // stop the page rubber-banding
  }, { passive: false });

  const end = () => {
    if(!dragging){ return; }
    dragging = false;
    panel.classList.remove('sheet-dragging');
    if(!decided || dy <= 0){ restoreBackdrop(); setYNow(0); return; }

    // Distance only — no velocity term. See DISMISS_PX above.
    if(dy >= DISMISS_PX){
      // Hand the remaining travel to the CSS slide-out, starting from where the
      // finger actually left the sheet. Without this the sheet-out keyframe
      // began at translateY(0) and the panel flashed back to full size for a
      // frame before sliding away.
      //
      // The scrim is deliberately NOT restored here: it was faded in step with
      // the drag, and resetting it would re-darken the backdrop on the same
      // frame, which read as part of the same flash. The overlay fades from
      // wherever the drag left it and is removed moments later.
      panel.style.setProperty('--sheet-exit-from', dy + 'px');
      setYNow(0);
      onDismiss();
    }else{
      panel.classList.add('sheet-settling');
      setYNow(0);
      restoreBackdrop();
      // transitionend BUBBLES. Without the target/property guard, any
      // transition finishing on a descendant — a button releasing its :active,
      // an input's focus ring, the theme fade — ended the settle early: the
      // class came off mid-flight and the transform snapped the rest of the
      // way. The panel's own transform is the only signal that the sheet has
      // actually finished settling.
      //
      // The timeout is the other half: if dy rounds to no visible change the
      // transition never starts, transitionend never fires, and the class (and
      // its will-change) would stick forever.
      let settled = false;
      const done = () => {
        if(settled) return;
        settled = true;
        panel.classList.remove('sheet-settling');
        panel.removeEventListener('transitionend', h);
        clearTimeout(timer);
      };
      function h(e){
        if(e.target !== panel || e.propertyName !== 'transform') return;
        done();
      }
      panel.addEventListener('transitionend', h);
      const timer = setTimeout(done, 500);   // > --dur-slow (320ms) + slack
    }
  };

  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}
