// ─────────────────────────────────────────────────────────────────────────────
// ui/tab-pager.js — the three top-level tabs as one horizontal pager (mobile).
//
// Below 540px the tab row is a fixed bottom bar, and a bottom bar implies pages
// laid side by side: Calendar, Overview, Settings, in that order. This module
// makes that implication true. A horizontal drag anywhere in the content region
// moves the page under the finger and brings its neighbour in from the edge;
// letting go either completes the move or puts it back.
//
// ONE PATH FOR BOTH INPUTS. A tap on the bottom bar runs the SAME staging and
// the SAME settle animation as a swipe released at rest — it is a swipe with no
// drag in front of it. There is no second, tap-only code path to drift out of
// sync with the gesture, which is the whole reason the two feel identical.
//
// WHAT MOVES. Only the content region pages; the header, the earnings hero and
// the bar itself are shared chrome and stay put. The incoming page is mounted
// absolutely INSIDE the track, so it costs the document no height while it is
// off screen and the page cannot grow, shrink or re-clamp its scroll mid-drag.
// It is also fully built AND wired the moment it is staged, so what slides in
// is the real tab — live charts, real numbers — not a placeholder that fills in
// after it lands.
//
// THE VERTICAL AXIS. The app is one scrolling document, so both pages share a
// scroll offset. The incoming page is therefore mounted at the offset it will
// LAND at (see placeGhost) and the scroll is set to match on the frame it goes
// into flow — so the pixels never jump. Landing offset is the current one,
// except when the destination is too short to hold it, in which case both the
// mount and the landing use the furthest the destination can actually reach.
// That case is also the only one where the incoming column starts below the top
// of the screen: the band above it is exactly the chrome that scrolling up is
// about to reveal.
//
// Desktop keeps the instant swap it always had (swap()) — above 540px the tab
// row is a text strip, not a bar of pages, and there is no gesture to match.
// ─────────────────────────────────────────────────────────────────────────────

const AXIS_PX   = 8;     // movement before the gesture picks an axis
const EDGE_PULL = 0.3;   // rubber-band factor when there is no page that way
const COMMIT_P  = 0.35;  // fraction of a page travelled that counts as "gone"
const FLICK_V   = 0.4;   // px/ms — a flick commits at any distance
const PAGE_MS   = 340;   // a full page crossing with no velocity behind it
const MIN_MS    = 160;
const MAX_MS    = 420;

// Bound from ctx on each render (see initTabPager):
let TABS, buildPane, wirePane, dropPane, setActive, dragPill, restPill, onSettle;

let vp = null;            // #tab-content — the window the pages move behind
let track = null;         // #tab-track   — the thing that actually translates
let ghosts = new Map();   // dir (-1 | 1) → staged page, or null for "no page"
let busy = false;         // a drag or a settle owns the region
let anim = null;          // the settle animation, while it runs
let curX = 0;             // where the track is right now, in px

const reduced = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
// The pager exists only where the tab row is a bottom bar. Read live: a rotation
// or a desktop window resize can cross this line while the app is open.
const narrow = () =>
  !!(window.matchMedia && window.matchMedia('(max-width: 540px)').matches);

const activePane = () => track && track.querySelector('.tabpane:not(.tabpane--next)');
const activeTab  = () => { const p = activePane(); return p ? p.dataset.pane : ''; };

// A page travels its own width plus the gutter between the two, so the pages
// stay separated for every pixel of the move instead of sliding as one sheet.
const gap    = () => parseFloat(getComputedStyle(track).getPropertyValue('--pager-gap')) || 0;
const pageW  = () => vp.clientWidth + gap();
// The settle never overshoots: the only thing past a page's resting place is the
// page after it, which is not mounted. --ease-out is the sheet's decelerate.
const ease   = () => getComputedStyle(document.documentElement)
                       .getPropertyValue('--ease-out').trim() || 'cubic-bezier(0.22,1,0.36,1)';

