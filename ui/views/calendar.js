// ─────────────────────────────────────────────────────────────────────────────
// ui/views/calendar.js — the Calendar tab (Phase 8).
//
// The month view: shift week-bar, one-tap "Log today" CTA, day cells with
// effective-hours pills, holiday chips. Plus getWeekStarts, the holiday-
// separator visibility helper (updateHolSeps, pure DOM), and the tab's
// listeners (wireCalendar): month nav, week-flip with undo, day-cell / log-edit
// -> openDayModal, quick-log. The day-modal opens route through ctx.openDayModal
// (no dependency on the day-log modal or modalCtx). ctx members bind to module
// lets on each render.
//
// THE GRID IS A WINDOW, NOT A PAGE. Days are built a WEEK at a time
// (weekRowsHTML) rather than a month at a time, because the grid is a six-row
// window onto one continuous ribbon of weeks — see ui/calendar-ribbon.js. A
// cell knows its own date and which month it belongs to (data-mo); whether it
// is "in" the month on show is a class the engine toggles, not something baked
// into the markup. Days outside the focused month stay in the grid as faint
// ghosts: they are what makes the boundary week readable as one row belonging
// to both months, and what makes the scroll legible while it moves.
//
// Everything that does NOT scroll — the weekday header, legend, week bar,
// quick-log CTA, holiday strip, Today pill — is chrome (chromeParts), swapped
// in place at the moment the target month commits.
// ─────────────────────────────────────────────────────────────────────────────

import { isSun, isSat, pad, mkds, pd, getMonday } from '../../core/dates.js';
import { createRibbon, monthRow, cellDate, WINDOW_ROWS,
         monthWeek, monthWeekEnd, weekDate } from '../calendar-ribbon.js';

// Month-nav chevrons. Up and down, not left and right: the grid moves
// vertically, and a control that points across motion it produces downward is a
// dissonance the user feels on every single press. Down = later, matching the
// direction time already runs inside the grid. Inline rather than in
// ui/icons.js because they exist only for this header; same 24-grid / stroke-2
// / round-caps family as the rest of the app's icons.
const CHEV_U='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';
const CHEV_D='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const CARET='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';

// Bound from ctx on each render:
let S, t, render, today, getLogs, saveLogs, getShifts, saveShifts, shiftFor,
    toggleShift, isHol, holName, isHolAuto, allWeekdaysLogged, defaultLogFor,
    buildQuickLogEntry, autoEff, ensureHolidays, HOLIDAYS,
    showUndoToast, openDayModal, refreshStats;
const bind = ctx => ({ S, t, render, today, getLogs, saveLogs, getShifts, saveShifts,
    shiftFor, toggleShift, isHol, holName, isHolAuto, allWeekdaysLogged, defaultLogFor,
    buildQuickLogEntry, autoEff, ensureHolidays, HOLIDAYS, showUndoToast,
    openDayModal, refreshStats } = ctx);

// The folds below are animated from JS, so they need the preference the
// stylesheet's @media block covers for everything else on this card. Same test
// the ribbon engine uses (see reduced() in ui/calendar-ribbon.js) — read live
// rather than cached, because the setting can change while the app is open.
const reducedMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

let _holSepObserver = null;
// `root` scopes the lookup to the live card.
export function updateHolSeps(root){
  const list = (root || document).querySelector('.hol-list');
  if(!list) return;
  const seps = list.querySelectorAll('.hol-sep');
  seps.forEach(sep => {
    const next = sep.nextElementSibling; // the .hchip after this sep
    const prev = sep.previousElementSibling; // the .hchip before this sep
    if(!next || !prev) { sep.style.display='none'; return; }
    // If the sep's top matches the previous chip's top, they're on the same row → show
    // If the sep wrapped to a new row (its top > prev chip's top), hide it
    const sepTop  = sep.getBoundingClientRect().top;
    const prevTop = prev.getBoundingClientRect().top;
    sep.style.visibility = Math.abs(sepTop - prevTop) < 4 ? '' : 'hidden';
    sep.style.margin     = Math.abs(sepTop - prevTop) < 4 ? '' : '0';
    sep.style.width      = Math.abs(sepTop - prevTop) < 4 ? '' : '0';
  });
  // Watch for container resize and re-evaluate
  if(_holSepObserver) _holSepObserver.disconnect();
  _holSepObserver = new ResizeObserver(() => {
    if(!list.isConnected){ _holSepObserver.disconnect(); return; }
    list.querySelectorAll('.hol-sep').forEach(sep => {
      const next = sep.nextElementSibling;
      const prev = sep.previousElementSibling;
      if(!next || !prev){ sep.style.visibility='hidden'; sep.style.width='0'; sep.style.margin='0'; return; }
      const sepTop  = sep.getBoundingClientRect().top;
      const prevTop = prev.getBoundingClientRect().top;
      const same = Math.abs(sepTop - prevTop) < 4;
      sep.style.visibility = same ? '' : 'hidden';
      sep.style.width      = same ? '' : '0';
      sep.style.margin     = same ? '' : '0';
    });
  });
  _holSepObserver.observe(list);
}

