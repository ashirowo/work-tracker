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