// Bind (or re-bind) to the region. A full render replaces #tab-content, so this
// runs again on nodes that have never been touched; everything the previous
// track owned went out of the document with it.
export function initTabPager(ctx){
  ({ tabs:TABS, buildPane, wirePane, dropPane, setActive, dragPill, restPill, onSettle } = ctx);
  const el = document.getElementById('tab-track');
  if(!el || el === track) return;
  anim = null; busy = false; curX = 0; ghosts.clear();
  track = el;
  vp = el.parentElement;
  bindGestures();
}

// ── Writing the track position ────────────────────────────────────────────────
// Coalesced to one write per frame. touchmove outruns the display and can burst
// several samples into a single frame; writing straight from the handler queued
// a style recalc per sample, each one re-rendering two full pages of content.
// Same rAF collapse ui/motion.js uses for the sheet drag.
let pendingX = null, rafId = 0;
const flushX = () => {
  rafId = 0;
  if(pendingX === null) return;
  track.style.transform = pendingX ? `translateX(${pendingX}px)` : '';
  pendingX = null;
};
function setX(px){
  curX = px;
  pendingX = px;
  if(!rafId) rafId = requestAnimationFrame(flushX);
}
function setXNow(px){
  if(rafId){ cancelAnimationFrame(rafId); rafId = 0; }
  pendingX = null;
  curX = px;
  track.style.transform = px ? `translateX(${px}px)` : '';
}

// ── Staging ───────────────────────────────────────────────────────────────────
// Build, mount and wire the page on one side. Memoised per direction for the
// life of the gesture: reversing across the start point stages the other
// neighbour once and then costs nothing, so a change of mind is free.
function stage(dir, tab){
  const had = ghosts.get(dir);
  if(had !== undefined) return had;     // null memoises "there is no page here"
  if(!tab){ ghosts.set(dir, null); return null; }

  const el = document.createElement('div');
  el.className = 'tabpane tabpane--next';
  el.dataset.pane = tab;
  el.style.setProperty('--pane-dir', dir);
  el.innerHTML = buildPane(tab);
  track.classList.add('is-paging');
  track.appendChild(el);
  // Wired before it is measured: wiring is what paints an entering Overview's
  // numbers to zero and hands the charts their canvases, and both change what
  // the page is once it is on screen.
  wirePane(tab);

  const g = { tab, el, dir, ty: placeGhost(el) };
  ghosts.set(dir, g);
  return g;
}

// Place a staged page on the vertical axis and report the scroll offset it will
// land at. See "THE VERTICAL AXIS" at the top of the file: `top` and the landing
// scroll are two halves of the same equation — a page mounted `sy - ty` below
// the track shows exactly what it will show once it is in flow at scroll `ty`.
function placeGhost(el){
  const sy = window.scrollY;
  const trackTop = track.getBoundingClientRect().top + sy;
  // Everything under the track — the footer and the bar's bottom clearance —
  // survives the swap, so it counts towards how far the destination scrolls.
  const below = Math.max(0, document.documentElement.scrollHeight - (trackTop + track.offsetHeight));
  const reach = Math.max(0, trackTop + el.offsetHeight + below - window.innerHeight);
  const ty = Math.min(sy, reach);
  el.style.top = (sy - ty) + 'px';
  return ty;
}

