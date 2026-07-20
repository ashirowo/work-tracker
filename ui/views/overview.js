// ─────────────────────────────────────────────────────────────────────────────
// ui/views/overview.js — the Overview tab (Phase 8d).
//
// buildOverview renders the data object computed by domain/projections.js
// (passed through ctx as `env` → computeOverviewData). This module owns the
// tab's full render surface: the live dashboard, the first-run empty state
// (buildOverviewEmpty + wireOverviewEmpty), the count-up / entrance
// choreography (initOverviewMotion family, module-local registries), both
// Chart.js renderers (chart handles module-local, Chart.js lazy-loaded from
// CDN), and the tab's listeners (wireOverview: range toggle, view-all,
// empty-state CTA). The S.chartRange clamp lives HERE (the compute layer must
// not mutate S). Bodies verbatim from app.js; day-log/all-shifts opens route
// through ctx openers (no modal imports). ctx members bind to module lets on
// each render/wire.
// ─────────────────────────────────────────────────────────────────────────────

import { pad, mkds, pd } from '../../core/dates.js';
import { entryHours, isZeroDay } from '../../domain/log-entries.js';
import { computeOverviewData } from '../../domain/projections.js';

// Bound from ctx on each render/wire:
let S, t, env, today, getLogs, shiftFor, applyTax, liveGross, autoGross,
    appFooter, switchTab, openDayModal, openAllShifts;
const bind = ctx => ({ S, t, env, today, getLogs, shiftFor, applyTax, liveGross,
    autoGross, appFooter, switchTab, openDayModal, openAllShifts } = ctx);