function getWeekStarts(y,m){
  const days=new Date(y,m+1,0).getDate(),seen=new Set(),weeks=[];
  for(let d=1;d<=days;d++){const s=mkds(y,m,d),mon=getMonday(s);if(!seen.has(mon)){seen.add(mon);weeks.push(mon);}}
  return weeks;
}

// ── One shift-week pill ──────────────────────────────────────────────────────
// The shift bar is the same ribbon as the grid, sampled weekly instead of
// daily and laid out across instead of down, so a pill is built exactly like a
// day cell: from its own week alone, carrying the index the engine needs to
// decide whether it is inside the month on show. Weeks here run Monday–Sunday
// because that is what the shift pattern is anchored to — so the bar covers a
// slightly different distance from the grid over the same transition, which is
// fine: they share the progress, not the distance.
function weekPillHTML(wi, focus){
  const ws=weekDate(wi), sh=shiftFor(ws), d=pd(ws);
  const ghost = focus && (wi<monthWeek(focus.y,focus.m) || wi>monthWeekEnd(focus.y,focus.m));
  return`<button class="wsb ${sh==='day'?'day-on':'night-on'}${ghost?' wsb--ghost':''}"`
    +` data-ws="${ws}" data-wi="${wi}">`
    +`<i class="fa-solid ${sh==='day'?'fa-sun':'fa-moon'}"></i> ${d.getMonth()+1}/${d.getDate()}</button>`;
}

function weekPillsHTML(from, to, focus){
  let out='';
  for(let i=from;i<=to;i++) out+=weekPillHTML(i, focus);
  return out;
}

