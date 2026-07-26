// ─────────────────────────────────────────────────────────────────────────────
// ui/views/settings.js — the Settings tab (Phase 8e).
//
// The whole Settings surface: the render (buildSettings + the inline export card
// buildExportCardInline) and ALL of its wiring (wireSettings — formerly
// attachContentListeners, which is now entirely settings after Calendar/Overview
// moved out). Covers wage timeline + three-dot menus, the Wage-Calc-Rules
// collapse and its edit/share/import workplace openers, the tax / insurance /
// target flows and the deduction-mode switch (with its surgical stats-hero +
// rules-row refresh), the holAuto toggle INCLUDING the bake-past-credits block,
// the danger-zone reset opener, and the full export card (format/options/range,
// desktop dropdowns + mobile bottom sheet, unified CSV/PDF export).
//
// Bodies are verbatim from app.js. The only edits are import wiring, the bind
// block, and the documented modal-opener transforms (workplace/share/import →
// ctx openers; all-holidays → ctx opener). RULE_ICONS/ruleRowsHTML moved to
// ui/icons.js. ctx members bind to module lets on each render/wire.
// ─────────────────────────────────────────────────────────────────────────────

import { pad, mkds, pd, isSat } from '../../core/dates.js';
import { TR } from '../../translations.js';
import { activeWageIdx } from '../../domain/wage-history.js';
import { DEFAULT_INSURANCE } from '../../domain/deductions.js';
import { ruleRowsHTML } from '../icons.js';
import { animateStatsHero } from '../motion.js';
import { buildRows, exportCSV, exportPDF, showExportToast, monthsWithData as expMonthsWithData } from '../../export.js';

// Bound from ctx on each render/wire:
let S, t, render, sv, scheduleSync, today,
    getWages, getLogs, saveLogs, wageFor, shiftFor, calcWage, autoEff,
    getTaxPct, isHolAuto, getWage,
    getDeductionMode, getInsurance, careRateOfGross, insuranceRate,
    rulesRows, getUpcomingHolidays, buildStats, wizT,
    HOLIDAYS, appFooter, showSuccess, switchTab,
    openWorkplace, openShare, openImport, openAllHolidays;
const bind = ctx => ({ S, t, render, sv, scheduleSync, today,
    getWages, getLogs, saveLogs, wageFor, shiftFor, calcWage, autoEff,
    getTaxPct, isHolAuto, getWage,
    getDeductionMode, getInsurance, careRateOfGross, insuranceRate,
    rulesRows, getUpcomingHolidays, buildStats, wizT,
    HOLIDAYS, appFooter, showSuccess, switchTab,
    openWorkplace, openShare, openImport, openAllHolidays } = ctx);

// Active UI language (settings-only; reads the bound S). Verbatim from app.js.
function getLang(){return S?.lang||localStorage.getItem('wt4_lang')||'en';}