export function buildOverview(ctx){
  bind(ctx);
  const logs=getLogs(),todayStr=today();
  const allEntries=Object.entries(logs);
  if(!allEntries.length) return buildOverviewEmpty();

  // ── Aggregation + projection math — domain/projections.js (Phase 8c) ──────
  // The per-month aggregation, six-bucket projection, best-month/top-day and
  // stat-card derivations are computed by the domain layer; this view renders
  // the returned object. The S.chartRange clamp stays HERE — the compute layer
  // must not mutate S.
  const D=computeOverviewData(env,{nowDate:new Date(),todayStr,targetHrs:S.targetHrs});
  const {monthData,months,curYM,curData,curBaseNet,projection,projectionLow,projectionHigh,
    bestMonthYM,soleBestMonth,allTimeTopDay,target,hrsWorked,hrsRemaining,hrsProgress,
    avgPerDay,avgHrsPerDay,avgDeltaPct,bestMonthDeltaPct,bestMonthHrs,bestMonthDays,
    bestDayHrs,bestDayAbovePct}=D;
  const chartMonths=D.chart.months, chartValues=D.chart.values;

  const mnames=t('mn');
  function fmtYM(ym){ const[y,m]=ym.split('-'); return`${mnames[parseInt(m)-1]} ${y}`; }

  // Chart data comes from domain/projections.js (all months oldest→newest;
  // current month uses projection). Stored on a module-level var so
  // renderTrendChart() reads the same values without re-computing separately;
  // it slices based on S.chartRange ('3m' | '6m' | '1y').
  _trendChartData={months:chartMonths,values:chartValues,curYM,mnames};

  // Range toggle — only show options that have enough data to be meaningful
  const has6=chartMonths.length>3;
  const hasYear=chartMonths.length>6;
  const rangeOpts=[
    {k:'3m', label:t('chartRange3m')},
    ...(has6?[{k:'6m', label:t('chartRange6m')}]:[]),
    ...(hasYear?[{k:'1y', label:t('chartRange1y')}]:[]),
  ];
  // Clamp stored range if it's no longer valid for this data set
  if(!rangeOpts.find(o=>o.k===S.chartRange)) S.chartRange=rangeOpts[rangeOpts.length-1].k;

  // ── Recent Shifts (last 5 logged entries) ────────────────────────────────
  const allLogEntries=Object.entries(logs)
    .filter(([ds])=>ds<=todayStr)
    .sort((a,b)=>b[0].localeCompare(a[0]))
    .slice(0,5);
  const dn=t('dn');
  const recentHTML=allLogEntries.length?allLogEntries.map(([ds,l])=>{
    const sh=(l.shiftOverride)||shiftFor(ds);
    const shLabel=sh==='double'?`<i class="fa-solid fa-rotate"></i> ${t('doubleShift')}`:sh==='night'?`<i class="fa-solid fa-moon"></i> ${t('nightShift')}`:`<i class="fa-solid fa-sun"></i> ${t('dayShift')}`;
    const shCls=sh==='double'?'rs-shift--double':sh==='night'?'rs-shift--night':'rs-shift--day';
    const {reg,ot}=entryHours(l);
    const totalH=(sh==='double'?0:reg)+ot;
    const net=applyTax(liveGross(ds,logs));
    const isToday=ds===todayStr;
    return`<div class="rs-item">
      <div class="rs-left">
        ${isToday?`<span class="rs-today-badge">${t('todayBadge')}</span>`:''}
        <span class="rs-date">${t('mn')[parseInt(ds.slice(5,7))-1]} ${parseInt(ds.slice(8,10))}</span>
        <span class="rs-shift ${shCls}">${shLabel}</span>
      </div>
      <div class="rs-right">
        <span class="rs-hrs">${totalH>0?totalH+t('hoursUnit'):'0'+t('hoursUnit')}</span>
        <span class="rs-pay">₩${net.toLocaleString()}</span>
        <span class="rs-chevron"><i class="fa-solid fa-chevron-right"></i></span>
      </div>
    </div>`;
  }).join(''):`<div class="rs-empty">${t('ovNoData')}</div>`;


  // Mini ring SVG helper
  function miniRing(pct,color='#6c8eff'){
    const r=18,circ=2*Math.PI*r,dash=Math.round((Math.min(100,pct)/100)*circ);
    return`<svg viewBox="0 0 44 44" width="44" height="44" style="flex-shrink:0;transform:rotate(-90deg)">
      <circle cx="22" cy="22" r="18" fill="none" stroke="var(--ring-track)" stroke-width="4"/>
      <circle cx="22" cy="22" r="18" fill="none" stroke="${color}" stroke-width="4"
        stroke-dasharray="${dash} ${circ-dash}" stroke-linecap="round"/>
    </svg>`;
  }


  // Format an hours value the same way the rest of the Overview does: whole
  // numbers stay bare, fractional ones keep one decimal place.
  function fmtHrs(v){ return v%1?v.toFixed(1):Math.round(v); }

  // Small ▲/▼ delta chip, matching the projection card's idiom.
  function deltaChip(pct,suffix){
    if(pct==null||!isFinite(pct)) return '';
    const up=pct>=0, sign=up?'▲':'▼';
    return`<div class="ov-stat4-delta ov-stat4-delta--${up?'up':'down'}">${sign} ${Math.abs(pct).toFixed(0)}% ${suffix}</div>`;
  }

  // ── Entrance / count-up gating ──────────────────────────────────────────────
  // The choreographed entrance (hero → stat cards → bottom panels) plays EXACTLY
  // ONCE per app session — the first time the Overview is mounted. Switching to
  // Calendar and back must NOT replay it (the user has already seen the data
  // assemble; replaying reads as a glitch), so we latch a module-level flag the
  // first time we arm the entrance. Every later mount, in-place re-render (auth
  // resolving, theme toggle, a shift edited from the All-Shifts modal), and tab
  // return renders the cards already settled. Number motion for genuine data
  // CHANGES is still handled by initOverviewMotion(), which tweens old→new.
  const _reduceMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ovEnter=!_reduceMotion&&!_ovEntranceDone;
  if(ovEnter) _ovEntranceDone=true;
  // Signature of everything the count-ups display — initOverviewMotion() uses
  // it to tell "same data re-rendered" (snap, no motion) from "data changed".
  const ovSig=[curYM,projection,curData.net,curData.overtimeNet,curData.days,hrsWorked,hrsProgress,avgPerDay,
    bestMonthYM?monthData[bestMonthYM].net:0,allTimeTopDay?allTimeTopDay.net:0,hrsRemaining.toFixed(1)].join('|');

  // Animated-number span: renders the FINAL formatted value (so no-JS, reduced
  // motion, and prerender all read correctly) and stamps the numeric target +
  // formatting + start delay for initOverviewMotion() to drive. Delays are
  // matched to each card's CSS entrance delay so a value starts counting just
  // as its card lands — the dashboard assembles itself from live data instead
  // of numbers popping in fully formed.
  function ovNum(key,value,o){
    o=o||{};
    const dp=o.dp||0,pre=o.pre||'',suf=o.suf||'';
    const txt=pre+(dp?value.toFixed(dp):Math.round(value).toLocaleString())+suf;
    return`<span class="ov-num" data-k="${key}" data-t="${value}" data-dp="${dp}" data-pre="${pre}" data-suf="${suf}" data-delay="${o.delay||0}">${txt}</span>`;
  }

  // Whether only the current month has been logged. In that case the trend chart
  // keeps its exact layout but renders a "not enough history yet" state — one real
  // point trailing into ghosted future months — instead of a normal multi-month
  // line (see renderTrendChart). A caption over the empty region explains it.
  const soloTrend = chartMonths.length < 2;

  return`<div class="ov-wrap${ovEnter?' ov-enter':''}" data-ovsig="${ovSig}">

    <!-- Projected Earnings card — left KPI panel + right chart panel -->
    <div class="ov-proj-card">
      <!-- Left: KPI summary -->
      <div class="ov-proj-kpi">
        <div class="ov-proj-kpi-header">${t('ovEstTotal')} <span class="ov-proj-period">• ${fmtYM(curYM)}</span></div>
        <div class="ov-proj-value">${ovNum('proj',projection,{pre:'₩',delay:140})}</div>
        ${(()=>{
          const prevIdx=months.indexOf(curYM)-1;
          const prevNet=prevIdx>=0?monthData[months[prevIdx]].net:0;
          if(!prevNet) return '';
          const pct=((projection-prevNet)/prevNet*100);
          const sign=pct>=0?'▲':'▼';
          const cls=pct>=0?'ov-proj-delta--up':'ov-proj-delta--down';
          const prevLabel=fmtYM(months[prevIdx]);
          return`<div class="ov-proj-delta ${cls}">${sign} ${Math.abs(pct).toFixed(1)}% ${t('deltaFrom', prevLabel)}</div>`;
        })()}
        ${projectionHigh>projectionLow?`<div class="ov-proj-range">${t('ovEstRange',projectionLow,projectionHigh)}</div>`:''}
        <div class="ov-proj-stat-cards">
          <div class="ov-proj-stat">
            <div class="ov-proj-stat-icon ov-proj-stat-icon--base"><i class="fa-solid fa-shield-halved"></i></div>
            <div class="ov-proj-stat-body">
              <div class="ov-proj-stat-label">${t('ovBaseEarnings')}</div>
              <div class="ov-proj-stat-val">${ovNum('base',curBaseNet,{pre:'₩',delay:300})}</div>
            </div>
          </div>
          <div class="ov-proj-stat">
            <div class="ov-proj-stat-icon ov-proj-stat-icon--ot"><i class="fa-solid fa-gem"></i></div>
            <div class="ov-proj-stat-body">
              <div class="ov-proj-stat-label">${t('ovOvertimeDesc')}</div>
              <div class="ov-proj-stat-val">${ovNum('ot',curData.overtimeNet,{pre:'₩',delay:370})}</div>
            </div>
          </div>
        </div>
      </div>
      <!-- Right: chart panel — same component whatever the data volume -->
      <div class="ov-proj-chart-panel">
        <div class="ov-proj-chart-glow"></div>
        ${rangeOpts.length>1?`<div class="ov-chart-range ov-chart-range--floating">
          ${rangeOpts.map(o=>`<button class="ov-range-btn${S.chartRange===o.k?' ov-range-btn--active':''}" data-range="${o.k}">${o.label}</button>`).join('')}
        </div>`:''}
        <div class="ov-proj-chart-wrap${soloTrend?' ov-proj-chart-wrap--solo':''}">
          <canvas id="ov-trend-chart"></canvas>
        </div>
        ${soloTrend?`<div class="ov-chart-empty-note"><span class="ov-chart-empty-pill"><i class="fa-solid fa-arrow-trend-up"></i><span>${t('ovTrendLocked')}</span></span></div>`:''}
      </div>
    </div>

    <!-- 4 stat cards -->
    <div class="ov-stat4-row">

      <!-- Hours Worked (This Month) -->
      <div class="ov-stat4-card ov-stat4-card--blue">
        <div class="ov-stat4-header">
          <div class="ov-stat4-icon ov-stat4-icon--blue"><i class="fa-solid fa-clock"></i></div>
          <div class="ov-stat4-header-text">
            <span class="ov-stat4-label">${t('hoursWorked')}</span>
            <span class="ov-stat4-header-sub">${fmtYM(curYM)}</span>
          </div>
        </div>
        <div class="ov-stat4-hrs-row">
          <span class="ov-stat4-hrs-val">${ovNum('hrs',hrsWorked,{dp:hrsWorked%1?1:0,suf:t('hoursUnit'),delay:260})}</span>
          <span class="ov-stat4-hrs-target">/ ${target}${t('hoursUnit')}</span>
        </div>
        <div class="ov-stat4-bar-wrap">
          <div class="ov-stat4-bar-track">
            <div class="ov-stat4-bar-fill ov-stat4-bar-fill--blue" data-ov-bar="hrs" data-t="${hrsProgress}" data-delay="320" style="width:${hrsProgress}%"></div>
          </div>
          <span class="ov-stat4-bar-pct">${ovNum('pct',hrsProgress,{suf:'%',delay:320})}</span>
        </div>
        <div class="ov-stat4-foot">
          <div class="ov-stat4-secondary">${t('dayCount', curData.days)}</div>
          ${hrsRemaining>0?`<div class="ov-stat4-secondary ov-stat4-secondary--accent">${hrsRemaining.toFixed(0)}${t('hoursUnit')} ${t('remainingLabel').toLowerCase()}</div>`:''}
        </div>
      </div>

      <!-- Avg Per Day -->
      <div class="ov-stat4-card ov-stat4-card--purple">
        <div class="ov-stat4-header">
          <div class="ov-stat4-icon ov-stat4-icon--purple"><i class="fa-solid fa-chart-line"></i></div>
          <div class="ov-stat4-header-text">
            <span class="ov-stat4-label">${t('ovAvgPerDay')}</span>
            <span class="ov-stat4-header-sub">${fmtYM(curYM)}</span>
          </div>
        </div>
        <div class="ov-stat4-val ov-stat4-val--white">${ovNum('avg',avgPerDay,{pre:'₩',delay:330})}</div>
        <div class="ov-stat4-foot ov-stat4-foot--stack">
          <div class="ov-stat4-secondary">${avgHrsPerDay}${t('hoursUnit')} ${t('hoursWorked').toLowerCase()}</div>
          ${deltaChip(avgDeltaPct,t('ovVsLastMonth'))}
        </div>
      </div>

      <!-- Best Month -->
      <div class="ov-stat4-card${bestMonthYM?'':' ov-stat4-card--empty'} ov-stat4-card--gold">
        <div class="ov-stat4-header">
          <div class="ov-stat4-icon ov-stat4-icon--gold"><i class="fa-solid fa-trophy"></i></div>
          <div class="ov-stat4-header-text">
            <span class="ov-stat4-label">${t('ovBestMonth')}</span>
            <span class="ov-stat4-header-sub">${bestMonthYM?fmtYM(bestMonthYM):'—'}</span>
          </div>
        </div>
        <div class="ov-stat4-val ov-stat4-val--gold">${bestMonthYM?ovNum('bestm',monthData[bestMonthYM].net,{pre:'₩',delay:400}):'—'}</div>
        ${bestMonthYM?`<div class="ov-stat4-foot ov-stat4-foot--stack">
          ${bestMonthHrs!=null?`<div class="ov-stat4-secondary">${fmtHrs(bestMonthHrs)}${t('hoursUnit')} ${t('ovHoursWorkedShort')}</div>`:''}
          ${bestMonthDays!=null?`<div class="ov-stat4-secondary">${t('dayCount',bestMonthDays)}</div>`:''}
          ${
            soleBestMonth
              ? `<div class="ov-stat4-badge ov-stat4-badge--gold"><i class="fa-solid fa-crown"></i> ${t('ovSoleMonth')}</div>`
              : bestMonthDeltaPct!=null
                ? deltaChip(bestMonthDeltaPct,t('ovVsPrevBest'))
                : `<div class="ov-stat4-secondary">${t('ovVsPrevBest')}</div>`
          }
        </div>`:''}
      </div>

      <!-- Best Single Day -->
      <div class="ov-stat4-card${allTimeTopDay?'':' ov-stat4-card--empty'} ov-stat4-card--teal">
        <div class="ov-stat4-header">
          <div class="ov-stat4-icon ov-stat4-icon--teal"><i class="fa-solid fa-gem"></i></div>
          <div class="ov-stat4-header-text">
            <span class="ov-stat4-label">${t('ovHighestDay')}</span>
            <span class="ov-stat4-header-sub">${allTimeTopDay?allTimeTopDay.ds:'—'}</span>
          </div>
        </div>
        <div class="ov-stat4-val ov-stat4-val--teal">${allTimeTopDay?ovNum('bestd',allTimeTopDay.net,{pre:'₩',delay:470}):'—'}</div>
        ${allTimeTopDay?`<div class="ov-stat4-foot ov-stat4-foot--stack">
          ${bestDayHrs!=null?`<div class="ov-stat4-secondary">${bestDayHrs}${t('hoursUnit')} ${t('ovHoursWorkedShort')}</div>`:''}
          ${bestDayAbovePct!=null?deltaChip(bestDayAbovePct,t('ovAboveAvg')):''}
        </div>`:''}
      </div>

    </div>

    <!-- Recent Shifts + Monthly Breakdown -->
    <div class="ov-bottom-row">
      <!-- Recent Shifts -->
      <div class="ov-panel card">
        <div class="ov-panel-hdr">
          <div class="ov-panel-title">${t('recentShifts')}</div>
          ${allLogEntries.length?`<a class="ov-view-all-link" id="rs-view-all" href="javascript:void(0)" role="button">${t('viewAll')}</a>`:''}
        </div>
        <div class="rs-list">${recentHTML}</div>
      </div>

      <!-- Daily Breakdown -->
      <div class="ov-panel card">
        <div class="ov-panel-title">${t('monthlyBreakdown')||'DAILY BREAKDOWN'} · ${fmtYM(curYM)}</div>
        <div class="tm-chart-wrap">
          <canvas id="ov-month-bar-chart" height="180"></canvas>
        </div>
        <div class="ov-breakdown-footer">
          <div class="ov-breakdown-stat">
            <span class="ov-breakdown-stat-label">${t('hoursWorked')}</span>
            <span class="ov-breakdown-stat-val">${ovNum('fhrs',hrsWorked,{dp:hrsWorked%1?1:0,suf:t('hoursUnit'),delay:640})}</span>
          </div>
          <div class="ov-breakdown-stat">
            <span class="ov-breakdown-stat-label">${t('targetHours')}</span>
            <span class="ov-breakdown-stat-val">${target}${t('hoursUnit')}</span>
          </div>
          <div class="ov-breakdown-stat">
            <span class="ov-breakdown-stat-label">${t('daysWorkedLabel')}</span>
            <span class="ov-breakdown-stat-val">${t('dayCount', curData.days)}</span>
          </div>
          <div class="ov-breakdown-stat">
            <span class="ov-breakdown-stat-label">${t('remainingLabel')}</span>
            <span class="ov-breakdown-stat-val ov-breakdown-stat-val--blue">${ovNum('frem',hrsRemaining,{dp:1,suf:t('hoursUnit'),delay:700})}</span>
          </div>
        </div>
      </div>
    </div>

  </div>
  ${appFooter()}`;
  // Charts rendered after DOM injection — see renderTrendChart() called from wireOverview
}