// ── Settling ──────────────────────────────────────────────────────────────────
// Hand the remaining travel to one animation. `g` is the page to land on, or
// null to put the current one back. Duration follows the finger: a flick
// finishes at the speed it was thrown, a slow drag gets the full page time.
function settle(g, vx){
  const W = pageW();
  const from = curX;
  const to = g ? -g.dir * W : 0;
  const speed = Math.max(Math.abs(vx) || 0, W / PAGE_MS);
  const ms = reduced() ? 1
    : Math.max(MIN_MS, Math.min(MAX_MS, Math.round(Math.abs(to - from) / speed)));

  // The inline transform goes to its final value FIRST and the animation paints
  // the tween over it. With fill:none (the default) the other order leaves one
  // frame at `from` after the animation hands the property back.
  setXNow(to);
  const a = track.animate(
    [{ transform:`translateX(${from}px)` }, { transform:`translateX(${to}px)` }],
    { duration: ms, easing: ease() }
  );
  anim = a;
  let done = false;
  const land = () => {
    if(done || anim !== a) return;
    done = true; anim = null;
    // A RUNNING animation outranks the inline transform, and one that never got
    // a frame is still running — it would go on pinning the track at the
    // position it started from, whatever anything else writes there. Cancelling
    // hands the property back; the inline style is already at `to`, so on the
    // normal path this changes nothing on screen.
    a.cancel();
    if(g) finish(g); else unstage();
  };
  a.onfinish = land;
  // onfinish does not arrive if the page is hidden or backgrounded before the
  // animation gets its frames, and the region would stay locked behind `busy`.
  setTimeout(land, ms + 120);
}

// The staged page becomes the real one. Every write here happens in one task
// with no layout read between them, so the browser paints the finished state
// once — the un-mounting, the swap and the scroll are a single frame.
function finish(g){
  const el = g.el;
  // Into flow BEFORE the outgoing page leaves: the other order empties the
  // track for an instant, and an empty track is a document short enough for the
  // scroll to be clamped out from under us.
  el.classList.remove('tabpane--next');
  el.style.top = '';
  el.style.removeProperty('--pane-dir');
  [...track.children].forEach(c => {
    if(c === el) return;
    // A page staged the other way was never shown; the page being left was.
    if(c.classList.contains('tabpane--next')) drop(c);
    c.remove();
  });

  track.style.transform = '';
  track.classList.remove('is-paging');
  curX = 0; pendingX = null; ghosts.clear(); busy = false;
  if(g.ty !== window.scrollY) window.scrollTo(0, g.ty);
  onSettle(g.tab);
}

// A page that is thrown away without ever having been shown. Views latch state
// when their markup is built (the Overview's one-per-session entrance is the
// live case), and staging builds markup that a swipe may well put straight back
// — so a build has an unbuild, and this is it.
function drop(el){ if(dropPane) dropPane(el.dataset.pane, el); }

// The drag came back: drop everything it staged.
function unstage(){
  ghosts.forEach(g => { if(g){ drop(g.el); g.el.remove(); } });
  ghosts.clear();
  track.style.transform = '';
  track.classList.remove('is-paging');
  curX = 0; pendingX = null; busy = false;
  onSettle(activeTab());
}

// ── Tab taps ──────────────────────────────────────────────────────────────────
// Returns false only when there is no region to page (then the caller falls
// back to a full render). A request that arrives mid-gesture is dropped, not
// queued: the finger is already deciding where this ends up.
export function pagerSwitch(tab){
  if(!track || !vp) return false;
  const cur = activeTab();
  if(!cur) return false;
  if(cur === tab || busy || anim) return true;
  if(!narrow()){ swap(tab); return true; }

  busy = true;
  // Calendar → Settings is two apart, and it still travels exactly one page:
  // the bar's order gives the direction, nothing else.
  const dir = TABS.indexOf(tab) > TABS.indexOf(cur) ? 1 : -1;
  const g = stage(dir, tab);
  if(!g){ busy = false; swap(tab); return true; }
  // Label and glyph switch at once while the page (and the pill) travel — the
  // bottom bar's existing rule, kept: touch feedback is immediate, the pill is
  // the thing that moves.
  setActive(tab);
  restPill();
  settle(g, 0);
  return true;
}

// The instant swap, unchanged in spirit from the original switchTab: desktop,
// and the fallback for anything the pager declines.
function swap(tab){
  const el = document.createElement('div');
  el.className = 'tabpane';
  el.dataset.pane = tab;
  el.innerHTML = buildPane(tab);
  track.replaceChildren(el);
  wirePane(tab);
  setActive(tab);
  restPill();
  onSettle(tab);
}