export function buildSettings(ctx){
  bind(ctx);
  const wages=getWages();
  const taxPct=getTaxPct();
  const rules=rulesRows();
  const holA=isHolAuto();
  const currentWage=getWage();

  // ── Wage timeline rows (newest first, up to 4) ────────────────────────────
  const LANG_LOCALE={en:'en-US',ko:'ko-KR',id:'id-ID',th:'th-TH',ru:'ru-RU',zh:'zh-CN',fr:'fr-FR',ne:'ne-NP'};
  const fmtWageDate=ds=>{const[y,m,d]=ds.split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString(LANG_LOCALE[S.lang]||'en-US',{month:'short',day:'2-digit',year:'numeric'});};
  // The "current" row is the entry active today (last one with date ≤ today),
  // matching wageFor()/getWage(). This may not be the newest row if a future-
  // dated wage change exists.
  const activeIdx=activeWageIdx(wages, today());
  const wageRows=wages.slice().reverse().slice(0,4).map((w,i)=>{
    const realIdx=wages.length-1-i;
    const isFirst=realIdx===0;
    const isCurrent=realIdx===activeIdx;
    return`<div class="sw-row${isCurrent?' sw-row--current':''}">
      <div class="sw-dot-col">
        <div class="sw-dot${isCurrent?' sw-dot--active':''}"></div>
      </div>
      <div class="sw-row-glass">
        <div class="sw-date">${fmtWageDate(w.date)}</div>
        ${isCurrent?`<span class="sw-current-badge sw-current-badge--mobile-only">${t('wageBadgeCurrent')}</span>`:''}
        <div class="sw-amount">₩${w.amount.toLocaleString()}</div>
        <button class="sw-three-dot" data-wage-menu="${realIdx}" aria-label="Options" title="Edit or delete">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>`;
  }).join('');

  const wageFormHTML='';

  // ── Deductions (tax vs 4대 보험 insurance mode) ────────────────────────────
  const dedMode=getDeductionMode();          // 'tax' | 'insurance'
  const ins=getInsurance();
  const insCarePct=careRateOfGross(ins);      // long-term care as % of gross
  const insTotalPct=insuranceRate(ins)*100;   // combined employee %

  // ── Deduction rings ─────────────────────────────────────────────────────────
  // Tax and insurance now live in separate cards, each with its own ring showing
  // that card's own rate (independent of which one is the active deduction).
  const TR_R=48,TR_C=60,TR_SW=9;
  const trCirc=2*Math.PI*TR_R;
  const taxDash=Math.round((Math.min(taxPct,100)/100)*trCirc);

  // ── Target ring + data ────────────────────────────────────────────────────
  const tgt=S.targetHrs||250;
  const nowD=new Date(),curY=nowD.getFullYear(),curMo=nowD.getMonth();
  const todayStr2=today(),logs2=getLogs();
  let curHrs=0;
  const dInM2=new Date(curY,curMo+1,0).getDate();
  for(let d=1;d<=dInM2;d++){const ds=mkds(curY,curMo,d);if(ds>todayStr2)break;curHrs+=autoEff(ds,logs2);}
  const tgtPct=Math.min(100,Math.round((curHrs/tgt)*100));
  const TG_R=46,TG_C=56,TG_SW=9;
  const tgCirc=2*Math.PI*TG_R;
  const tgDash=Math.round((tgtPct/100)*tgCirc);

  const rulesHTML=ruleRowsHTML(rules);

  return`
  <!-- ── Row 1: three equal cards ── -->
  <div class="s3-row">

    <!-- HOURLY WAGE -->
    <div class="s3-card">
      <div class="s3-eyebrow">
        <div class="s3-icon-badge s3-icon-badge--purple s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <span>${t('wageCardTitle').toUpperCase()}</span>
      </div>
      <div class="s3-sub-label">${t('wageCurrentLabel')}</div>
      <div class="s3-big-val">₩${currentWage.toLocaleString()}<span class="s3-big-unit">${t('perHourUnit')}</span></div>
      <div class="s3-sub-label" style="margin-top:14px;margin-bottom:8px;">${t('wageHistoryLabel')}</div>
      <div class="sw-timeline-scroll${wages.length>3?' sw-timeline-scroll--scrollable':''}"><div class="sw-timeline">${wageRows}</div></div>
      <button class="sw-add-btn" id="show-wage-add-form">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('wageAddNew')}
      </button>
    </div>

    <!-- MONTHLY TARGET -->
    <div class="s3-card">
      <div class="s3-eyebrow">
        <div class="s3-icon-badge s3-icon-badge--teal s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <span>${t('monthlyTarget').toUpperCase()}</span>
      </div>

      <!-- Hero: label+number left, ring right — aligned on same baseline row -->
      <div class="s3-target-hero">
        <div class="s3-target-left">
          <div class="s3-sub-label" style="margin-bottom:6px;">${t('monthlyTargetHoursLabel')}</div>
          <div class="s3-target-val" id="tgt-display-val" style="font-size:${tgt.toString().length+t('hoursUnit').length<=4?'34px':tgt.toString().length+t('hoursUnit').length<=6?'26px':'20px'}">${tgt}${t('hoursUnit')}</div>
        </div>
        <div class="s3-target-ring">
          <svg id="tgt-ring-svg" viewBox="0 0 ${TG_C*2} ${TG_C*2}" width="${TG_C*2}" height="${TG_C*2}" style="filter:drop-shadow(0 0 12px rgba(108,134,255,0.3))">
            <defs>
              <linearGradient id="stgt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#6c86ff"/>
                <stop offset="100%" stop-color="#a78bfa"/>
              </linearGradient>
            </defs>
            <circle cx="${TG_C}" cy="${TG_C}" r="${TG_R}" fill="none" stroke="var(--ring-track)" stroke-width="${TG_SW}"/>
            <circle id="tgt-ring-arc" cx="${TG_C}" cy="${TG_C}" r="${TG_R}" fill="none" stroke="url(#stgt-grad)" stroke-width="${TG_SW}"
              stroke-dasharray="${tgDash} ${tgCirc-tgDash}" stroke-dashoffset="${tgCirc*0.25}" stroke-linecap="round"
              style="transition:stroke-dasharray 0.55s cubic-bezier(0.4,0,0.2,1);"/>
            <text id="tgt-ring-txt" x="${TG_C}" y="${TG_C+1}" text-anchor="middle" dominant-baseline="middle"
              fill="var(--text)" font-size="18" font-weight="700" font-family="inherit">${tgtPct}%</text>
          </svg>
          <div class="s3-target-sub" id="tgt-ring-sub">${curHrs.toFixed(1)} / ${tgt}${t('hoursUnit')}</div>
        </div>
      </div>

      <!-- Quick presets: 3 in a row -->
      <div class="s3-sub-label s3-presets-label">${t('monthlyTargetPresets')}</div>
      <div class="s3-pill-grid s3-pill-grid--3" style="margin-bottom:10px;">
        ${[180,250,300].map(h=>`<button class="s3-pill${(S.targetHrs||250)===h?' s3-pill--active':''}" data-target-preset="${h}">${h}${t('hoursUnit')}</button>`).join('')}
      </div>

      <!-- Custom input: full-width below the 3 presets -->
      <div class="s3-custom-row--full s3-custom-row" style="margin-bottom:10px;">
        <input class="s3-inp s3-inp--full" id="target-hrs-in" type="number" value="${tgt}" min="1" max="500" step="1" placeholder="${t('monthlyTargetCustom')}">
        <span class="s3-inp-unit">${t('hoursUnit')}</span>
      </div>

      <button class="s3-full-btn" id="save-target-hrs">${t('monthlyTargetSave')}</button>
    </div>

    <!-- INCOME TAX RATE -->
    <div class="s3-card ded-card${dedMode==='tax'?' ded-card--active':' ded-card--inactive'}" id="ded-card-tax">
      <div class="s3-eyebrow">
        <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg" style="font-size:var(--fs-500);font-weight:var(--fw-black);color:var(--info);">%</div>
        <span>${t('deductionsLabel').toUpperCase()}</span>
        <button class="ded-pick${dedMode==='tax'?' ded-pick--on':''}" id="ded-pick-tax" data-ded-mode="tax"
          role="switch" aria-checked="${dedMode==='tax'}" aria-label="${t('deductionModeTax')}">
          <span class="ded-pick-dot"></span>
          <span class="ded-pick-txt">${dedMode==='tax'?t('deductionActive'):t('deductionUse')}</span>
        </button>
      </div>

      <div class="s3-sub-label">${t('taxRateCurrentLabel')}</div>
      <div class="s3-ring-center">
        <svg viewBox="0 0 ${TR_C*2} ${TR_C*2}" width="${TR_C*2}" height="${TR_C*2}" style="filter:drop-shadow(0 0 12px rgba(108,134,255,0.35))">
          <defs>
            <linearGradient id="stax-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#6c86ff"/>
              <stop offset="100%" stop-color="#a78bfa"/>
            </linearGradient>
          </defs>
          <circle cx="${TR_C}" cy="${TR_C}" r="${TR_R}" fill="none" stroke="var(--ring-track)" stroke-width="${TR_SW}"/>
          <circle id="tax-ring-arc" cx="${TR_C}" cy="${TR_C}" r="${TR_R}" fill="none" stroke="url(#stax-grad)" stroke-width="${TR_SW}"
            stroke-dasharray="${taxDash} ${trCirc-taxDash}" stroke-dashoffset="${trCirc*0.25}" stroke-linecap="round"
            style="transition:stroke-dasharray 0.55s cubic-bezier(0.4,0,0.2,1);"/>
          <text id="tax-ring-txt" x="${TR_C}" y="${TR_C+2}" text-anchor="middle" dominant-baseline="middle"
            fill="var(--text)" font-size="18" font-weight="700" font-family="inherit">${(Math.round(taxPct*100)/100)}%</text>
        </svg>
      </div>

      <div class="ded-body" id="ded-body-tax">
        <div class="s3-hint">${t('taxRateRange')}</div>
        <div class="s3-pill-grid s3-pill-grid--3" style="margin-bottom:8px;">
          ${[3.3,5,10].map(p=>`<button class="s3-pill${Math.abs(taxPct-p)<0.001?' s3-pill--active':''}" data-tax-preset="${p}"${dedMode!=='tax'?' disabled':''}>${p}%</button>`).join('')}
        </div>
        <div class="s3-custom-row s3-custom-row--full" style="margin-bottom:10px;">
          <input class="s3-inp s3-inp--full" id="tax-rate-in" type="number" value="${taxPct}" min="0" max="45" step="0.1" placeholder="${t('taxRatePlaceholder')}"${dedMode!=='tax'?' disabled':''}>
          <span class="s3-inp-unit">%</span>
        </div>
        <button class="s3-full-btn" id="save-tax-rate"${dedMode!=='tax'?' disabled':''}>${t('taxRateSave')}</button>
      </div>
    </div>

  </div><!-- /s3-row -->

  <!-- ── Insurance (4대 보험) — own full-width row, mutually exclusive with Tax ── -->
  <div class="s1-row">
    <div class="s3-card ded-card${dedMode==='insurance'?' ded-card--active':' ded-card--inactive'}" id="ded-card-ins">
      <div class="s3-eyebrow">
        <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <span>${t('deductionModeInsurance').toUpperCase()}</span>
        <button class="ded-pick${dedMode==='insurance'?' ded-pick--on':''}" id="ded-pick-insurance" data-ded-mode="insurance"
          role="switch" aria-checked="${dedMode==='insurance'}" aria-label="${t('deductionModeInsurance')}">
          <span class="ded-pick-dot"></span>
          <span class="ded-pick-txt">${dedMode==='insurance'?t('deductionActive'):t('deductionUse')}</span>
        </button>
      </div>

      <div class="ded-body ded-ins-body" id="ded-body-ins">
        <!-- Hero: total contribution as the answer-first number -->
        <div class="ins-hero">
          <div class="ins-hero-figure">
            <div class="s3-sub-label">${t('insuranceTotalLabel')}</div>
            <div class="ins-hero-total" id="ins-total-val">${(Math.round(insTotalPct*100)/100)}%</div>
          </div>
        </div>

        <!-- Breakdown: four components in a scannable row. Each is a self-contained
             tile — colored icon, label, inline-editable value, and a proportional
             bar whose width = this component's share of the total. -->
        <div class="ins-breakdown">
          <div class="ins-comp" data-comp="pension">
            <div class="ins-comp-head">
              <div class="s3-icon-badge s3-icon-badge--warning">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M4 21V10l8-6 8 6v11M9 21v-6h6v6"/></svg>
              </div>
              <span class="ins-comp-label">${t('insPension')}</span>
            </div>
            <div class="ins-comp-input"><input class="s3-inp ins-inp" id="ins-pension" type="number" value="${ins.pension}" min="0" max="30" step="0.01"${dedMode!=='insurance'?' disabled':''}><span class="s3-inp-unit">%</span></div>
            <div class="ins-comp-bar"><span class="ins-comp-bar-fill" id="ins-bar-pension"></span></div>
          </div>

          <div class="ins-comp" data-comp="health">
            <div class="ins-comp-head">
              <div class="s3-icon-badge s3-icon-badge--danger">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
              </div>
              <span class="ins-comp-label">${t('insHealth')}</span>
            </div>
            <div class="ins-comp-input"><input class="s3-inp ins-inp" id="ins-health" type="number" value="${ins.health}" min="0" max="30" step="0.01"${dedMode!=='insurance'?' disabled':''}><span class="s3-inp-unit">%</span></div>
            <div class="ins-comp-bar"><span class="ins-comp-bar-fill" id="ins-bar-health"></span></div>
          </div>

          <div class="ins-comp" data-comp="employment">
            <div class="ins-comp-head">
              <div class="s3-icon-badge s3-icon-badge--blue">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </div>
              <span class="ins-comp-label">${t('insEmployment')}</span>
            </div>
            <div class="ins-comp-input"><input class="s3-inp ins-inp" id="ins-employment" type="number" value="${ins.employment}" min="0" max="30" step="0.01"${dedMode!=='insurance'?' disabled':''}><span class="s3-inp-unit">%</span></div>
            <div class="ins-comp-bar"><span class="ins-comp-bar-fill" id="ins-bar-employment"></span></div>
          </div>

          <div class="ins-comp ins-comp--derived" data-comp="care">
            <div class="ins-comp-head">
              <div class="s3-icon-badge s3-icon-badge--purple">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
              </div>
              <span class="ins-comp-label">${t('insCare')}</span>
            </div>
            <div class="ins-comp-input"><span class="ins-derived-val" id="ins-care-val">${(Math.round(insCarePct*1000)/1000)}</span><span class="s3-inp-unit">%</span><span class="ins-derived-tag">${t('insCareDerived')}</span></div>
            <div class="ins-comp-bar"><span class="ins-comp-bar-fill" id="ins-bar-care"></span></div>
          </div>
        </div>

        <div class="ins-divider"></div>

        <button class="s3-full-btn" id="save-insurance"${dedMode!=='insurance'?' disabled':''}>${t('insuranceSave')}</button>
      </div>
    </div>
  </div><!-- /s1-row -->

  <!-- ── Row 2: Holiday Credit | Export ── -->
  <div class="s2-row">

    <!-- AUTO HOLIDAY CREDIT -->
    <div class="s3-card s3-card--hol">

      <!-- ── Header ── -->
      <div class="s3-hol-header">
        <div class="s3-eyebrow" style="margin-bottom:0;">
          <div class="s3-icon-badge s3-icon-badge--purple s3-icon-badge--lg">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none"/></svg>
          </div>
          <span class="s3-hol-title">${t('holAutoTitle')}</span>
        </div>
        <div class="s3-hol-onbadge${holA?' s3-hol-onbadge--on':' s3-hol-onbadge--off'}">
          <span class="s3-hol-onbadge-dot"></span>
          <span>${holA?'ON':'OFF'}</span>
        </div>
      </div>

      <!-- ── Description ── -->
      <p class="s3-hol-desc-top">${t('holAutoSub')}</p>

      <!-- ── Gradient divider ── -->
      <div class="s3-hol-divider"></div>

      <!-- ── Three feature tiles ── -->
      <div class="s3-hol-features">

        <div class="s3-hol-feat">
          <div class="s3-hol-feat-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          </div>
          <div class="s3-hol-feat-title">${t('holFeatAutoTitle')}</div>
          <div class="s3-hol-feat-sub">${t('holFeatAutoSub')}</div>
        </div>

        <div class="s3-hol-feat">
          <div class="s3-hol-feat-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="s3-hol-feat-title">${t('holFeat8hTitle')}</div>
          <div class="s3-hol-feat-sub">${t('holFeat8hSub')}</div>
        </div>

        <div class="s3-hol-feat">
          <div class="s3-hol-feat-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
          </div>
          <div class="s3-hol-feat-title">${t('holFeatAlwaysTitle')}</div>
          <div class="s3-hol-feat-sub">${t('holFeatAlwaysSub')}</div>
        </div>

      </div>

      <!-- ── Upcoming Holiday Credits ── -->
      ${(()=>{
        const upcoming = getUpcomingHolidays(3);
        if(!upcoming.length) return '';
        const tr2 = TR[S.lang] || TR.en;
        const rows = upcoming.map(({ds, name, diffDays}, i) => {
          const d = pd(ds);
          const dow = (tr2.dh||TR.en.dh)[d.getDay()];
          const mo  = (tr2.mn||TR.en.mn)[d.getMonth()];
          return `<div class="s3-hol-upc-row${i < upcoming.length-1 ? '' : ' s3-hol-upc-row--last'}">
            <div class="s3-hol-upc-timeline">
              <div class="s3-hol-upc-dot"></div>
              ${i < upcoming.length-1 ? '<div class="s3-hol-upc-line"></div>' : ''}
            </div>
            <div class="s3-hol-upc-info">
              <div class="s3-hol-upc-name">${name}</div>
              <div class="s3-hol-upc-date">${dow}, ${mo} ${d.getDate()}</div>
            </div>
            <div class="s3-hol-upc-right">
              
              <span class="s3-hol-upc-pill">${t('holInDays', diffDays)}</span>
            </div>
          </div>`;
        }).join('');
        return `<div class="s3-hol-upc-section">
          <div class="s3-hol-upc-eyebrow">${t('holUpcomingCredits')}</div>
          <div class="s3-hol-upc-list">${rows}</div>
          <button class="s3-hol-view-all" id="hol-view-all-btn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            ${t('holViewUpcoming')}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>`;
      })()}

      <!-- ── Gradient divider ── -->
      <div class="s3-hol-divider"></div>

      <!-- ── Status row ── -->
      <div class="s3-hol-status-row${holA?'':' s3-hol-status-row--off'}">
        <div class="s3-hol-status-check${holA?' s3-hol-status-check--on':' s3-hol-status-check--off'}">
          <svg class="s3-hol-ic s3-hol-ic--check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <svg class="s3-hol-ic s3-hol-ic--x" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </div>
        <div class="s3-hol-status-text">
          <div class="${holA?'s3-hol-enabled':'s3-hol-disabled'}">${holA?t('holStatusEnabled'):t('holStatusDisabled')}</div>
          <div class="s3-hol-status-txt">${holA?t('holStatusOnTxt'):t('holStatusOffTxt')}</div>
        </div>
        <button id="${holA?'hol-auto-off':'hol-auto-on'}" class="s3-toggle${holA?' s3-toggle--on':''}">
          <div class="s3-toggle-knob"></div>
        </button>
      </div>

      <!-- hidden button for event wiring compatibility -->
      <button id="${holA?'hol-auto-on':'hol-auto-off'}" style="display:none;"></button>
    </div>

    <!-- EXPORT DATA -->
    <div class="s3-card s3-card--export" id="export-card">
      ${buildExportCardInline()}
    </div>

  </div><!-- /s2-row -->

  <!-- ── Row 3: Wage Calculation Rules ── -->
  <div class="s3-card s3-card--rules${S.rulesCollapsed?' s3-card--rules-collapsed':''}">
    <div class="sr-header" id="sr-header" role="button" tabindex="0" aria-controls="sr-list" aria-expanded="${S.rulesCollapsed?'false':'true'}">
      <div class="sr-header-left">
        <div class="s3-icon-badge s3-icon-badge--purple s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        </div>
        <div>
          <div class="sr-header-title">${t('wageCalcRulesTitle')}</div>
          <div class="sr-header-sub">${t('wageCalcRulesSub')}</div>
        </div>
      </div>
      <button class="sr-collapse-btn" id="sr-collapse-btn" aria-label="${t('wageCalcRulesToggle')}" title="${t('wageCalcRulesToggle')}" aria-expanded="${S.rulesCollapsed?'false':'true'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
      </button>
    </div>
    <div class="sr-list" id="sr-list">${rulesHTML}
      <button type="button" class="sw-add-btn" id="pr-edit-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        ${wizT(S.lang,'edit')}
      </button>
      <!-- Phase 6.3: workplace sharing — a code sets up these exact pay rules
           on a coworker's phone; import replaces this workplace via preview. -->
      <div class="pr-btn-row">
        <button type="button" class="sw-add-btn" id="pr-share-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          ${wizT(S.lang,'shareBtn')}
        </button>
        <button type="button" class="sw-add-btn" id="pr-import-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          ${wizT(S.lang,'importBtn')}
        </button>
      </div>
    </div>
  </div>

  <!-- ── Row 4: Danger Zone ── -->
  <div class="s3-card s3-card--danger">
    <div class="s3-danger-left">
      <div class="s3-danger-shield">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div>
        <div class="s3-danger-title">${t('dangerZone')}</div>
        <div class="s3-danger-sub">${t('resetTitle')}.</div>
        <div class="s3-danger-sub">${t('resetSub')}</div>
      </div>
    </div>
    <button class="s3-danger-btn" id="open-reset-modal">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      ${t('resetBtn')}
    </button>
  </div>

  ${appFooter()}`;
}

function buildExportCardInline(){
  const logs=getLogs();
  const months=[...new Set(Object.keys(logs).filter(ds=>{const e=logs[ds];return(e.regHrs||e.hrs||0)>0;}).map(ds=>ds.slice(0,7)))].sort();

  const now=new Date();
  const curYM=`${now.getFullYear()}-${pad(now.getMonth()+1)}`;
  const prevYM=now.getMonth()===0?`${now.getFullYear()-1}-12`:`${now.getFullYear()}-${pad(now.getMonth())}`;

  if(!months.length){
    // ── Premium onboarding empty state ──────────────────────────────────────
    // Shown to first-run users with no logged shifts. A layered-glass hero with
    // a document-stack illustration, an inline explanation of what becomes
    // exportable, and three intentional actions: Start logging (primary),
    // a locked Export affordance, and a "What you can export" disclosure.
    const eItem=(icon,title,sub)=>`
      <div class="sexp-empty-item">
        <div class="sexp-empty-item-ico">${icon}</div>
        <div class="sexp-empty-item-txt">
          <div class="sexp-empty-item-t">${title}</div>
          <div class="sexp-empty-item-s">${sub}</div>
        </div>
        <svg class="sexp-empty-item-chk" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>`;
    return`<div class="sexp-empty" id="sexp-empty">
      <div class="sexp-header">
        <div class="s3-eyebrow" style="margin-bottom:0;">
          <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <span class="sexp-title">${t('exportTitle').toUpperCase()}</span>
        </div>
        <div class="sexp-privacy-badge">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          ${t('expPrivate')}
        </div>
      </div>

      <div class="s3-hol-divider"></div>

      <div class="sexp-empty-hero">
        <div class="sexp-empty-art" aria-hidden="true">
          <span class="sexp-art-glow"></span>
          <span class="sexp-art-doc sexp-art-doc--b"></span>
          <span class="sexp-art-doc sexp-art-doc--m"></span>
          <span class="sexp-art-doc sexp-art-doc--f">
            <span class="sexp-art-bar"></span>
            <span class="sexp-art-line"></span>
            <span class="sexp-art-line sexp-art-line--short"></span>
            <span class="sexp-art-line"></span>
            <span class="sexp-art-line sexp-art-line--short"></span>
          </span>
          <span class="sexp-art-badge">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>
          </span>
        </div>
        <div class="sexp-empty-title">${t('sexpHead')}</div>
        <p class="sexp-empty-desc">${t('sexpDesc')}</p>
      </div>

      <button class="sexp-empty-cta" id="sexp-empty-start">
        <span class="sexp-empty-cta-ico">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </span>
        <span>${t('sexpStart')}</span>
        <svg class="sexp-empty-cta-arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>

      <div class="sexp-empty-foot">
        <div class="sexp-empty-locked" title="${t('sexpLockedHint')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span>${t('sexpLocked')}</span>
          <span class="sexp-empty-locked-tag">${t('sexpLockedHint')}</span>
        </div>
        <button class="sexp-empty-learn" id="sexp-empty-learn" aria-expanded="false" aria-controls="sexp-empty-more">
          <span>${t('sexpLearn')}</span>
          <svg class="sexp-empty-learn-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>

      <div class="sexp-empty-more" id="sexp-empty-more">
        <div class="sexp-empty-more-inner">
          <div class="sexp-empty-list">
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',t('sexpEarnT'),t('sexpEarnS'))}
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',t('sexpHolT'),t('sexpHolS'))}
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',t('sexpMonthT'),t('sexpMonthS'))}
          </div>
          <div class="sexp-empty-formats">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
            <span>${t('sexpFormats')}</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  const firstM=months[0],lastM=months[months.length-1];
  function clamp(ym){return ym<firstM?firstM:ym>lastM?lastM:ym;}
  function threeAgo(){let y=now.getFullYear(),m=now.getMonth()-3;if(m<0){m+=12;y--;}return clamp(`${y}-${pad(m+1)}`);}
  function sixAgo(){let y=now.getFullYear(),m=now.getMonth()-6;if(m<0){m+=12;y--;}return clamp(`${y}-${pad(m+1)}`);}

  const mnames=t('mn');
  function optLabel(ym){const[y,m]=ym.split('-');return`${mnames[parseInt(m)-1]} ${y}`;}

  const totalEntries=Object.keys(logs).length;
  function fmtSize(kb){return kb>=1024?`${(kb/1024).toFixed(1)} MB`:`${Math.round(kb)} KB`;}

  const curLang=getLang();
  const savedFmt=localStorage.getItem('wt4_exp_format')||'csv';
  const csvActive=savedFmt==='csv';

  const defaultFrom=clamp(prevYM);
  const defaultTo  =clamp(prevYM);

  const allLangMeta=getReportLanguageOptions();
  const reportLangs=curLang==='ko'
    ?[{code:'ko',label:'한국어'}]
    :[allLangMeta.find(l=>l.code===curLang)||{code:'en',label:'English'},{code:'ko',label:'한국어'}];
  const defaultLang=reportLangs[0];

  const chevSVG=`<svg class="asm-sort-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const checkSVG=`<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const rangeDisplayLabel=defaultFrom===defaultTo?optLabel(defaultFrom):`${optLabel(defaultFrom)} – ${optLabel(defaultTo)}`;

  const thisYearFrom=`${now.getFullYear()}-01`;
  const thisYearTo  =`${now.getFullYear()}-12`;

  // Desktop preset pills
  const presets=[
    {label:t('exportPresetThisMonth'),from:clamp(curYM),  to:clamp(curYM)},
    {label:t('exportPresetLastMonth'),from:clamp(prevYM), to:clamp(prevYM)},
    {label:t('exportPresetLast3'),    from:threeAgo(),    to:clamp(prevYM)},
    {label:t('exportPresetAllTime'),  from:firstM,        to:lastM},
  ].filter((p,i,arr)=>arr.findIndex(x=>x.from+x.to===p.from+p.to)===i);

  const bsPresets=[
    {key:'thisMonth',label:t('exportPresetThisMonth'),from:clamp(curYM),       to:clamp(curYM)},
    {key:'lastMonth',label:t('exportPresetLastMonth'),from:clamp(prevYM),      to:clamp(prevYM)},
    {key:'last3',    label:t('exportPresetLast3'),    from:threeAgo(),          to:clamp(prevYM)},
    {key:'last6',    label:t('exportPresetLast6'),   from:sixAgo(),            to:clamp(prevYM)},
    {key:'thisYear', label:t('exportPresetThisYear'), from:clamp(thisYearFrom), to:clamp(thisYearTo)},
    {key:'allTime',  label:t('exportPresetAllTime'),  from:firstM,              to:lastM},
    {key:'custom',   label:t('expCustomRange'),       from:'',                  to:''},
  ];

  function presetSub(p){
    if(p.key==='allTime') return t('expPresetSubAllTime');
    if(p.key==='custom')  return t('expPresetSubCustom');
    if(p.from===p.to)     return optLabel(p.from);
    return`${optLabel(p.from)} – ${optLabel(p.to)}`;
  }

  function monthItems(selectedYM){
    return months.map(ym=>`<li class="asm-sort-opt sexp-month-opt${ym===selectedYM?' asm-sort-opt--active':''}" data-ym="${ym}">${optLabel(ym)}${ym===selectedYM?checkSVG:''}</li>`).join('');
  }

  const presetIcons={
    thisMonth:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    lastMonth:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    last3:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    last6:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    thisYear: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    allTime:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="4.93" y1="4.93" x2="9.17" y2="9.17"/><line x1="14.83" y1="14.83" x2="19.07" y2="19.07"/><line x1="14.83" y1="9.17" x2="19.07" y2="4.93"/><line x1="4.93" y1="19.07" x2="9.17" y2="14.83"/></svg>`,
    custom:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>`,
  };
  const presetColors={thisMonth:'#4977fd',lastMonth:'#4977fd',last3:'#22c55e',last6:'#22c55e',thisYear:'#f59e0b',allTime:'#22d3ee',custom:'#ef4444'};

  return`
    <div class="sexp-header">
      <div class="s3-eyebrow" style="margin-bottom:0;">
        <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>
        <span class="sexp-title">${t('exportTitle').toUpperCase()}</span>
      </div>
      <div class="sexp-privacy-badge">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        ${t('expPrivate')}
      </div>
    </div>

    <p class="sexp-desc">${t('exportSub')}</p>
    <div class="s3-hol-divider"></div>
    <div class="sexp-chips">
      <div class="sexp-chip">
        <div class="sexp-chip-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        </div>
        <div class="sexp-chip-body">
          <div class="sexp-chip-val" id="sexp-kpi-records">${totalEntries.toLocaleString()}</div>
          <div class="sexp-chip-lbl">${t('expStatRecords')||'Records'}</div>
        </div>
      </div>
      <div class="sexp-chip-divider"></div>
      <div class="sexp-chip">
        <div class="sexp-chip-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </div>
        <div class="sexp-chip-body">
          <div class="sexp-chip-val" id="sexp-kpi-months">1</div>
          <div class="sexp-chip-lbl" id="sexp-kpi-range">${t('expStatMonths')||'Months'}</div>
        </div>
      </div>
      <div class="sexp-chip-divider"></div>
      <div class="sexp-chip">
        <div class="sexp-chip-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="9" y2="17"/><line x1="15" y1="13" x2="15" y2="17"/><line x1="12" y1="13" x2="12" y2="17"/></svg>
        </div>
        <div class="sexp-chip-body">
          <div class="sexp-chip-val" id="sexp-kpi-size">—</div>
          <div class="sexp-chip-lbl" id="sexp-kpi-size-sub">${t('expStatSize')||'Est. size'}</div>
        </div>
      </div>
    </div>
    
    <div class="sexp-section-label">1. ${t('expSectionFormat')}</div>
    <div class="sexp-btns">
      <button class="sexp-tile sexp-tile--csv${csvActive?' sexp-tile--active':''}" id="exp-csv" data-format="csv">
        <div class="sexp-tile-icon sexp-tile-icon--csv">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        </div>
        <div class="sexp-tile-text">
          <div class="sexp-tile-label">${t('expCsvLabel')}</div>
          <div class="sexp-tile-sub">${t('expCsvSub')}</div>
        </div>
        <div class="sexp-tile-radio${csvActive?' sexp-tile-radio--on':''}" id="sexp-radio-csv"></div>
      </button>
      <button class="sexp-tile sexp-tile--pdf${!csvActive?' sexp-tile--active':''}" id="exp-pdf" data-format="pdf">
        <div class="sexp-tile-icon sexp-tile-icon--pdf">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M10 12v6"/><path d="M14 12v6"/><path d="M10 15h4"/></svg>
        </div>
        <div class="sexp-tile-text">
          <div class="sexp-tile-label">${t('expPdfLabel')}</div>
          <div class="sexp-tile-sub">${t('expPdfSub')}</div>
        </div>
        <div class="sexp-tile-radio${!csvActive?' sexp-tile-radio--on':''}" id="sexp-radio-pdf"></div>
      </button>
    </div>

    <div class="sexp-section-label">2. ${t('expSectionInclude')}</div>
    <div class="sexp-pill-row">
      <button class="sexp-pill sexp-pill--on" id="sexp-opt-hol" data-opt="hol">
        <svg class="sexp-pill-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        ${t('expIncHol')}
      </button>
      <button class="sexp-pill sexp-pill--on" id="sexp-opt-earn" data-opt="earn">
        <svg class="sexp-pill-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        ${t('expIncEarn')}
      </button>
      <button class="sexp-pill sexp-pill--on" id="sexp-opt-monthly" data-opt="monthly">
        <svg class="sexp-pill-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        ${t('expIncMonthly')}
      </button>
      </button>
    </div>

    <div class="sexp-section-label">3. ${t('expSectionDateRange')}</div>
    <!-- DESKTOP: two-dropdown layout (hidden on mobile) -->
    <div class="sexp-range-control sexp-desktop-only">
      <div class="sexp-range-left">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-muted);"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <div class="sexp-range-selects">
          <div class="asm-sort-dropdown sexp-month-drop" id="sexp-from-wrap">
            <button class="asm-sort-trigger sexp-month-trigger" id="sexp-from-trigger" aria-haspopup="listbox" aria-expanded="false">
              <span class="asm-sort-value sexp-month-val" id="sexp-from-val">${optLabel(defaultFrom)}</span>
              ${chevSVG}
            </button>
            <ul class="asm-sort-menu sexp-month-menu" id="sexp-from-menu" role="listbox" data-role="from">
              ${monthItems(defaultFrom)}
            </ul>
          </div>
          <span class="sexp-range-dash">–</span>
          <div class="asm-sort-dropdown sexp-month-drop" id="sexp-to-wrap">
            <button class="asm-sort-trigger sexp-month-trigger" id="sexp-to-trigger" aria-haspopup="listbox" aria-expanded="false">
              <span class="asm-sort-value sexp-month-val" id="sexp-to-val">${optLabel(defaultTo)}</span>
              ${chevSVG}
            </button>
            <ul class="asm-sort-menu sexp-month-menu" id="sexp-to-menu" role="listbox" data-role="to">
              ${monthItems(defaultTo)}
            </ul>
          </div>
        </div>
      </div>
      <div class="sexp-range-divider"></div>
      <div class="sexp-range-right">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-muted);"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <div class="asm-sort-dropdown sexp-lang-drop" id="sexp-lang-wrap">
          <button class="asm-sort-trigger sexp-lang-trigger" id="sexp-lang-trigger" aria-haspopup="listbox" aria-expanded="false">
            <span class="asm-sort-value sexp-lang-val" id="sexp-lang-val">${defaultLang.label}</span>
            ${chevSVG}
          </button>
          <ul class="asm-sort-menu sexp-lang-menu" id="sexp-lang-menu" role="listbox">
            ${reportLangs.map(l=>`<li class="asm-sort-opt sexp-lang-opt${l.code===defaultLang.code?' asm-sort-opt--active':''}" data-lang="${l.code}">${l.label}${l.code===defaultLang.code?checkSVG:''}</li>`).join('')}
          </ul>
        </div>
      </div>
    </div>
    <!-- preset row (desktop only) -->
    <div class="exp-preset-row sexp-desktop-only" style="margin-top:8px;flex-wrap:wrap;gap:6px;">
      ${presets.map((p,i)=>`<button class="exp-preset${i===1?' exp-preset--active':''}" data-from="${p.from}" data-to="${p.to}">${p.label}</button>`).join('')}
    </div>

    <!-- MOBILE: single date range field + bottom sheet (hidden on desktop) -->
    <div class="sexp-dr-row sexp-mobile-only">
      <button class="sexp-dr-field" id="sexp-dr-trigger" aria-label="Select date range">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="sexp-dr-cal-icon"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span class="sexp-dr-label" id="sexp-dr-label">${rangeDisplayLabel}</span>
        ${chevSVG}
      </button>
      <div class="asm-sort-dropdown sexp-lang-drop sexp-dr-lang" id="sexp-lang-wrap-mob">
        <button class="asm-sort-trigger sexp-lang-trigger sexp-dr-lang-trigger" id="sexp-lang-trigger-mob" aria-haspopup="listbox" aria-expanded="false">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--text-muted);"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span class="asm-sort-value sexp-lang-val" id="sexp-lang-val-mob">${defaultLang.label}</span>
          ${chevSVG}
        </button>
        <ul class="asm-sort-menu sexp-lang-menu" id="sexp-lang-menu-mob" role="listbox">
          ${reportLangs.map(l=>`<li class="asm-sort-opt sexp-lang-opt-mob${l.code===defaultLang.code?' asm-sort-opt--active':''}" data-lang="${l.code}">${l.label}${l.code===defaultLang.code?checkSVG:''}</li>`).join('')}
        </ul>
      </div>
    </div>
    <!-- ── Bottom-sheet: date range picker (mobile) ── -->
    <div class="sexp-bs-overlay" id="sexp-bs-overlay" hidden>
      <div class="sexp-bs-backdrop" id="sexp-bs-backdrop"></div>
      <div class="sexp-bs" id="sexp-bs">
        <div class="sexp-bs-handle"></div>
        <!-- VIEW 1: Preset list -->
        <div class="sexp-bs-view" id="sexp-bs-view-presets">
          <div class="sexp-bs-header">
            <span class="sexp-bs-title">${t('expBsSelectRange')}</span>
            <button class="sexp-bs-close" id="sexp-bs-close" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="sexp-bs-presets">
            ${bsPresets.map(p=>`
            <button class="sexp-bs-preset${p.key==='lastMonth'?' sexp-bs-preset--active':''}" data-key="${p.key}" data-from="${p.from}" data-to="${p.to}">
              <div class="sexp-bs-preset-icon" style="--preset-color:${presetColors[p.key]||'#4977fd'}">
                ${presetIcons[p.key]||presetIcons.custom}
              </div>
              <div class="sexp-bs-preset-text">
                <span class="sexp-bs-preset-label">${p.label}</span>
                <span class="sexp-bs-preset-sub">${presetSub(p)}</span>
              </div>
              ${p.key==='custom'?`<svg class="sexp-bs-preset-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`:''}
            </button>`).join('')}
          </div>
        </div>
        <!-- VIEW 2: Custom range -->
        <div class="sexp-bs-view sexp-bs-view--hidden" id="sexp-bs-view-custom">
          <div class="sexp-bs-header">
            <button class="sexp-bs-back" id="sexp-bs-back" aria-label="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span class="sexp-bs-title">${t('expBsCustomRange')}</span>
            <button class="sexp-bs-close sexp-bs-close--custom" id="sexp-bs-close2" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="sexp-bs-custom-dates">
            <div class="sexp-bs-date-field" id="sexp-cust-from-field">
              <span class="sexp-bs-date-lbl">${t('expBsStartDate')}</span>
              <div class="sexp-bs-date-val-row">
                <span class="sexp-bs-date-val" id="sexp-cust-from-val">${optLabel(defaultFrom)}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </div>
            </div>
            <span class="sexp-bs-date-dash">–</span>
            <div class="sexp-bs-date-field sexp-bs-date-field--end" id="sexp-cust-to-field">
              <span class="sexp-bs-date-lbl">${t('expBsEndDate')}</span>
              <div class="sexp-bs-date-val-row">
                <span class="sexp-bs-date-val" id="sexp-cust-to-val">${optLabel(defaultTo)}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </div>
            </div>
          </div>
          <div class="sexp-bs-custom-lists">
            <div class="sexp-bs-custom-col">
              <div class="sexp-bs-custom-col-label">${t('exportFrom')}</div>
              <ul class="sexp-bs-month-list" id="sexp-cust-from-list" data-role="from">
                ${monthItems(defaultFrom)}
              </ul>
            </div>
            <div class="sexp-bs-custom-col">
              <div class="sexp-bs-custom-col-label">${t('exportTo')}</div>
              <ul class="sexp-bs-month-list" id="sexp-cust-to-list" data-role="to">
                ${monthItems(defaultTo)}
              </ul>
            </div>
          </div>
          <div class="sexp-bs-custom-actions">
            <button class="sexp-bs-apply" id="sexp-bs-apply">${t('expBsApply')}</button>
            <button class="sexp-bs-clear" id="sexp-bs-clear">${t('expBsClear')}</button>
          </div>
        </div>
      </div>
    </div>

    <div id="exp-range-err" style="display:none;font-size:11px;color:var(--danger);margin-top:6px;">${t('exportRangeErr')}</div>
    <div class="s3-hol-divider sexp-export-divider"></div>
    <button class="sexp-export-btn" id="sexp-do-export">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      ${t('expExportBtn')}
    </button>
    <div class="sexp-security-note">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      ${t('expSecNote')}
    </div>`;
}