// ── One day ──────────────────────────────────────────────────────────────────
// Everything a cell shows depends on its DATE alone, never on which month is on
// screen — which is what lets the same cell be a ghost in one month's window
// and a full cell in the next without being rebuilt. `data-mo` carries its
// month so the engine can toggle .dc--ghost across the whole ribbon in one
// pass; the classes below are exactly the ones this cell has ever had.
function dayCellHTML(s, todayStr, logs, focusKey){
  const dt=pd(s), y=dt.getFullYear(), m=dt.getMonth(), d=dt.getDate(), dw=dt.getDay();
  const mo=`${y}-${pad(m+1)}`;
  const future=s>todayStr,logged=!!logs[s],hol=isHol(s),tod=s===todayStr;
  // A "credit-only" holiday: a holiday whose log entry is a pure 8h auto-credit
  // (no worked hours) — either created live by holAuto, or baked in when the
  // user turned holAuto OFF (so the credit is preserved). These must keep the
  // auto-credit blue-dot identity, NOT render as a worked day/night shift.
  const _le=logs[s];
  const creditOnlyHol = hol && !!_le && (_le.holCreditOverride===true)
    && !(_le.regHrs>0) && !(_le.otHrs>0);
  // "logged" for display purposes = an actual worked entry (excludes credit-only)
  const workedLog = logged && !creditOnlyHol;
  const sun=dw===0,autoSun=sun&&!hol&&!logged&&!future&&allWeekdaysLogged(s);
  // Auto-credited holiday: live (holAuto ON, no entry) OR a baked credit-only entry.
  // The live auto-credit is suppressed on Saturdays (dw===6): those fall under the
  // separate 50% Saturday pay rule and pay 0 when unworked, so no auto-cred marker.
  const autoHol=hol&&!future&&((!logged&&isHolAuto()&&dw!==6)||creditOnlyHol);
  const dayShift=logs[s]?.shiftOverride||shiftFor(s);
  const isNight=dayShift==='night';
  const isDouble=dayShift==='double';
  let cls='dc';
  if(mo!==focusKey)cls+=' dc--ghost';
  if(future)cls+=' future';if(dw===0)cls+=' csun';if(dw===6)cls+=' csat';
  if(hol)cls+=' hol';
  if(workedLog)cls+=' logged';
  else if(autoSun||autoHol)cls+=' auto-cred';
  if(tod)cls+=' today';
  if(isNight&&(workedLog||autoSun||autoHol))cls+=' night-shift';
  if(isDouble&&(workedLog||autoSun||autoHol))cls+=' double-shift';
  let shiftIcon='';
  if(workedLog){
    if(dayShift==='double') shiftIcon=`<div class="dc-shift dc-shift--double"><i class="fa-solid fa-rotate"></i></div>`;
    else if(dayShift==='night') shiftIcon=`<div class="dc-shift dc-shift--night"><i class="fa-solid fa-moon"></i></div>`;
    else shiftIcon=`<div class="dc-shift dc-shift--day"><i class="fa-solid fa-sun"></i></div>`;
  } else if(autoSun||autoHol){
    shiftIcon=`<div class="dc-shift dc-shift--auto"><i class="fa-solid fa-circle"></i></div>`;
  } else if(!future&&!hol&&dw!==0){
    shiftIcon=`<div class="dc-shift dc-shift--off">·</div>`;
  }
  const holDot=hol?`<div class="dc-hol-dot"></div>`:'';
  const todayBadge=tod?`<div class="dc-today-badge">${t('todayBadge')}</div>`:'';
  // Effective hours pill — shown on logged/auto-credited days (not rest or sunday-only)
  let effPill='';
  if(!future&&dw!==0){
    const effHrs=autoEff(s,logs);
    if(effHrs>0){
      let pillCls='dc-eff-pill';
      if(autoSun||autoHol) pillCls+=' dc-eff-pill--auto';
      else if(dayShift==='night') pillCls+=' dc-eff-pill--night';
      else if(dayShift==='double') pillCls+=' dc-eff-pill--double';
      else pillCls+=' dc-eff-pill--day';
      effPill=`<div class="${pillCls}">${effHrs%1===0?effHrs:effHrs.toFixed(1)}h</div>`;
    }
  }
  return`<div class="${cls}" data-date="${s}" data-mo="${mo}">`
    +`${todayBadge}${holDot}<div class="dn">${d}</div>${shiftIcon}${effPill}</div>`;
}

// Cells for an inclusive range of week rows — the engine's only way to make
// calendar. `focus` is the month currently being navigated to, so rows
// materialised part-way through a transition arrive already ghosted correctly
// rather than flashing as in-month until the next commit. Logs and today are
// read once per range, not once per cell.
function weekRowsHTML(from, to, focus){
  const todayStr=today(), logs=getLogs();
  const key=focus?`${focus.y}-${pad(focus.m+1)}`:'';
  let out='';
  for(let r=from;r<=to;r++)
    for(let c=0;c<7;c++) out+=dayCellHTML(cellDate(r,c), todayStr, logs, key);
  return out;
}

// Does this month contain a double shift? Drives the legend's third chip. Read
// off the month rather than collected while building cells, because cells are
// now built per week and a week belongs to two months.
function monthHasDouble(y,m){
  const logs=getLogs(), todayStr=today(), n=new Date(y,m+1,0).getDate();
  for(let d=1;d<=n;d++){
    const s=mkds(y,m,d);
    if(s>todayStr) continue;
    const le=logs[s];
    if(!le) continue;
    const hol=isHol(s);
    const creditOnly = hol && le.holCreditOverride===true && !(le.regHrs>0) && !(le.otHrs>0);
    if(creditOnly) continue;
    if((le.shiftOverride||shiftFor(s))==='double') return true;
  }
  return false;
}

