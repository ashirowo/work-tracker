// ─────────────────────────────────────────────────────────────────────────────
// ui/share-widgets.js — shared workplace-code entry components (Phase 6).
//
// The XXXX-XXXX code mask, the untrusted-lookup helper, the stage-state markup,
// and the share/import modal scaffold — used by BOTH the Settings share/import
// modals and the onboarding join flow, so neither can drift. Bodies verbatim
// from app.js; the only change is buildShareLikeModal now takes an explicit
// `lang` (was reading S.lang) so this module has no app-state coupling.
//
// unpackShare enforces the trust model on every looked-up envelope.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchShare } from '../firebase.js';
import { unpackShare } from '../share.js';
import { wizT } from '../domain/wizard-core.js';
import { SHM_IC_CHECK } from './icons.js';
import { animateModalClose } from './dom.js';

// The XXXX-XXXX code mask. Typing inserts the hyphen after the 4th char; pasting
// accepts JDAYJ9KW, JDAY-J9KW, or a whole share link (everything after 'join=');
// Backspace/Delete hop over the auto-hyphen. onChange(complete, changed) fires
// after every edit — `complete` gates the lookup button, `changed` lets the
// caller disarm a stale preview. Enter calls onEnter.
export function wireShareCodeInput(inp,{onChange,onEnter}){
  const sig=(v,pos)=>v.slice(0,pos).replace(/[^0-9A-Za-z]/g,'').length;
  let last=null;
  function mask(){
    const caret=sig(inp.value,inp.selectionStart??inp.value.length);
    let raw=inp.value;
    const ji=raw.lastIndexOf('join=');
    if(ji>=0)raw=raw.slice(ji+5);
    const s=raw.toUpperCase().replace(/[^0-9A-Z]/g,'').slice(0,8);
    inp.value=s.length>4?s.slice(0,4)+'-'+s.slice(4):s;
    const c=Math.min(caret,s.length);
    const pos=c>4?c+1:c;
    inp.setSelectionRange(pos,pos);
    const changed=s!==last;
    last=s;
    onChange(s.length===8,changed);
  }
  inp.addEventListener('input',mask);
  inp.addEventListener('keydown',e=>{
    const p=inp.selectionStart;
    if(p===inp.selectionEnd){
      if(e.key==='Backspace'&&inp.value[p-1]==='-')inp.setSelectionRange(p-1,p-1);
      else if(e.key==='Delete'&&inp.value[p]==='-')inp.setSelectionRange(p+1,p+1);
    }
    if(e.key==='Enter'){e.preventDefault();if(onEnter)onEnter();}
  });
  mask();                                          // normalize any prefill
  inp.setSelectionRange(inp.value.length,inp.value.length);
}

// Canonical code → {ok:true,r:{profile,name?}} | {ok:false,msg} with the
// user-facing message already chosen. Never throws.
export async function shareLookupByCode(code,W){
  let env;
  try{ env=await fetchShare(code); }
  catch(e){ console.warn('[share] fetch failed',e); return {ok:false,msg:W('imErrNet')}; }
  if(!env) return {ok:false,msg:W('imErrNotFound')};
  const r=unpackShare(env);                        // envelope is UNTRUSTED
  if(!r.ok) return {ok:false,msg:W(r.error==='version'?'imErrVersion':r.error==='format'?'imErrNotFound':'imErrInvalid')};
  return {ok:true,r};
}

// Stage-state markup shared by both entry points.
export const shmEmptyHTML=(icon,title,desc)=>`<div class="shm-empty">
  <span class="shm-empty-ic" aria-hidden="true">${icon}</span>
  <div class="shm-empty-t">${title}</div>
  <div class="shm-empty-s">${desc}</div>
</div>`;
export const shmFoundHeadHTML=(title,hintHTML)=>`<div class="shm-card-head">
  <span class="shm-card-badge is-fresh" aria-hidden="true">${SHM_IC_CHECK}</span>
  <div class="shm-card-headtxt">
    <div class="shm-card-title">${title}</div>
    <div class="shm-card-hint">${hintHTML}</div>
  </div>
</div>`;
// Shared modal scaffolding: overlay + glass header + body + footer, with the
// exact close/Escape/focus behavior of the workplace modal.
export function buildShareLikeModal({ovId,badgeSVG,title,sub,bodyHTML,footHTML,lang}){
  document.querySelectorAll('#'+ovId).forEach(el=>el.remove());
  const W=k=>wizT(lang,k);
  const ov=document.createElement('div');
  ov.className='modal-overlay';ov.id=ovId;
  document.body.classList.add('modal-open');
  const close=()=>animateModalClose('#'+ovId,()=>{document.body.classList.remove('modal-open');});
  ov.innerHTML=`<div class="modal wpm-modal shm-modal" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="wm-glow" aria-hidden="true"></div>
    <div class="wm-header wpm-header">
      <div class="wm-header-badge wpm-badge">${badgeSVG}</div>
      <div class="wm-header-text">
        <h3 class="wm2-title wpm-title">${title}</h3>
        <div class="wpm-sub">${sub}</div>
      </div>
      <button class="asm-close-btn wm-close" data-shm-close aria-label="${W('cancel')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="wpm-body shm-body">${bodyHTML}</div>
    ${footHTML?`<div class="wpm-actions">${footHTML}</div>`:''}
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click',e=>{if(e.target===ov)close();});
  ov.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();}});
  ov.querySelectorAll('[data-shm-close]').forEach(b=>b.addEventListener('click',close));
  const panel=ov.querySelector('.wpm-modal');
  panel.tabIndex=-1;
  panel.focus({preventScroll:true});
  return { ov, close };
}
