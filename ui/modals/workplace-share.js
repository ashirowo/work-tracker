// ─────────────────────────────────────────────────────────────────────────────
// ui/modals/workplace-share.js — workplace editor + share + import modals (P7).
//
// Three interlinked Settings modals over the Phase-6 shared components: the
// "Edit workplace" configuration panel (workplace-form), and the share/import
// code flows (share-widgets + the share.js pipeline + firebase transport). Pure
// UI: all packing/validation/migration lives in share.js; these never mutate
// profile data themselves. Import/save commit via the wizard's exact write
// (sv('wt4_profile') + scheduleSync). Bodies verbatim; the reassigned
// CURRENT_USER arrives as currentUser(). ctx members bind to module lets on
// each open; copyToClipboard/shareFmtDate/shareLink stay module-internal.
// ─────────────────────────────────────────────────────────────────────────────

import { buildShareLikeModal, wireShareCodeInput, shareLookupByCode, shmEmptyHTML, shmFoundHeadHTML } from '../share-widgets.js';
import { workplaceFormHTML, wireWorkplaceForm } from '../workplace-form.js';
import { wizT, wizardProfileFrom, rulesStateFromProfile } from '../../domain/wizard-core.js';
import { packShare, unpackShare, normalizeShareCode, formatShareCode } from '../../share.js';
import { createShare, deleteShare, listMyShares, signInWithGoogle, scheduleSync } from '../../firebase.js';
import { needsNightSchedule } from '../../profile-v2.js';
import { buildRulesRows } from '../../calc.js';
import { WZI, SHM_IC_CHECK, SHM_IC_SEARCH } from '../icons.js';
import { escHTML, animateModalClose } from '../dom.js';
import { attachSheetGestures } from '../motion.js';
import { showExportToast } from '../../export.js';

// Bound from ctx on each open:
let S, render, sv, getProfile, isHolAuto, getActiveDeductionPct, getDeductionNoun,
    storedPatternIsFixedDay, ruleRowsHTML, currentUser;
const bind = ctx => ({ S, render, sv, getProfile, isHolAuto, getActiveDeductionPct,
    getDeductionNoun, storedPatternIsFixedDay, ruleRowsHTML, currentUser } = ctx);

