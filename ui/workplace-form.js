// ─────────────────────────────────────────────────────────────────────────────
// ui/workplace-form.js — the shared workplace configuration form + night page.
//
// Rendered VERBATIM by both onboarding (steps 3–4) and the Settings "Edit
// workplace" modal. Render-once + surgical updates: class toggles for
// selection, textContent swaps for the live preview, animated grid-row folds
// for progressive sections. Bodies verbatim from app.js; the only change is
// the wire functions now REQUIRE opts.lang (the dead `||S.lang` fallback is
// gone — every caller passes it), so the module has zero app-state coupling.
//
// Pure over (state, lang, opts): no S, no render(), no storage. Mutations
// surface through opts.onChange.
// ─────────────────────────────────────────────────────────────────────────────

import { WZI } from './icons.js';
import { WZ_STEP, WZ_BRK, wzStepNext, wzRuleVal, wzRestOn, wzFmtMult, wzCapText,
         wzDurNext, wzFmtDur, wzBreakOf, wzNormBreak, wzPreviewRows,
         wizNeedsSchedule, obxNightData, wizT } from '../domain/wizard-core.js';

export function wzRuleRowHTML(lang,q,st){
  const W=k=>wizT(lang,k);
  if(q==='rest'){
    const on=wzRestOn(st);
    return `<div class="wz-rule">
      <span class="wz-rule-ic">${WZI.rest}</span>
      <span class="wz-rule-txt"><span class="wz-rule-t" id="wz-rest-label">${W('rRest')}</span><span class="wz-rule-c" data-wcap="rest">${W(on?'cYes':'cNo')}</span></span>
      <button type="button" class="s3-toggle wz-rule-tog${on?' s3-toggle--on':''}" data-wrest role="switch" aria-checked="${on?'true':'false'}" aria-labelledby="wz-rest-label"><div class="s3-toggle-knob"></div></button>
    </div>`;
  }
  const v=wzRuleVal(st,q);
  const ic={night:WZI.moon,sat:WZI.cal,hol:WZI.sun,ot:WZI.clock}[q];
  const t={night:'rNight',sat:'rSat',hol:'rHol',ot:'rOT'}[q];
  return `<div class="wz-rule">
    <span class="wz-rule-ic">${ic}</span>
    <span class="wz-rule-txt"><span class="wz-rule-t" id="wz-rule-${q}">${W(t)}</span><span class="wz-rule-c${v>1?' wz-rule-c--on':''}" data-wcap="${q}">${wzCapText(lang,v)}</span></span>
    <div class="wz-stp${v>1?' wz-stp--on':''}" data-wstp="${q}" role="group" aria-labelledby="wz-rule-${q}">
      <button type="button" class="wz-stp-btn" data-wstep="${q}" data-wdir="-1" aria-label="${W('decA')}"${v<=WZ_STEP.min?' disabled':''}>${WZI.minus}</button>
      <span class="wz-stp-v" data-wval="${q}" aria-live="polite">${wzFmtMult(v)}</span>
      <button type="button" class="wz-stp-btn" data-wstep="${q}" data-wdir="1" aria-label="${W('incA')}"${v>=WZ_STEP.max?' disabled':''}>${WZI.plus}</button>
    </div>
  </div>`;
}
// wzPreviewRows moved to domain/wizard-core.js (Phase 6); this markup wrapper
// stays with the form.
export function wzPreviewHTML(st,lang,pattern){
  const rows=wzPreviewRows(st,lang,pattern);
  if(!rows.length) return '';
  return `<div class="wz-pv-head"><span class="wz-pv-spark">${WZI.spark}</span>${wizT(lang,'prevTitle')}</div>
    ${rows.map(r=>`<div class="wz-pv-row wz-pv-row--${r.cls}"><span class="wz-pv-k">${r.k}</span><span class="wz-pv-v" data-wz-pv="${r.cls}">${r.v}</span></div>`).join('')}`;
}
// The night panel: shift times, premium window, and the unpaid break.
// No "do you work nights?" gate: this panel only unfolds when the workplace's
// rules need a schedule, so it asks the times directly, prefilled with the
// statutory 22:00–06:00 defaults. st.window stays IMPLICIT while the fields sit
// at the default (the input handler deletes it when values return to
// 22:00/06:00), preserving the "default window does not round-trip as custom"
// invariant. The break is ANCHORED (start/end times, not minutes) so a break
// overlapping the premium window is excluded from night-premium pay — see
// nightHoursOf() in profile-v2.js.
export function wzSchedHTML(st,lang){
  const W=k=>wizT(lang,k);
  const n=(st.schedule&&st.schedule.night)||{start:'22:00',end:'06:00'};
  const win=st.window||{start:'22:00',end:'06:00'};
  const {tot,night:bn}=wzBreakOf(n);
  const tf=(attr,k,val,label)=>`<label class="wz-tf"><span>${label}</span><input type="time" class="wz-time" data-${attr}="${k}" value="${val}"></label>`;
  const dstp=(kind,val,min,max,labelId)=>`<div class="wz-stp wz-stp--dur" role="group" aria-labelledby="${labelId}">
      <button type="button" class="wz-stp-btn" data-wbrk="${kind}" data-wdir="-1" aria-label="${W('decA')}"${val<=min?' disabled':''}>${WZI.minus}</button>
      <span class="wz-stp-v" data-wbrk-val="${kind}" aria-live="polite">${wzFmtDur(lang,val)}</span>
      <button type="button" class="wz-stp-btn" data-wbrk="${kind}" data-wdir="1" aria-label="${W('incA')}"${val>=max?' disabled':''}>${WZI.plus}</button>
    </div>`;
  return `<div class="wz-sched">
      <div class="wz-sched-grid">
        <div class="wz-sched-sec">
          <div class="wz-sched-head"><span class="wz-sched-ic">${WZI.moon}</span><span>${W('schedWhen')}</span></div>
          <div class="wz-times">${tf('wz-sched','start',n.start,W('schedStart'))}${tf('wz-sched','end',n.end,W('schedEnd'))}</div>
        </div>
        <div class="wz-sched-sec">
          <div class="wz-sched-head"><span class="wz-sched-ic">${WZI.prem}</span><span>${W('windowQ')}</span></div>
          <div class="wz-times">${tf('wz-win','start',win.start,W('schedStart'))}${tf('wz-win','end',win.end,W('schedEnd'))}</div>
        </div>
      </div>
      <div class="wz-break">
        <div class="wz-rule wz-rule--sched">
          <span class="wz-sched-ic">${WZI.coffee}</span>
          <span class="wz-rule-txt"><span class="wz-rule-t wz-rule-t--sched" id="wz-brk-tot-l">${W('brkTot')}</span><span class="wz-rule-c">${W('brkTotSub')}</span></span>
          ${dstp('tot',tot,WZ_BRK.min,WZ_BRK.max,'wz-brk-tot-l')}
        </div>
        <div class="wz-fold${tot>0?' wz-fold--open':''}" data-wz-fold="brknight">
          <div class="wz-fold-in"><div class="wz-brk-night">
            <div class="wz-rule wz-rule--sched">
              <span class="wz-sched-ic">${WZI.moon}</span>
              <span class="wz-rule-txt"><span class="wz-rule-t wz-rule-t--sched" id="wz-brk-n-l">${W('brkNight')}</span><span class="wz-rule-c">${W('brkNightSub')}</span></span>
              ${dstp('night',bn,0,tot,'wz-brk-n-l')}
            </div>
            <div class="wz-brk-meter" aria-hidden="true"><div class="wz-brk-meter-fill" data-wbrk-meter style="width:${tot?Math.round(bn/tot*100):0}%"></div></div>
          </div></div>
        </div>
      </div>
      <div class="wz-sched-note"><span class="wz-sched-ic wz-sched-ic--hint">${WZI.info}</span><span>${W('schedHint')}</span></div>
    </div>`;
}