// ── Overview EMPTY STATE — the real dashboard, waiting for data ──────────────
// Shown to brand-new users with zero logged days. It renders the FIRST viewport
// of the real Overview (reusing the exact ov-* card classes) as a ghosted, inert
// skeleton — reduced opacity, desaturated, softly blurred, with shimmering
// skeleton loaders where figures will land. The stage is height-capped and
// fades out at the bottom, implying more analytics unlock below the fold. A
// lightweight hero (headline + CTA, no card/badge/scrim) floats over it so the
// dashboard, not a modal, stays the focus. When the first shift is logged the
// live buildOverview() renders the identical shell — it simply fills in.
// The root deliberately avoids the `.ov-wrap` class so initOverviewMotion()
// no-ops, and includes no <canvas> so the chart renderers no-op too.
// (Hero copy lives in translations.js — ovbTitle/ovbSub/ovbCta; every DASHBOARD
// label below is pulled from the SAME t() keys the live Overview uses, so this
// reads as the real dashboard waiting for data, not a preview.)
function buildOverviewEmpty(){
  const hu=t('hoursUnit');
  // Skeleton value — a shimmering placeholder where a real figure will land.
  // Reads as "loading / waiting for data", not fake data. Labels and structure
  // around it stay intact so every card is instantly recognizable.
  const sk=(w,h)=>`<span class="ovb-sk" style="width:${w};height:${h}"></span>`;

  // Month labels for the sample period, pulled from the live month names so the
  // replica's card subheaders match what the real Overview would show.
  const mn=t('mn')||[];
  const _now=new Date();
  const sampleMonth=`${mn[_now.getMonth()]||''} ${_now.getFullYear()}`;
  const _prev=new Date(_now.getFullYear(),_now.getMonth()-1,1);
  const prevMonth=`${mn[_prev.getMonth()]||''} ${_prev.getFullYear()}`;
  const _best=new Date(_now.getFullYear(),_now.getMonth()-2,1);
  const bestMonth=`${mn[_best.getMonth()]||''} ${_best.getFullYear()}`;

  // Sample "best single day" date, shown raw like the live card does.
  const _bd=pd(today()); _bd.setDate(_bd.getDate()-9);
  const bestDayDs=mkds(_bd.getFullYear(),_bd.getMonth(),_bd.getDate());

  // ── Recent-shift placeholders — real rs-item markup, dates relative to today ──
  const shiftMeta={
    day:{cls:'rs-shift--day',label:`<i class="fa-solid fa-sun"></i> ${t('dayShift')}`},
    night:{cls:'rs-shift--night',label:`<i class="fa-solid fa-moon"></i> ${t('nightShift')}`},
    double:{cls:'rs-shift--double',label:`<i class="fa-solid fa-rotate"></i> ${t('doubleShift')}`},
  };
  const sampleShifts=[
    {off:0,sh:'night',h:9,today:true},
    {off:1,sh:'day',h:8},
    {off:3,sh:'day',h:8.5},
    {off:5,sh:'double',h:16},
    {off:6,sh:'night',h:9},
  ];
  const recentHTML=sampleShifts.map(s=>{
    const d=pd(today()); d.setDate(d.getDate()-s.off);
    const label=`${mn[d.getMonth()]||''} ${d.getDate()}`;
    const m=shiftMeta[s.sh];
    return`<div class="rs-item">
      <div class="rs-left">
        ${s.today?`<span class="rs-today-badge">${t('todayBadge')}</span>`:''}
        <span class="rs-date">${label}</span>
        <span class="rs-shift ${m.cls}">${m.label}</span>
      </div>
      <div class="rs-right">
        <span class="rs-hrs">${s.h}${hu}</span>
        <span class="rs-pay">${sk('58px','13px')}</span>
      </div>
    </div>`;
  }).join('');

  // Monthly-breakdown skeleton bars (no <canvas>, so renderMonthBarChart no-ops).
  const skelBars=[42,68,54,88,72,96,60].map(h=>`<span class="ovb-skel-bar" style="height:${h}%"></span>`).join('');

  // NOTE: the stage deliberately does NOT use the .ov-wrap class and includes no
  // <canvas>, so initOverviewMotion() / renderTrendChart() / renderMonthBarChart()
  // all no-op — nothing here animates counters or instantiates Chart.js.
  return`<div class="ov-onboard" id="ov-onboard">
    <div class="ovb-stage-wrap">

      <!-- Locked replica of the REAL Overview: identical ov-* cards & layout -->
      <div class="ovb-stage" aria-hidden="true">

        <!-- Projected Earnings — same left-KPI + right-chart split -->
        <div class="ov-proj-card">
          <div class="ov-proj-kpi">
            <div class="ov-proj-kpi-header">${t('ovEstTotal')} <span class="ov-proj-period">• ${sampleMonth}</span></div>
            <div class="ov-proj-value">${sk('152px','30px')}</div>
            <div class="ov-proj-delta ov-proj-delta--up">${sk('118px','13px')}</div>
            <div class="ov-proj-stat-cards">
              <div class="ov-proj-stat">
                <div class="ov-proj-stat-icon ov-proj-stat-icon--base"><i class="fa-solid fa-shield-halved"></i></div>
                <div class="ov-proj-stat-body">
                  <div class="ov-proj-stat-label">${t('ovBaseEarnings')}</div>
                  <div class="ov-proj-stat-val">${sk('90px','15px')}</div>
                </div>
              </div>
              <div class="ov-proj-stat">
                <div class="ov-proj-stat-icon ov-proj-stat-icon--ot"><i class="fa-solid fa-gem"></i></div>
                <div class="ov-proj-stat-body">
                  <div class="ov-proj-stat-label">${t('ovOvertimeDesc')}</div>
                  <div class="ov-proj-stat-val">${sk('74px','15px')}</div>
                </div>
              </div>
            </div>
          </div>
          <div class="ov-proj-chart-panel ovb-chart">
            <div class="ov-chart-range ov-chart-range--floating">
              <span class="ov-range-btn ov-range-btn--active">${t('chartRange3m')}</span>
              <span class="ov-range-btn">${t('chartRange6m')}</span>
              <span class="ov-range-btn">${t('chartRange1y')}</span>
            </div>
            <svg class="ovb-chart-svg" viewBox="0 0 300 150" preserveAspectRatio="none">
              <defs>
                <linearGradient id="ovbArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.24"/>
                  <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <line x1="0" y1="112" x2="300" y2="112" stroke="var(--border)" stroke-width="1"/>
              <line x1="0" y1="74" x2="300" y2="74" stroke="var(--border)" stroke-width="1"/>
              <line x1="0" y1="36" x2="300" y2="36" stroke="var(--border)" stroke-width="1"/>
              <path d="M0,118 C36,104 60,110 96,80 C130,52 156,66 190,44 C222,24 256,34 300,16 L300,150 L0,150 Z" fill="url(#ovbArea)"/>
              <path d="M0,118 C36,104 60,110 96,80 C130,52 156,66 190,44 C222,24 256,34 300,16" fill="none" stroke="var(--primary)" stroke-width="2.4" stroke-linecap="round" stroke-opacity="0.55"/>
              <circle cx="300" cy="16" r="3.5" fill="var(--primary)" fill-opacity="0.6"/>
            </svg>
          </div>
        </div>

        <!-- 4 stat cards — identical to the live Overview -->
        <div class="ov-stat4-row">

          <!-- Hours Worked -->
          <div class="ov-stat4-card ov-stat4-card--blue">
            <div class="ov-stat4-header">
              <div class="ov-stat4-icon ov-stat4-icon--blue"><i class="fa-solid fa-clock"></i></div>
              <div class="ov-stat4-header-text">
                <span class="ov-stat4-label">${t('hoursWorked')}</span>
                <span class="ov-stat4-header-sub">${sampleMonth}</span>
              </div>
            </div>
            <div class="ov-stat4-hrs-row">
              <span class="ov-stat4-hrs-val">${sk('76px','20px')}</span>
              <span class="ov-stat4-hrs-target">/ 250${hu}</span>
            </div>
            <div class="ov-stat4-bar-wrap">
              <div class="ov-stat4-bar-track"><div class="ov-stat4-bar-fill ov-stat4-bar-fill--blue" style="width:57%"></div></div>
              <span class="ov-stat4-bar-pct">57%</span>
            </div>
            <div class="ov-stat4-foot">
              <div class="ov-stat4-secondary">${t('dayCount',18)}</div>
              <div class="ov-stat4-secondary ov-stat4-secondary--accent">108${hu} ${t('remainingLabel').toLowerCase()}</div>
            </div>
          </div>

          <!-- Avg Per Day -->
          <div class="ov-stat4-card ov-stat4-card--purple">
            <div class="ov-stat4-header">
              <div class="ov-stat4-icon ov-stat4-icon--purple"><i class="fa-solid fa-chart-line"></i></div>
              <div class="ov-stat4-header-text">
                <span class="ov-stat4-label">${t('ovAvgPerDay')}</span>
                <span class="ov-stat4-header-sub">${sampleMonth}</span>
              </div>
            </div>
            <div class="ov-stat4-val ov-stat4-val--white">${sk('96px','22px')}</div>
            <div class="ov-stat4-foot ov-stat4-foot--stack">
              <div class="ov-stat4-secondary">7.9${hu} ${t('hoursWorked').toLowerCase()}</div>
              <div class="ov-stat4-delta ov-stat4-delta--up">▲ 6% ${t('ovVsLastMonth')}</div>
            </div>
          </div>

          <!-- Best Month -->
          <div class="ov-stat4-card ov-stat4-card--gold">
            <div class="ov-stat4-header">
              <div class="ov-stat4-icon ov-stat4-icon--gold"><i class="fa-solid fa-trophy"></i></div>
              <div class="ov-stat4-header-text">
                <span class="ov-stat4-label">${t('ovBestMonth')}</span>
                <span class="ov-stat4-header-sub">${bestMonth}</span>
              </div>
            </div>
            <div class="ov-stat4-val ov-stat4-val--gold">${sk('104px','22px')}</div>
            <div class="ov-stat4-foot ov-stat4-foot--stack">
              <div class="ov-stat4-secondary">168${hu} ${t('ovHoursWorkedShort')}</div>
              <div class="ov-stat4-secondary">${t('dayCount',21)}</div>
              <div class="ov-stat4-delta ov-stat4-delta--up">▲ 12% ${t('ovVsPrevBest')}</div>
            </div>
          </div>

          <!-- Best Single Day -->
          <div class="ov-stat4-card ov-stat4-card--teal">
            <div class="ov-stat4-header">
              <div class="ov-stat4-icon ov-stat4-icon--teal"><i class="fa-solid fa-gem"></i></div>
              <div class="ov-stat4-header-text">
                <span class="ov-stat4-label">${t('ovHighestDay')}</span>
                <span class="ov-stat4-header-sub">${bestDayDs}</span>
              </div>
            </div>
            <div class="ov-stat4-val ov-stat4-val--teal">${sk('92px','22px')}</div>
            <div class="ov-stat4-foot ov-stat4-foot--stack">
              <div class="ov-stat4-secondary">13.5${hu} ${t('ovHoursWorkedShort')}</div>
              <div class="ov-stat4-delta ov-stat4-delta--up">▲ 64% ${t('ovAboveAvg')}</div>
            </div>
          </div>

        </div>

        <!-- Recent Shifts + Monthly Breakdown — same bottom row as the live view -->
        <div class="ov-bottom-row">
          <div class="ov-panel card">
            <div class="ov-panel-hdr">
              <div class="ov-panel-title">${t('recentShifts')}</div>
              <span class="ov-view-all-link">${t('viewAll')}</span>
            </div>
            <div class="rs-list">${recentHTML}</div>
          </div>
          <div class="ov-panel card">
            <div class="ov-panel-title">${t('monthlyBreakdown')||'DAILY BREAKDOWN'} · ${t('mn')[new Date().getMonth()]} ${new Date().getFullYear()}</div>
            <div class="tm-chart-wrap"><div class="ovb-skel-bars">${skelBars}</div></div>
            <div class="ov-breakdown-footer">
              <div class="ov-breakdown-stat">
                <span class="ov-breakdown-stat-label">${t('hoursWorked')}</span>
                <span class="ov-breakdown-stat-val">${sk('56px','16px')}</span>
              </div>
              <div class="ov-breakdown-stat">
                <span class="ov-breakdown-stat-label">${t('targetHours')}</span>
                <span class="ov-breakdown-stat-val">250${hu}</span>
              </div>
              <div class="ov-breakdown-stat">
                <span class="ov-breakdown-stat-label">${t('daysWorkedLabel')}</span>
                <span class="ov-breakdown-stat-val">${t('dayCount',18)}</span>
              </div>
              <div class="ov-breakdown-stat">
                <span class="ov-breakdown-stat-label">${t('remainingLabel')}</span>
                <span class="ov-breakdown-stat-val ov-breakdown-stat-val--blue">${sk('56px','16px')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Lightweight hero — no card chrome, no badge, no scrim. It sits within
         the page over the ghosted dashboard; the dashboard stays the star. -->
    <div class="ovb-hero">
      <h2 class="ovb-title">${t('ovbTitle')}</h2>
      <p class="ovb-sub">${t('ovbSub')}</p>
      <button class="ovb-cta" id="ov-onboard-cta">
        <span class="ovb-cta-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
        <span>${t('ovbCta')}</span>
        <svg class="ovb-cta-arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  </div>`;
}