// ── Chrome ───────────────────────────────────────────────────────────────────
// Everything that does not scroll. All of it is month-scoped but position-
// fixed, so it is swapped in place at commit rather than travelling with the
// ribbon: a legend that slid with the grid would imply it described only the
// rows next to it, which it does not.
function chromeParts(y,m){
  // Ensure holidays for this year (and adjacent) are loaded; re-renders when done if needed
  ensureHolidays([y-1, y, y+1]);
  const logs=getLogs();

  // ── One-tap "Log today" eligibility ──────────────────────────────────────────
  // Offer a quick-log CTA only when: today is in this displayed month, not yet
  // logged, and we have a confident default (defaultLogFor passed its gate).
  // Skip Sundays and public holidays — those are auto-credited (see autoGross/
  // autoEff), so a manual "log today" prompt doesn't apply.
  const _td=today();
  const _tdInMonth = pd(_td).getFullYear()===y && pd(_td).getMonth()===m;
  const _quickDef = (_tdInMonth && !logs[_td] && !(isSun(_td)||isHol(_td))) ? defaultLogFor(_td) : null;
  let quickLogCTA='';
  if(_quickDef){
    const shIcon = _quickDef.shift==='night' ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    const shLabel = _quickDef.shift==='night' ? t('nightShift') : t('dayShift');
    quickLogCTA = `<button class="quick-log-cta" data-quick-log data-date="${_td}">
      <span class="quick-log-cta__ico">${shIcon}</span>
      <span class="quick-log-cta__text">
        <span class="quick-log-cta__title">${t('quickLogToday')}</span>
        <span class="quick-log-cta__sub">${shLabel} · ${_quickDef.regHrs}${t('hoursUnit')}</span>
      </span>
      <span class="quick-log-cta__plus">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </span>
    </button>`;
  }

  const monthHols=Object.entries(HOLIDAYS).filter(([s])=>s.startsWith(`${y}-${pad(m+1)}`));
  const holChips=monthHols.map(([s],i)=>{
    const day=pd(s).getDate();
    const sep=i>0?`<span class="hol-sep" aria-hidden="true"></span>`:'';
    return`${sep}<span class="hchip"><span class="hchip-num">${day}</span>${holName(s)}</span>`;
  }).join('');

  // The Today pill doubles as a direction sign: when today is off the top of
  // the window it points up, off the bottom it points down. The user should
  // never have to guess which way home is.
  const nowD=new Date();
  const isCurrentMonth=(y===nowD.getFullYear()&&m===nowD.getMonth());
  const dir = isCurrentMonth ? 0
    : (monthRow(nowD.getFullYear(),nowD.getMonth()) < monthRow(y,m) ? -1 : 1);
  const todayPill=isCurrentMonth?'':
    `<button class="cal-today" id="cal-today">`
    +`<span class="cal-today-dir${dir>0?' cal-today-dir--down':''}">${CARET}</span>`
    +`${t('todayBadge')}</button>`;

  return{
    monthLabel:t('mn')[m],
    year:String(y),
    todayPill,
    quickLog:quickLogCTA,
    holList:holChips?`<div class="hol-list">${holChips}</div>`:'',
    legend:
      `<span class="cal-leg-item cal-leg-item--day"><i class="fa-solid fa-sun"></i> ${t('dayShift')}</span>
       <span class="cal-leg-item cal-leg-item--night"><i class="fa-solid fa-moon"></i> ${t('nightShift')}</span>
       ${monthHasDouble(y,m)?`<span class="cal-leg-item cal-leg-item--double"><i class="fa-solid fa-rotate"></i> ${t('doubleShift')}</span>`:''}
       <span class="cal-leg-item cal-leg-item--auto"><i class="fa-solid fa-circle"></i> ${t('dayOff')}</span>
       <span class="shift-hint">${t('shiftHint')}</span>`
  };
}

