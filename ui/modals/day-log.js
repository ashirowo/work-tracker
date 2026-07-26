// ─────────────────────────────────────────────────────────────────────────────
// ui/modals/day-log.js — the per-day work-log modal (Phase 7).
//
// The core logging UI: shift toggle, reg/OT steppers, holiday-credit switch,
// note field, and a live pay preview — self-contained (local `ms` state, no
// render() until commit). Opened from calendar cells, log-edit buttons, the
// Overview empty-state CTA, and All-Shifts rows (all set S.modal then render).
// The most app-coupled modal: ~17 ctx members bind to module lets on each open
// (one modal at a time) so the body stays verbatim. The All-Shifts return trip
// goes through ctx.openAllShifts (no modal->modal import).
// ─────────────────────────────────────────────────────────────────────────────

import { animateModalClose } from '../dom.js';
import { attachSheetGestures } from '../motion.js';
import { dowOf, pd } from '../../core/dates.js';

// Bound from ctx on each open:
let t, render, getLogs, saveLogs, wageFor, calcWage, isHol, isSat, isSun, holName,
    isHolAuto, allWeekdaysLogged, shiftFor, showUndoToast, getActiveDeductionPct,
    getDeductionNoun, S, openAllShifts;

export function buildModal(ctx){
  ({t,render,getLogs,saveLogs,wageFor,calcWage,isHol,isSat,isSun,holName,isHolAuto,allWeekdaysLogged,shiftFor,showUndoToast,getActiveDeductionPct,getDeductionNoun,S,openAllShifts}=ctx);
  const{date,existing}=S.modal;
  const holDay=isHol(date),sun=isSun(date)&&!isHol(date),sat=isSat(date)&&!isHol(date);
  const weekShift=shiftFor(date);
  const wage=wageFor(date),dn=t('dn'),mn=t('mn'),dw=dowOf(date);
  const dObj=pd(date);

  // ── Local modal state (never stored in S) ──────────────────────────────────
  const ms={
    shift: existing?.shiftOverride || weekShift,
    holCredit: holDay
      ? (existing?.holCreditOverride ?? isHolAuto())
      : undefined,
    breakdownOpen:false,
  };

  // Default input values
  const defReg = existing?.regHrs !== undefined
    ? existing.regHrs
    : (sun ? 0 : holDay ? (ms.holCredit ? 0 : 8) : 8);
  const defOT = existing?.otHrs !== undefined ? existing.otHrs : 0;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getReg(){ const el=document.getElementById('m-reg'); return el ? parseFloat(el.value)||0 : 0; }
  function getOT(){  const el=document.getElementById('m-ot');  return el ? parseFloat(el.value)||0 : 0; }
  const fmtH=h=>(h%1===0?String(h):h.toFixed(2).replace(/0$/,''));

  // Patch the live preview in place (build-once DOM; textContent swaps only) so
  // the disclosure stays open across refreshes and the net value can animate.
  let _lastNet=null;
  function refreshPreview(){
    const r = ms.shift==='double' ? 0 : getReg();
    const o = getOT();
    const c = calcWage(date,r,o,wage,ms.shift,ms.holCredit);
    const tax=c.gross-c.net;
    const netEl=document.getElementById('wm2-net');
    if(netEl){
      const txt='₩'+c.net.toLocaleString();
      if(netEl.textContent!==txt){
        netEl.textContent=txt;
        if(_lastNet!==null){ // no tick on first paint
          netEl.classList.remove('wm2-tick');
          void netEl.offsetWidth; // restart animation
          netEl.classList.add('wm2-tick');
        }
      }
      _lastNet=c.net;
    }
    const grossEl=document.getElementById('wm2-gross');
    if(grossEl) grossEl.textContent=`${t('gross')} ₩${c.gross.toLocaleString()}`;
    const taxEl=document.getElementById('wm2-taxv');
    if(taxEl) taxEl.textContent=`${t('taxLine',getActiveDeductionPct(),getDeductionNoun())} −₩${tax.toLocaleString()}`;
    // Effective-hours transform: show "input → effective" when they differ
    const effEl=document.getElementById('wm2-effv');
    if(effEl){
      const inputTotal=r+o;
      const hu=t('hoursUnit');
      effEl.textContent=(ms.shift!=='double' && Math.abs(inputTotal-c.eff)>0.001)
        ? `${fmtH(inputTotal)}${hu} → ${fmtH(c.eff)}${hu}`
        : `${fmtH(c.eff)}${hu}`;
    }
    const notesEl=document.getElementById('wm2-notes');
    if(notesEl) notesEl.innerHTML=c.notes.map(n=>`<div class="wm2-note">${n}</div>`).join('');
  }

  // ── Header pieces ──────────────────────────────────────────────────────────
  let badges='';
  if(holDay) badges+=`<span class="mbadge b-hol">● ${holName(date)}</span>`;
  if(isSun(date)) badges+=`<span class="mbadge b-sun">${dn[0]}</span>`;
  if(sat) badges+=`<span class="mbadge b-sat">${dn[6]}</span>`;

  // ── Stepper field ──────────────────────────────────────────────────────────
  function stepperHTML(id,label,value,hint,extraAttrs=''){
    return`<div class="fg">
      <label for="${id}">${label}${hint?` <span style="font-size:10px;color:var(--text-hint);text-transform:none;letter-spacing:0;">${hint}</span>`:''}</label>
      <div class="wm2-stepper">
        <button type="button" class="wm2-step-btn" data-step="${id}" data-dir="-1" aria-label="−0.5">−</button>
        <input id="${id}" type="number" value="${value}" min="0" step="0.5"${extraAttrs} inputmode="decimal">
        <button type="button" class="wm2-step-btn" data-step="${id}" data-dir="1" aria-label="+0.5">+</button>
      </div>
    </div>`;
  }

  function buildRegOtRows(sh){
    return`<div class="fg-row wm2-hours-row${sh==='double'?' wm2-hours-row--solo':''}" id="m-hours-row" style="margin-bottom:0;">
      <div id="m-reg-row" class="wm2-reg-row${sh==='double'?' wm2-reg-row--collapsed':''}"${sh==='double'?' aria-hidden="true"':''}>
        ${stepperHTML('m-reg',t('regHrs'),defReg,'')}
      </div>
      <div id="m-ot-row">
        ${stepperHTML('m-ot',t('otHrs'),defOT,t('otHint'),' max="24"')}
      </div>
    </div>`;
  }

  // Holiday credit — the app's real switch, not an emoji button
  function buildHolCreditToggle(hc){
    if(isHolAuto()) return '';
    return`<div class="wm2-credit-row">
      <span class="wm2-credit-lbl">${t('holCreditToggle')}</span>
      <button id="m-hol-credit" class="s3-toggle${hc?' s3-toggle--on':''}" role="switch" aria-checked="${!!hc}" aria-label="${t('holCreditToggle')}">
        <span class="s3-toggle-knob"></span>
      </button>
    </div>`;
  }

  // ── Live pay preview (static skeleton; values patched by refreshPreview) ───
  const previewHTMLShell=`<div class="wm2-preview" id="m-preview">
    <div class="wm2-net-lbl">${t('net')}</div>
    <div class="wm2-net" id="wm2-net"></div>
    <div class="wm2-sub">
      <span id="wm2-gross"></span>
      <span class="wm2-sub-dot">·</span>
      <span class="wm2-tax" id="wm2-taxv"></span>
    </div>
    <div class="wm2-eff">
      <span>${t('eff')}</span>
      <span class="wm2-eff-val" id="wm2-effv"></span>
    </div>
    <div class="wm2-eff" style="border-top:none;margin-top:2px;padding-top:0;">
      <span>${t('rateLabel')}</span>
      <span class="wm2-eff-val" style="color:var(--text-muted);">₩${wage.toLocaleString()}</span>
    </div>
    <div class="wm2-disc" id="wm2-disc">
      <button type="button" class="wm2-disc-btn" id="wm2-disc-btn" aria-expanded="false">
        <span class="wm2-disc-chev">▶</span>${t('mBreakdown')}
      </button>
      <div class="wm2-notes" id="wm2-notes"></div>
    </div>
  </div>`;

  // ── Body per day type ──────────────────────────────────────────────────────
  let bodyHTML='';
  if(sun){
    const autoSunQual=allWeekdaysLogged(date);
    bodyHTML=`<div class="info-box">${autoSunQual?t('sunAuto'):t('sunNotYet')}</div>
    <div class="info-box accent" style="margin-top:0;">${t('sunWorkedInfo')}</div>
    ${buildRegOtRows(ms.shift)}
    ${previewHTMLShell}`;
  }else if(holDay){
    const holInfoKey=(ms.holCredit && dw!==6)?'holInfo':'holInfoNoAuto';
    bodyHTML=`<div class="info-box warn" id="m-hol-info">${t(holInfoKey)}</div>
    ${buildHolCreditToggle(ms.holCredit)}
    ${buildRegOtRows(ms.shift)}
    ${previewHTMLShell}`;
  }else{
    bodyHTML=`${buildRegOtRows(ms.shift)}
    ${previewHTMLShell}`;
  }

  // ── Note field (optional, free text, max 120 chars) ────────────────────────
  const existingNote = existing?.note || '';
  const noteHTML=`<div class="wm2-note-field" id="m-note-field">
    <div class="wm2-note-head">
      <svg class="wm2-note-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
      <span class="wm2-note-lbl">${t('noteLabel')} <span class="wm2-note-opt">${t('otHint')}</span></span>
      <span class="wm2-note-count" id="m-note-count">${existingNote.length} / 120</span>
    </div>
    <textarea id="m-note" class="wm2-note-input" maxlength="120" rows="2" placeholder="${t('notePlaceholder')}">${existingNote.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
  </div>`;

  const _segPos={day:0,night:1,double:2};
  const shiftToggleHTML=`<div class="wm2-seg" role="radiogroup" aria-label="${t('dayShift')}/${t('nightShift')}/${t('doubleShift')}">
    <div class="wm2-seg-pill wm2-seg-pill--${ms.shift}" id="m-seg-pill" style="--seg-pos:${_segPos[ms.shift]};" aria-hidden="true"></div>
    <button id="m-shift-day" class="shift-tog${ms.shift==='day'?' shift-tog-on-day':''}" role="radio" aria-checked="${ms.shift==='day'}"><i class="fa-solid fa-sun"></i> ${t('dayShift')}</button>
    <button id="m-shift-night" class="shift-tog${ms.shift==='night'?' shift-tog-on-night':''}" role="radio" aria-checked="${ms.shift==='night'}"><i class="fa-solid fa-moon"></i> ${t('nightShift')}</button>
    <button id="m-shift-double" class="shift-tog${ms.shift==='double'?' shift-tog-on-double':''}" role="radio" aria-checked="${ms.shift==='double'}"><i class="fa-solid fa-rotate"></i> ${t('doubleShift')}</button>
  </div>`;

  // ── Build and mount overlay ────────────────────────────────────────────────
  document.querySelectorAll('#modal-ov').forEach(el=>el.remove());
  const ov=document.createElement('div');
  ov.className='modal-overlay';ov.id='modal-ov';
  document.body.classList.add('modal-open');
  ov.innerHTML=`<div class="modal wm-modal">
    <div class="wm-glow" aria-hidden="true"></div>
    <div class="wm-scroll">
    <div class="wm-header">
      <div class="wm-header-badge">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2.5"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>
      </div>
      <div class="wm-header-text">
        <div class="wm2-eyebrow">${dn[dw]} · ${dObj.getFullYear()}</div>
        <h3 class="wm2-title">${mn[dObj.getMonth()]} ${dObj.getDate()}</h3>
      </div>
      <button class="asm-close-btn wm-close" id="m-cancel-x" aria-label="${t('cancel')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="wm-divider"></div>
    <div class="wm2-badges">${badges}</div>
    ${shiftToggleHTML}
    ${bodyHTML}
    ${noteHTML}
    <div class="m-actions">
      <button class="btn-sec" id="m-cancel">${t('cancel')}</button>
      ${existing?`<button class="btn-del" id="m-del">${t('del')}</button>`:''}
      <button class="btn-pri" id="m-save">${t('save')}</button>
    </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  refreshPreview(); // first paint of the live values

  // ── Wire events — all update modal DOM only, never call render() ───────────

  ov.addEventListener('click',e=>{if(e.target.id==='modal-ov')closeModal();});
  // Mobile: drag the sheet down to dismiss (no-op above 540px).
  attachSheetGestures(ov, closeModal);
  document.getElementById('m-cancel').addEventListener('click',()=>closeModal());
  document.getElementById('m-cancel-x')?.addEventListener('click',()=>closeModal());

  // Keyboard: Enter saves, Escape closes (fires while focus is inside the panel)
  ov.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();closeModal();}
    else if(e.key==='Enter' && e.target.tagName!=='BUTTON'){
      e.preventDefault();document.getElementById('m-save')?.click();
    }
  });

  const delBtn=document.getElementById('m-del');
  if(delBtn) delBtn.addEventListener('click',()=>{
    const l=getLogs();
    const removed=l[date]; // capture for undo
    delete l[date];
    saveLogs(l);
    closeModal(true);
    if(removed!==undefined){
      showUndoToast(t('logDeletedToast'),()=>{
        const cur=getLogs();
        cur[date]=removed;
        saveLogs(cur);
        render();
      });
    }
  });

  // Hour inputs → refresh preview only
  const regIn=document.getElementById('m-reg');
  const otIn=document.getElementById('m-ot');
  if(regIn) regIn.addEventListener('input',refreshPreview);
  if(otIn)  otIn.addEventListener('input',refreshPreview);

  // Stepper buttons: ±0.5, clamped to 0–24, snapped to the 0.5 grid
  ov.querySelectorAll('.wm2-step-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const input=document.getElementById(btn.dataset.step);
      if(!input) return;
      const cur=parseFloat(input.value)||0;
      let next=Math.round((cur+0.5*Number(btn.dataset.dir))*2)/2;
      next=Math.min(24,Math.max(0,next));
      input.value=next;
      refreshPreview();
    });
  });

  // Shift toggle → update button styles, show/hide reg row, refresh preview
  function applyShiftToggle(newShift){
    ms.shift=newShift;
    // Slide the pill to the new slot and swap its color variant
    const pill=document.getElementById('m-seg-pill');
    if(pill){
      pill.style.setProperty('--seg-pos',_segPos[newShift]);
      pill.className='wm2-seg-pill wm2-seg-pill--'+newShift;
    }
    ['day','night','double'].forEach(s=>{
      const btn=document.getElementById('m-shift-'+s);
      if(btn){
        btn.className='shift-tog'+(newShift===s?' shift-tog-on-'+s:'');
        btn.setAttribute('aria-checked',String(newShift===s));
      }
    });
    // ── Show/hide the reg-hours field when switching to/from Double ──
    // Layout snaps instantly (no height animation).
    const regRow=document.getElementById('m-reg-row');
    const hoursRow=document.getElementById('m-hours-row');
    const toDouble=newShift==='double';

    if(regRow){
      regRow.classList.toggle('wm2-reg-row--collapsed',toDouble);
      regRow.setAttribute('aria-hidden',String(toDouble));
    }
    if(hoursRow) hoursRow.classList.toggle('wm2-hours-row--solo',toDouble);

    refreshPreview();
  }
  ['day','night','double'].forEach(s=>{
    const btn=document.getElementById('m-shift-'+s);
    if(btn) btn.addEventListener('click',()=>applyShiftToggle(s));
  });

  // Holiday credit switch → flip knob, patch info text + default hours, refresh
  const holCreditBtn=document.getElementById('m-hol-credit');
  if(holCreditBtn) holCreditBtn.addEventListener('click',()=>{
    ms.holCredit=!ms.holCredit;
    holCreditBtn.classList.toggle('s3-toggle--on',ms.holCredit);
    holCreditBtn.setAttribute('aria-checked',String(ms.holCredit));
    const infoBox=document.getElementById('m-hol-info');
    if(infoBox) infoBox.textContent=t(ms.holCredit?'holInfo':'holInfoNoAuto');
    // Update default reg hours if no value has been entered yet
    if(regIn && (parseFloat(regIn.value)||0)===0){
      regIn.value=ms.holCredit?0:8;
    }
    refreshPreview();
  });

  // Note field → live char counter
  const noteIn=document.getElementById('m-note');
  const noteCount=document.getElementById('m-note-count');
  if(noteIn && noteCount){
    noteIn.addEventListener('input',()=>{
      noteCount.textContent=`${noteIn.value.length} / 120`;
    });
  }

  const discBtn=document.getElementById('wm2-disc-btn');
  if(discBtn) discBtn.addEventListener('click',()=>{
    ms.breakdownOpen=!ms.breakdownOpen;
    document.getElementById('wm2-disc')?.classList.toggle('wm2-disc--open',ms.breakdownOpen);
    discBtn.setAttribute('aria-expanded',String(ms.breakdownOpen));
  });

  const saveBtn=document.getElementById('m-save');
  if(saveBtn) saveBtn.addEventListener('click',()=>{
    const sh=ms.shift;
    const r=sh==='double'?0:getReg();
    const o=getOT();
    const c=calcWage(date,r,o,wage,sh,ms.holCredit);
    const logs=getLogs();
    const override=sh!==weekShift?sh:undefined;
    const creditOverride=(holDay && ms.holCredit!==undefined && ms.holCredit!==isHolAuto())
      ? ms.holCredit : undefined;
    const noteVal=(document.getElementById('m-note')?.value||'').trim();

    // Plain auto-credited holiday with no work logged: don't persist a log entry.
    // Writing one would flip the calendar cell from the blue "auto-credited" tint
    // to a regular day/night shift tint. Keep it auto-credited instead — and clear
    // any pre-existing entry so it reverts cleanly to the auto-credit state.
    // Exception: if the user typed a note, keep a minimal entry so the note isn't lost.
    if(holDay && isHolAuto() && r===0 && o===0 && creditOverride===undefined && !noteVal){
      if(logs[date]!==undefined){ delete logs[date]; saveLogs(logs); }
      closeModal(true);
      return;
    }

    logs[date]={regHrs:r,otHrs:o,hrs:r+o,gross:c.gross,net:c.net,eff:c.eff,
      shiftOverride:override,...(creditOverride!==undefined&&{holCreditOverride:creditOverride}),
      ...(noteVal&&{note:noteVal})};
    saveLogs(logs);closeModal(true);
  });
}

function closeModal(changed){
  const ret = S.modal?._returnToAllShifts;
  animateModalClose('#modal-ov', () => {
    document.body.classList.remove('modal-open');
    S.modal=null;
    // Only re-render the app when the modal actually changed data (save/delete).
    // Cancel / backdrop / Escape close without a render to avoid a jarring repaint.
    if (changed || ret) render();
    if (ret) openAllShifts(ret); // restore the saved view state
  });
}
