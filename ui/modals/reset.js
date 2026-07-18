// ─────────────────────────────────────────────────────────────────────────────
// ui/modals/reset.js — the "Reset all data" modal (Phase 7).
//
// DESTRUCTIVE: clears every wt4_* key (except the gov/holiday caches),
// optionally deletes the user's Firestore doc, then reloads so onboarding runs
// fresh. Requires typing the confirmation word. app.js passes ctx of the
// app-bound surface (S, t, render, currentUser accessor); sign-out and cloud
// delete are direct firebase imports. Body verbatim except CURRENT_USER ->
// currentUser() (it is reassigned in app.js, so it must arrive as an accessor).
// ─────────────────────────────────────────────────────────────────────────────

import { animateModalClose } from '../dom.js';
import { signOutUser, deleteCloudData } from '../../firebase.js';

export function buildResetModal(ctx){
  const { S, t, render, currentUser } = ctx;
  const closeResetModal=(changed)=>{
    animateModalClose('#reset-modal-ov', () => {
      document.body.classList.remove('modal-open');
      S.resetModal=false;
      if(changed) render();
    });
  };
  const cw=t('resetConfirmWord');
  const signedIn=!!currentUser();

  const ov=document.createElement('div');
  ov.className='modal-overlay';ov.id='reset-modal-ov';document.body.classList.add('modal-open');

  // Per-item icons (red family) for the delete list — calendar, moon, dollar, gear, rocket
  const rmIcon={
    logs:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    shifts:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
    wages:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M14.5 9a2.5 2 0 0 0-2.5-1.5h-.5a2 2 0 0 0 0 4h1a2 2 0 0 1 0 4h-.5A2.5 2 0 0 1 9.5 15"/><line x1="12" y1="6" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="18"/></svg>`,
    settings:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    onboarding:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91 0z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
  };
  const rmRow=(key,label)=>`<div class="rm-item">
    <div class="rm-item-icon">${rmIcon[key]}</div>
    <div class="rm-item-text">${label}</div>
  </div>`;

  ov.innerHTML=`<div class="modal wm-modal rm-modal wm-modal--danger">
    <div class="wm-glow wm-glow--danger" aria-hidden="true"></div>
    <div class="wm-scroll">
    <div class="wm-header">
      <div class="wm-header-badge wm-header-badge--danger">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
      </div>
      <div class="wm-header-text">
        <h3 class="wm-title"><span class="rm-title-accent">${t('resetWord')}</span> ${t('resetTitleRest')}</h3>
        <div class="wm-subtitle">${t('resetModalSubtitle')}</div>
      </div>
      <button class="asm-close-btn wm-close" id="reset-cancel" aria-label="${t('cancel')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="wm-divider"></div>

    <div class="rm-panel">
      <div class="rm-panel-intro">${t('resetModalIntro')}</div>
      <div class="rm-list">
        ${rmRow('logs',t('resetItemLogs'))}
        ${rmRow('shifts',t('resetItemShifts'))}
        ${rmRow('wages',t('resetItemWages'))}
        ${rmRow('settings',t('resetItemSettings'))}
        ${rmRow('onboarding',t('resetItemOnboarding'))}
      </div>
    </div>

    ${signedIn?`
    <div class="rm-cloud-panel">
      <label class="rm-cloud-toggle">
        <input type="checkbox" id="reset-cloud-cb">
        <span class="rm-cloud-box" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </span>
        <span class="rm-cloud-label">${t('resetCloudLabel')}</span>
      </label>
      <div class="rm-cloud-sub">${t('resetCloudSub')}</div>
      <div class="rm-cloud-signout">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>${t('resetSignOutNote')}</span>
      </div>
    </div>
    `:''}

    <div class="rm-warn">
      <div class="rm-warn-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="rm-warn-text">
        <div class="rm-warn-title">${t('resetCancelling')}</div>
        <div class="rm-warn-sub">${t('resetWarnConfirm')}</div>
      </div>
    </div>

    <div class="rm-confirm">
      <label class="rm-confirm-label">${t('resetConfirmLabel',cw)}</label>
      <input class="rm-confirm-input" id="reset-confirm-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${cw}">
    </div>

    <div class="rm-actions">
      <button class="rm-btn-cancel" id="reset-cancel-2">${t('cancel')}</button>
      <button class="rm-btn-delete" id="reset-confirm" disabled>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        ${t('resetBtnFinal')}
      </button>
    </div>
    </div>
  </div>`;

  document.querySelectorAll('#reset-modal-ov').forEach(el => el.remove());
  document.body.appendChild(ov);

  ov.addEventListener('click',e=>{if(e.target.id==='reset-modal-ov')closeResetModal();});
  document.getElementById('reset-cancel').addEventListener('click',()=>closeResetModal());
  document.getElementById('reset-cancel-2')?.addEventListener('click',()=>closeResetModal());

  const confirmIn=document.getElementById('reset-confirm-in');
  const confirmBtn=document.getElementById('reset-confirm');
  confirmIn.addEventListener('input',()=>{
    confirmBtn.disabled = confirmIn.value.trim() !== cw;
  });

  confirmBtn.addEventListener('click',async()=>{
    if(confirmIn.value.trim()!==cw)return;
    confirmBtn.disabled=true;
    confirmBtn.textContent=t('resetBtnFinal')+'…';

    const wipeCloud=signedIn && document.getElementById('reset-cloud-cb')?.checked;
    const uid=currentUser()?.uid; // capture before sign-out clears CURRENT_USER

    // Sign out first — signOutUser() may push any pending sync changes before
    // signing out. Deleting the cloud doc AFTER sign-out (using the captured
    // uid) ensures nothing gets recreated by that push.
    if(signedIn){
      try{ await signOutUser(); }
      catch(e){ console.warn('[reset] Sign-out failed, continuing with local reset:',e.message); }
    }

    if(wipeCloud){
      try{ await deleteCloudData(uid); }
      catch(e){ console.warn('[reset] Cloud delete failed, continuing with local reset:',e.message); }
    }

    // Clear every wt4_* key (app data, settings, onboarding state, sync flags).
    // Holiday API caches (wt4_gov_*, wt4_hol_*) are left intact — they're just
    // cached lookups, not user data, and will be reused or refreshed naturally.
    Object.keys(localStorage)
      .filter(k=>k.startsWith('wt4_') && !k.startsWith('wt4_gov_') && !k.startsWith('wt4_hol_'))
      .forEach(k=>localStorage.removeItem(k));

    // Reload so onboarding runs fresh against a clean slate.
    window.location.reload();
  });
}