// ── The gesture ───────────────────────────────────────────────────────────────
// touch-action:pan-y on the window means the browser keeps the vertical axis and
// never claims the horizontal one, so every listener here can stay passive and
// nothing has to be preventDefault'd out from under the scroller.
//
// The axis is decided once, on the first movement worth reading, and a vertical
// decision hands the whole gesture back for good. Ties go to vertical: this is a
// scrolling page first, and the browser may already have started.
function bindGestures(){
  let sx = 0, sy = 0, mode = 0, live = false;
  let lastX = 0, lastT = 0, vx = 0, from = '';

  vp.addEventListener('touchstart', e => {
    live = false;
    if(busy || anim) return;
    if(e.touches.length !== 1) return;
    if(!narrow()) return;
    // A sheet or a modal covers the region; whatever is on top owns the touch.
    if(document.body.classList.contains('modal-open')) return;
    if(e.target.closest('.modal-overlay, .sexp-bs-overlay:not([hidden])')) return;
    sx = lastX = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    lastT = e.timeStamp; vx = 0; mode = 0; live = true;
  }, { passive:true });

  vp.addEventListener('touchmove', e => {
    if(!live) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    const rx = x - sx, ry = y - sy;

    if(!mode){
      if(Math.abs(rx) < AXIS_PX && Math.abs(ry) < AXIS_PX) return;
      mode = Math.abs(rx) > Math.abs(ry) ? 2 : 1;
      if(mode === 1){ live = false; return; }
      from = activeTab();
      busy = true;
      track.classList.add('is-paging');
      lastX = x; lastT = e.timeStamp;
    }

    const dt = e.timeStamp - lastT;
    if(dt > 0){ vx = (x - lastX) / dt; lastX = x; lastT = e.timeStamp; }
    // The threshold is spent, not carried: the page starts from where it is
    // rather than jumping the 8px the axis test cost.
    paint(rx - Math.sign(rx) * AXIS_PX);
  }, { passive:true });

  function paint(rx){
    const W = pageW();
    const dir = rx < 0 ? 1 : (rx > 0 ? -1 : 0);
    const i = TABS.indexOf(from);
    const g = dir ? stage(dir, TABS[i + dir]) : null;
    // No page that way — the drag is resisted rather than blocked, so the edge
    // is something you can feel instead of a dead surface.
    const px = g ? Math.max(-W, Math.min(W, rx)) : rx * EDGE_PULL;
    setX(px);

    // The pill tracks the finger 1:1 across the bar, and the label it is heading
    // for takes over at the half-way point — the same instant the incoming page
    // owns more of the screen than the one it is replacing.
    const p = g ? Math.min(1, Math.abs(px) / W) : 0;
    dragPill(from, g ? g.tab : from, p);
    setActive(g && p >= 0.5 ? g.tab : from);
  }

  const release = e => {
    if(!live) return;
    live = false;
    if(mode !== 2) return;
    const dir = curX < 0 ? 1 : (curX > 0 ? -1 : 0);
    const g = dir ? ghosts.get(dir) : null;
    // Stale samples mean the finger stopped before lifting — a placement, not a
    // flick, so the velocity is dropped. Same rule as the calendar ribbon.
    const v = (e.timeStamp - lastT) < 80 ? vx : 0;
    const flick = Math.abs(v) >= FLICK_V && (v < 0 ? 1 : -1) === dir;
    const go = !!g && (Math.abs(curX) / pageW() >= COMMIT_P || flick);

    setActive(go ? g.tab : from);
    restPill();
    settle(go ? g : null, v);
  };
  vp.addEventListener('touchend', release, { passive:true });
  vp.addEventListener('touchcancel', release, { passive:true });
}