// Wire the first-run Overview hero: the primary CTA opens today's log entry,
// routing through the Calendar so closing the modal lands on a usable view.
function wireOverviewEmpty(){
  const root=document.getElementById('ov-onboard');
  if(!root) return;
  document.getElementById('ov-onboard-cta')?.addEventListener('click',()=>{
    switchTab('calendar');
    const ds=today();
    openDayModal(ds);
  });
}

// ── Overview number choreography ─────────────────────────────────────────────
// Drives every .ov-num count-up and [data-ov-bar] sweep on the Overview tab,
// using the same critically-damped spring as the header hero (animateStatsHero)
// so all motion in the app shares one physical character.
//
// Two situations, distinguished by the .ov-enter class buildOverview() stamps
// once per session:
//
//   FIRST-LOAD ENTRANCE (.ov-enter present) — cards and their numbers reveal as
//     they SCROLL INTO VIEW. An IntersectionObserver watches every card; when
//     one crosses into the viewport it gets .ov-in (triggering the CSS rise)
//     and its numbers begin counting. On desktop the whole dashboard is usually
//     on screen at once, so everything fires together in the staggered order;
//     on mobile the bottom panels wait until the user scrolls to them. Plays
//     ONlY this once — see _ovEntranceDone.
//
//   DATA CHANGE (no .ov-enter, signature differs) — a value changed while the
//     tab was already settled (logged a shift, tweaked tax). Numbers tween from
//     the previously shown figure straight to the new one; no reveal, no scroll
//     gating. Unchanged signature = redundant re-render → snap, no motion.
let _ovEntranceDone=false;   // latched true after the one session entrance
let _ovPrevNums={};          // key → last shown value, so data-change tweens old→new
let _ovAnimSig=null;         // signature last committed to screen
let _ovRAF=0;                // active count-up loop handle
let _ovIO=null;              // IntersectionObserver for scroll reveal
const _ovSpring=x=>{ if(x>=1)return 1; const l=5.5; return 1-Math.exp(-l*x)*(1+l*x); };
const OV_DUR=950;