function closeWorkplaceModal(){
  animateModalClose('#wp-modal-ov',()=>{document.body.classList.remove('modal-open');});
}
export function buildWorkplaceModal(ctx){
  bind(ctx);
  document.querySelectorAll('#wp-modal-ov').forEach(el=>el.remove());
  const W=k=>wizT(S.lang,k);
  const st=rulesStateFromProfile(getProfile());
  const pattern=storedPatternIsFixedDay()?'day':null;
  const ov=document.createElement('div');
  ov.className='modal-overlay';ov.id='wp-modal-ov';
  document.body.classList.add('modal-open');
  ov.innerHTML=`<div class="modal wpm-modal" role="dialog" aria-modal="true" aria-label="${W('edit')}">
    <div class="wm-glow" aria-hidden="true"></div>
    <div class="wm-header wpm-header">
      <div class="wm-header-badge wpm-badge">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
      </div>
      <div class="wm-header-text">
        <h3 class="wm2-title wpm-title">${W('edit')}</h3>
        <div class="wpm-sub">${W('sub')}</div>
      </div>
      <button class="asm-close-btn wm-close" id="wp-close" aria-label="${W('cancel')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="wpm-body" id="wp-form">${workplaceFormHTML(st,S.lang,{pattern})}</div>
    <div class="wpm-actions">
      <button class="btn-sec" id="wp-cancel">${W('cancel')}</button>
      <button class="btn-pri wpm-save" id="wp-save"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>${W('save')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  attachSheetGestures(ov, closeWorkplaceModal);   // bottom sheet below 540px
  wireWorkplaceForm(document.getElementById('wp-form'),st,{lang:S.lang,pattern});
  ov.addEventListener('click',e=>{if(e.target===ov)closeWorkplaceModal();});
  ov.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeWorkplaceModal();}});
  document.getElementById('wp-close').addEventListener('click',closeWorkplaceModal);
  document.getElementById('wp-cancel').addEventListener('click',closeWorkplaceModal);
  document.getElementById('wp-save').addEventListener('click',()=>{
    try{
      sv('wt4_profile',wizardProfileFrom(st,null));
      scheduleSync();
    }catch(err){ console.warn('[wiz] profile save failed',err); return; }
    animateModalClose('#wp-modal-ov',()=>{
      document.body.classList.remove('modal-open');
      render();               // rules card reflects the new profile
      showExportToast(W('saved'));
    });
  });
  // Focus the panel so Escape works immediately, without scrolling the page.
  const panel=ov.querySelector('.wpm-modal');
  panel.tabIndex=-1;
  panel.focus({preventScroll:true});
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 6.3: workplace sharing — Settings "Share workplace" / "Import
// workplace" modals. Pure UI over the share.js pipeline + firebase.js
// transport: pack/unpack do all validation; these modals never construct or
// mutate profile data themselves. Import commits via the SAME write the
// wizard uses (sv('wt4_profile') + scheduleSync) — the engine sees nothing new.
// ═════════════════════════════════════════════════════════════════════════════
const SHARE_LOCALE={ko:'ko-KR',en:'en-US',zh:'zh-CN',ja:'ja-JP',id:'id-ID',ru:'ru-RU',th:'th-TH',vi:'vi-VN'};
const shareFmtDate=ms=>new Date(ms).toLocaleDateString(SHARE_LOCALE[S.lang]||'en-US',{year:'numeric',month:'short',day:'numeric'});
// The share link. The code rides the HASH so the SW-cached shell at '/' serves
// the PWA identically — no server routing, no cache-key changes (Phase 6.4
// reads it at boot; until then the link still opens the app).
const shareLink=code=>location.origin+location.pathname+'#join='+formatShareCode(code);
async function copyToClipboard(text,toast){
  try{ await navigator.clipboard.writeText(text); }
  catch(e){
    // Clipboard API needs a secure context — fall back to the classic path.
    const ta=document.createElement('textarea');
    ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    try{ document.execCommand('copy'); }catch(e2){}
    ta.remove();
  }
  if(toast) showExportToast(toast);   // omitted when the button gives inline feedback
}

// ── Share workplace ───────────────────────────────────────────────────────────
export function buildShareModal(ctx){
  bind(ctx);
  const W=k=>wizT(S.lang,k);
  const badge='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

  // Default share name: the preset label when the workplace came from one.
  const p=getProfile();
  const presetNames={'kr-factory-2shift':W('pFactory'),'kr-statutory-5plus':W('pStatutory')};
  const defName=(p.source&&p.source.kind==='preset'&&presetNames[p.source.presetId])||'';

  // Phase 6.5: Backup — the same envelope as a code, downloaded as a .json
  // file. Needs NO account (the offline/no-sign-in escape hatch); Restore
  // lives in the Import modal and runs the identical unpackShare pipeline.
  const wireBackup=m=>{
    m.ov.querySelector('#sh-backup')?.addEventListener('click',()=>{
      try{
        const nameIn=m.ov.querySelector('#sh-name');
        const name=(nameIn&&nameIn.value.trim())||defName||'';
        const env=packShare(getProfile(), name?{name}:{});
        const blob=new Blob([JSON.stringify(env,null,2)],{type:'application/json'});
        const a=document.createElement('a');
        a.href=URL.createObjectURL(blob);
        a.download='shiftr-workplace-'+today()+'.json';
        document.body.appendChild(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(a.href),4000);
        showExportToast(W('bkDone'));
      }catch(e){ console.warn('[share] backup failed',e); }
    });
  };

  // Sharing needs an accountable owner (rules enforce it server-side too):
  // signed-out users get the explanation + the app's normal sign-in — and the
  // file backup, which is exactly the path that works without an account.
  if(!currentUser()){
    const m=buildShareLikeModal({
      ovId:'sh-modal-ov',badgeSVG:badge,title:W('shTitle'),sub:W('shSub'),lang:S.lang,
      bodyHTML:`<div class="shm-auth">
        <div class="shm-auth-msg">${W('shAuthMsg')}</div>
        <button class="btn-pri" id="sh-signin">${W('shSignIn')}</button>
      </div>
      <button type="button" class="shm-file-btn" id="sh-backup">${W('bkDownload')}</button>`,
      footHTML:`<button class="btn-sec" data-shm-close>${W('cancel')}</button>`,
    });
    m.ov.querySelector('#sh-signin').addEventListener('click',()=>{m.close();signInWithGoogle();});
    wireBackup(m);
    return;
  }

  // Icons for the sharing surfaces (app icon convention: currentColor,
  // stroke-width 2, round caps/joins).
  const icShare=(s=14)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
  const icLink=(s=14)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
  const icCopy='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const icCheck=SHM_IC_CHECK;

  const m=buildShareLikeModal({
    ovId:'sh-modal-ov',badgeSVG:badge,title:W('shTitle'),sub:W('shSub'),lang:S.lang,
    bodyHTML:`
      <div class="shm-form" id="sh-form">
        <label class="shm-label" for="sh-name">${W('shNameLabel')}</label>
        <input type="text" id="sh-name" class="shm-name-in" maxlength="60"
               value="${escHTML(defName)}" placeholder="${W('shNamePh')}" autocomplete="off">
        <button class="btn-pri shm-create" id="sh-create">${W('shCreate')}</button>
        <div class="imm-err" id="sh-err" hidden></div>
      </div>
      <div class="shm-stage" id="sh-stage" aria-live="polite"></div>
      <div class="shm-active">
        <div class="shm-label">${W('shActive')}</div>
        <div class="shm-list" id="sh-list"></div>
      </div>
      <button type="button" class="shm-file-btn" id="sh-backup">${W('bkDownload')}</button>`,
    footHTML:`<button class="btn-sec" data-shm-close>${W('cancel')}</button>`,
  });
  wireBackup(m);

  const showErr=msg=>{const el=m.ov.querySelector('#sh-err');el.hidden=false;el.textContent=msg;};

  // ── The dynamic stage below the CTA ─────────────────────────────────────────
  // One slot, two states: a quiet dashed placeholder until a code exists, then
  // the sharing card. The SAME card serves a fresh mint (success header) and a
  // re-opened active code (row share icon) — reopening never mints a new code.
  const stage=m.ov.querySelector('#sh-stage');
  let shown=null;                                  // code currently on the stage
  const revealStage=()=>stage.scrollIntoView({
    behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',
    block:'nearest'});
  const markOpenRow=()=>{m.ov.querySelectorAll('.shm-item').forEach(it=>
    it.classList.toggle('is-open',it.dataset.code===shown));};

  function renderEmpty(){
    shown=null;
    stage.innerHTML=`<div class="shm-empty">
      <span class="shm-empty-ic" aria-hidden="true">${icShare(15)}</span>
      <div class="shm-empty-t">${W('shEmptyTitle')}</div>
      <div class="shm-empty-s">${W('shEmptyDesc')}</div>
    </div>`;
    markOpenRow();
  }

  // Copy button with inline feedback: flips to "✓ Copied" in place (no toast).
  function wireCopy(btn,text){
    btn.addEventListener('click',async()=>{
      if(btn.classList.contains('is-copied'))return;
      await copyToClipboard(text);
      const orig=btn.innerHTML;
      btn.classList.add('is-copied');
      btn.innerHTML=`${icCheck}${W('shCopied')}`;
      setTimeout(()=>{if(!btn.isConnected)return;
        btn.classList.remove('is-copied');btn.innerHTML=orig;},1400);
    });
  }

  function renderCard({code,name,expiresAtMs,fresh}){
    shown=code;
    // Compact link display: the host may truncate, the code tail never does.
    const bare=shareLink(code).replace(/^https?:\/\//,'');
    const ji=bare.lastIndexOf('#join=');
    stage.innerHTML=`<div class="shm-card">
      <div class="shm-card-head">
        <span class="shm-card-badge${fresh?' is-fresh':''}" aria-hidden="true">${fresh?icCheck:icShare(13)}</span>
        <div class="shm-card-headtxt">
          <div class="shm-card-title">${fresh?W('shCreated'):(name?escHTML(name):W('shYourCode'))}</div>
          <div class="shm-card-hint">${W('shHint')}</div>
        </div>
      </div>
      <div class="shm-code-row">
        <span class="shm-code">${formatShareCode(code)}</span>
        <button class="shm-copy" id="sh-copy-code">${icCopy}${W('shCopyCode')}</button>
      </div>
      <div class="shm-divider"><span>${W('shOrLink')}</span></div>
      <div class="shm-link-row">
        <span class="shm-link-ic" aria-hidden="true">${icLink(14)}</span>
        <span class="shm-link-url"><span class="shm-link-pre">${escHTML(bare.slice(0,ji+6))}</span><span class="shm-link-code">${escHTML(bare.slice(ji+6))}</span></span>
        <button class="shm-copy" id="sh-copy-link">${icCopy}${W('shCopyLink')}</button>
      </div>
      <div class="shm-card-meta">
        <span class="shm-expiry">${expiresAtMs?W('shExpires')(shareFmtDate(expiresAtMs)):''}</span>
        ${navigator.share?`<button class="shm-native" id="sh-native">${icShare(13)}${W('shNative')}</button>`:''}
      </div>
    </div>`;
    wireCopy(stage.querySelector('#sh-copy-code'),formatShareCode(code));
    wireCopy(stage.querySelector('#sh-copy-link'),shareLink(code));
    stage.querySelector('#sh-native')?.addEventListener('click',()=>{
      navigator.share({text:`${W('shYourCode')}: ${formatShareCode(code)}`,url:shareLink(code)}).catch(()=>{});
    });
    markOpenRow();
  }
  renderEmpty();

  async function refreshList(){
    const el=m.ov.querySelector('#sh-list');
    if(!el)return;
    el.innerHTML='<span class="obx-spin" aria-hidden="true"></span>';
    let shares;
    try{ shares=(await listMyShares()).sort((a,b)=>b.createdAtMs-a.createdAtMs); }
    catch(e){
      if(el.isConnected) el.innerHTML=`<div class="shm-none">${W('imErrNet')}</div>`;
      return;
    }
    if(!el.isConnected)return;                     // modal closed mid-flight
    if(!shares.length){el.innerHTML=`<div class="shm-none">${W('shNone')}</div>`;return;}
    el.innerHTML=shares.map(s=>`
      <div class="shm-item" data-code="${s.code}">
        <span class="shm-item-ic" aria-hidden="true">${icLink(14)}</span>
        <div class="shm-item-main">
          <div class="shm-item-top">
            <span class="shm-item-code">${formatShareCode(s.code)}</span>
            <span class="shm-item-live"><i aria-hidden="true"></i><em>${W('shActiveTag')}</em></span>
          </div>
          <div class="shm-item-sub">${s.name?`${escHTML(s.name)} · `:''}${s.createdAtMs?W('shCreatedOn')(shareFmtDate(s.createdAtMs)):''}</div>
        </div>
        <button class="shm-item-share" data-share="${s.code}" aria-label="${W('shNative')}">${icShare(14)}</button>
        <button class="shm-revoke" data-revoke="${s.code}">${W('shRevoke')}</button>
      </div>`).join('');
    // Row share icon → the same sharing card for that code (no new code is
    // minted). Tapping the open row's icon again folds the stage back.
    el.querySelectorAll('[data-share]').forEach(b=>b.addEventListener('click',()=>{
      const s=shares.find(x=>x.code===b.dataset.share);
      if(!s)return;
      if(shown===s.code){renderEmpty();return;}
      renderCard({code:s.code,name:s.name,expiresAtMs:s.expiresAtMs,fresh:false});
      revealStage();
    }));
    el.querySelectorAll('[data-revoke]').forEach(b=>b.addEventListener('click',async()=>{
      b.disabled=true;
      try{
        await deleteShare(b.dataset.revoke);
        if(shown===b.dataset.revoke)renderEmpty(); // a revoked code leaves the stage
        refreshList();
      }
      catch(e){ b.disabled=false; }
    }));
    markOpenRow();                                 // keep the open-row accent in sync
  }
  refreshList();

  m.ov.querySelector('#sh-create').addEventListener('click',async()=>{
    const btn=m.ov.querySelector('#sh-create');
    const orig=btn.innerHTML;
    btn.disabled=true;
    btn.innerHTML=`<span class="obx-spin" aria-hidden="true"></span>${W('shCreating')}`;
    m.ov.querySelector('#sh-err').hidden=true;
    try{
      const name=m.ov.querySelector('#sh-name').value.trim();
      const env=packShare(getProfile(),name?{name}:{});
      const {code,expiresAtMs}=await createShare(env);
      btn.disabled=false;
      btn.innerHTML=orig;
      renderCard({code,name,expiresAtMs,fresh:true});
      revealStage();
      refreshList();
    }catch(err){
      console.warn('[share] create failed',err);
      btn.disabled=false;
      btn.innerHTML=orig;
      showErr(err&&err.message==='auth-required'?W('shAuthMsg'):W('shErr'));
    }
  });
}

// ── Import workplace ──────────────────────────────────────────────────────────
// opts.auto — run the lookup on open (deep-linked #join= codes arrive verified
// in format but not in existence; auto-lookup shows the preview or the error
// without an extra tap).
export function buildImportModal(ctx,prefill,opts){
  bind(ctx);
  const W=k=>wizT(S.lang,k);
  const badge='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const m=buildShareLikeModal({
    ovId:'im-modal-ov',badgeSVG:badge,title:W('imTitle'),sub:W('imSub'),lang:S.lang,
    bodyHTML:`
      <div class="imm-row">
        <input type="text" id="im-code" class="imm-input" placeholder="${W('imPlaceholder')}"
               autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="120"
               value="${prefill?escHTML(prefill):''}">
        <button class="btn-pri" id="im-lookup" disabled>${W('imLookup')}</button>
      </div>
      <div class="imm-err" id="im-err" hidden></div>
      <div class="imm-stage" id="im-stage" aria-live="polite"></div>
      <button type="button" class="shm-file-btn" id="im-restore-file">${W('bkRestore')}</button>
      <input type="file" id="im-file" accept=".json,application/json" hidden>`,
    footHTML:`<button class="btn-sec" data-shm-close>${W('cancel')}</button>
      <button class="btn-pri wpm-save" id="im-confirm" disabled>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>${W('imConfirm')}
      </button>`,
  });

  const inp=m.ov.querySelector('#im-code');
  const errEl=m.ov.querySelector('#im-err');
  const stage=m.ov.querySelector('#im-stage');
  const lookupBtn=m.ov.querySelector('#im-lookup');
  const confirmBtn=m.ov.querySelector('#im-confirm');
  let pending=null;                                  // the unpacked result awaiting confirm

  // The stage below the entry row: an intentional placeholder until a lookup
  // succeeds, then the "Workplace found" card. Confirm stays visible but
  // disabled until a result is armed — the whole flow reads at a glance.
  const renderIdle=()=>{stage.innerHTML=shmEmptyHTML(SHM_IC_SEARCH,W('imEmptyTitle'),W('imEmptyDesc'));};
  renderIdle();

  const showErr=msg=>{errEl.hidden=false;errEl.textContent=msg;renderIdle();confirmBtn.disabled=true;pending=null;};

  // The shared XXXX-XXXX mask; editing after a successful lookup disarms the
  // stale preview so the armed confirm always matches the visible code.
  wireShareCodeInput(inp,{
    onChange:(complete,changed)=>{
      lookupBtn.disabled=!complete;
      if(changed&&pending){pending=null;confirmBtn.disabled=true;errEl.hidden=true;renderIdle();}
    },
    onEnter:()=>{if(!lookupBtn.disabled)lookup();},
  });

  // Both transports (code lookup, backup file) land here with an unpacked,
  // pipeline-verified result: a "Workplace found" card with the SAME
  // context-aware rules rows Settings renders, the replace warning, and the
  // now-armed confirm button. `sub` names the source (code or backup file).
  function presentResult(r,sub){
    pending=r;
    errEl.hidden=true;
    const rows=buildRulesRows(r.profile,TR[S.lang].seg,
      {holAuto:isHolAuto(),dedPct:getActiveDeductionPct(),dedNoun:getDeductionNoun()});
    stage.innerHTML=`<div class="shm-card">
      ${shmFoundHeadHTML(W('imFound'),r.name?`<b>${escHTML(r.name)}</b>`:escHTML(sub||''))}
      <div class="imm-rules">${ruleRowsHTML(rows)}</div>
      <div class="imm-warn">${W('imReplaceWarn')}</div>
    </div>`;
    confirmBtn.disabled=false;
  }

  async function lookup(){
    errEl.hidden=true;
    // The mask keeps the field canonical; normalizeShareCode still fixes the
    // classic O/I/L transcription typos.
    const code=normalizeShareCode(inp.value);
    if(!code){showErr(W('imErrFormat'));return;}
    const orig=lookupBtn.innerHTML;
    lookupBtn.disabled=true;
    lookupBtn.innerHTML=`<span class="obx-spin" aria-hidden="true"></span>${W('imChecking')}`;
    const res=await shareLookupByCode(code,W);
    lookupBtn.disabled=false;
    lookupBtn.innerHTML=orig;
    if(!res.ok){showErr(res.msg);return;}
    presentResult(res.r,formatShareCode(code));
  }

  lookupBtn.addEventListener('click',lookup);

  // Phase 6.5: Restore — a backup .json is the same envelope by another
  // transport. Parse, then the identical UNTRUSTED-input pipeline; version
  // mismatches keep their "update the app" message, everything else that
  // fails is simply "not a Shiftr backup".
  const fileBtn=m.ov.querySelector('#im-restore-file');
  const fileIn=m.ov.querySelector('#im-file');
  fileBtn.addEventListener('click',()=>fileIn.click());
  fileIn.addEventListener('change',async()=>{
    const f=fileIn.files&&fileIn.files[0];
    fileIn.value='';                                 // same file re-selectable
    if(!f)return;
    let env;
    try{ env=JSON.parse(await f.text()); }
    catch(e){ showErr(W('bkErrFile')); return; }
    const r=unpackShare(env);
    if(!r.ok){ showErr(r.error==='version'?W('imErrVersion'):W('bkErrFile')); return; }
    presentResult(r,f.name);
  });
  confirmBtn.addEventListener('click',()=>{
    if(!pending)return;
    try{
      sv('wt4_profile',pending.profile);             // the wizard's exact write
      scheduleSync();
    }catch(err){ console.warn('[share] import save failed',err); return; }
    const needsSched=needsNightSchedule(pending.profile);
    animateModalClose('#im-modal-ov',()=>{
      document.body.classList.remove('modal-open');
      render();                                      // rules card reflects the import
      showExportToast(needsSched?W('imSchedNote'):W('imported'));
    });
  });
  inp.focus({preventScroll:true});
  if(opts&&opts.auto&&prefill) lookup();
}