// ── Shared surgical-update helpers ───────────────────────────────────────────
// Used by BOTH homes of the wizard state (the Settings all-in-one form and the
// split onboarding screens): the animated fold + inert, the value pop, and the
// row-sync routines that repaint steppers/captions/toggles from state.
export function wzFoldEl(el,open){
  if(!el) return;
  el.classList.toggle('wz-fold--open',!!open);
  el.setAttribute('aria-hidden',open?'false':'true');
  if(el.firstElementChild) el.firstElementChild.inert=!open;
}
export function wzPopEl(el){ if(!el) return; el.classList.remove('wz-pop'); void el.offsetWidth; el.classList.add('wz-pop'); }
export function wzSyncRules(root,st,lang,animate){
  ['night','sat','hol','ot'].forEach(q=>{
    const v=wzRuleVal(st,q), txt=wzFmtMult(v);
    const val=root.querySelector(`[data-wval="${q}"]`);
    if(val&&val.textContent!==txt){ val.textContent=txt; if(animate) wzPopEl(val); }
    const cap=root.querySelector(`[data-wcap="${q}"]`);
    if(cap){ cap.textContent=wzCapText(lang,v); cap.classList.toggle('wz-rule-c--on',v>1); }
    const stp=root.querySelector(`[data-wstp="${q}"]`);
    if(stp) stp.classList.toggle('wz-stp--on',v>1);
    root.querySelectorAll(`[data-wstep="${q}"]`).forEach(b=>{
      b.disabled=+b.dataset.wdir<0?v<=WZ_STEP.min:v>=WZ_STEP.max;
    });
  });
  const on=wzRestOn(st);
  const tog=root.querySelector('[data-wrest]');
  if(tog){ tog.classList.toggle('s3-toggle--on',on); tog.setAttribute('aria-checked',on?'true':'false'); }
  const rc=root.querySelector('[data-wcap="rest"]');
  if(rc) rc.textContent=wizT(lang,on?'cYes':'cNo');
}
export function wzSyncBreak(root,st,lang,animate){
  const {tot,night:bn}=wzBreakOf(st.schedule&&st.schedule.night);
  const set=(kind,val,min,max)=>{
    const el=root.querySelector(`[data-wbrk-val="${kind}"]`);
    const txt=wzFmtDur(lang,val);
    if(el&&el.textContent!==txt){ el.textContent=txt; if(animate) wzPopEl(el); }
    root.querySelectorAll(`[data-wbrk="${kind}"]`).forEach(b=>{
      b.disabled=+b.dataset.wdir<0?val<=min:val>=max;
    });
  };
  set('tot',tot,WZ_BRK.min,WZ_BRK.max);
  set('night',bn,0,tot);
  const m=root.querySelector('[data-wbrk-meter]');
  if(m) m.style.width=(tot?Math.round(bn/tot*100):0)+'%';
  wzFoldEl(root.querySelector('[data-wz-fold="brknight"]'),tot>0);
}