// Count up a set of {el,target,from,dp,pre,suf,delay,kind} items on one shared
// rAF clock. Returns nothing; cancels any previous loop first.
function _ovRunCountup(items){
  if(_ovRAF){ cancelAnimationFrame(_ovRAF); _ovRAF=0; }
  if(!items.length) return;
  const fmt=(it,v)=>it.pre+(it.dp?v.toFixed(it.dp):Math.round(v).toLocaleString())+it.suf;
  const paint=(it,v)=>{
    if(it.kind==='bar') it.el.style.width=Math.max(0,Math.min(100,v)).toFixed(2)+'%';
    else it.el.textContent=fmt(it,v);
  };
  // Suspend bar CSS width-transitions for the sweep so the spring owns the frame.
  items.forEach(it=>{ if(it.kind==='bar') it.el.style.transition='none'; paint(it,it.from); });
  let start=0;
  const step=ts=>{
    if(!start)start=ts;
    let done=true;
    for(const it of items){
      const raw=(ts-start-(it.delay||0))/OV_DUR;
      if(raw<0){ done=false; continue; }
      if(raw>=1){ paint(it,it.target); continue; }
      paint(it, it.from+(it.target-it.from)*_ovSpring(raw));
      done=false;
    }
    if(done){ _ovRAF=0; items.forEach(it=>{ if(it.kind==='bar') it.el.style.transition=''; }); return; }
    _ovRAF=requestAnimationFrame(step);
  };
  _ovRAF=requestAnimationFrame(step);
}

// Read the animated targets attached to a card (or the whole wrap).
function _ovCollect(root){
  const nums=[...root.querySelectorAll('.ov-num')].map(el=>({
    el, key:el.dataset.k, target:parseFloat(el.dataset.t)||0,
    dp:parseInt(el.dataset.dp)||0, pre:el.dataset.pre||'', suf:el.dataset.suf||'',
    delay:parseInt(el.dataset.delay)||0, kind:'num'
  }));
  const bars=[...root.querySelectorAll('[data-ov-bar]')].map(el=>({
    el, key:'bar:'+el.dataset.ovBar, target:parseFloat(el.dataset.t)||0,
    delay:parseInt(el.dataset.delay)||0, kind:'bar'
  }));
  return nums.concat(bars);
}