function getReportLanguageOptions(){
  return[{code:'en',label:'English'},{code:'ko',label:'한국어'},{code:'id',label:'Indonesia'},{code:'th',label:'ภาษาไทย'},{code:'ru',label:'Русский'},{code:'zh',label:'中文'},{code:'fr',label:'Français'},{code:'ne',label:'नेपाली'}];
}

export function wireSettings(ctx){
  bind(ctx);
  // Toggle fade mask on timeline scroll wrapper
  const swScroll=document.querySelector('.sw-timeline-scroll');
  if(swScroll){
    const checkFull=()=>swScroll.classList.toggle('sw-timeline-scroll--full',swScroll.scrollHeight<=swScroll.clientHeight+2);
    checkFull();
    swScroll.addEventListener('scroll',checkFull,{passive:true});
  }

  const showWageAddBtn=document.getElementById('show-wage-add-form');
  if(showWageAddBtn)showWageAddBtn.addEventListener('click',()=>{
    S.wageModal={mode:'add'};render();
  });

  // Three-dot menus on wage rows
  document.querySelectorAll('[data-wage-menu]').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const existing=document.querySelector('.sw-ctx-menu');
      if(existing){
        const wasThisBtn=existing.dataset.forBtn===btn.dataset.wageMenu;
        existing.remove();
        if(wasThisBtn)return;
      }
      const idx=parseInt(btn.dataset.wageMenu);
      const wages=getWages();
      const isFirst=idx===0;
      const menu=document.createElement('div');
      menu.className='sw-ctx-menu';
      menu.dataset.forBtn=btn.dataset.wageMenu;
      menu.innerHTML=`<button class="sw-ctx-item" id="wctx-edit">${t('edit')}</button>${!isFirst?`<button class="sw-ctx-item sw-ctx-item--danger" id="wctx-del">${t('del')}</button>`:''}`;
      document.body.appendChild(menu);
      requestAnimationFrame(()=>{
        const btnR=btn.getBoundingClientRect();
        const menuW=130;
        const menuH=menu.getBoundingClientRect().height;
        const spaceBelow=window.innerHeight-btnR.bottom;
        const top=spaceBelow>=menuH+6?btnR.bottom+4:btnR.top-menuH-4;
        const left=Math.min(btnR.right-menuW,window.innerWidth-menuW-8);
        menu.style.top=top+'px';
        menu.style.left=Math.max(8,left)+'px';
      });
      const editBtn=document.getElementById('wctx-edit');
      const delBtn=document.getElementById('wctx-del');
      if(editBtn)editBtn.addEventListener('click',e2=>{
        e2.stopPropagation();
        menu.remove();
        S.wageModal={mode:'edit',idx};render();
      });
      if(delBtn)delBtn.addEventListener('click',e2=>{
        e2.stopPropagation();
        menu.remove();
        S.wageModal={mode:'delete',idx};render();
      });
      setTimeout(()=>document.addEventListener('click',()=>menu.remove(),{once:true}),0);
    });
  });

  // ── Wage Calc Rules — collapse/expand ───────────────────────────────────────
  // Toggle locally (animate height) without a full render(); persist the choice.
  (function(){
    const card=document.querySelector('.s3-card--rules');
    const header=document.getElementById('sr-header');
    const btn=document.getElementById('sr-collapse-btn');
    const list=document.getElementById('sr-list');
    if(!card||!header||!list)return;

    function setExpanded(state){ // state: true=expanded
      header.setAttribute('aria-expanded',String(state));
      btn?.setAttribute('aria-expanded',String(state));
    }

    function toggle(){
      const willCollapse=!card.classList.contains('s3-card--rules-collapsed');
      // Animate from explicit pixel height so the transition has something to tween.
      const full=list.scrollHeight;
      if(willCollapse){
        list.style.height=full+'px';
        // force reflow so the browser registers the starting height
        void list.offsetHeight;
        card.classList.add('s3-card--rules-collapsed');
        list.style.height='0px';
      }else{
        card.classList.remove('s3-card--rules-collapsed');
        list.style.height='0px';
        void list.offsetHeight;
        list.style.height=full+'px';
        // After the open animation, clear the inline height so the list can
        // reflow naturally (e.g. on language change or window resize).
        list.addEventListener('transitionend',function clear(e){
          if(e.propertyName!=='height')return;
          list.style.height='';
          list.removeEventListener('transitionend',clear);
        });
      }
      S.rulesCollapsed=willCollapse;
      sv('wt4_rules_collapsed',willCollapse);
      scheduleSync();
      setExpanded(!willCollapse);
    }

    // If the card mounted already collapsed, lock the list height to 0.
    if(card.classList.contains('s3-card--rules-collapsed')) list.style.height='0px';

    btn?.addEventListener('click',e=>{e.stopPropagation();toggle();});
    header.addEventListener('click',toggle);

    // Phase 6: "Edit workplace" opens the workplace configuration modal —
    // no inline expansion, no page reflow underneath.
    const editBtn=card.querySelector('#pr-edit-btn');
    if(editBtn) editBtn.addEventListener('click',e=>{
      e.stopPropagation();
      openWorkplace();
    });
    // Phase 6.3: share/import this workplace by code.
    const shareBtn=card.querySelector('#pr-share-btn');
    if(shareBtn) shareBtn.addEventListener('click',e=>{
      e.stopPropagation();
      openShare();
    });
    const importBtn=card.querySelector('#pr-import-btn');
    if(importBtn) importBtn.addEventListener('click',e=>{
      e.stopPropagation();
      openImport();
    });
    header.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}
    });
  })();

  // Animate tax ring arc smoothly given a 0-45 value
  function animateRing(pct,idBase){
    const arc=document.getElementById(idBase+'-arc');
    const txt=document.getElementById(idBase+'-txt');
    if(!arc)return;
    const TR_R=48;
    const circ=2*Math.PI*TR_R;
    const dash=Math.round((Math.min(pct,100)/100)*circ);
    arc.setAttribute('stroke-dasharray',dash+' '+(circ-dash));
    arc.setAttribute('stroke-dashoffset', circ*0.25);
    if(txt)txt.textContent=(Math.round(pct*100)/100)+'%';
  }
  // Back-compat: the tax card's ring keeps its original driver name.
  function animateTaxRing(pct){ animateRing(pct,'tax-ring'); }

  // Preview only — updates the ring + active pill highlight, does NOT persist.
  // Used while the user is still choosing a rate (typing or clicking a preset).
  function previewTaxRate(v){
    animateTaxRing(v);
    document.querySelectorAll('[data-tax-preset]').forEach(b=>{
      b.classList.toggle('s3-pill--active', Math.abs(parseFloat(b.dataset.taxPreset)-v)<0.001);
    });
  }

  // Persists the rate. Only called when the user explicitly clicks Save.
  function applyTaxRate(v){
    v=Math.min(45,Math.max(0,parseFloat(v.toFixed(2))));
    previewTaxRate(v);
    S.taxRate=v;sv('wt4_tax_rate',v);scheduleSync();
  }

  const saveTaxBtn=document.getElementById('save-tax-rate');
  if(saveTaxBtn)saveTaxBtn.addEventListener('click',()=>{
    const inp=document.getElementById('tax-rate-in');
    if(!inp)return;
    const v=parseFloat(inp.value);
    if(isNaN(v)||v<0||v>45)return;
    applyTaxRate(v);
    showSuccess('taxRate');
  });

  // Tax rate presets — preview on the ring only; nothing is saved until Save is clicked
  document.querySelectorAll('[data-tax-preset]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const v=parseFloat(btn.dataset.taxPreset);
      const inp=document.getElementById('tax-rate-in');
      if(inp)inp.value=v;
      previewTaxRate(v);
    });
  });
  // Custom input — preview on the ring only; nothing is saved until Save is clicked
  const taxInp=document.getElementById('tax-rate-in');
  if(taxInp){
    taxInp.addEventListener('input',()=>{
      const v=parseFloat(taxInp.value);
      if(isNaN(v)||v<0||v>45)return;
      previewTaxRate(v);
    });
  }

  // ── Deduction mode switch (Tax ↔ 4대 보험) ─────────────────────────────────
  // Recompute the live insurance total from the current input values.
  function insCareLive(){
    const health=parseFloat(document.getElementById('ins-health')?.value)||0;
    return health*(DEFAULT_INSURANCE.careOfHealth/100);
  }
  function insTotalLive(){
    const p=parseFloat(document.getElementById('ins-pension')?.value)||0;
    const h=parseFloat(document.getElementById('ins-health')?.value)||0;
    const e=parseFloat(document.getElementById('ins-employment')?.value)||0;
    return p+h+insCareLive()+e;
  }
  // Set each component's share bar. Width = component / total, so the four bars
  // visually encode relative magnitude at a glance (the reference's key idea).
  function setInsBars(pension,health,care,employment,total){
    const t100=total>0?total:1;
    const set=(id,val)=>{
      const el=document.getElementById(id);
      if(el)el.style.width=Math.max(0,Math.min(100,(val/t100)*100))+'%';
    };
    set('ins-bar-pension',pension);
    set('ins-bar-health',health);
    set('ins-bar-care',care);
    set('ins-bar-employment',employment);
  }
  function refreshInsPreview(){
    const p=parseFloat(document.getElementById('ins-pension')?.value)||0;
    const h=parseFloat(document.getElementById('ins-health')?.value)||0;
    const e=parseFloat(document.getElementById('ins-employment')?.value)||0;
    const care=insCareLive(), total=insTotalLive();
    const cv=document.getElementById('ins-care-val');
    const tv=document.getElementById('ins-total-val');
    if(cv)cv.textContent=Math.round(care*1000)/1000;
    if(tv)tv.textContent=(Math.round(total*100)/100)+'%';
    setInsBars(p,h,care,e,total);
  }

  // Activate exactly one deduction card (tax XOR insurance). The other card
  // stays visible but dimmed/disabled — mutual exclusivity is preserved because
  // wt4_deduction_mode remains the single source of truth read by deductionRate().
  function setDeductionMode(mode){
    sv('wt4_deduction_mode',mode);
    scheduleSync();
    const taxOn=mode==='tax', insOn=mode==='insurance';

    const taxCard=document.getElementById('ded-card-tax');
    const insCard=document.getElementById('ded-card-ins');
    taxCard?.classList.toggle('ded-card--active',taxOn);
    taxCard?.classList.toggle('ded-card--inactive',!taxOn);
    insCard?.classList.toggle('ded-card--active',insOn);
    insCard?.classList.toggle('ded-card--inactive',!insOn);

    // Update each card's selector pill (state + label)
    const pickTax=document.getElementById('ded-pick-tax');
    const pickIns=document.getElementById('ded-pick-insurance');
    if(pickTax){
      pickTax.classList.toggle('ded-pick--on',taxOn);
      pickTax.setAttribute('aria-checked',String(taxOn));
      const tx=pickTax.querySelector('.ded-pick-txt');
      if(tx)tx.textContent=taxOn?t('deductionActive'):t('deductionUse');
    }
    if(pickIns){
      pickIns.classList.toggle('ded-pick--on',insOn);
      pickIns.setAttribute('aria-checked',String(insOn));
      const ix=pickIns.querySelector('.ded-pick-txt');
      if(ix)ix.textContent=insOn?t('deductionActive'):t('deductionUse');
    }

    // Actually disable (not just visually dim) every input/button inside the
    // inactive card. pointer-events:none alone still leaves them focusable
    // and editable via keyboard (Tab + type, or Enter on a focused button),
    // so the real `disabled` attribute is required to make the inactive
    // card genuinely non-selectable/non-editable, not just grayed out.
    ['tax-rate-in','save-tax-rate'].forEach(id=>{
      const el=document.getElementById(id);
      if(el)el.disabled=!taxOn;
    });
    document.querySelectorAll('[data-tax-preset]').forEach(btn=>{btn.disabled=!taxOn;});
    ['ins-pension','ins-health','ins-employment','save-insurance'].forEach(id=>{
      const el=document.getElementById(id);
      if(el)el.disabled=!insOn;
    });
  }
  document.querySelectorAll('[data-ded-mode]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(getDeductionMode()===btn.dataset.dedMode)return; // already active — no-op
      setDeductionMode(btn.dataset.dedMode);
      // Refresh ONLY the stats hero so earnings reflect the new mode. A full
      // render() would rebuild the settings screen too, destroying the other
      // card's grayed-out CSS transition (and re-flashing its ring animation).
      // setDeductionMode() already updated both cards' active/inactive state.
      const hero=document.querySelector('.stats-hero');
      if(hero){
        const tmp=document.createElement('div');
        tmp.innerHTML=buildStats();
        const fresh=tmp.firstElementChild;
        if(fresh){ hero.replaceWith(fresh); requestAnimationFrame(animateStatsHero); }
      }
      // Refresh just the deduction row (last row) in the Wage Calculation
      // Rules card so it reflects Tax vs 4 Insurances instantly — no need to
      // rebuild the whole rules list or reload the page.
      const srList=document.getElementById('sr-list');
      const lastRow=srList?.querySelector('.sr-row:last-child');
      if(lastRow){
        const freshRules=rulesRows();
        const [dedType,dedRule]=freshRules[freshRules.length-1];
        const nameEl=lastRow.querySelector('.sr-name');
        const descEl=lastRow.querySelector('.sr-desc');
        if(nameEl)nameEl.textContent=dedType;
        if(descEl)descEl.textContent=dedRule;
      }
    });
  });

  // The inactive deduction card must appear grayed the instant the Settings tab
  // mounts — with no fade-in. The dim transitions are gated behind
  // `.ded-cards--armed` (see style.css); arm it two frames after mount so the
  // initial dimmed state paints un-transitioned, then later mode switches still
  // animate smoothly. Scoped to the deduction cards' shared ancestor.
  const dedHost=document.getElementById('ded-card-tax')?.parentElement;
  if(dedHost && !dedHost.classList.contains('ded-cards--armed')){
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      dedHost.classList.add('ded-cards--armed');
    }));
  }

  // Live-preview insurance total as the user edits any rate
  ['ins-pension','ins-health','ins-employment'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',refreshInsPreview);
  });
  // Paint the proportional bars on first render (they start at 0% in CSS, so
  // this triggers the fill animation from empty → each component's share).
  if(document.getElementById('ins-breakdown')||document.getElementById('ins-bar-pension')){
    requestAnimationFrame(refreshInsPreview);
  }

  const saveInsBtn=document.getElementById('save-insurance');
  if(saveInsBtn)saveInsBtn.addEventListener('click',()=>{
    const clamp=v=>Math.min(30,Math.max(0,parseFloat(v)||0));
    const payload={
      pension:    clamp(document.getElementById('ins-pension')?.value),
      health:     clamp(document.getElementById('ins-health')?.value),
      employment: clamp(document.getElementById('ins-employment')?.value),
      careOfHealth: DEFAULT_INSURANCE.careOfHealth, // derived ratio, not user-set
    };
    sv('wt4_insurance',payload);
    scheduleSync();
    showSuccess('insurance');
  });

  // ── Target hours ring animation (mirrors tax ring pattern) ──────────────────
  function animateTargetRing(newTgt){
    const arc=document.getElementById('tgt-ring-arc');
    const txt=document.getElementById('tgt-ring-txt');
    const sub=document.getElementById('tgt-ring-sub');
    const disp=document.getElementById('tgt-display-val');
    if(!arc)return;
    // Re-compute progress against the new target value (curHrs unchanged)
    const nowD2=new Date(),curY2=nowD2.getFullYear(),curMo2=nowD2.getMonth();
    const tStr2=today(),logs3=getLogs();
    let cHrs=0;
    const dInM3=new Date(curY2,curMo2+1,0).getDate();
    for(let d=1;d<=dInM3;d++){const ds=mkds(curY2,curMo2,d);if(ds>tStr2)break;cHrs+=autoEff(ds,logs3);}
    const TG_R2=46,TG_SW2=9;
    const circ2=2*Math.PI*TG_R2;
    const pct2=Math.min(100,Math.round((cHrs/newTgt)*100));
    const dash2=Math.round((pct2/100)*circ2);
    arc.setAttribute('stroke-dasharray',dash2+' '+(circ2-dash2));
    arc.setAttribute('stroke-dashoffset',circ2*0.25);
    if(txt)txt.textContent=pct2+'%';
    if(sub)sub.textContent=cHrs.toFixed(1)+' / '+newTgt+t('hoursUnit');
    if(disp){
      const label=newTgt+t('hoursUnit');
      const len=label.length;
      disp.style.fontSize=len<=4?'34px':len<=6?'26px':'20px';
      disp.textContent=label;
    }
  }
  function previewTargetHrs(v){
    animateTargetRing(v);
    document.querySelectorAll('[data-target-preset]').forEach(b=>{
      b.classList.toggle('s3-pill--active', parseInt(b.dataset.targetPreset)===v);
    });
  }
  const saveTargetBtn=document.getElementById('save-target-hrs');
  if(saveTargetBtn)saveTargetBtn.addEventListener('click',()=>{
    const inp=document.getElementById('target-hrs-in');
    if(!inp)return;
    let v=parseInt(inp.value);
    if(isNaN(v)||v<1)return;
    v=Math.min(500,Math.max(1,v));
    inp.value=v;
    previewTargetHrs(v);
    S.targetHrs=v;sv('wt4_target_hrs',v);scheduleSync();showSuccess('targetHrs');
  });
  // Target hours presets — preview ring immediately on click
  document.querySelectorAll('[data-target-preset]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const v=parseInt(btn.dataset.targetPreset);
      const inp=document.getElementById('target-hrs-in');
      if(inp)inp.value=v;
      previewTargetHrs(v);
    });
  });
  // Custom input — preview ring live as user types
  const targetInp=document.getElementById('target-hrs-in');
  if(targetInp)targetInp.addEventListener('input',()=>{
    const v=parseInt(targetInp.value);
    if(isNaN(v)||v<1||v>500)return;
    previewTargetHrs(v);
  });
  document.getElementById('hol-view-all-btn')?.addEventListener('click', () => {
    openAllHolidays();
  });
  const holOnBtn=document.getElementById('hol-auto-on');
  const holOffBtn=document.getElementById('hol-auto-off');

  // Animate the switch in place by flipping the class on the LIVE element so the
  // CSS knob-slide transition actually plays. Also update the status label live
  // so the text tracks the knob. The full render() (for hero stats) is deferred
  // by the caller until the slide finishes, so it doesn't recreate the knob
  // mid-animation and make it snap.
  const HOL_TOGGLE_MS=380; // clear of the knob slide (0.22s) and colour fades (0.3s)
  function smoothHolToggle(turnOn){
    const tog=document.querySelector('.s3-toggle');
    if(tog) tog.classList.toggle('s3-toggle--on',turnOn);
    // Top-of-card ON/OFF badge (colour transitions via CSS; text flips instantly)
    const ob=document.querySelector('.s3-hol-onbadge');
    if(ob){
      ob.classList.toggle('s3-hol-onbadge--on',turnOn);
      ob.classList.toggle('s3-hol-onbadge--off',!turnOn);
      const obTxt=ob.querySelector('span:not(.s3-hol-onbadge-dot)');
      if(obTxt) obTxt.textContent=turnOn?'ON':'OFF';
    }
    // Status row tint (green ↔ gray)
    const row=document.querySelector('.s3-hol-status-row');
    if(row) row.classList.toggle('s3-hol-status-row--off',!turnOn);
    // Check badge colour + icon cross-fade (check ↔ X handled by CSS)
    const badge=document.querySelector('.s3-hol-status-check');
    if(badge){
      badge.classList.toggle('s3-hol-status-check--on',turnOn);
      badge.classList.toggle('s3-hol-status-check--off',!turnOn);
    }
    // Status label (colour transitions via CSS)
    const lbl=document.querySelector('.s3-hol-enabled,.s3-hol-disabled');
    if(lbl){
      lbl.className=turnOn?'s3-hol-enabled':'s3-hol-disabled';
      lbl.textContent=turnOn?t('holStatusEnabled'):t('holStatusDisabled');
    }
    const sub=document.querySelector('.s3-hol-status-txt');
    if(sub) sub.textContent=turnOn?t('holStatusOnTxt'):t('holStatusOffTxt');
  }

  if(holOnBtn)holOnBtn.addEventListener('click',()=>{
    smoothHolToggle(true);                          // slide the knob now
    S.holAuto=true;sv('wt4_hol_auto',true);scheduleSync();
    showExportToast(t('holAutoSaved'));             // toast without an immediate re-render
    setTimeout(render,HOL_TOGGLE_MS);               // refresh stats after the slide
  });
  if(holOffBtn)holOffBtn.addEventListener('click',()=>{
    smoothHolToggle(false);                         // slide the knob now
    // Before turning holAuto off, bake any past auto-credited holidays into real
    // log entries so they don't silently disappear. Two cases:
    //
    // 1. No log entry at all — create one with holCreditOverride:true.
    // 2. Existing log entry but no explicit holCreditOverride (was stored without
    //    it because it matched the global default at save time, line 1376) — set
    //    holCreditOverride:true and recalculate so the credit is preserved.
    const logs = getLogs();
    const todayStr = today();
    let changed = false;
    Object.keys(HOLIDAYS).forEach(ds => {
      if(ds >= todayStr) return;                          // skip today and future
      const w = wageFor(ds);
      const sf = shiftFor(ds);
      if(!logs[ds]) {
        // Case 1: no entry — bake in as a pure holiday credit day.
        // Saturday holidays are never auto-credited (they follow the 50% Saturday
        // pay rule), so there's no phantom credit to preserve — skip them.
        if(isSat(ds)) return;
        const c = calcWage(ds, 0, 0, w, sf, true);
        logs[ds] = {regHrs:0, otHrs:0, hrs:0, gross:c.gross, net:c.net, eff:c.eff,
          holCreditOverride:true};
        changed = true;
      } else if(logs[ds].holCreditOverride === undefined) {
        // Case 2: entry exists but no explicit override — the credit was implied
        // by holAuto being ON, so bake it in now before the setting changes
        const l = logs[ds];
        const c = calcWage(ds, l.regHrs||0, l.otHrs||0, w, l.shiftOverride||sf, true);
        logs[ds] = {...l, holCreditOverride:true, gross:c.gross, net:c.net, eff:c.eff};
        changed = true;
      }
    });
    if(changed) saveLogs(logs);
    S.holAuto=false;sv('wt4_hol_auto',false);scheduleSync();
    showExportToast(t('holAutoSaved'));             // toast without an immediate re-render
    setTimeout(render,HOL_TOGGLE_MS);               // refresh stats after the slide
  });

  const openResetBtn=document.getElementById('open-reset-modal');
  if(openResetBtn)openResetBtn.addEventListener('click',()=>{
    S.resetModal=true;render();
  });

  // Export card — wire premium UI with live summary, filtered export, persistence
  if(S.tab==='settings'){
    const card=document.getElementById('export-card');
    if(!card)return;

    // ── Empty state (no logged shifts yet) ───────────────────────────────────
    // The onboarding empty state has its own actions and none of the export
    // controls below, so wire it and bail before the populated-card refs.
    const emptyRoot=document.getElementById('sexp-empty');
    if(emptyRoot){
      document.getElementById('sexp-empty-start')?.addEventListener('click',()=>switchTab('calendar'));
      const learnBtn=document.getElementById('sexp-empty-learn');
      learnBtn?.addEventListener('click',()=>{
        const open=emptyRoot.classList.toggle('sexp-empty--open');
        learnBtn.setAttribute('aria-expanded',open?'true':'false');
      });
      return;
    }

    // ── Gather DOM refs ──────────────────────────────────────────────────────
    const csvTile   =document.getElementById('exp-csv');
    const pdfTile   =document.getElementById('exp-pdf');
    const radioCsv  =document.getElementById('sexp-radio-csv');
    const radioPdf  =document.getElementById('sexp-radio-pdf');
    const doExportBtn=document.getElementById('sexp-do-export');
    if(!doExportBtn)return;

    // ── Range state ───────────────────────────────────────────────────────────────────────────────────────
    const allMonths=expMonthsWithData();
    if(!allMonths.length)return;

    const now=new Date();
    const prevM=now.getMonth()===0?`${now.getFullYear()-1}-12`:`${now.getFullYear()}-${pad(now.getMonth())}`;
    function clampM(ym){return ym<allMonths[0]?allMonths[0]:ym>allMonths[allMonths.length-1]?allMonths[allMonths.length-1]:ym;}

    let _from=clampM(prevM);
    let _to  =clampM(prevM);
    let _lang=(()=>{
      const active=card.querySelector('.sexp-lang-opt.asm-sort-opt--active');
      return active?.dataset.lang||getLang();
    })();
    let _exporting=false;
    let _expFormat=localStorage.getItem('wt4_exp_format')||'csv';

    const mnames=t('mn');
    function ymLabel(ym){const[y,m]=ym.split('-');return`${mnames[parseInt(m)-1]} ${y}`;}

    // ── Update the main date range trigger label ──────────────────────────────────────
    function refreshDrLabel(){
      const el=card.querySelector('#sexp-dr-label');
      if(!el)return;
      el.textContent=_from===_to?ymLabel(_from):`${ymLabel(_from)} – ${ymLabel(_to)}`;
    }

    // ── Live summary chips refresh ─────────────────────────────────────────────────────────
    function fmtSz(kb){return kb>=1024?`${(kb/1024).toFixed(1)} MB`:`${Math.round(kb)} KB`;}

    function refreshExpSummary(){
      let rows=[];
      try{rows=buildRows(_from,_to);}catch(e){}
      const incHol    =card.querySelector('#sexp-opt-hol')?.classList.contains('sexp-pill--on')!==false;
      const incEarn   =card.querySelector('#sexp-opt-earn')?.classList.contains('sexp-pill--on')!==false;
      const incMonthly=card.querySelector('#sexp-opt-monthly')?.classList.contains('sexp-pill--on')!==false;
      let filtered=rows;
      if(!incHol) filtered=filtered.filter(r=>!(r.holiday&&r.autoCredit&&r.regHrs===0&&r.otHrs===0));
      const count=filtered.length;
      // CSV: measured ~0.074 KB/row base; earnings cols add ~3 extra fields ≈ 30% more
      const csvKB=Math.max(0.5,count*(incEarn?0.096:0.074));
      // PDF: measured ~520 KB/page at scale:2, JPEG 0.92
      // earnings cols widen the table slightly (~+10%), monthly grid adds ~0.5 pages worth
      const ROWS_PER_PDF_PAGE=28;
      const dataPages=Math.max(1,Math.ceil(count/ROWS_PER_PDF_PAGE));
      const perPageKB=incEarn?520:470;
      const monthlyKB=incMonthly?260:0; // monthly summary grid is roughly half a page
      const pdfKB=Math.max(200,(dataPages+1)*perPageKB+monthlyKB);
      const fromY=parseInt(_from.split('-')[0]),fromMo=parseInt(_from.split('-')[1]);
      const toY=parseInt(_to.split('-')[0]),toMo=parseInt(_to.split('-')[1]);
      const monthSpan=(toY-fromY)*12+(toMo-fromMo)+1;
      const elRec=card.querySelector('#sexp-kpi-records');
      const elMonths=card.querySelector('#sexp-kpi-months');
      const elSize=card.querySelector('#sexp-kpi-size');
      if(elRec)    elRec.textContent=count.toLocaleString();
      if(elMonths) elMonths.textContent=monthSpan;
      if(elSize)   elSize.textContent=fmtSz(_expFormat==='pdf'?pdfKB:csvKB);
      if(doExportBtn&&!_exporting) doExportBtn.disabled=count===0;
    }

    // ── Format toggle ──────────────────────────────────────────────────────────────────────────────
    function setFormat(fmt){
      _expFormat=fmt;
      localStorage.setItem('wt4_exp_format',fmt);
      csvTile?.classList.toggle('sexp-tile--active',fmt==='csv');
      pdfTile?.classList.toggle('sexp-tile--active',fmt==='pdf');
      if(radioCsv) radioCsv.classList.toggle('sexp-tile-radio--on',fmt==='csv');
      if(radioPdf) radioPdf.classList.toggle('sexp-tile-radio--on',fmt==='pdf');
      refreshExpSummary();
    }
    setFormat(_expFormat);
    csvTile?.addEventListener('click',()=>setFormat('csv'));
    pdfTile?.addEventListener('click',()=>setFormat('pdf'));

    // ── Pill toggles ──────────────────────────────────────────────────────────────────────────────
    card.querySelectorAll('.sexp-pill').forEach(btn=>{
      btn.addEventListener('click',()=>{btn.classList.toggle('sexp-pill--on');refreshExpSummary();});
    });

    // ── Range validation ──────────────────────────────────────────────────────────────────────────────
    const errEl=document.getElementById('exp-range-err');
    function validateRange(){
      const valid=_from<=_to;
      if(errEl) errEl.style.display=valid?'none':'block';
      return valid;
    }

    // ── Desktop: month dropdowns (from / to) ────────────────────────────────────────────────────────
    function refreshMonthDrop(role,ym){
      const valEl2=card.querySelector(`#sexp-${role}-val`);
      const menu2 =card.querySelector(`#sexp-${role}-menu`);
      if(!valEl2||!menu2)return;
      const checkSVGd=`<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      valEl2.textContent=ymLabel(ym);
      menu2.querySelectorAll('.sexp-month-opt').forEach(li=>{
        const isActive=li.dataset.ym===ym;
        li.classList.toggle('asm-sort-opt--active',isActive);
        const ex=li.querySelector('.asm-sort-check');
        if(isActive&&!ex) li.insertAdjacentHTML('beforeend',checkSVGd);
        if(!isActive&&ex) ex.remove();
      });
    }
    // ── Shared: close all desktop dropdowns ──────────────────────────────────────────────────────────────
    const _allDropIds=[
      {menu:'#sexp-from-menu', trigger:'#sexp-from-trigger'},
      {menu:'#sexp-to-menu',   trigger:'#sexp-to-trigger'},
      {menu:'#sexp-lang-menu', trigger:'#sexp-lang-trigger'},
    ];
    function closeAllDropdowns(){
      _allDropIds.forEach(({menu:mSel,trigger:tSel})=>{
        card.querySelector(mSel)?.classList.remove('asm-sort-menu--open');
        card.querySelector(tSel)?.setAttribute('aria-expanded','false');
      });
    }

        function wireMonthDrop(role){
      const trigger=card.querySelector(`#sexp-${role}-trigger`);
      const menu   =card.querySelector(`#sexp-${role}-menu`);
      if(!trigger||!menu)return;
      const otherRole=role==='from'?'to':'from';
      function close(){menu.classList.remove('asm-sort-menu--open');trigger.setAttribute('aria-expanded','false');}
      function closeOther(){
        const otherMenu=card.querySelector(`#sexp-${otherRole}-menu`);
        const otherTrigger=card.querySelector(`#sexp-${otherRole}-trigger`);
        otherMenu?.classList.remove('asm-sort-menu--open');
        otherTrigger?.setAttribute('aria-expanded','false');
      }
      function open() {closeAllDropdowns();menu.classList.add('asm-sort-menu--open');trigger.setAttribute('aria-expanded','true');}
      trigger.addEventListener('click',e=>{e.stopPropagation();menu.classList.contains('asm-sort-menu--open')?close():open();});
      menu.querySelectorAll('.sexp-month-opt').forEach(li=>{
        li.addEventListener('click',e=>{
          e.stopPropagation();
          const chosen=li.dataset.ym;
          close();
          if(role==='from'){_from=chosen;if(_from>_to){_to=_from;refreshMonthDrop('to',_to);}}
          else{_to=chosen;if(_to<_from){_from=_to;refreshMonthDrop('from',_from);}}
          refreshMonthDrop(role,chosen);
          card.querySelectorAll('.exp-preset').forEach(b=>b.classList.remove('exp-preset--active'));
          validateRange();refreshExpSummary();refreshDrLabel();
        });
      });
      document.addEventListener('click',()=>close());
    }
    wireMonthDrop('from');
    wireMonthDrop('to');

    // ── Desktop: preset pills ─────────────────────────────────────────────────────────────────────────────────
    card.querySelectorAll('.exp-preset').forEach(btn=>{
      btn.addEventListener('click',()=>{
        _from=btn.dataset.from;_to=btn.dataset.to;
        refreshMonthDrop('from',_from);refreshMonthDrop('to',_to);
        if(errEl) errEl.style.display='none';
        card.querySelectorAll('.exp-preset').forEach(b=>b.classList.remove('exp-preset--active'));
        btn.classList.add('exp-preset--active');
        refreshDrLabel();refreshExpSummary();
      });
    });

    // ── Language dropdown (desktop) ────────────────────────────────────────────────────────────────────────────
    function wireLangDrop(triggerId,menuId,valId,optClass){
      const trigger=card.querySelector(triggerId);
      const menu   =card.querySelector(menuId);
      const valEl  =card.querySelector(valId);
      if(!trigger||!menu)return;
      const checkSVG2=`<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      function close(){menu.classList.remove('asm-sort-menu--open');trigger.setAttribute('aria-expanded','false');}
      trigger.addEventListener('click',e=>{e.stopPropagation();menu.classList.contains('asm-sort-menu--open')?close():(closeAllDropdowns(),menu.classList.add('asm-sort-menu--open'),trigger.setAttribute('aria-expanded','true'));});
      document.addEventListener('click',()=>close());
      menu.querySelectorAll(optClass).forEach(li=>{
        li.addEventListener('click',e=>{
          e.stopPropagation();
          _lang=li.dataset.lang;
          if(valEl) valEl.textContent=li.textContent.trim().replace(/[✓✔]/g,'').trim();
          menu.querySelectorAll(optClass).forEach(o=>{
            const isActive=o.dataset.lang===_lang;
            o.classList.toggle('asm-sort-opt--active',isActive);
            const ex=o.querySelector('.asm-sort-check');
            if(isActive&&!ex) o.insertAdjacentHTML('beforeend',checkSVG2);
            if(!isActive&&ex) ex.remove();
          });
          close();
        });
      });
    }
    wireLangDrop('#sexp-lang-trigger','#sexp-lang-menu','#sexp-lang-val','.sexp-lang-opt');
    wireLangDrop('#sexp-lang-trigger-mob','#sexp-lang-menu-mob','#sexp-lang-val-mob','.sexp-lang-opt-mob');

    // ── Bottom-sheet wiring ─────────────────────────────────────────────────────────────────────────────
    // Move overlay to body so position:fixed covers the full viewport
    const staleOverlay=document.body.querySelector(':scope > #sexp-bs-overlay');
    if(staleOverlay) staleOverlay.remove();
    const bsOverlay=card.querySelector('#sexp-bs-overlay');
    if(bsOverlay) document.body.appendChild(bsOverlay);
    const bs       =document.getElementById('sexp-bs');
    const viewPresets=document.getElementById('sexp-bs-view-presets');
    const viewCustom =document.getElementById('sexp-bs-view-custom');
    let _custFrom=_from;
    let _custTo  =_to;

    function openBS(){
      if(!bsOverlay)return;
      bsOverlay.removeAttribute('hidden');
      requestAnimationFrame(()=>{requestAnimationFrame(()=>{
        bs?.classList.add('sexp-bs--open');
        bsOverlay?.classList.add('sexp-bs-overlay--open');
      });});
      document.body.style.overflow='hidden';
      showPresetView();
    }

    function closeBS(){
      bs?.classList.remove('sexp-bs--open');
      bsOverlay?.classList.remove('sexp-bs-overlay--open');
      document.body.style.overflow='';
      setTimeout(()=>bsOverlay?.setAttribute('hidden',''),300);
    }

    // ── Drag-to-dismiss on handle ───────────────────────────────────────────────────────────
    (function wireDragDismiss(){
      const handle=document.querySelector('.sexp-bs-handle');
      if(!handle||!bs)return;
      let startY=0, currentY=0, dragging=false;
      const DISMISS_THRESHOLD=80; // px down to trigger close

      function onStart(e){
        dragging=true;
        startY=e.touches?e.touches[0].clientY:e.clientY;
        currentY=0;
        // Disable transition while dragging so sheet follows finger exactly
        bs.style.transition='none';
      }

      function onMove(e){
        if(!dragging)return;
        e.preventDefault(); // prevent page scroll while dragging handle
        const y=(e.touches?e.touches[0].clientY:e.clientY)-startY;
        if(y<0)return; // don't allow dragging up
        currentY=y;
        bs.style.transform=`translateY(${y}px)`;
        // Fade backdrop proportionally
        const progress=Math.min(y/(bs.offsetHeight*0.5),1);
        const backdrop=document.getElementById('sexp-bs-backdrop');
        if(backdrop) backdrop.style.background=`rgba(0,0,0,${0.55*(1-progress)})`;
      }

      function onEnd(){
        if(!dragging)return;
        dragging=false;
        bs.style.transition=''; // restore CSS transition
        if(currentY>=DISMISS_THRESHOLD){
          // Snap closed
          bs.style.transform='';
          const backdrop=document.getElementById('sexp-bs-backdrop');
          if(backdrop) backdrop.style.background='';
          closeBS();
        }else{
          // Snap back open
          bs.style.transform='';
          const backdrop=document.getElementById('sexp-bs-backdrop');
          if(backdrop) backdrop.style.background='';
        }
      }

      handle.addEventListener('touchstart',onStart,{passive:false});
      document.addEventListener('touchmove',onMove,{passive:false});
      document.addEventListener('touchend',onEnd);
      // Mouse fallback for desktop testing
      handle.addEventListener('mousedown',onStart);
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onEnd);
    })();

    function showPresetView(){
      viewPresets?.classList.remove('sexp-bs-view--hidden');
      viewCustom?.classList.add('sexp-bs-view--hidden');
    }

    function showCustomView(){
      viewPresets?.classList.add('sexp-bs-view--hidden');
      viewCustom?.classList.remove('sexp-bs-view--hidden');
      _custFrom=_from;_custTo=_to;
      refreshCustomDates();refreshCustomLists();
    }

    function refreshCustomDates(){
      const fromEl=document.getElementById('sexp-cust-from-val');
      const toEl  =document.getElementById('sexp-cust-to-val');
      if(fromEl) fromEl.textContent=ymLabel(_custFrom);
      if(toEl)   toEl.textContent  =ymLabel(_custTo);
    }

    function refreshCustomLists(){
      const checkSVG=`<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      ['from','to'].forEach(role=>{
        const selYm=role==='from'?_custFrom:_custTo;
        const list=document.getElementById(`sexp-cust-${role}-list`);
        if(!list)return;
        list.querySelectorAll('.sexp-month-opt').forEach(li=>{
          const isActive=li.dataset.ym===selYm;
          li.classList.toggle('asm-sort-opt--active',isActive);
          const ex=li.querySelector('.asm-sort-check');
          if(isActive&&!ex) li.insertAdjacentHTML('beforeend',checkSVG);
          if(!isActive&&ex) ex.remove();
        });
        const activeEl=list.querySelector('.asm-sort-opt--active');
        if(activeEl) activeEl.scrollIntoView({block:'nearest'});
      });
    }

    card.querySelector('#sexp-dr-trigger')?.addEventListener('click',()=>openBS());
    document.getElementById('sexp-bs-close')?.addEventListener('click',()=>closeBS());
    document.getElementById('sexp-bs-close2')?.addEventListener('click',()=>closeBS());
    document.getElementById('sexp-bs-backdrop')?.addEventListener('click',()=>closeBS());
    document.getElementById('sexp-bs-back')?.addEventListener('click',()=>showPresetView());

    document.querySelectorAll('.sexp-bs-preset').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const key=btn.dataset.key;
        if(key==='custom'){showCustomView();return;}
        _from=btn.dataset.from;
        _to  =btn.dataset.to;
        document.querySelectorAll('.sexp-bs-preset').forEach(b=>b.classList.remove('sexp-bs-preset--active'));
        btn.classList.add('sexp-bs-preset--active');
        refreshDrLabel();validateRange();refreshExpSummary();
        setTimeout(()=>closeBS(),180);
      });
    });

    ['from','to'].forEach(role=>{
      const list=document.getElementById(`sexp-cust-${role}-list`);
      if(!list)return;
      list.querySelectorAll('.sexp-month-opt').forEach(li=>{
        li.addEventListener('click',()=>{
          const chosen=li.dataset.ym;
          if(role==='from'){_custFrom=chosen;if(_custFrom>_custTo)_custTo=_custFrom;}
          else{_custTo=chosen;if(_custTo<_custFrom)_custFrom=_custTo;}
          refreshCustomDates();refreshCustomLists();
        });
      });
    });

    document.getElementById('sexp-bs-apply')?.addEventListener('click',()=>{
      _from=_custFrom;_to=_custTo;
      document.querySelectorAll('.sexp-bs-preset').forEach(b=>b.classList.remove('sexp-bs-preset--active'));
      refreshDrLabel();validateRange();refreshExpSummary();closeBS();
    });

    document.getElementById('sexp-bs-clear')?.addEventListener('click',()=>{
      _custFrom=allMonths[0];_custTo=allMonths[allMonths.length-1];
      refreshCustomDates();refreshCustomLists();
    });

    // ── Error toast ─────────────────────────────────────────────────────────────────────────────────
    function showErrToast(msg){
      document.getElementById('exp-toast-err')?.remove();
      const el=document.createElement('div');
      el.id='exp-toast-err';
      el.style.cssText='position:fixed;bottom:24px;left:50%;transform:translate(-50%,12px);background:var(--danger-bg);border:1px solid var(--danger);color:var(--danger);padding:10px 16px;border-radius:12px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;z-index:9999;opacity:0;transition:opacity 0.2s,transform 0.2s;pointer-events:none;max-width:88vw;';
      el.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>${msg}</span>`;
      document.body.appendChild(el);
      requestAnimationFrame(()=>{el.style.opacity='1';el.style.transform='translate(-50%,0)';});
      setTimeout(()=>{el.style.opacity='0';setTimeout(()=>el.remove(),220);},3200);
    }

    // ── Unified export button ────────────────────────────────────────────────────────────────────────────
    const EXPORT_BTN_INNER=doExportBtn.innerHTML;
    doExportBtn.addEventListener('click',async()=>{
      if(_exporting)return;
      if(!validateRange())return;
      const opts={
        includeHol:     card.querySelector('#sexp-opt-hol')?.classList.contains('sexp-pill--on')!==false,
        includeEarnings:card.querySelector('#sexp-opt-earn')?.classList.contains('sexp-pill--on')!==false,
        includeMonthly: card.querySelector('#sexp-opt-monthly')?.classList.contains('sexp-pill--on')!==false,
      };
      if(_expFormat==='csv'){
        _exporting=true;doExportBtn.disabled=true;
        try{ exportCSV(_from,_to,opts); }
        catch(e){ console.warn('[export] CSV failed:',e); showErrToast(t('exportPDFError')||'Export failed. Please try again.'); }
        finally{ _exporting=false; doExportBtn.disabled=false; }
      }else{
        _exporting=true;doExportBtn.disabled=true;
        doExportBtn.innerHTML=`<svg class="exp-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-9-9"/></svg>${t('exportPDFGenerating')||'Generating PDF…'}`;
        try{ await exportPDF(_from,_to,_lang,opts); }
        catch(err){ console.warn('[export] PDF failed:',err); showErrToast(t('exportPDFError')||"Couldn't generate PDF. Check your connection and try again."); }
        finally{ _exporting=false; doExportBtn.disabled=false; doExportBtn.innerHTML=EXPORT_BTN_INNER; }
      }
    });

    // ── Initial render ──────────────────────────────────────────────────────────────────────────────────
    refreshMonthDrop('from',_from);
    refreshMonthDrop('to',_to);
    refreshDrLabel();
    refreshExpSummary();
  }
}