export function workplaceFormHTML(st,lang,opts){
  const W=k=>wizT(lang,k);
  const pattern=opts&&opts.pattern;
  const isDay=pattern==='day';
  // Top-level choices: Standard workplace, Iljitech (recommended), Customize.
  // Customize opens the rate steppers directly — no sub-presets: "Small
  // workplace" and "Legal minimum" aren't workplaces, they're answer combos.
  // Same identity glyphs as the onboarding preset cards (office / users /
  // sliders) so the modal reads as the same three choices.
  const presets=[
    {id:'kr-statutory-5plus',t:W('pStatutory'),s:W('pStatutorySub'),ic:WZI.office},
    {id:'kr-factory-2shift', t:W('pFactory'),  s:W('pFactorySub'),  ic:WZI.users},
    {id:null,                t:W('pCustom'),   s:W('pCustomSub'),   ic:WZI.custom},
  ];
  const choices=presets.map(p=>{
    const active=p.id===null?!st.preset:st.preset===p.id;
    return `<button type="button" class="wz-choice${active?' wz-choice--active':''}" data-wz-preset="${p.id??''}" role="radio" aria-checked="${active}">
        <span class="wz-choice-ic">${p.ic}</span>
        <span class="wz-choice-txt"><span class="wz-choice-t">${p.t}</span><span class="wz-choice-s">${p.s}</span></span>
        <span class="wz-choice-check">${WZI.check}</span>
      </button>`;
  }).join('');
  const customOpen=!st.preset;
  // Day-pattern users never see the night rule (they can't earn it); everyone
  // else gets it back as a stepper — the break panel below collects the two
  // values that make the premium computable (total break + its night portion).
  const qs=['night','sat','hol','ot','rest'].filter(q=>!(isDay&&q==='night'));
  // Steppers show concrete values; materialize the defaults into the state so
  // the rows display exactly what saving will compile (never a silent drift).
  if(customOpen){
    qs.forEach(q=>{ if(q!=='rest'&&typeof st[q]!=='number') st[q]=wzRuleVal(st,q); });
    if(st.rest==='idk') st.rest=true;
  }
  // Older stored breaks (anchored times / bare counts) become the duration
  // pair the panel edits — converted through the engine so pay is unchanged.
  wzNormBreak(st);
  const needSched=!isDay&&wizNeedsSchedule(st);
  // The user is never asked WHETHER they work nights — the workplace's own pay
  // rules (overlap-mode night premium) already say whether shift times are
  // needed. Materialize the statutory default schedule into the state so the
  // fields display exactly what saving will compile (never a silent mismatch).
  if(needSched&&!(st.schedule&&st.schedule.night))
    st.schedule={night:{start:'22:00',end:'06:00',breakMin:0}};
  return `<div class="wz">
    <div class="wz-choices" role="radiogroup" aria-label="${W('title')}">${choices}</div>
    <div class="wz-fold${customOpen?' wz-fold--open':''}" data-wz-fold="custom">
      <div class="wz-fold-in"><div class="wz-rules">
        <div class="wz-rules-head">
          <span class="wz-rules-eyebrow">${W('secRules')}</span>
          <button type="button" class="wz-std" data-wz-std>${W('stdReset')}</button>
        </div>
        ${qs.map(q=>wzRuleRowHTML(lang,q,st)).join('')}
      </div></div>
    </div>
    <div class="wz-fold${needSched?' wz-fold--open':''}" data-wz-fold="sched">
      <div class="wz-fold-in">${wzSchedHTML(st,lang)}</div>
    </div>
    <div class="wz-preview" data-wz-preview aria-live="polite">${wzPreviewHTML(st,lang,pattern)}</div>
  </div>`;
}