function initOverviewMotion(){
  if(_ovRAF){ cancelAnimationFrame(_ovRAF); _ovRAF=0; }
  if(_ovIO){ _ovIO.disconnect(); _ovIO=null; }
  const wrap=document.querySelector('#tab-content .ov-wrap');
  if(!wrap) return;

  const sig=wrap.dataset.ovsig||'';
  const entering=wrap.classList.contains('ov-enter');
  const all=_ovCollect(wrap);
  const commit=()=>{
    const p={}; all.forEach(it=>p[it.key]=it.target);
    _ovPrevNums=p; _ovAnimSig=sig;
  };

  const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Scroll-triggered first-load reveal ──────────────────────────────────────
  if(entering && !reduce && 'IntersectionObserver' in window){
    // Cards animate the FIRST time each scrolls into view. Numbers inside a card
    // start counting from 0 in that same moment. Everything begins at rest
    // (opacity 0 via CSS, numbers painted to 0) so nothing flashes its final
    // state before its reveal.
    _ovBatch=[]; // fresh entrance run — drop any stale batch items
    const cards=[...wrap.querySelectorAll('.ov-proj-card, .ov-stat4-card, .ov-bottom-row .ov-panel')];
    // Paint every animated number/bar to its zero state up front (synchronously,
    // before the browser paints the freshly injected DOM) so no final figure
    // flashes before its card is revealed.
    all.forEach(it=>{
      if(it.kind==='bar'){ it.el.style.transition='none'; it.el.style.width='0%'; }
      else it.el.textContent=it.pre+(it.dp?(0).toFixed(it.dp):'0')+it.suf;
    });
    commit(); // targets are known; the loop from here is purely visual

    const reveal=card=>{
      if(card.dataset.ovIn) return;
      card.dataset.ovIn='1';
      card.classList.add('ov-in');
      // Count up just this card's numbers, preserving their per-element stagger
      // delays so values within a card still land in sequence with its CSS rise.
      const items=_ovCollect(card).map(it=>({...it, from:0}));
      if(items.length) _ovAppendCountup(items);
    };

    _ovIO=new IntersectionObserver((entries,obs)=>{
      // Cards crossing in together (the common desktop case, where the whole
      // dashboard is on screen at once) get a small incremental delay so they
      // still cascade in reading order rather than all snapping in at once.
      // On mobile, entries typically arrive one-at-a-time as the user scrolls,
      // so this stagger collapses to ~0 and each reveals on arrival.
      let i=0;
      entries.forEach(e=>{
        if(!e.isIntersecting) return;
        const card=e.target;
        obs.unobserve(card);
        const wait=i++*70;
        if(wait) setTimeout(()=>reveal(card), wait);
        else reveal(card);
      });
    }, { root:null, threshold:0.15, rootMargin:'0px 0px -8% 0px' });

    // Any card already in the viewport on mount reveals immediately (observer
    // fires for those on the next tick); off-screen ones wait for scroll.
    cards.forEach(c=>_ovIO.observe(c));
    return;
  }

  // ── No entrance (data change or reduced motion) ──────────────────────────────
  if(reduce){ commit(); return; }
  // Same data, tab just re-rendered/returned: leave numbers settled.
  if(sig===_ovAnimSig){ commit(); return; }
  // Data changed while settled: tween each value from its last shown figure.
  const items=all.map(it=>({...it, from:(it.key in _ovPrevNums ? _ovPrevNums[it.key] : it.target)}));
  commit();
  _ovRunCountup(items);
}

// Merge a fresh batch of count-up items into the running loop instead of
// replacing it, so cards revealed at different scroll positions each animate
// without cancelling one another. Falls back to starting the loop if idle.
let _ovBatch=[];
function _ovAppendCountup(items){
  const now=performance.now();
  const fmt=(it,v)=>it.pre+(it.dp?v.toFixed(it.dp):Math.round(v).toLocaleString())+it.suf;
  const paint=(it,v)=>{
    if(it.kind==='bar') it.el.style.width=Math.max(0,Math.min(100,v)).toFixed(2)+'%';
    else it.el.textContent=fmt(it,v);
  };
  // Prep each incoming item BEFORE checking whether a loop is running: rebase
  // its clock to now (so a card revealed later still respects its internal
  // per-number stagger from its own reveal), suspend bar width-transitions, and
  // paint its start value so nothing flashes final before counting.
  const fresh=items.map(it=>({...it,_active:true,_base:now}));
  fresh.forEach(it=>{ if(it.kind==='bar') it.el.style.transition='none'; paint(it,it.from); });
  _ovBatch=_ovBatch.filter(it=>it._active).concat(fresh);
  if(_ovRAF) return; // loop already running; it reads the reassigned _ovBatch

  const step=ts=>{
    let done=true;
    for(const it of _ovBatch){
      if(!it._active) continue;
      const raw=(performance.now()-it._base-(it.delay||0))/OV_DUR;
      if(raw<0){ done=false; continue; }
      if(raw>=1){ paint(it,it.target); if(it.kind==='bar') it.el.style.transition=''; it._active=false; continue; }
      paint(it, it.from+(it.target-it.from)*_ovSpring(raw));
      done=false;
    }
    if(done){ _ovRAF=0; _ovBatch=[]; return; }
    _ovRAF=requestAnimationFrame(step);
  };
  _ovRAF=requestAnimationFrame(step);
}

// ── Trend chart (Chart.js, lazy-loaded) ──────────────────────────────────────
// A single module-level ref so we can destroy before re-creating on each render.
let _trendChart = null;
// Populated by buildOverview() so renderTrendChart() shares the same numbers.
let _trendChartData = null;

