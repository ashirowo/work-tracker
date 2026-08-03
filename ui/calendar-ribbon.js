// ─────────────────────────────────────────────────────────────────────────────
// ui/calendar-ribbon.js — the Calendar's motion engine.
//
// THE MODEL
// There is one endless ribbon of weeks. A month is not a page — it is a WINDOW
// onto that ribbon (six rows), plus a highlight saying which of those days
// belong to it. Changing month scrolls the window and moves the highlight.
//
// That is the whole idea, and everything else falls out of it:
//
//  • Motion is vertical, because time inside a calendar grid is already
//    vertical — row 1, row 2, row 3. A horizontal transition would invent a
//    second, contradictory time axis on top of the one the grid already has.
//  • The weekday header never moves. It is the frame; the days scroll behind
//    it. Monday stays above Monday for every pixel of the motion — impossible
//    in a horizontal design, where the incoming month's columns travel across
//    the outgoing month's under a header that no longer describes either.
//  • The week straddling the boundary is one physical row belonging to both
//    months. It is row 5 of the old window and row 0 of the new one, so the
//    transition carries a row of real, unchanging dates from the bottom of the
//    screen to the top. Continuity is demonstrated, not implied by an easing.
//  • There are never two grids to keep in sync, so nothing can desync, and no
//    empty state can appear — not because it is defended against, but because
//    the ribbon is continuous by construction.
//
// ONE SCALAR DRIVES EVERYTHING
// `sp` is a floating STEP index: whole numbers are months, and it is the only
// animated quantity. Row position is interpolated from it (each step covers its
// own row delta, so months of different heights all take the same time), and
// the header's month token reads it directly. Two style writes per frame — the
// ribbon's transform and the title strip's — and nothing else.
//
// PHYSICS
// Spring, mass 1 / stiffness 520 / damping 44 → ω = 22.8 rad/s, ζ = 0.965.
// Deliberately closer to critical damping than a page transition would be: a
// scroll that bounces at the end reads as sloppy. Overshoot is ~0.005% — it
// arrives and stops. Settles in ~240ms. Integrated at a fixed 1/240s substep so
// 60Hz and 120Hz behave identically.
//
// Pure DOM + rAF. Knows nothing about logs, shifts or storage: it is handed a
// row builder and returns commit/settle callbacks.
// ─────────────────────────────────────────────────────────────────────────────

import { pad } from '../core/dates.js';

// ── Week-row arithmetic ──────────────────────────────────────────────────────
// Row 0 is the week beginning Sunday 1970-01-04 (day 3 of the epoch). UTC
// throughout so no row boundary can be moved by a daylight-saving shift.
const DAY_MS = 86400000;
const EPOCH_SUNDAY = 3;

export const rowOfYMD = (y, m, d) =>
  Math.floor((Date.UTC(y, m, d) / DAY_MS - EPOCH_SUNDAY) / 7);

/** First row of the window for a month — the week containing the 1st. */
export const monthRow = (y, m) => rowOfYMD(y, m, 1);

