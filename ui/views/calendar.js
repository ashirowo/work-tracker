// ─────────────────────────────────────────────────────────────────────────────
// ui/views/calendar.js — the Calendar tab (Phase 8).
//
// The month grid (buildCal): shift week-bar, one-tap "Log today" CTA, day cells
// with effective-hours pills, holiday chips. Plus getWeekStarts, the holiday-
// separator visibility helper (updateHolSeps, pure DOM), and the tab's
// listeners (wireCalendar): month nav, week-flip with undo, day-cell / log-edit
// -> openDayModal, quick-log. Bodies verbatim; the day-modal opens route
// through ctx.openDayModal (no dependency on the day-log modal or modalCtx).
// ctx members bind to module lets on each render.
// ─────────────────────────────────────────────────────────────────────────────

import { isSun, isSat, pad, mkds, pd, getMonday } from '../../core/dates.js';

// Bound from ctx on each render:
let S, t, render, today, getLogs, saveLogs, getShifts, saveShifts, shiftFor,
    toggleShift, isHol, holName, isHolAuto, allWeekdaysLogged, defaultLogFor,
    buildQuickLogEntry, autoEff, appFooter, ensureHolidays, HOLIDAYS,
    showUndoToast, openDayModal;
const bind = ctx => ({ S, t, render, today, getLogs, saveLogs, getShifts, saveShifts,
    shiftFor, toggleShift, isHol, holName, isHolAuto, allWeekdaysLogged, defaultLogFor,
    buildQuickLogEntry, autoEff, appFooter, ensureHolidays, HOLIDAYS, showUndoToast,
    openDayModal } = ctx);