// The static first paint. At rest none of the motion machinery is engaged: the
// ribbon holds exactly the six visible rows, untransformed and unmasked, and
// the viewport is sized by a hidden six-row sizer so the window's height is
// whatever the stylesheet's own cell geometry produces — never a number JS
// computed and could get wrong.
export function buildCal(ctx){
  bind(ctx);
  const y=S.calY, m=S.calM;
  const p=chromeParts(y,m);
  const dh=t('dh');
  const r0=monthRow(y,m), w0=monthWeek(y,m);
  const cells=weekRowsHTML(r0, r0+WINDOW_ROWS-1, {y,m});
  return`<div class="card cal-card">
    <div class="cal-hdr">
      <div class="cal-title">
        <span class="cal-title-mon"><span class="cal-mon-strip"><span class="cal-tok">${p.monthLabel}</span></span></span>
        <span class="cal-title-yr">${p.year}</span>
      </div>
      <div class="cal-hdr-nav">
        <span class="cal-today-slot">${p.todayPill}</span>
        <button class="cal-nav" id="cal-prev" aria-label="${t('prevMonth')}">${CHEV_U}</button>
        <button class="cal-nav" id="cal-next" aria-label="${t('nextMonth')}">${CHEV_D}</button>
      </div>
    </div>
    <div class="cal-legend">${p.legend}</div>
    <div class="week-bar"><div class="wsb-strip">${weekPillsHTML(w0, monthWeekEnd(y,m), {y,m})}</div></div>
    <div class="cal-fold${p.quickLog?'':' cal-fold--empty'}" id="cal-fold-quick"><div class="cal-fold-in">${p.quickLog}</div></div>
    <div class="cal-grid">
      <div class="cal-dow">${dh.map((d,i)=>`<div class="dh${i===0?' sun':i===6?' sat':''}">${d}</div>`).join('')}</div>
      <div class="cal-ribbon-vp">
        <div class="cal-ribbon-sizer" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="cal-ribbon">${cells}</div>
      </div>
    </div>
    <div class="cal-fold${p.holList?'':' cal-fold--empty'}" id="cal-fold-hol"><div class="cal-fold-in">${p.holList}</div></div>
  </div>`;
}

// The live engine for the card currently on screen. A full render() throws that
// card away, so the old one is torn down before a new one is built.
let _ribbon=null;

