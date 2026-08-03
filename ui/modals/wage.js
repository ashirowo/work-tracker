// ─────────────────────────────────────────────────────────────────────────────
// ui/modals/wage.js — the wage add/edit/delete modal (Phase 7).
//
// Opened from the Settings wage timeline (add button + per-row three-dot menu),
// driven by S.wageModal = {mode, idx?}. app.js passes a ctx of the app-bound
// surface (S, t, render, the wage-history accessors, today, showSuccess). Body
// verbatim; closeWageModal becomes a local closure over ctx.
// ─────────────────────────────────────────────────────────────────────────────

import { animateModalClose } from '../dom.js';
import { attachSheetGestures } from '../motion.js';

export function buildWageModal(ctx){
  const { S, t, render, getWages, saveWages, getWage, today, showSuccess } = ctx;
  const closeWageModal=(changed)=>{
    animateModalClose('#wage-modal-ov', () => {
      document.body.classList.remove('modal-open');
      S.wageModal=null;
      if(changed) render();
    });
  };
  const{mode,idx}=S.wageModal;
  const wages=getWages();
  const entry=idx!==undefined?wages[idx]:null;
  const LANG_LOCALE={ko:'ko-KR',en:'en-US',zh:'zh-CN',ja:'ja-JP',id:'id-ID',ru:'ru-RU',th:'th-TH',vi:'vi-VN'};
  const fmtWageDate=ds=>{const[y,m,d]=ds.split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString(LANG_LOCALE[S.lang]||'en-US',{month:'short',day:'2-digit',year:'numeric'});};

  const ov=document.createElement('div');
  ov.className='modal-overlay';ov.id='wage-modal-ov';document.body.classList.add('modal-open');

  if(mode==='delete'){
    ov.innerHTML=`<div class="modal">
      <h3 style="color:var(--danger)">${t('wageModalDelTitle')}</h3>
      <div class="modal-sub" style="margin-bottom:20px;">${t('wageModalDelBody', entry.amount.toLocaleString(), fmtWageDate(entry.date))}</div>
      <div class="m-actions">
        <button class="btn-sec" id="wm-cancel">${t('cancel')}</button>
        <button class="btn-del" id="wm-delete">${t('del')}</button>
      </div>
    </div>`;
    document.querySelectorAll('#wage-modal-ov').forEach(el=>el.remove());
    document.body.appendChild(ov);
    ov.addEventListener('click',e=>{if(e.target.id==='wage-modal-ov')closeWageModal();});
    document.getElementById('wm-cancel').addEventListener('click',()=>closeWageModal());
    document.getElementById('wm-delete').addEventListener('click',()=>{
      const updated=wages.filter((_,i)=>i!==idx);
      saveWages(updated);
      closeWageModal(true);
    });
    return;
  }

  // add or edit
  const defDate=entry?entry.date:today();
  const defAmount=entry?entry.amount:getWage();
  const title=mode==='edit'?t('wageModalEditTitle'):t('wageModalAddTitle');
  const sub=mode==='edit'?t('wageModalEditSub'):t('wageModalAddSub');

  // Pinned header / scrolling body / pinned actions — see day-log.js.
  ov.innerHTML=`<div class="modal wm-modal">
    <div class="wm-glow" aria-hidden="true"></div>
    <div class="wm-header">
      <div class="wm-header-badge">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      </div>
      <div class="wm-header-text">
        <h3 class="wm-title">${title}</h3>
        <div class="wm-subtitle">${sub}</div>
      </div>
      <button class="asm-close-btn wm-close" id="wm-cancel" aria-label="${t('cancel')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="wm-divider"></div>

    <div class="wm-scroll">
    <div class="wm-fields">
      <div class="wm-field">
        <label for="wm-date">${t('wageEffectiveDate')}</label>
        <div class="wm-input-wrap">
          <span class="wm-input-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </span>
          <input class="wm-input" id="wm-date" type="date" value="${defDate}">
        </div>
      </div>
      <div class="wm-field">
        <label for="wm-amount">${t('wageAmount')}</label>
        <div class="wm-input-wrap">
          <span class="wm-input-icon wm-input-icon--won" aria-hidden="true">₩</span>
          <input class="wm-input" id="wm-amount" type="number" value="${defAmount}" min="0" step="100" inputmode="numeric">
          <span class="wm-input-suffix">${t('perHourUnit')}</span>
        </div>
      </div>
    </div>

    </div>

    <div class="wm-actions">
      <button class="wm-btn-cancel" id="wm-cancel-2">${t('cancel')}</button>
      <button class="wm-btn-save" id="wm-save">
        ${t('save')}
      </button>
    </div>

    <div class="wm-secure">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>${t('wageSecureNote')}</span>
    </div>
  </div>`;

  document.querySelectorAll('#wage-modal-ov').forEach(el=>el.remove());
  document.body.appendChild(ov);
  // Mobile: drag the sheet down to dismiss (no-op above 540px).
  attachSheetGestures(ov, () => closeWageModal());
  ov.addEventListener('click',e=>{if(e.target.id==='wage-modal-ov')closeWageModal();});
  document.getElementById('wm-cancel').addEventListener('click',()=>closeWageModal());
  document.getElementById('wm-cancel-2')?.addEventListener('click',()=>closeWageModal());
  document.getElementById('wm-save').addEventListener('click',()=>{
    const amount=parseInt(document.getElementById('wm-amount').value);
    const date=document.getElementById('wm-date').value;
    if(isNaN(amount)||amount<0||!date)return;
    let working=wages.slice();
    if(mode==='edit'&&idx!==undefined) working=working.filter((_,i)=>i!==idx);
    working=working.filter(e=>e.date!==date);
    working.push({date,amount});
    working.sort((a,b)=>a.date.localeCompare(b.date));
    saveWages(working);
    showSuccess(t('wageSaved'));
    closeWageModal(true);
  });

}