let _holSepObserver = null;
export function updateHolSeps(){
  const list = document.querySelector('.hol-list');
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
    const l = document.querySelector('.hol-list');
    if(!l){ _holSepObserver.disconnect(); return; }
    l.querySelectorAll('.hol-sep').forEach(sep => {
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


export function buildCal(ctx){
  bind(ctx);
  const y=S.calY,m=S.calM,firstDay=new Date(y,m,1).getDay(),daysInM=new Date(y,m+1,0).getDate();
  // Ensure holidays for this year (and adjacent) are loaded; re-renders when done if needed
  ensureHolidays([y-1, y, y+1]);
  const todayStr=today(),logs=getLogs(),dh=t('dh');
  const weeks=getWeekStarts(y,m);
  // ── One-tap "Log today" eligibility ──────────────────────────────────────────
  // Offer a quick-log CTA only when: today is in this displayed month, not yet
  // logged, and we have a confident default (defaultLogFor passed its gate).
  // Skip Sundays and public holidays — those are auto-credited (see autoGross/
  // autoEff), so a manual "log today" prompt doesn't apply.
  const _td=today();
  const _tdInMonth = pd(_td).getFullYear()===y && pd(_td).getMonth()===m;
  const _tdLogged = !!logs[_td];
  const _tdAutoDay = isSun(_td) || isHol(_td);
  const _quickDef = (_tdInMonth && !_tdLogged && !_tdAutoDay) ? defaultLogFor(_td) : null;
  let quickLogCTA='';
  if(_quickDef){
    const shIcon = _quickDef.shift==='night' ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    const shLabel = _quickDef.shift==='night' ? t('nightShift') : t('dayShift');
    quickLogCTA = `<button class="quick-log-cta" id="quick-log-today" data-date="${_td}">
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
  const wkBtns=weeks.map(ws=>{
    const sh=shiftFor(ws),d=pd(ws);
    return`<button class="wsb ${sh==='day'?'day-on':'night-on'}" data-ws="${ws}"><i class="fa-solid ${sh==='day'?'fa-sun':'fa-moon'}"></i> ${d.getMonth()+1}/${d.getDate()}</button>`;
  }).join('');
  let cells='';
  let hasDoubleThisMonth=false;
  for(let i=0;i<firstDay;i++)cells+=`<div class="dc empty"></div>`;
  for(let d=1;d<=daysInM;d++){
    const s=mkds(y,m,d),dw=new Date(y,m,d).getDay();
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
    if(future)cls+=' future';if(dw===0)cls+=' csun';if(dw===6)cls+=' csat';
    if(hol)cls+=' hol';
    if(workedLog)cls+=' logged';
    else if(autoSun||autoHol)cls+=' auto-cred';
    if(tod)cls+=' today';
    if(isNight&&(workedLog||autoSun||autoHol))cls+=' night-shift';
    if(isDouble&&(workedLog||autoSun||autoHol))cls+=' double-shift';
    let shiftIcon='';
    if(workedLog){
      if(dayShift==='double'){ shiftIcon=`<div class="dc-shift dc-shift--double"><i class="fa-solid fa-rotate"></i></div>`; hasDoubleThisMonth=true; }
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
    cells+=`<div class="${cls}" data-date="${s}">${todayBadge}${holDot}<div class="dn">${d}</div>${shiftIcon}${effPill}</div>`;
  }
  const monthHols=Object.entries(HOLIDAYS).filter(([s])=>s.startsWith(`${y}-${pad(m+1)}`));
  const holChips=monthHols.map(([s],i)=>{
    const day=pd(s).getDate();
    const sep=i>0?`<span class="hol-sep" aria-hidden="true"></span>`:'';
    return`${sep}<span class="hchip"><span class="hchip-num">${day}</span>${holName(s)}</span>`;
  }).join('');

  // Show Today button only when not on the current month
  const nowD=new Date(), nowY=nowD.getFullYear(), nowM=nowD.getMonth();
  const isCurrentMonth=(y===nowY&&m===nowM);
  const todayBtn=isCurrentMonth?'':
    `<button class="cal-nav cal-nav--today" id="cal-today">${t('todayBadge')}</button>`;

  return`<div class="card">
    <div class="cal-hdr">
      <div class="cal-hdr-left">
        <button class="cal-nav" id="cal-prev">‹</button>
        ${todayBtn}
      </div>
      <div class="cal-month">${t('mn')[m]} ${y}</div>
      <button class="cal-nav" id="cal-next">›</button>
    </div>
    <div class="cal-legend">
      <span class="cal-leg-item cal-leg-item--day"><i class="fa-solid fa-sun"></i> ${t('dayShift')}</span>
      <span class="cal-leg-item cal-leg-item--night"><i class="fa-solid fa-moon"></i> ${t('nightShift')}</span>
      ${hasDoubleThisMonth?`<span class="cal-leg-item cal-leg-item--double"><i class="fa-solid fa-rotate"></i> ${t('doubleShift')}</span>`:''}
      <span class="cal-leg-item cal-leg-item--auto"><i class="fa-solid fa-circle"></i> ${t('dayOff')}</span>
    </div>
    <div class="shift-hint">${t('shiftHint')}</div>
    <div class="week-bar">${wkBtns}</div>
    ${quickLogCTA}
    <div class="cal-grid">
      ${dh.map((d,i)=>`<div class="dh${i===0?' sun':i===6?' sat':''}">${d}</div>`).join('')}
      ${cells}
    </div>
    ${holChips?`<div class="hol-list">${holChips}</div>`:''}
  </div>
  ${appFooter()}`;
}

export function wireCalendar(ctx){
  bind(ctx);
  const cp=document.getElementById('cal-prev');
  if(cp)cp.addEventListener('click',()=>{S.calM--;if(S.calM<0){S.calM=11;S.calY--;}render();});
  const cn=document.getElementById('cal-next');
  if(cn)cn.addEventListener('click',()=>{S.calM++;if(S.calM>11){S.calM=0;S.calY++;}render();});
  const ct=document.getElementById('cal-today');
  if(ct)ct.addEventListener('click',()=>{const nd=new Date();S.calY=nd.getFullYear();S.calM=nd.getMonth();render();});
  const wsbBtns=[...document.querySelectorAll('.wsb[data-ws]')];
  // Highlight every week from the hovered/focused one onward, so the user can
  // SEE that flipping a week re-alternates all later weeks (not just this one).
  function setDownstreamCue(fromWs,on){
    wsbBtns.forEach(btn=>{
      if(btn.dataset.ws>=fromWs) btn.classList.toggle('wsb--affected',on);
    });
  }
  wsbBtns.forEach(b=>{
    const ws=b.dataset.ws;
    b.addEventListener('mouseenter',()=>setDownstreamCue(ws,true));
    b.addEventListener('mouseleave',()=>setDownstreamCue(ws,false));
    b.addEventListener('focus',()=>setDownstreamCue(ws,true));
    b.addEventListener('blur',()=>setDownstreamCue(ws,false));
    b.addEventListener('click',()=>{
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
    });
  });
  document.querySelectorAll('.dc[data-date]').forEach(el=>el.addEventListener('click',()=>{
    const s=el.dataset.date;if(s>today())return;
    openDayModal(s);
  }));
  // ── One-tap "Log today" ──────────────────────────────────────────────────────
  const quickBtn=document.getElementById('quick-log-today');
  if(quickBtn) quickBtn.addEventListener('click',()=>{
    const s=quickBtn.dataset.date;
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
  });
  document.querySelectorAll('.log-edit[data-date]').forEach(el=>el.addEventListener('click',()=>{
    openDayModal(el.dataset.date);
  }));
}