// Delegated wiring on a stable container. opts = { lang, pattern, onChange }.
// onChange() fires after every state mutation (onboarding persists the session
// there); ALL visual updates happen here, surgically — never a re-render.
export function wireWorkplaceForm(root,st,opts){
  const lang=(opts&&opts.lang);
  const pattern=opts&&opts.pattern;
  const isDay=pattern==='day';
  const changed=()=>{ if(opts&&opts.onChange) opts.onChange(); };
  const foldByName=name=>root.querySelector(`[data-wz-fold="${name}"]`);
  // Animated disclosure: grid-row fold + inert, so nothing inside a closed
  // fold is focusable or clickable while it's visually collapsed.
  const fold=wzFoldEl;
  root.querySelectorAll('.wz-fold').forEach(f=>fold(f,f.classList.contains('wz-fold--open')));

  const updatePreview=()=>{
    const box=root.querySelector('[data-wz-preview]');
    if(!box) return;
    const rows=wzPreviewRows(st,lang,pattern);
    // The row set is fixed per pattern — swap values in place with a soft pop.
    let structural=!rows.length&&box.innerHTML!=='';
    rows.forEach(r=>{
      const v=box.querySelector(`[data-wz-pv="${r.cls}"]`);
      if(!v){ structural=true; return; }
      const k=v.previousElementSibling;
      if(k&&k.textContent!==r.k) k.textContent=r.k;  // e.g. "8h night shift" → "7h…"
      if(v.textContent!==r.v){ v.textContent=r.v; wzPopEl(v); }
    });
    if(structural) box.innerHTML=wzPreviewHTML(st,lang,pattern);
  };
  const syncSched=()=>{
    const need=!isDay&&wizNeedsSchedule(st);
    if(need&&!(st.schedule&&st.schedule.night)){
      st.schedule={night:{start:'22:00',end:'06:00',breakMin:0}};
      root.querySelectorAll('[data-wz-sched]').forEach(i=>{
        i.value=st.schedule.night[i.dataset.wzSched]||'';
      });
    }
    fold(foldByName('sched'),need);
  };
  const syncRules=animate=>wzSyncRules(root,st,lang,animate);
  const syncBreak=animate=>wzSyncBreak(root,st,lang,animate);

  root.addEventListener('click',e=>{
    // Workplace choice rows
    const pv=e.target.closest('[data-wz-preset]');
    if(pv&&root.contains(pv)){
      const id=pv.dataset.wzPreset||null;
      if((st.preset||null)===id) return;            // reselect → no-op, no flash
      st.preset=id;
      // Customize opens seeded with the Korean standard rates, ready to be
      // nudged from there.
      if(!id){ st.night=1.5;st.sat=1.5;st.hol=1.5;st.ot=1.5;st.rest=true; syncRules(false); }
      root.querySelectorAll('[data-wz-preset]').forEach(b=>{
        const on=(b.dataset.wzPreset||null)===id;
        b.classList.toggle('wz-choice--active',on);
        b.setAttribute('aria-checked',on?'true':'false');
      });
      fold(foldByName('custom'),!id);
      syncSched(); updatePreview(); changed();
      return;
    }
    // Rate steppers — snap one detent along the ×0.25 grid. The night rule
    // can summon/dismiss the schedule panel, so re-check the sched fold.
    const sb=e.target.closest('[data-wstep]');
    if(sb&&root.contains(sb)){
      const q=sb.dataset.wstep;
      const v=wzStepNext(wzRuleVal(st,q),+sb.dataset.wdir);
      if(v===wzRuleVal(st,q)) return;
      st[q]=v;
      syncRules(true); syncSched(); updatePreview(); changed();
      return;
    }
    // Paid weekly rest day switch
    const rt=e.target.closest('[data-wrest]');
    if(rt&&root.contains(rt)){
      st.rest=!wzRestOn(st);
      syncRules(false); updatePreview(); changed();
      return;
    }
    // "Reset to Korean standard" — every row springs back to the default
    // (the break stays: it's a fact about the user's shift, not a pay rule)
    const std=e.target.closest('[data-wz-std]');
    if(std&&root.contains(std)){
      if(!isDay) st.night=1.5;
      st.sat=1.5;st.hol=1.5;st.ot=1.5;st.rest=true;
      syncRules(true); syncSched(); updatePreview(); changed();
      return;
    }
    // Break duration steppers — the total, and the portion inside the window
    const bb=e.target.closest('[data-wbrk]');
    if(bb&&root.contains(bb)){
      if(!(st.schedule&&st.schedule.night)) st.schedule={night:{start:'22:00',end:'06:00',breakMin:0}};
      const n=st.schedule.night;
      const {tot,night:bn}=wzBreakOf(n);
      const dir=+bb.dataset.wdir;
      if(bb.dataset.wbrk==='tot'){
        const nt=wzDurNext(tot,dir);
        if(nt===tot) return;
        n.breakMin=nt;
        // "All of it at night" is sticky: the night portion tracks the total
        // until the user explicitly lowers it — after that it only clamps.
        n.breakNightMin=(bn===tot)?nt:Math.min(bn,nt);
      }else{
        const nn=Math.min(wzDurNext(bn,dir,WZ_BRK.incNight),tot);
        if(nn===bn) return;
        n.breakNightMin=nn;
      }
      syncBreak(true); updatePreview(); changed();
      return;
    }
  });

  root.addEventListener('input',e=>{
    const t=e.target;
    if(t.matches('[data-wz-win]')){
      if(!st.window) st.window={start:'22:00',end:'06:00'};
      if(t.value) st.window[t.dataset.wzWin]=t.value;
      // Back at the statutory default → drop the custom marker so the default
      // window stays implicit (it must never round-trip as "custom").
      if(st.window.start==='22:00'&&st.window.end==='06:00') delete st.window;
      updatePreview(); changed(); return;
    }
    if(t.matches('[data-wz-sched]')){
      if(!(st.schedule&&st.schedule.night)) st.schedule={night:{start:'22:00',end:'06:00',breakMin:0}};
      if(t.value) st.schedule.night[t.dataset.wzSched]=t.value;
      updatePreview(); changed(); return;
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Split onboarding screens — the wizard state authored across TWO focused pages
// instead of the Settings modal's all-in-one panel.
//   • Workplace & Pay Rules (obxWorkplaceHTML/obxWireWorkplace): WHAT the
//     workplace pays — preset cards, and the rate steppers under Customize.
//   • Night Schedule (obxNightHTML/obxWireNight): WHEN those rules apply —
//     shift times, premium window, unpaid breaks, and a live timeline preview.
// Both mutate the SAME rules state the Settings form edits, through the same
// helpers, so a profile authored here round-trips into "Edit workplace" intact.
// ═════════════════════════════════════════════════════════════════════════════

// Does this rules state make the Night Schedule page worth showing? Only
// overlap-mode night premiums are schedule-driven — day patterns, threshold
// rulebooks (the factory preset) and ×1 night rates have nothing to ask.
export function obxNeedsSchedPage(st,pattern){
  return pattern!=='day' && wizNeedsSchedule(st);
}

export function obxWorkplaceHTML(st,lang,pattern){
  const W=k=>wizT(lang,k);
  const isDay=pattern==='day';
  // Three distinct workplace PROFILES, not settings rows: each card carries an
  // accent-tinted identity tile, a short pitch, and exactly THREE concrete
  // feature badges so the differences read at a glance (one compact row on
  // mobile). Order everywhere: Standard, Iljitech, Customize.
  const cards=[
    {id:'kr-statutory-5plus',cls:' wpx-card--std',   ic:WZI.office,t:W('pStatutory'),s:W('pStatutorySub'),
     feats:[[WZI.shield,W('fStd1')],[WZI.cal,W('fStd2')],[WZI.rest,W('fStd3')]]},
    {id:'kr-factory-2shift', cls:' wpx-card--rec',   ic:WZI.users, t:W('pFactory'),  s:W('pFactorySub'),
     feats:[[WZI.moon,W('fFac1')],[WZI.cal,W('fFac2')],[WZI.sun,W('fFac4')]]},
    {id:null,                cls:' wpx-card--custom',ic:WZI.custom,t:W('pCustom'),   s:W('pCustomSub'),
     feats:[[WZI.custom,W('fCus1')],[WZI.clock,W('fCus2')],[WZI.gear,W('fCus3')]]},
  ];
  const customOpen=!st.preset;
  const qs=['night','sat','hol','ot','rest'].filter(q=>!(isDay&&q==='night'));
  // Steppers show concrete values; materialize the defaults into the state so
  // the rows display exactly what saving will compile (never a silent drift).
  if(customOpen){
    qs.forEach(q=>{ if(q!=='rest'&&typeof st[q]!=='number') st[q]=wzRuleVal(st,q); });
    if(st.rest==='idk') st.rest=true;
  }
  return `<div class="wpx" id="ob-wpx">
    <div class="wpx-choices" role="radiogroup" aria-label="${W('title')}">
      ${cards.map(c=>{
        const active=c.id===null?!st.preset:st.preset===c.id;
        return `<button type="button" class="wpx-card${c.cls}${active?' wpx-card--active':''}" data-wz-preset="${c.id??''}" role="radio" aria-checked="${active}">
          <span class="wpx-radio" aria-hidden="true">${WZI.check}</span>
          <span class="wpx-card-head">
            <span class="wpx-card-ic">${c.ic}</span>
            <span class="wpx-card-txt">
              <span class="wpx-card-t">${c.t}</span>
              <span class="wpx-card-s">${c.s}</span>
            </span>
          </span>
          <span class="wpx-feats">
            ${c.feats.map(([ic,txt])=>`<span class="wpx-feat">${ic}<span>${txt}</span></span>`).join('')}
          </span>
        </button>`;
      }).join('')}
    </div>
    <div class="wz-fold${customOpen?' wz-fold--open':''}" data-wz-fold="custom">
      <div class="wz-fold-in">
        <div class="obs-sec wpx-rules">
          <div class="obs-sec-head">
            <span class="obs-sec-ic">${WZI.custom}</span>
            <span class="obs-sec-t">${W('secRules')}</span>
            <button type="button" class="wpx-restore" data-wz-std>${WZI.restore}<span>${W('restoreDefaults')}</span></button>
          </div>
          ${qs.map(q=>wzRuleRowHTML(lang,q,st)).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

// Wiring for the Workplace & Pay Rules page. opts = { lang, pattern, onChange }.
// Same render-once philosophy as wireWorkplaceForm: every interaction is a
// class toggle, a textContent swap, or a fold — never a re-render.
export function obxWireWorkplace(root,st,opts){
  const lang=(opts&&opts.lang);
  const pattern=opts&&opts.pattern;
  const isDay=pattern==='day';
  const changed=()=>{ if(opts&&opts.onChange) opts.onChange(); };
  root.querySelectorAll('.wz-fold').forEach(f=>wzFoldEl(f,f.classList.contains('wz-fold--open')));

  root.addEventListener('click',e=>{
    // Preset cards
    const pv=e.target.closest('[data-wz-preset]');
    if(pv&&root.contains(pv)){
      const id=pv.dataset.wzPreset||null;
      if((st.preset||null)===id) return;            // reselect → no-op, no flash
      st.preset=id;
      // Customize opens seeded with the Korean standard rates
      if(!id){ st.night=1.5;st.sat=1.5;st.hol=1.5;st.ot=1.5;st.rest=true; wzSyncRules(root,st,lang,false); }
      root.querySelectorAll('[data-wz-preset]').forEach(b=>{
        const on=(b.dataset.wzPreset||null)===id;
        b.classList.toggle('wpx-card--active',on);
        b.setAttribute('aria-checked',on?'true':'false');
      });
      wzFoldEl(root.querySelector('[data-wz-fold="custom"]'),!id);
      changed();
      return;
    }
    // Rate steppers
    const sb=e.target.closest('[data-wstep]');
    if(sb&&root.contains(sb)){
      const q=sb.dataset.wstep;
      const v=wzStepNext(wzRuleVal(st,q),+sb.dataset.wdir);
      if(v===wzRuleVal(st,q)) return;
      st[q]=v;
      wzSyncRules(root,st,lang,true); changed();
      return;
    }
    // Paid weekly rest day switch
    const rt=e.target.closest('[data-wrest]');
    if(rt&&root.contains(rt)){
      st.rest=!wzRestOn(st);
      wzSyncRules(root,st,lang,false); changed();
      return;
    }
    // Restore defaults
    const std=e.target.closest('[data-wz-std]');
    if(std&&root.contains(std)){
      if(!isDay) st.night=1.5;
      st.sat=1.5;st.hol=1.5;st.ot=1.5;st.rest=true;
      wzSyncRules(root,st,lang,true); changed();
      return;
    }
  });
}

// ── Night Schedule page — markup + wiring ────────────────────────────────────
// obxNightData (the engine-truth timeline data) moved to domain/wizard-core.js
// (Phase 6); the markup + wiring below render from it.
export function obxNightPreviewHTML(st,lang){
  const W=k=>wizT(lang,k);
  const d=obxNightData(st);
  if(!d) return '';
  const hU=v=>W('hUnit')(v);
  return `
    <div class="nsx-pv-shift">
      <span class="nsx-pv-shift-k">${W('pvShift')}</span>
      <span class="nsx-pv-shift-v">${d.shiftTxt}</span>
      ${d.tot>0?`<span class="nsx-pv-shift-m">${W('brkTot')}: ${wzFmtDur(lang,d.tot)} · ${W('pvOverlap')}: ${wzFmtDur(lang,d.bn)}</span>`:''}
    </div>
    <div class="nsx-tl" aria-hidden="true">
      <div class="nsx-tl-bar">
        ${d.segs.map(sg=>`<i class="nsx-tl-seg nsx-tl-seg--${sg.kind}" style="width:${(sg.min/d.dur*100).toFixed(2)}%"></i>`).join('')}
      </div>
      <div class="nsx-tl-labels">
        ${d.labels.map((l,i)=>`<span style="left:${l.at.toFixed(2)}%"${i===0?' data-edge="l"':i===d.labels.length-1?' data-edge="r"':''}>${l.t}</span>`).join('')}
      </div>
    </div>
    <div class="nsx-leg">
      <span><i class="nsx-leg-i nsx-leg-i--prem"></i>${W('legPrem')} (${hU(d.nightH)})</span>
      <span><i class="nsx-leg-i nsx-leg-i--plain"></i>${W('legReg')} (${hU(d.plainH)})</span>
      ${d.tot>0?`<span><i class="nsx-leg-i nsx-leg-i--brk"></i>${W('legBrk')} (${wzFmtDur(lang,d.tot)})</span>`:''}
    </div>
    <div class="nsx-earn">
      <div class="nsx-earn-h">${W('earnTitle')}</div>
      <div class="nsx-earn-r"><span class="nsx-earn-k nsx-earn-k--reg">${W('legReg')}</span><span class="nsx-earn-v">${hU(d.paidH)}</span></div>
      <div class="nsx-earn-r"><span class="nsx-earn-k nsx-earn-k--night">${W('legPrem')}${d.mult>1?` <i class="nsx-earn-pct">+${Math.round((d.mult-1)*100)}%</i>`:''}</span><span class="nsx-earn-v">+${hU(d.bonus)}</span></div>
      <div class="nsx-earn-total"><span>${W('earnTotal')}</span><span class="nsx-earn-big">${hU(d.eff)}</span></div>
    </div>`;
}
export function obxNightHTML(st,lang){
  const W=k=>wizT(lang,k);
  if(!(st.schedule&&st.schedule.night)) st.schedule={night:{start:'22:00',end:'06:00',breakMin:0}};
  wzNormBreak(st);
  const n=st.schedule.night;
  const win=st.window||{start:'22:00',end:'06:00'};
  const {tot,night:bn}=wzBreakOf(n);
  const tfield=(attr,k,val,label)=>`<input type="time" class="wz-time" data-${attr}="${k}" value="${val}" aria-label="${label}">`;
  const dstp=(kind,val,min,max,labelId)=>`<div class="wz-stp wz-stp--dur" role="group" aria-labelledby="${labelId}">
      <button type="button" class="wz-stp-btn" data-wbrk="${kind}" data-wdir="-1" aria-label="${W('decA')}"${val<=min?' disabled':''}>${WZI.minus}</button>
      <span class="wz-stp-v" data-wbrk-val="${kind}" aria-live="polite">${wzFmtDur(lang,val)}</span>
      <button type="button" class="wz-stp-btn" data-wbrk="${kind}" data-wdir="1" aria-label="${W('incA')}"${val>=max?' disabled':''}>${WZI.plus}</button>
    </div>`;
  return `<div class="nsx" id="ob-nsx">
    <div class="obs-sec obs-sec--night">
      <div class="obs-sec-head">
        <span class="obs-sec-ic obs-sec-ic--night">${WZI.moon}</span>
        <span class="obs-sec-t">${W('secSched')}</span>
      </div>
      <div class="nsx-grid">
        <div class="nsx-fgroup">
          <span class="nsx-q">${W('schedWhen')}</span>
          <div class="nsx-times">
            ${tfield('wz-sched','start',n.start,W('schedStart'))}
            <span class="nsx-times-sep">${WZI.arrowR}</span>
            ${tfield('wz-sched','end',n.end,W('schedEnd'))}
          </div>
        </div>
        <div class="nsx-fgroup">
          <span class="nsx-q">${W('windowQ')}</span>
          <div class="nsx-times">
            ${tfield('wz-win','start',win.start,W('schedStart'))}
            <span class="nsx-times-sep nsx-times-sep--dash">–</span>
            ${tfield('wz-win','end',win.end,W('schedEnd'))}
          </div>
        </div>
      </div>
      <div class="nsx-note"><span class="wz-sched-ic wz-sched-ic--hint">${WZI.info}</span><span>${W('premNote')}</span></div>
    </div>
    <div class="obs-sec">
      <div class="obs-sec-head">
        <span class="obs-sec-ic">${WZI.coffee}</span>
        <span class="obs-sec-t">${W('secBreaks')}</span>
      </div>
      <div class="wz-rule wz-rule--nsx">
        <span class="wz-rule-txt"><span class="wz-rule-t" id="nsx-brk-tot-l">${W('brkTot')}</span><span class="wz-rule-c">${W('brkTotSub')}</span></span>
        ${dstp('tot',tot,WZ_BRK.min,WZ_BRK.max,'nsx-brk-tot-l')}
      </div>
      <div class="wz-fold${tot>0?' wz-fold--open':''}" data-wz-fold="brknight">
        <div class="wz-fold-in"><div class="nsx-brk-night">
          <div class="wz-rule wz-rule--nsx">
            <span class="wz-rule-txt"><span class="wz-rule-t" id="nsx-brk-n-l">${W('brkNight')}</span><span class="wz-rule-c">${W('brkNightSub')}</span></span>
            ${dstp('night',bn,0,tot,'nsx-brk-n-l')}
          </div>
          <div class="wz-brk-meter" aria-hidden="true"><div class="wz-brk-meter-fill" data-wbrk-meter style="width:${tot?Math.round(bn/tot*100):0}%"></div></div>
        </div></div>
      </div>
    </div>
    <div class="obs-sec nsx-pv">
      <div class="obs-sec-head">
        <span class="obs-sec-ic">${WZI.spark}</span>
        <span class="obs-sec-t">${W('prevTitle')}</span>
        <span class="nsx-pv-tag">${W('pvTag')}</span>
      </div>
      <div class="nsx-pv-body" data-nsx-pv aria-live="polite">${obxNightPreviewHTML(st,lang)}</div>
    </div>
  </div>`;
}

// Wiring for the Night Schedule page. opts = { lang, onChange }.
export function obxWireNight(root,st,opts){
  const lang=(opts&&opts.lang);
  const changed=()=>{ if(opts&&opts.onChange) opts.onChange(); };
  root.querySelectorAll('.wz-fold').forEach(f=>wzFoldEl(f,f.classList.contains('wz-fold--open')));
  const refreshPreview=()=>{
    const box=root.querySelector('[data-nsx-pv]');
    if(box) box.innerHTML=obxNightPreviewHTML(st,lang);
  };

  root.addEventListener('click',e=>{
    const bb=e.target.closest('[data-wbrk]');
    if(!bb||!root.contains(bb)) return;
    if(!(st.schedule&&st.schedule.night)) st.schedule={night:{start:'22:00',end:'06:00',breakMin:0}};
    const n=st.schedule.night;
    const {tot,night:bn}=wzBreakOf(n);
    const dir=+bb.dataset.wdir;
    if(bb.dataset.wbrk==='tot'){
      const nt=wzDurNext(tot,dir);
      if(nt===tot) return;
      n.breakMin=nt;
      // "All of it at night" is sticky: the night portion tracks the total
      // until the user explicitly lowers it — after that it only clamps.
      n.breakNightMin=(bn===tot)?nt:Math.min(bn,nt);
    }else{
      const nn=Math.min(wzDurNext(bn,dir,WZ_BRK.incNight),tot);
      if(nn===bn) return;
      n.breakNightMin=nn;
    }
    wzSyncBreak(root,st,lang,true); refreshPreview(); changed();
  });

  root.addEventListener('input',e=>{
    const t=e.target;
    if(t.matches('[data-wz-win]')){
      if(!st.window) st.window={start:'22:00',end:'06:00'};
      if(t.value) st.window[t.dataset.wzWin]=t.value;
      // Back at the statutory default → drop the custom marker so the default
      // window stays implicit (it must never round-trip as "custom").
      if(st.window.start==='22:00'&&st.window.end==='06:00') delete st.window;
      refreshPreview(); changed(); return;
    }
    if(t.matches('[data-wz-sched]')){
      if(!(st.schedule&&st.schedule.night)) st.schedule={night:{start:'22:00',end:'06:00',breakMin:0}};
      if(t.value) st.schedule.night[t.dataset.wzSched]=t.value;
      refreshPreview(); changed(); return;
    }
  });
}