let _trendChartRenderSeq=0;
async function renderTrendChart(){
  const canvas = document.getElementById('ov-trend-chart');
  if(!canvas) return;

  // Guard overlapping invocations: a fast range-toggle (or a re-render landing
  // during the CDN import) can call this again before the previous run reaches
  // `new Chart`. Each call claims a sequence number; after any await we bail if
  // a newer call has since started, so only the latest wins and we never build
  // two charts on one canvas (which left the animation half-applied).
  const seq=++_trendChartRenderSeq;

  // Lazy-load Chart.js from CDN — cached after first load
  if(!window.Chart){
    try{
      await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js');
    }catch(e){
      console.warn('[chart] Chart.js load failed:', e);
      return;
    }
  }
  if(seq!==_trendChartRenderSeq) return; // superseded during import

  // Destroy previous instance to prevent memory leaks on re-render
  if(_trendChart){ _trendChart.destroy(); _trendChart=null; }

  // Use the data already computed by buildOverview() — single source of truth.
  // This guarantees chart bars match the Calendar tab totals exactly.
  if(!_trendChartData) return;
  const {months: allMonths, values: allValues, mnames} = _trendChartData;

  // ── Single-month state ──────────────────────────────────────────────────────
  // With only one month logged there's no trend to draw yet, but we keep the SAME
  // line/area chart so users always recognise this component: the one real month
  // is a solid point + area fill, then a faint dashed line trails off into a few
  // ghosted future-month slots (hollow markers). A caption in the panel explains
  // the state. This reads as an early version of the chart, not a different widget.
  if(allMonths.length<2){
    const isDark=S.theme==='dark';
    const lineColor = isDark?'#7c93ff':'rgba(58,95,255,1)';
    const lastColor = isDark?'#a78bfa':'#7c69d4';
    const labelColor= isDark?'rgba(107,117,153,0.85)':'rgba(99,112,160,0.9)';
    const gridColor = isDark?'rgba(255,255,255,0.04)':'rgba(99,115,177,0.06)';
    const ghostColor= isDark?'rgba(124,147,255,0.30)':'rgba(99,115,177,0.32)';

    const realYM=allMonths[0]||`${new Date().getFullYear()}-${pad(new Date().getMonth()+1)}`;
    const realVal=allValues[0]||0;
    const [ry,rm]=realYM.split('-').map(Number);
    // Ghost future months continue the timeline so the axis reads as "waiting to
    // fill", not a lone dot floating in space.
    const GHOST=3;
    const labels=[mnames[rm-1]];
    for(let i=1;i<=GHOST;i++){ const d=new Date(ry,rm-1+i,1); labels.push(mnames[d.getMonth()]); }

    const ctx=canvas.getContext('2d');
    const h=canvas.offsetHeight||200;
    const grad=ctx.createLinearGradient(0,0,0,h);
    if(isDark){ grad.addColorStop(0,'rgba(124,147,255,0.35)'); grad.addColorStop(1,'rgba(124,147,255,0)'); }
    else{ grad.addColorStop(0,'rgba(58,95,255,0.16)'); grad.addColorStop(1,'rgba(58,95,255,0)'); }

    function fmtYAxisWonSolo(v){
      if(Math.abs(v)>=1000000) return '₩'+(v/1000000).toFixed(1)+(t('millionSuffix')||'M');
      if(Math.abs(v)>=1000)    return '₩'+(v/1000).toFixed(0)+(t('thousandSuffix')||'K');
      return '₩'+v;
    }

    _trendChart = new window.Chart(ctx,{
      type:'line',
      data:{
        labels,
        datasets:[
          // Ghost trail — a gently curved dashed line trailing off into the future
          // month slots, with faint hollow markers. Values follow a subtle wave (not
          // flat) so the curve reads as a placeholder timeline, not a real forecast.
          {
            data:[realVal, realVal*1.20, realVal*0.95, realVal*1.18],
            borderColor:ghostColor,
            borderWidth:1.5,
            borderDash:[5,5],
            pointBackgroundColor:'transparent',
            pointBorderColor:ghostColor,
            pointBorderWidth:1.5,
            pointRadius:[0,3.5,3.5,3.5],
            pointHoverRadius:[0,3.5,3.5,3.5],
            tension:0.45,
            fill:false,
          },
          // The one real month — solid point + area fill, exactly like live data.
          {
            data:[realVal,null,null,null],
            borderColor:lineColor,
            borderWidth:2.5,
            pointBackgroundColor:[lastColor],
            pointBorderColor:[lastColor],
            pointRadius:[7,0,0,0],
            pointHoverRadius:[9,0,0,0],
            pointBorderWidth:0,
            tension:0,
            fill:true,
            backgroundColor:grad,
          },
        ]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:{ duration:700, easing:'easeInOutQuart' },
        layout:{ padding:{ top:20, left:4, right:16, bottom:10 } },
        plugins:{ legend:{ display:false }, tooltip:{ enabled:false } },
        scales:{
          x:{ grid:{ display:false }, border:{ display:false }, ticks:{ color:labelColor, font:{ size:11, weight:'600' }, maxRotation:0 } },
          y:{
            display:true, position:'left',
            grid:{ color:gridColor, drawBorder:false },
            border:{ display:false, dash:[3,3] },
            ticks:{ color:labelColor, font:{ size:10, weight:'500' }, maxTicksLimit:5, callback:v=>fmtYAxisWonSolo(v) },
            min:0,
            suggestedMax: realVal>0 ? realVal*1.5 : 100000,
          }
        },
        interaction:{ intersect:false, mode:'index' },
      }
    });
    return;
  }

  // Slice to the selected range
  const sliceCount = S.chartRange==='1y' ? 12 : S.chartRange==='6m' ? 6 : 3;
  const months = allMonths.slice(-sliceCount);
  const values = allValues.slice(-sliceCount);

  // Smart year suffix: only add " 'YY" when the slice spans more than one calendar year
  const years = new Set(months.map(ym=>ym.slice(0,4)));
  const showYear = years.size > 1;
  const labels = months.map(ym=>{
    const [y,m] = ym.split('-');
    return showYear ? `${mnames[parseInt(m)-1]} '${y.slice(2)}` : mnames[parseInt(m)-1];
  });

  // Theme-aware colours
  const isDark=S.theme==='dark';
  const lineColor  = isDark ? '#7c93ff'                : 'rgba(58,95,255,1)';
  const dotColor   = isDark ? '#7c93ff'                : '#3a5fff';
  const lastColor  = isDark ? '#a78bfa'                : '#7c69d4';
  const labelColor = isDark ? 'rgba(107,117,153,0.85)' : 'rgba(99,112,160,0.9)';
  const gridColor  = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(99,115,177,0.06)';

  // Point colors: last point is magenta/highlighted, rest are blue
  const pointBg  = values.map((_,i)=>i===values.length-1?lastColor:dotColor);
  const pointBdr = values.map((_,i)=>i===values.length-1?lastColor:dotColor);
  const pointR   = values.map((_,i)=>i===values.length-1?7:3);
  const pointHR  = values.map((_,i)=>i===values.length-1?9:5);

  // Strong purple gradient fill
  const ctx=canvas.getContext('2d');
  const h=canvas.offsetHeight||200;
  const grad=ctx.createLinearGradient(0,0,0,h);
  if(isDark){
    grad.addColorStop(0,'rgba(124,147,255,0.45)');
    grad.addColorStop(0.5,'rgba(167,139,250,0.2)');
    grad.addColorStop(1,'rgba(124,147,255,0.0)');
  }else{
    grad.addColorStop(0,'rgba(58,95,255,0.18)');
    grad.addColorStop(1,'rgba(58,95,255,0)');
  }

  // Y-axis formatter: ₩1.0M, ₩1.5M etc.
  function fmtYAxisWon(v){
    if(Math.abs(v)>=1000000) return '₩'+(v/1000000).toFixed(1)+(t('millionSuffix')||'M');
    if(Math.abs(v)>=1000)    return '₩'+(v/1000).toFixed(0)+(t('thousandSuffix')||'K');
    return '₩'+v;
  }

  _trendChart = new window.Chart(ctx,{
    type:'line',
    data:{
      labels,
      datasets:[{
        data: values,
        borderColor: lineColor,
        borderWidth: 2.5,
        pointBackgroundColor: pointBg,
        pointBorderColor: pointBdr,
        pointRadius: pointR,
        pointHoverRadius: pointHR,
        pointBorderWidth: 0,
        tension: 0.42,
        fill: true,
        backgroundColor: grad,
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:{
        // Progressive line-draw + fade that replays on every (re)creation —
        // so switching 3m/6m/1y visibly re-animates rather than snapping. The
        // chart is destroyed and rebuilt on each toggle, so this entry
        // animation runs fresh each time.
        duration:700,
        easing:'easeInOutQuart',
        y:{ from:(ctx)=>{ const s=ctx.chart.scales.y; return s?s.getPixelForValue(s.min):undefined; } },
      },
      layout:{ padding:{ top:20, left:4, right:16, bottom:10 } },
      plugins:{
        legend:{ display:false },
        tooltip:{
          backgroundColor: isDark?'rgba(10,14,40,0.97)':'rgba(255,255,255,0.97)',
          borderColor: isDark?'rgba(120,150,255,0.2)':'rgba(99,115,177,0.15)',
          borderWidth:1,
          titleColor: isDark?'#f0f2ff':'#0d1033',
          bodyColor: isDark?'#6b7599':'#6370a0',
          titleFont:{ weight:'700', size:13 },
          bodyFont:{ size:12 },
          padding:12,
          cornerRadius:10,
          displayColors:false,
          callbacks:{
            label: ctx=>'₩'+ctx.parsed.y.toLocaleString(),
          }
        },
      },
      scales:{
        x:{
          grid:{ display:false },
          border:{ display:false },
          ticks:{ color:labelColor, font:{ size:11, weight:'600' }, maxRotation:0 },
        },
        y:{
          display:true,
          position:'left',
          grid:{ color:gridColor, drawBorder:false },
          border:{ display:false, dash:[3,3] },
          ticks:{
            color:labelColor,
            font:{ size:10, weight:'500' },
            maxTicksLimit:5,
            callback: v=>fmtYAxisWon(v),
          },
          beginAtZero:false,
        }
      },
      interaction:{ intersect:false, mode:'index' },
    }
  });
}

// ── Monthly bar chart (This Month panel in Overview) ──────────────────────────
let _monthBarChart = null;

async function renderMonthBarChart(){
  const canvas = document.getElementById('ov-month-bar-chart');
  if(!canvas) return;
  if(!window.Chart){
    try{ await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js'); }
    catch(e){ return; }
  }
  if(_monthBarChart){ _monthBarChart.destroy(); _monthBarChart=null; }

  const logs=getLogs(),todayStr=today();
  const now=new Date(),curY=now.getFullYear(),curMo=now.getMonth();
  const daysInCur=new Date(curY,curMo+1,0).getDate();
  const labels=[],values=[];
  // First pass: collect every worked/credited day this month (bar per day).
  const bars=[]; // { day, value }
  for(let d=1;d<=daysInCur;d++){
    const ds=mkds(curY,curMo,d);
    if(ds>todayStr) break;
    const g=autoGross(ds,logs);
    if(g>0||(logs[ds]&&isZeroDay(logs[ds]))){
      bars.push({day:d, value:applyTax(g)});
    }
  }
  if(!bars.length) return;

  // Second pass: decide label density from the NUMBER OF BARS, not the calendar
  // date. With only a few bars there's ample room, so label them all; once bars
  // get dense, thin them to ~6 evenly-spaced labels (always incl. first & last)
  // so they never overlap.
  const mLabel=t('mn')[curMo].slice(0,3);
  const n=bars.length;
  const MAX_LABELS=6;               // most labels we ever show at once
  const LABEL_ALL_THRESHOLD=8;      // at/under this many bars, label every one
  let showAt;
  if(n<=LABEL_ALL_THRESHOLD){
    showAt=()=>true;
  }else{
    const step=Math.ceil((n-1)/(MAX_LABELS-1)); // gap between labelled bars
    showAt=(i)=> i===0 || i===n-1 || i%step===0;
  }
  const allLabels=[], allValues=[];
  bars.forEach((b,i)=>{
    allLabels.push(showAt(i) ? `${mLabel} ${b.day}` : '');
    allValues.push(b.value);
  });

  const isDark=S.theme==='dark';

  // Gradient bar fill: indigo → violet (both modes use the same primary gradient)
  const ctx=canvas.getContext('2d');
  const h=canvas.offsetHeight||180;
  const barGrad=ctx.createLinearGradient(0,0,0,h);
  if(isDark){
    barGrad.addColorStop(0,'rgba(139,120,255,0.95)');
    barGrad.addColorStop(1,'rgba(108,134,255,0.35)');
  }else{
    barGrad.addColorStop(0,'rgba(139,92,246,0.90)');
    barGrad.addColorStop(1,'rgba(73,119,253,0.40)');
  }
  const barHoverGrad=ctx.createLinearGradient(0,0,0,h);
  if(isDark){
    barHoverGrad.addColorStop(0,'rgba(167,139,250,1)');
    barHoverGrad.addColorStop(1,'rgba(124,147,255,0.6)');
  }else{
    barHoverGrad.addColorStop(0,'rgba(139,92,246,1)');
    barHoverGrad.addColorStop(1,'rgba(73,119,253,0.7)');
  }

  const labelColor=isDark?'rgba(107,117,153,0.75)':'rgba(99,112,160,0.75)';
  const gridColor =isDark?'rgba(255,255,255,0.035)':'rgba(99,115,177,0.055)';

  function fmtY(v){
    if(v>=1000000) return '₩'+(v/1000000).toFixed(1)+(t('millionSuffix')||'M');
    if(v>=1000)    return '₩'+(v/1000).toFixed(0)+(t('thousandSuffix')||'K');
    return '₩'+v;
  }

  _monthBarChart=new window.Chart(ctx,{
    type:'bar',
    data:{
      labels: allLabels,
      datasets:[{
        data: allValues,
        backgroundColor: barGrad,
        hoverBackgroundColor: barHoverGrad,
        borderRadius: 6,
        borderSkipped: false,
        borderWidth: 0,
        barPercentage: 0.55,
        categoryPercentage: 0.75,
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:{duration:600,easing:'easeInOutQuart'},
      layout:{ padding:{ top:8, right:4, bottom:0, left:0 } },
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:isDark?'rgba(10,12,28,0.97)':'rgba(255,255,255,0.97)',
          borderColor:isDark?'rgba(139,120,255,0.25)':'rgba(99,115,177,0.15)',
          borderWidth:1,
          titleColor:isDark?'#f0f2ff':'#0d1033',
          bodyColor:isDark?'#6b7599':'#6370a0',
          titleFont:{weight:'700',size:12},
          bodyFont:{size:11},
          padding:10,cornerRadius:10,displayColors:false,
          callbacks:{
            title: items => {
              // Reuse the bars array so the tooltip day always matches the bar,
              // even for bars whose axis label was thinned out.
              const b=bars[items[0].dataIndex];
              return b ? `${mLabel} ${b.day}` : '';
            },
            label: ctx=>'₩'+ctx.parsed.y.toLocaleString(),
          }
        }
      },
      scales:{
        x:{
          display:true,
          grid:{display:false},
          border:{display:false},
          ticks:{
            color:labelColor,
            font:{size:10,weight:'600'},
            maxRotation:0,
            // only render non-empty labels
            callback(val,i){ return allLabels[i]||null; }
          }
        },
        y:{
          display:true,
          position:'left',
          grid:{color:gridColor,drawBorder:false},
          border:{display:false,dash:[3,4]},
          ticks:{
            color:labelColor,
            font:{size:10,weight:'500'},
            maxTicksLimit:4,
            callback: v=>fmtY(v),
          },
          beginAtZero:true,
        }
      },
      interaction:{intersect:false,mode:'index'},
    }
  });
}

// The Overview tab's listeners + after-DOM-injection passes. Called from
// app.js attachListeners() whenever the Overview tab is active.
export function wireOverview(ctx){
  bind(ctx);
  // initOverviewMotion() runs first: on a first-load entrance it paints every
  // animated number to its zero state synchronously (before the browser paints
  // the freshly injected DOM, so finals never flash) and arms an
  // IntersectionObserver that reveals each card as it scrolls into view.
  initOverviewMotion(); renderTrendChart(); renderMonthBarChart(); wireOverviewEmpty();

  // Chart range toggle — update state and re-render chart in-place (no full render)
  document.querySelectorAll('.ov-range-btn').forEach(btn=>btn.addEventListener('click',()=>{
    S.chartRange=btn.dataset.range;
    document.querySelectorAll('.ov-range-btn').forEach(b=>b.classList.toggle('ov-range-btn--active',b===btn));
    renderTrendChart();
  }));

  // ── All Shifts modal trigger ─────────────────────────────────────────────────
  const rsViewAll = document.getElementById('rs-view-all');
  if(rsViewAll) rsViewAll.addEventListener('click', e => {
    e.stopPropagation();
    openAllShifts();
  });
}