/** 'YYYY-MM-DD' for a cell in the ribbon (col 0 = Sunday). */
export function cellDate(row, col) {
  const d = new Date((EPOCH_SUNDAY + row * 7 + col) * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Rows in the visible window. Six always spans any month. */
export const WINDOW_ROWS = 6;

// ── Monday-week arithmetic, for the shift bar ────────────────────────────────
// The week bar is the SAME ribbon sampled weekly instead of daily, laid out
// horizontally because the bar is. It shows exactly the weeks its month
// touches — four to six — so unlike the grid its pitch is NOT constant, and
// the transition interpolates the pill width alongside the offset. Its weeks
// run Monday–Sunday (that is what the shift pattern is anchored to), so it
// needs its own epoch; week 0 begins Monday 1970-01-05.
const EPOCH_MONDAY = 4;

export const weekOfYMD = (y, m, d) =>
  Math.floor((Date.UTC(y, m, d) / DAY_MS - EPOCH_MONDAY) / 7);

/** First Monday-week of a month, and the last one it touches. */
export const monthWeek = (y, m) => weekOfYMD(y, m, 1);
export const monthWeekEnd = (y, m) => weekOfYMD(y, m, new Date(y, m + 1, 0).getDate());

/** 'YYYY-MM-DD' of the Monday that starts a week. */
export function weekDate(idx) {
  const d = new Date((EPOCH_MONDAY + idx * 7) * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Most Monday-weeks a month can touch — the materialisation buffer, not a
 *  window size: at rest the bar holds exactly the weeks its month has. */
export const MAX_MONTH_WEEKS = 6;

// ── Spring ───────────────────────────────────────────────────────────────────
const K = 520, C = 44, MASS = 1;
const SUBSTEP = 1 / 240;
// In step units. A step is 4–6 rows of ~46px, so 0.002 is well under half a
// pixel — the snap that ends a run cannot be seen.
const REST_X = 0.002, REST_V = 0.03;

// Past one whole step a drag meets asymptotic resistance: unbounded input,
// bounded output, capped at a third of a step.
const RUBBER = 0.33;
// Steps/sec past which a flick decides the outcome regardless of distance.
const FLICK = 0.5;

const addMonths = (ym, n) => {
  const i = ym.y * 12 + ym.m + n;
  return { y: Math.floor(i / 12), m: ((i % 12) + 12) % 12 };
};

/**
 * @param {object} o
 * @param {HTMLElement} o.card      the .cal-card element
 * @param {{y:number,m:number}} o.start   month already rendered in it
 * @param {(from:number,to:number)=>string} o.buildRows  cells for an inclusive row range
 * @param {(y:number,m:number,dir:number)=>void} o.onCommit  target month chosen
 * @param {(y:number,m:number)=>void} o.onSettle            motion finished
 * @param {(label:string)=>string} o.monthLabel   month token text for a step
 */
export function createRibbon({ card, start, buildRows, buildWeeks, onCommit, onSettle, monthLabel }) {
  const vp     = card.querySelector('.cal-ribbon-vp');
  const ribbon = card.querySelector('.cal-ribbon');
  const sizer  = card.querySelector('.cal-ribbon-sizer');
  const monVp  = card.querySelector('.cal-title-mon');
  const strip  = card.querySelector('.cal-mon-strip');
  const yearEl = card.querySelector('.cal-title-yr');
  const barVp  = card.querySelector('.week-bar');
  const bar    = card.querySelector('.wsb-strip');
  if (!vp || !ribbon || !sizer || !strip || !monVp || !bar) return null;

  const reduced = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let sp = 0, vel = 0, stepTarget = 0, focusStep = 0;
  let raf = 0, lastTS = 0, travelling = false, destroyed = false;
  let rowH = 0, tokH = 0, barInner = 0, wGap = 0;
  // Inclusive row range currently materialised in the ribbon.
  let from = monthRow(start.y, start.m), to = from + WINDOW_ROWS - 1;
  // Inclusive Monday-week range materialised in the shift bar — exactly this
  // month's own weeks at rest, four to six of them.
  let wFrom = monthWeek(start.y, start.m), wTo = monthWeekEnd(start.y, start.m);
  // Inclusive step range materialised in the title strip, and each token's
  // width — the year rides a transform derived from those so it glides to its
  // new position instead of jumping when the month name changes length.
  let sFrom = 0, sTo = 0, tokW = [], tokWMax = 0;

  const months = new Map([[0, { y: start.y, m: start.m }]]);

  // Counted off the NEAREST step already resolved rather than off `stepTarget`:
  // goTo() must assign the new target before it can resolve that target, so the
  // target is the one index guaranteed to be missing when it is needed.
  function monthAt(step) {
    if (months.has(step)) return months.get(step);
    let near = 0, best = Infinity;
    months.forEach((_, k) => { const d = Math.abs(k - step); if (d < best) { best = d; near = k; } });
    const ym = addMonths(months.get(near), step - near);
    months.set(step, ym);
    return ym;
  }
  const rowAtStep  = step => { const { y, m } = monthAt(step); return monthRow(y, m); };
  const weekAtStep = step => { const { y, m } = monthAt(step); return monthWeek(y, m); };
  // How many Monday-weeks this month touches — four to six — and therefore how
  // wide one of its pills is when they share the bar.
  const weekCountAt = step => { const { y, m } = monthAt(step); return monthWeekEnd(y, m) - monthWeek(y, m) + 1; };
  const pillWFor = step => { const n = weekCountAt(step); return (barInner - (n - 1) * wGap) / n; };

  // Position for a fractional step, in rows and in weeks. Piecewise-linear, so
  // every step takes the same TIME regardless of whether that month is 4, 5 or
  // 6 rows tall — the pace of navigation stays constant even though the
  // distance does not. The bar and the grid cover different distances (Monday
  // weeks vs Sunday weeks) over the same progress, which is what keeps them in
  // step with each other rather than merely similar.
  const lerpStep = (at, x) => {
    const i = Math.floor(x), f = x - i;
    return f ? at(i) + (at(i + 1) - at(i)) * f : at(i);
  };
  const rowPos  = x => lerpStep(rowAtStep, x);
  const weekPos = x => lerpStep(weekAtStep, x);
  // Pill width at a fractional step. Months touch different numbers of weeks,
  // so the bar's pitch is genuinely not constant — rather than padding every
  // month out to six and dimming the filler, the pitch itself rides the spring
  // and the bar makes room for the incoming month as it arrives. At either
  // endpoint it is exactly that month's own share of the bar, so the window
  // lands flush.
  const pillWAt = x => lerpStep(pillWFor, x);
  // Width of the month token at a fractional step — the year's travel.
  const tokWAt  = x => lerpStep(i => tokW[i - sFrom] ?? tokWMax, x);

  // ── Geometry ───────────────────────────────────────────────────────────────
  // Taken from the live DOM, so every pitch is whatever the stylesheet actually
  // produced — never a constant duplicated here that could drift from the CSS.
  function measure() {
    const s = sizer.children;
    if (s.length > 1) rowH = s[1].offsetTop - s[0].offsetTop;
    const tk = strip.children;
    if (tk.length) tokH = tk[0].offsetHeight;
    // Taken while the bar is still at rest — the strip's own content width and
    // the stylesheet's gap — so every pill width below is derived from what the
    // CSS actually produced rather than a constant duplicated here.
    barInner = bar.clientWidth;
    wGap = parseFloat(getComputedStyle(bar).columnGap) || 0;
  }

  function measureTokens() {
    tokW = [...strip.children].map(t => t.offsetWidth);
    tokWMax = tokW.length ? Math.max(...tokW) : 0;
  }

  // ── Materialisation ────────────────────────────────────────────────────────
  // Rows are only ever added at the ends and the transform is recomputed from
  // `from` every frame, so prepending is self-correcting: the ribbon grows
  // upward by exactly the amount the transform then compensates for.
  function ensureRows(needFrom, needTo) {
    // Rows built mid-transition are ghosted against the month being navigated
    // TO, so they arrive already correct instead of flashing as in-month until
    // the next commit.
    const focus = monthAt(focusStep);
    if (needFrom < from) {
      ribbon.insertAdjacentHTML('afterbegin', buildRows(needFrom, from - 1, focus));
      from = needFrom;
    }
    if (needTo > to) {
      ribbon.insertAdjacentHTML('beforeend', buildRows(to + 1, needTo, focus));
      to = needTo;
    }
  }

  // Rebuilt rather than extended at the ends. Rows can be extended safely — a
  // row's identity is an absolute week number and can never go stale — but a
  // token's is derived from the month map, and jump() re-anchors that map
  // wholesale. Extending would then leave earlier tokens describing the old
  // anchor, which showed up as a strip reading Jun|Jul|Jun|Sep. The strip is
  // two to eight spans and holds no state worth preserving, so rebuilding it
  // whenever the range moves is both cheaper and impossible to get wrong.
  // The shift bar's pills, materialised exactly like the rows: extended at the
  // ends only, with the transform recomputed from `wFrom` every frame so a
  // prepend is self-correcting.
  function ensureWeeks(needFrom, needTo) {
    const focus = monthAt(focusStep);
    if (needFrom < wFrom) {
      bar.insertAdjacentHTML('afterbegin', buildWeeks(needFrom, wFrom - 1, focus));
      wFrom = needFrom;
    }
    if (needTo > wTo) {
      bar.insertAdjacentHTML('beforeend', buildWeeks(wTo + 1, needTo, focus));
      wTo = needTo;
    }
  }

  function syncTokens(a, b) {
    if (a === sFrom && b === sTo) return;
    let h = '';
    for (let i = a; i <= b; i++) h += `<span class="cal-tok">${monthLabel(monthAt(i))}</span>`;
    strip.innerHTML = h;
    sFrom = a; sTo = b;
    measureTokens();
  }

  /** Everything the trip between `sp` and the target will pass through. */
  function ensureSpan() {
    const a = rowPos(sp), b = rowAtStep(stepTarget);
    ensureRows(Math.floor(Math.min(a, b)) - 1, Math.floor(Math.max(a, b)) + WINDOW_ROWS);
    const wa = weekPos(sp), wb = weekAtStep(stepTarget);
    ensureWeeks(Math.floor(Math.min(wa, wb)) - 1, Math.floor(Math.max(wa, wb)) + MAX_MONTH_WEEKS);
    // Exactly the tokens that can be on screen. `sp` never leaves the interval
    // between where it started and the target, so no padding is needed — and
    // padding is what would force a month to be derived for an index the jump
    // anchor cannot answer for.
    syncTokens(Math.floor(Math.min(sp, stepTarget)), Math.ceil(Math.max(sp, stepTarget)));
  }

  // ── Month membership ───────────────────────────────────────────────────────
  // Which days are "in" the month on show is a discrete fact, so it is a class
  // toggle with a CSS cross-fade rather than a per-frame value. Cells outside
  // it stay in the DOM as ghosts — they are what makes the scroll legible, and
  // what makes the boundary week visible as one continuous row.
  function applyFocus(y, m) {
    const key = `${y}-${pad(m + 1)}`;
    const kids = ribbon.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('dc--ghost', kids[i].dataset.mo !== key);
    }
    // A week pill can't carry a single month the way a day can — the week
    // straddling a boundary genuinely belongs to both — so membership is a
    // range test, and the shared pill comes out in-month on both sides.
    const w0 = monthWeek(y, m), w1 = monthWeekEnd(y, m);
    const pills = bar.children;
    for (let i = 0; i < pills.length; i++) {
      const wi = +pills[i].dataset.wi;
      pills[i].classList.toggle('wsb--ghost', wi < w0 || wi > w1);
    }
  }

  // The focused month, and everything downstream of it. `live` marks a change
  // made mid-drag: the caller uses it to skip the expensive parts (rebuilding
  // the stats hero, animating the week bar) while a finger is still down, and
  // gets a final non-live call on release to catch up.
  function setFocus(step, dir, live) {
    focusStep = step;
    const ym = monthAt(step);
    applyFocus(ym.y, ym.m);
    if (onCommit) onCommit(ym.y, ym.m, dir, live);
  }

  // A drag hands the month over at the half-way mark rather than on release.
  // Without this the title — which tracks the finger continuously — reads the
  // month you are arriving at while the week bar, legend and folds still read
  // the one you are leaving, which is visible and wrong. The 0.05 either side
  // of the midpoint is deadband: hovering exactly on the boundary must not
  // flip the whole card back and forth.
  function trackFocus() {
    if (sp > focusStep + 0.55) setFocus(focusStep + 1, 1, true);
    else if (sp < focusStep - 0.55) setFocus(focusStep - 1, -1, true);
  }

  // ── Travel state ───────────────────────────────────────────────────────────
  // Nothing below is true at rest: the ribbon is exactly the six visible rows,
  // untransformed, unmasked and uncomposited — the same inert markup a full
  // render produces. Ghosts brighten as one CSS transition rather than a
  // per-frame value, so a frame costs two style writes no matter how many
  // cells are on screen.
  function beginTravel() {
    if (travelling) return;
    travelling = true;
    measure();
    // Pinned to one token BEFORE the others are added, so the box keeps a
    // single line's height while the strip grows underneath it. Width and
    // baseline need no help: the strip stays in flow (see §32).
    monVp.style.height = monVp.offsetHeight + 'px';
    measureTokens();
    // The bar's pitch is written BEFORE the class that starts reading it. The
    // travelling rule swaps the strip's 1fr columns for var(--wsb-w), and until
    // the first paint set that variable it resolved to nothing — so the columns
    // fell back to `auto`, both months' weeks were squeezed into one bar's
    // width, every pill's label wrapped to a second line, and the bar (with the
    // whole grid under it) grew 11px until the next frame put it back. Seeded
    // with the resting month's own share, which is what 1fr was already giving
    // it, the first travelling layout is identical to the last resting one.
    bar.style.setProperty('--wsb-w', pillWFor(Math.round(sp)).toFixed(2) + 'px');
    vp.classList.add('is-travelling');
    ribbon.classList.add('is-travelling');
    monVp.classList.add('is-travelling');
    if (barVp) barVp.classList.add('is-travelling');
  }

  function endTravel() {
    travelling = false;
    const base = rowAtStep(stepTarget);
    // Trim back to exactly the window so the resting DOM is the same size it
    // would be after a plain render — and so the next trip starts from a known,
    // minimal state.
    trimRows(base, base + WINDOW_ROWS - 1);
    // Back to exactly this month's own weeks — no filler, no ghost pills. The
    // stylesheet's 1fr columns take over again the moment --wsb-w is cleared.
    trimWeeks(weekAtStep(stepTarget), weekAtStep(stepTarget) + weekCountAt(stepTarget) - 1);
    syncTokens(stepTarget, stepTarget);
    sp = stepTarget;
    ribbon.style.transform = '';
    strip.style.transform = '';
    bar.style.transform = '';
    bar.style.removeProperty('--wsb-w');
    // Cleared on the same frame the token strip shrinks back to one, so the
    // box narrowing and the year's compensating offset cancel exactly.
    if (yearEl) yearEl.style.transform = '';
    vp.classList.remove('is-travelling');
    ribbon.classList.remove('is-travelling');
    monVp.classList.remove('is-travelling');
    if (barVp) barVp.classList.remove('is-travelling');
    monVp.style.height = '';
    // Re-anchor so indices stay near zero and the maps stay one entry deep.
    const ym = monthAt(stepTarget);
    months.clear(); months.set(0, ym);
    sp = stepTarget = focusStep = 0; sFrom = sTo = 0;
    if (onSettle) onSettle(ym.y, ym.m);
  }

  function trimRows(a, b) {
    while (from < a) { for (let i = 0; i < 7; i++) ribbon.firstElementChild?.remove(); from++; }
    while (to > b)   { for (let i = 0; i < 7; i++) ribbon.lastElementChild?.remove();  to--; }
    ensureRows(a, b);
  }
  function trimWeeks(a, b) {
    while (wFrom < a) { bar.firstElementChild?.remove(); wFrom++; }
    while (wTo > b)   { bar.lastElementChild?.remove();  wTo--; }
    ensureWeeks(a, b);
  }

  // ── Paint ──────────────────────────────────────────────────────────────────
  function paint() {
    if (!travelling) return;
    // Four transforms, one scalar. The grid and the shift bar cover different
    // distances — Sunday weeks down, Monday weeks across — over the same
    // progress, which is what makes them read as one object rather than two
    // things that happen to move at the same time.
    ribbon.style.transform = `translate3d(0,${(-(rowPos(sp) - from) * rowH).toFixed(2)}px,0)`;
    // The bar's pitch moves with the transition, so the column width is written
    // alongside the offset and the two stay consistent frame to frame. One
    // variable on a strip of a dozen small buttons — the only layout in the
    // whole loop, and a cheap one.
    const pw = pillWAt(sp);
    bar.style.setProperty('--wsb-w', pw.toFixed(2) + 'px');
    bar.style.transform = `translate3d(${(-(weekPos(sp) - wFrom) * (pw + wGap)).toFixed(2)}px,0,0)`;
    strip.style.transform  = `translate3d(0,${(-(sp - sFrom) * tokH).toFixed(2)}px,0)`;
    // While travelling, the month box is as wide as the widest token in play,
    // so the year sits further right than it belongs. Pulling it back by the
    // difference between that and the CURRENT token's width glides it to its
    // new position instead of jumping when the month name changes length —
    // and it is a transform, so it costs no layout.
    if (yearEl) yearEl.style.transform =
      `translate3d(${(tokWAt(sp) - tokWMax).toFixed(2)}px,0,0)`;
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  // kick() starts an idle loop; a RUNNING loop re-arms itself below. The
  // distinction is load-bearing: `lastTS = 0` here, reached every frame, would
  // make every frame integrate one substep instead of the elapsed time.
  function kick() {
    if (raf || destroyed) return;
    lastTS = 0;
    raf = requestAnimationFrame(frame);
  }

  function frame(ts) {
    raf = 0;
    if (destroyed) return;
    // A tab switch detaches the card without going through a render, so there
    // is no teardown hook to hang destroy() on.
    if (!card.isConnected) { destroyed = true; return; }

    let dt = lastTS ? (ts - lastTS) / 1000 : SUBSTEP;
    lastTS = ts;
    dt = Math.min(dt, 0.05);          // a backgrounded tab must not launch it

    let rest = dt;
    while (rest > 0) {
      const h = Math.min(SUBSTEP, rest);
      vel += ((-K * (sp - stepTarget) - C * vel) / MASS) * h;
      sp += vel * h;
      rest -= h;
    }

    if (Math.abs(stepTarget - sp) < REST_X && Math.abs(vel) < REST_V) {
      sp = stepTarget; vel = 0;
      paint();
      endTravel();
      return;
    }
    ensureSpan();
    paint();
    raf = requestAnimationFrame(frame);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  function goToStep(step, forced) {
    if (destroyed || step === stepTarget) return;
    const dir = Math.sign(step - sp) || 1;
    beginTravel();
    // A jump lands on a month that is not adjacent to the one on screen, so the
    // map has to be re-anchored — but BOTH ends are pinned, not just the
    // destination: the month being left is still on screen for the length of
    // the transition and has to keep its own label. Nearest-anchor derivation
    // then answers a mid-jump arrow press off the destination, which is the
    // end the user is now navigating from.
    if (forced) {
      const leaving = monthAt(stepTarget);
      months.clear();
      months.set(stepTarget, leaving);
      months.set(step, forced);
    }
    stepTarget = step;
    setFocus(step, dir, false);
    ensureSpan();

    if (reduced()) { sp = stepTarget; vel = 0; paint(); endTravel(); return; }
    kick();
  }

  // ── Drag ───────────────────────────────────────────────────────────────────
  let dragBase = 0, dragFrom = 0, dragging = false, dragSlope = 0;

  const rubber = x => (1 - 1 / (x / RUBBER + 1)) * RUBBER;

  function dragStart() {
    if (destroyed) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    beginTravel();
    dragging = true;
    vel = 0;
    dragFrom = sp;
    dragBase = Math.round(sp);
    stepTarget = dragBase;
    dragSlope = 0;
    // Both neighbours up front, so the adjacent weeks are already under the
    // finger the instant it starts to move — there is nothing to populate
    // mid-gesture and nothing that can arrive late.
    ensureRows(rowAtStep(dragBase - 1) - 1, rowAtStep(dragBase + 1) + WINDOW_ROWS);
    ensureWeeks(weekAtStep(dragBase - 1) - 1, weekAtStep(dragBase + 1) + MAX_MONTH_WEEKS);
    syncTokens(dragBase - 1, dragBase + 1);
  }

  /** @param {number} dy finger travel in px (down is positive) */
  function dragMove(dy) {
    if (!dragging || !rowH) return;
    const rows = -dy / rowH;                       // drag up ⇒ later months
    // How many rows this step is worth, in the direction being dragged. Fixed
    // on first movement so the tracking ratio cannot change mid-gesture.
    if (!dragSlope && rows) {
      const d = Math.sign(rows);
      dragSlope = Math.abs(rowAtStep(dragBase + d) - rowAtStep(dragBase)) || 5;
    }
    let p = dragFrom + (dragSlope ? rows / dragSlope : 0);
    const lo = dragBase - 1, hi = dragBase + 1;
    if (p > hi) p = hi + rubber(p - hi);
    else if (p < lo) p = lo - rubber(lo - p);
    sp = p;
    trackFocus();
    paint();
  }

  /** @param {number} v release velocity in steps/sec. @returns {boolean} moved */
  function dragEnd(v) {
    dragging = false;
    if (!travelling) return false;
    const off = sp - dragBase;
    let step = dragBase;
    if (Math.abs(v) > FLICK) step = dragBase + Math.sign(v);
    else if (Math.abs(off) > 0.5) step = dragBase + Math.sign(off);
    step = Math.max(dragBase - 1, Math.min(dragBase + 1, step));

    const changed = step !== stepTarget;
    stepTarget = step;
    // Always non-live, even when the mid-drag flip already landed on this
    // month: this is the call that lets the caller do the work it deferred
    // while the finger was down.
    setFocus(step, Math.sign(step - dragBase) || 1, false);
    // The finger's velocity IS the spring's initial velocity. There is no
    // hand-off to smooth over — only a change in what drives the same number.
    vel = v;
    if (reduced()) { sp = stepTarget; paint(); endTravel(); return changed; }
    kick();
    return changed;
  }

  return {
    go(delta) { goToStep(stepTarget + delta); },
    /**
     * Slide to an arbitrary month, entering from the side it really lies on.
     *
     * Within two months the ribbon simply scrolls the whole way: the spring
     * settles in the same ~250ms whether it covers one step or two, so the
     * only difference is that you SEE the months in between — which is the
     * truthful thing to show, and keeps the step axis a real month axis.
     *
     * Beyond that, sweeping every intervening month would be a long, silly
     * scroll, so the destination is planted one step away and both ends of the
     * map are pinned. The cost is that a step index no longer means "one month
     * along" until the jump settles, so an arrow pressed DURING a long jump
     * steps in that temporary space and returns to the month being left rather
     * than continuing past the destination. Everything stays in sync — grid,
     * header and chrome all agree — it is only the arithmetic that is local.
     */
    jump(y, m) {
      const cur = monthAt(stepTarget);
      const dist = (y * 12 + m) - (cur.y * 12 + cur.m);
      if (!dist) return;
      if (Math.abs(dist) <= 2) { goToStep(stepTarget + dist); return; }
      goToStep(stepTarget + Math.sign(dist), { y, m });
    },
    dragStart, dragMove, dragEnd,
    get rowH() { measure(); return rowH; },
    get moving() { return travelling; },
    /** Rows between the top of the window and a date — for the Today hint. */
    offscreenDir(dateStr) {
      const [yy, mm, dd] = dateStr.split('-').map(Number);
      const r = rowOfYMD(yy, mm - 1, dd);
      const top = rowAtStep(stepTarget);
      if (r < top) return -1;
      if (r > top + WINDOW_ROWS - 1) return 1;
      return 0;
    },
    onResize() { if (travelling) { measure(); paint(); } },
    destroy() { destroyed = true; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  };
}