export function wireCalendar(ctx){
  bind(ctx);
  const card=document.querySelector('.cal-card');
  if(!card) return;
  // wireCalendar runs on every full render AND on every tab switch, both of
  // which rebuild .cal-card from scratch — so the flag lives on the card, not
  // in the module, and resets itself exactly when the nodes do.
  if(card.dataset.calBound) return;
  card.dataset.calBound='1';

  if(_ribbon) _ribbon.destroy();
  _ribbon=createRibbon({
    card,
    start:{ y:S.calY, m:S.calM },
    buildRows:weekRowsHTML,
    buildWeeks:weekPillsHTML,
    monthLabel:ym=>t('mn')[ym.m],
    onCommit:commitMonth,
    onSettle:()=>updateHolSeps(card)
  });

  // ── Commit ──────────────────────────────────────────────────────────────────
  // The month on show is authoritative the instant it changes, not when the
  // motion lands: S drives every other surface (the modal a tapped day opens,
  // the stats hero, a later week flip), and none of them may lag the grid.
  // Every fixed element is swapped here, so the chrome and the grid are never
  // describing different months — including half-way through a drag, which is
  // when the engine hands the month over.
  //
  // `live` means a finger is still down. The cheap swaps run anyway; only
  // rebuilding the stats hero is deferred to the non-live call the engine makes
  // on release, because replacing that block mid-drag risks a dropped frame.
  // The shift bar is NOT swapped here at all any more — it is a ribbon the
  // engine slides, so it follows the finger like the grid does.
  function commitMonth(y,m,dir,live){
    S.calY=y; S.calM=m;
    const p=chromeParts(y,m);

    const leg=card.querySelector('.cal-legend');
    if(leg) swapLegend(leg,p.legend);

    setFold(card.querySelector('#cal-fold-quick'), p.quickLog);
    setFold(card.querySelector('#cal-fold-hol'),   p.holList);

    // Only animate what actually changed. The year is the same token eleven
    // times out of twelve, and sliding an unchanged word is motion that means
    // nothing — so it cross-fades only when it really turns over.
    const yr=card.querySelector('.cal-title-yr');
    if(yr && yr.textContent!==p.year){
      yr.textContent=p.year;
      yr.classList.remove('cal-yr-turn'); void yr.offsetWidth;
      yr.classList.add('cal-yr-turn');
    }

    const slot=card.querySelector('.cal-today-slot');
    if(slot && slot.innerHTML.trim()!==p.todayPill.trim()){
      const had=!!slot.firstElementChild;
      slot.innerHTML=p.todayPill;
      if(!had) slot.firstElementChild?.classList.add('cal-today--in');
    }

    // Earnings, hours and days are all per-month — refresh the hero so its
    // figures travel with the grid rather than snapping when it lands.
    if(!live && refreshStats) refreshStats();
  }

  // Rebuild the legend but only animate chips that are genuinely new (in
  // practice just the double-shift one), so the row does not blink on every
  // navigation.
  function swapLegend(el, html){
    const before=new Set([...el.children].map(c=>c.className));
    el.innerHTML=html;
    [...el.children].forEach(c=>{ if(!before.has(c.className)) c.classList.add('cal-leg-in'); });
  }

  // Open, close and exchange for the two blocks whose content is month-scoped:
  // the quick-log CTA above the grid and the holiday strip below it.
  //
  // EVERY height change is animated, not just present↔absent. The strip is one
  // row for a month with one or two holidays and two rows for a month with
  // three, so "September after August" is a 30px change that never touches the
  // --empty class at all — and a CSS-only fold can only animate the class. It
  // landed in a single frame, which is what the calendar popping under the
  // finger actually was: the strip is the last thing on the page, so a shrink
  // there shortens the document, and the browser clamps the scroll to match.
  //
  // Hence: measure where the fold is, install the new state, measure where it
  // wants to be, and animate between the two. A close keeps its outgoing
  // content for the length of the close — that content is WHAT is closing, and
  // clearing it first is what made the old collapse instant (1fr had already
  // resolved to zero before the class flipped, so there was nothing left to
  // animate). It is dropped once the fold has actually reached zero, and only
  // if nothing newer has claimed the fold in the meantime.
  //
  // THE PAGE MUST NEVER SEE THE NEW SIZE BEFORE THE ANIMATION DOES. Measuring
  // is a layout, and a layout in which this fold has already taken its new
  // (shorter) height is a document that is briefly shorter — which the browser
  // answers by clamping the scroll, and the clamp is NOT given back when the
  // height comes back. That single measurement reproduced the whole bug on its
  // own. So the current height is pinned inline before anything changes, and
  // the target is read off the CONTENT inside that pin rather than off the fold
  // itself: same number, but the fold's own box never budges. The pin is handed
  // straight to the animation with no layout in between, so the first size the
  // page is ever laid out at is the first frame.
  //
  // Duration and easing come off the element (see --fold-dur in the Folds
  // section of the stylesheet), so the fold is timed with the rest of the card
  // rather than by a number duplicated here.
  function foldTiming(fold){
    const cs=getComputedStyle(fold), d=cs.getPropertyValue('--fold-dur').trim();
    return { duration: (parseFloat(d)||360) * (/\dms$/.test(d) ? 1 : 1000),
             easing: cs.getPropertyValue('--fold-ease').trim() || 'ease-out' };
  }

  function setFold(fold, html){
    if(!fold) return;
    const inner=fold.querySelector('.cal-fold-in');
    const want=html.trim();
    // Tracked on the node rather than read back off innerHTML: mid-close the
    // DOM still holds the outgoing content, so the DOM is not the answer to
    // "what is this fold currently showing?".
    if(fold._foldWant===undefined) fold._foldWant=inner.innerHTML.trim();
    if(fold._foldWant===want) return;
    const exchanging=!!fold._foldWant && !!want;
    fold._foldWant=want;
    // Both read style, so both are read up front: anything that flushes style
    // has to happen before the pin goes on, never while it is coming off.
    const timing=foldTiming(fold), reduced=reducedMotion();

    // Read, then pin, then cancel — in that order. `from` is wherever the fold
    // is right now, mid-animation included; pinning it first means the cancel
    // below reverts to that height rather than to the natural one.
    const from=fold.getBoundingClientRect().height;
    fold.style.height=from+'px';
    fold._foldAnim?.cancel();
    fold._foldAnim=null;

    if(want){
      inner.innerHTML=html;
      // Opening and closing are already motion; only an exchange needs the
      // content itself to arrive rather than cut.
      inner.classList.remove('cal-fold-in--in');
      if(exchanging){ void inner.offsetWidth; inner.classList.add('cal-fold-in--in'); }
    }
    fold.classList.toggle('cal-fold--empty', !want);
    // The one layout in here, and it happens with the pin on. .cal-fold-in
    // carries its own overflow, so its box height is the fold's natural height
    // — the holiday strip's top margin included rather than collapsed away.
    const to=want ? inner.getBoundingClientRect().height : 0;

    const settle=()=>{
      fold._foldAnim=null;
      if(!fold._foldWant){ inner.innerHTML=''; inner.classList.remove('cal-fold-in--in'); }
    };
    if(from===to || reduced){ fold.style.height=''; settle(); return; }
    fold._foldAnim=fold.animate([{height:from+'px'},{height:to+'px'}], timing);
    // Only onfinish. cancel() does not fire it, which is exactly right: a
    // cancel means the next navigation has taken the fold over, and it has
    // already measured from wherever this one had got to.
    fold._foldAnim.onfinish=settle;
    // The pin comes off only once the animation owns the height — an animation
    // outranks an inline style, so this changes nothing on screen. The other
    // order leaves a window, however short, in which the fold sits at its new
    // size with nothing holding it, and one layout inside that window is all it
    // takes: the document is briefly short, the scroll is clamped to fit, and
    // the clamp stays after the height has gone back.
    fold.style.height='';
  }

  // ── Navigation ──────────────────────────────────────────────────────────────
  const tick=ms=>{ if(navigator.vibrate) navigator.vibrate(ms); };
  // Set by the gesture handler below; read by the click handler above it.
  let swallowClick=false;

  card.addEventListener('click',e=>{
    // A drag ends in a click on whatever was under the finger. That is not a
    // tap and must not reach a day cell or a chevron.
    if(swallowClick){ e.stopPropagation(); e.preventDefault(); return; }

    const prev=e.target.closest('#cal-prev');
    const next=e.target.closest('#cal-next');
    if(prev||next){ tick(8); _ribbon.go(prev?-1:1); return; }

    if(e.target.closest('#cal-today')){
      const nd=new Date();
      _ribbon.jump(nd.getFullYear(), nd.getMonth());
      return;
    }

    const wsb=e.target.closest('.wsb[data-ws]');
    if(wsb){ flipWeek(wsb.dataset.ws); return; }

    const quick=e.target.closest('[data-quick-log]');
    if(quick){ quickLog(quick.dataset.date); return; }

    const cell=e.target.closest('.dc[data-date]');
    if(cell){
      // Ghosts are context, not targets (CSS makes them inert too).
      if(cell.classList.contains('dc--ghost')) return;
      const s=cell.dataset.date;
      if(s>today()) return;
      openDayModal(s);
      return;
    }

    const edit=e.target.closest('.log-edit[data-date]');
    if(edit) openDayModal(edit.dataset.date);
  });

  // ── Gesture ─────────────────────────────────────────────────────────────────
  // ONE AXIS, ONE MEANING. A vertical drag is direct manipulation: the ribbon
  // follows the finger 1:1 on the same axis it moves on, which is the only
  // honest way to drag a scrolling surface. The horizontal axis is not the
  // calendar's to take — sideways is how you move between the app's three tabs
  // (see ui/tab-pager.js), and a surface that answered a sideways swipe with a
  // month change would be the one place in the app where that gesture meant
  // something else. So this decides the axis and then keeps only its own:
  // mode 2 is "not ours", and the events go on to the pager untouched.
  //
  // touch-action:none on the viewport is what makes the vertical drag possible
  // at all: the browser would otherwise have begun scrolling the page before we
  // could know which gesture this was. It costs the pager nothing — a listener
  // still sees every move — and the page stays scrollable from every other part
  // of the card.
  const vp=card.querySelector('.cal-ribbon-vp');
  let sx=0, sy=0, tracking=false, mode=0;   // 0 undecided, 1 vertical, 2 sideways
  let lastP=0, lastT=0, vpx=0;

  if(vp){
    vp.addEventListener('touchstart',e=>{
      if(e.touches.length!==1){ tracking=false; return; }
      sx=e.touches[0].clientX; sy=lastP=e.touches[0].clientY;
      lastT=e.timeStamp; vpx=0;
      tracking=true; mode=0;
    },{passive:true});

    vp.addEventListener('touchmove',e=>{
      if(!tracking) return;
      const x=e.touches[0].clientX, y=e.touches[0].clientY;
      const dx=x-sx, dy=y-sy;
      if(!mode){
        if(Math.abs(dx)<8 && Math.abs(dy)<8) return;
        mode = Math.abs(dy)>=Math.abs(dx) ? 1 : 2;
        // Sideways belongs to the pager. Stop tracking rather than idle through
        // the rest of the gesture, so nothing here can claim the tap that ends
        // it — the pager makes the moving pages inert for exactly that reason.
        if(mode===2){ tracking=false; return; }
        _ribbon.dragStart(); lastP=y; lastT=e.timeStamp;
      }
      const dt=e.timeStamp-lastT;
      if(dt>0){ vpx=(y-lastP)/dt; lastP=y; lastT=e.timeStamp; }
      _ribbon.dragMove(dy);
    },{passive:true});

    const release=e=>{
      if(!tracking) return;
      tracking=false;
      if(mode!==1) return;
      // Stale samples mean the finger stopped before lifting — a considered
      // placement, not a flick, so the velocity is dropped.
      const rowH=_ribbon.rowH||1;
      // px/ms → steps/sec. Dragging up (negative px) advances; a step is
      // whatever this month is worth in rows, so ~5 rows.
      const v=(e.timeStamp-lastT)<80 ? (-vpx*1000)/(rowH*5) : 0;
      if(_ribbon.dragEnd(v)) tick(8);
      swallowClick=true;
      setTimeout(()=>{ swallowClick=false; },350);
    };
    vp.addEventListener('touchend',release,{passive:true});
    vp.addEventListener('touchcancel',release,{passive:true});
  }

  // Bound once for the app's lifetime — the card is rebuilt constantly, so a
  // per-render listener here would stack up. It reads whichever engine is live.
  if(!window._calRibbonResizeBound){
    window._calRibbonResizeBound=true;
    window.addEventListener('resize',()=>{ if(_ribbon) _ribbon.onResize(); });
  }

  // ── Week-bar flip ───────────────────────────────────────────────────────────
  function flipWeek(ws){
    // Snapshot the entire shifts map so Undo can fully restore it — the flip
    // deletes all superseded anchors, so a simple inverse toggle isn't enough.
    const prev=JSON.parse(JSON.stringify(getShifts()));
    toggleShift(ws);
    const newShift=shiftFor(ws);
    render();
    const label=t(newShift==='day'?'dayShift':'nightShift');
    showUndoToast(t('weekFlipUndo').replace('{0}',label),()=>{
      saveShifts(prev);
      render();
    });
  }
  // Highlight every week from the hovered/focused one onward, so the user can
  // SEE that flipping a week re-alternates all later weeks (not just this one).
  // Delegated: the buttons are replaced on every commit, so nothing may hold a
  // reference to them.
  function setDownstreamCue(btn,on){
    const bar=btn.closest('.week-bar');
    if(!bar) return;
    bar.querySelectorAll('.wsb[data-ws]').forEach(b=>{
      if(b.dataset.ws>=btn.dataset.ws) b.classList.toggle('wsb--affected',on);
    });
  }
  ['mouseover','mouseout','focusin','focusout'].forEach(type=>{
    card.addEventListener(type,e=>{
      const b=e.target.closest?.('.wsb[data-ws]');
      if(!b) return;
      // mouseover/out also fire when moving between a button's own children;
      // ignore those so the cue doesn't flicker.
      if(e.relatedTarget && b.contains(e.relatedTarget)) return;
      setDownstreamCue(b, type==='mouseover'||type==='focusin');
    });
  });

  // ── One-tap "Log today" ──────────────────────────────────────────────────────
  function quickLog(s){
    const entry=buildQuickLogEntry(s);
    if(!entry) return; // gate no longer met (shouldn't happen) — fail safe
    const logs=getLogs();
    const prev=logs[s]; // capture for undo (normally undefined)
    logs[s]=entry;
    saveLogs(logs);
    if(navigator.vibrate) navigator.vibrate(12); // subtle haptic tick
    render();
    showUndoToast(t('quickLoggedToast'),()=>{
      const l=getLogs();
      if(prev!==undefined) l[s]=prev; else delete l[s];
      saveLogs(l);
      render();
    });
  }
}
