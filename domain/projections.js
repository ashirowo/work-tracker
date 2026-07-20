// ─────────────────────────────────────────────────────────────────────────────
// domain/projections.js — the Overview tab's aggregation + projection math
// (Phase 8c).
//
// computeOverviewData() is everything buildOverview() used to compute inline:
// per-month aggregation, the six-bucket pattern projection (decay-weighted
// blending with deterministic floors), best-month/top-day, and the stat-card
// derivations. It is PURE with respect to the app shell:
//   • no S — callers inject targetHrs; the S.chartRange clamp stays in the view;
//   • no new Date() — callers inject nowDate (tests pin it);
//   • no HTML — it returns a data object the view renders.
//
// env is the same capability record domain/earnings.js consumes (APP_ENV in
// app.js; the tests assemble one from the golden oracle):
//   { getLogs(), wageFor(ds), shiftFor(ds), isHol(ds), isHolAuto(),
//     applyTax(gross), getProfile(), tr(), todayStr() }
//
// Bodies are verbatim from app.js buildOverview(). The only edits are the
// env/opts bindings at the top of computeOverviewData, two documented
// transforms (`new Date()` → nowDate, `S.targetHrs` → targetHrs) and the
// trailing return object.
// ─────────────────────────────────────────────────────────────────────────────

import { pad, mkds, pd } from '../core/dates.js';
import { isZeroDay } from './log-entries.js';
import { liveGrossIn, autoEffIn, baseEffForIn, bucketKeysIn, bucketForIn, bucketDeterministicEffIn } from './earnings.js';

export function computeOverviewData(env, { nowDate, todayStr, targetHrs }){
  // Bind the app.js names the moved bodies close over, so they stay verbatim.
  const applyTax = env.applyTax, wageFor = env.wageFor, shiftFor = env.shiftFor;
  const autoGross = (ds, logsArg) => liveGrossIn(env, ds, logsArg);
  const autoEff = (ds, logsArg) => autoEffIn(env, ds, logsArg);
  const baseEffFor = (ds, sh) => baseEffForIn(env, ds, sh);
  const bucketKeys = () => bucketKeysIn(env.getProfile());
  const bucketFor = ds => bucketForIn(env, ds);
  const bucketDeterministicEff = bucket => bucketDeterministicEffIn(env, bucket);

  const logs = env.getLogs();

  // ── Per-month aggregation ──────────────────────────────────────────────────
  // Mirrors buildStats() exactly: iterate every calendar day up to today,
  // using autoGross() so auto-credited holidays and Sundays are included in
  // ALL months, not just the current one. This ensures Best Month always
  // matches the Calendar tab's monthly total.
  const monthData={};
  function ensureMonth(ym){ if(!monthData[ym]) monthData[ym]={net:0,gross:0,days:0,hrs:0,overtimeNet:0,topDay:null}; }

  // Derive the range of months to scan from the log keys (plus current month).
  const now=nowDate,curY=now.getFullYear(),curMo=now.getMonth();
  const curYM=`${curY}-${pad(curMo+1)}`;
  const logMonths=new Set(Object.keys(logs).map(ds=>ds.slice(0,7)));
  logMonths.add(curYM);

  logMonths.forEach(ym=>{
    const [yStr,mStr]=ym.split('-');
    const y=parseInt(yStr),mo=parseInt(mStr)-1;
    const daysInMo=new Date(y,mo+1,0).getDate();
    for(let d=1;d<=daysInMo;d++){
      const ds=mkds(y,mo,d);
      if(ds>todayStr) break;
      const g=autoGross(ds,logs);  // liveGross: always recomputed from hours × wageFor(ds)
      const e=autoEff(ds,logs);
      const isLogged=!!logs[ds];
      const zeroDay=isLogged&&isZeroDay(logs[ds]);
      if(g>0||zeroDay){
        ensureMonth(ym);
        const m=monthData[ym];
        const net=applyTax(g);
        m.net+=net; m.gross+=g; m.days++; m.hrs+=e;
        // Overtime = earnings beyond the plain base for that day type
        const l=logs[ds];
        const sh=(l&&l.shiftOverride)||shiftFor(ds);
        const baseEff=baseEffFor(ds, sh); // engine probe of the active profile
        const basePay=applyTax(Math.round(Math.min(e,baseEff)*wageFor(ds)));
        m.overtimeNet+=Math.max(0,net-basePay);
        if(!m.topDay||net>m.topDay.net) m.topDay={ds,net,hrs:e};
      }
    }
  });

  const daysInCur=new Date(curY,curMo+1,0).getDate();

  const months=Object.keys(monthData).sort();
  const curData=monthData[curYM]||{net:0,gross:0,days:0,hrs:0,overtimeNet:0,topDay:null};
  const curBaseNet=Math.max(0,curData.net-curData.overtimeNet);

  // ── Pattern-based projection (v2) ──────────────────────────────────────────
  // Days are classified into SIX buckets so shift type (day/night) and
  // Sunday-vs-holiday pay differences are no longer averaged together:
  //   'dayWeekday'   — Mon–Fri, day shift, not a public holiday
  //   'nightWeekday' — Mon–Fri, night shift, not a public holiday
  //   'daySat'       — Saturday, day shift, not a public holiday
  //   'nightSat'     — Saturday, night shift, not a public holiday
  //   'sun'          — plain Sunday (always auto-credited)
  //   'holiday'      — public holiday (any day of week; auto-credit depends on holAuto)
  // Buckets mirror the engine's rate cells, so each bucket's average reflects
  // a single, internally-consistent pay formula (classes with their own tables
  // split by shift; aliased classes pool with their target; rest days and
  // holidays stand alone). See bucketKeys()/bucketFor() at top level.
  const BUCKET_KEYS=bucketKeys(); // derived from the active profile (Phase 4)

  // Exponential-decay weighted average: more recent entries count more.
  // weight(daysAgo) = DECAY^daysAgo, normalized so weights sum to 1.
  // DECAY=0.9 → an entry 7 days old carries ~48% the weight of today's;
  // 14 days old ~23%. Smooth, no discontinuity (unlike the old 70/30 split).
  const DECAY=0.9;
  function decayWeightedAvg(entries, refDateStr){
    if(!entries.length) return 0;
    if(entries.length===1) return entries[0].net;
    const refMs=pd(refDateStr).getTime();
    const dayMs=24*3600*1000;
    let wSum=0,vSum=0;
    for(const e of entries){
      const daysAgo=Math.max(0,Math.round((refMs-pd(e.ds).getTime())/dayMs));
      const w=Math.pow(DECAY,daysAgo);
      wSum+=w; vSum+=w*e.net;
    }
    return wSum>0 ? vSum/wSum : 0;
  }

  // Build per-bucket entries for a given year-month string.
  // Includes both manually logged entries AND auto-credited sun/hol days.
  function buildMonthEntries(ym){
    const [yStr,mStr]=ym.split('-');
    const y=parseInt(yStr),mo=parseInt(mStr)-1;
    const daysInMo=new Date(y,mo+1,0).getDate();
    const isCurrent=ym===curYM;
    const cutoff=isCurrent?todayStr:`${ym}-${pad(daysInMo)}`; // whole month for past months
    const bucket={}; BUCKET_KEYS.forEach(k=>bucket[k]=[]);

    for(let d=1;d<=daysInMo;d++){
      const ds=mkds(y,mo,d);
      if(ds>cutoff) break;
      const cls=bucketFor(ds);
      // Always use liveGross so projection averages reflect current wage history
      const g=autoGross(ds,logs);
      // Exclude double-shift days from the average — they're outliers that would
      // inflate projections. They still count toward actual earned totals via curData.
      if(g>0 && logs[ds]?.shiftOverride!=='double') bucket[cls].push({net:applyTax(g), ds});
    }
    // Sort oldest→newest within each bucket so decay weighting is time-ordered
    BUCKET_KEYS.forEach(k=>bucket[k].sort((a,b)=>a.ds.localeCompare(b.ds)));
    return bucket;
  }

  const curEntries=buildMonthEntries(curYM);

  // Per-bucket confidence: each bucket's reliability depends on ITS OWN count
  // this month, not the total. A user with 12 day-shift entries but 0 Saturday
  // entries should get full confidence on dayWeekday but fall back to last
  // month (or the deterministic estimate) for sat.
  // Lower thresholds than before (2/4 vs 5/9) since buckets are now finer-grained
  // and naturally accumulate fewer entries per month.
  const CONF_LO=2, CONF_HI=4;
  function confidenceFor(bucket){
    const n=curEntries[bucket].length;
    return n<=CONF_LO ? 0 : n>=CONF_HI ? 1 : (n-CONF_LO)/(CONF_HI-CONF_LO);
  }

  // Find the most recent previous month with at least CONF_LO entries in this bucket.
  const prevEntriesCache={};
  function getPrevMonthEntries(bucket){
    if(prevEntriesCache[bucket]!==undefined) return prevEntriesCache[bucket];
    const prevMonths=months.filter(ym=>ym<curYM).sort().reverse();
    for(const ym of prevMonths){
      const e=buildMonthEntries(ym);
      if(e[bucket].length>=CONF_LO){ prevEntriesCache[bucket]=e; return e; }
    }
    prevEntriesCache[bucket]=null;
    return null;
  }

  // Deterministic fallback: when there's no usable historical data for a bucket
  // (neither this month nor a previous month), estimate using calcWage() directly
  // with a representative 8h day, the wage active on the projection date, and the
  // correct shift/holiday-credit context. This replaces the old "8h × wage" guess
  // that only applied to the combined sunhol bucket — now every bucket has a
  // deterministic floor.
  function deterministicEstimate(bucket, dateStr){
    return applyTax(Math.round(bucketDeterministicEff(bucket)*wageFor(dateStr)));
  }

  // Blend per-bucket averages: (confidence × current) + ((1-confidence) × previous),
  // falling back to a deterministic estimate when no historical data exists at all.
  // refDateStr anchors the decay weighting and wage lookup for the fallback.
  // Returns {avg, low, high}: low/high are the min/max observed net values across
  // the pooled current+previous entries used for this bucket, giving an honest
  // range for the projection rather than a single false-precision number.
  function blendAvg(bucket, refDateStr){
    const confidence=confidenceFor(bucket);
    const curList=curEntries[bucket];
    const curAvg=decayWeightedAvg(curList, refDateStr);
    let avg, pooled;
    if(confidence===1 || curList.length>0){
      const prevEntries=confidence<1 ? getPrevMonthEntries(bucket) : null;
      if(prevEntries){
        const prevAvg=decayWeightedAvg(prevEntries[bucket], refDateStr);
        avg=curAvg*confidence + prevAvg*(1-confidence);
        pooled=curList.concat(prevEntries[bucket]);
      }else{
        avg=curAvg; // no previous data to blend with — use current as-is
        pooled=curList;
      }
    }else{
      // No current-month data at all for this bucket
      const prevEntries=getPrevMonthEntries(bucket);
      avg=prevEntries ? decayWeightedAvg(prevEntries[bucket], refDateStr) : 0;
      pooled=prevEntries ? prevEntries[bucket] : [];
    }
    if(avg<=0){
      const det=deterministicEstimate(bucket, refDateStr);
      return {avg:det, low:det, high:det};
    }
    if(!pooled.length) return {avg, low:avg, high:avg};
    const nets=pooled.map(e=>e.net);
    return {avg, low:Math.min(...nets), high:Math.max(...nets)};
  }

  // Count remaining days of each type after today (future logs already counted in curData),
  // and accumulate the projection using a PER-DAY average anchored to that day's date
  // (so wage changes mid-projection and decay weighting both resolve correctly).
  // Also accumulate low/high bounds for a confidence range display.
  let remainder=0, remainderLow=0, remainderHigh=0;
  for(let d=1;d<=daysInCur;d++){
    const ds=mkds(curY,curMo,d);
    if(ds<=todayStr) continue;      // past/today already in curData.net
    if(logs[ds]) continue;          // manually logged future day already in curData.net
    const cls=bucketFor(ds);
    const {avg,low,high}=blendAvg(cls, ds);
    remainder+=avg; remainderLow+=low; remainderHigh+=high;
  }

  // Projected = actual earned so far + sum of per-day estimates for remaining days.
  // projectionLow/High give an honest range using the min/max historically observed
  // net value per bucket, rather than presenting a single number with false precision.
  const projection=Math.round(curData.net + remainder);
  const projectionLow=Math.round(curData.net + remainderLow);
  const projectionHigh=Math.round(curData.net + remainderHigh);


  // Best month (exclude current for the "past best" card)
  let bestYM=null,bestNet=0;
  months.forEach(ym=>{ if(monthData[ym].net>bestNet){bestNet=monthData[ym].net;bestYM=ym;} });
  const pastBestYM = bestYM===curYM ? (months.length>1?months.slice(0,-1).reduce((a,b)=>monthData[a].net>monthData[b].net?a:b):null) : bestYM;

  // When the current month is the ONLY month with earnings there is no "past
  // best" to compare against — but the Best Month card should still celebrate
  // it rather than sit empty behind dashes. Treat the sole month as the current
  // leader and badge it (below) so the missing comparison reads as intentional
  // and the card promises the comparison becomes meaningful with more data.
  const soleBestMonth = !pastBestYM && curData.net>0;
  const bestMonthYM = pastBestYM || (soleBestMonth ? curYM : null);

  // Chart data — all months oldest→newest; current month uses projection.
  // All months are stored; the view's renderTrendChart() slices based on
  // S.chartRange ('3m' | '6m' | '1y').
  const chartMonths=months.slice();
  const chartValues=chartMonths.map(ym=>ym===curYM?projection:monthData[ym].net);

  // Best Single Day across ALL logged days (not just current month)
  let allTimeTopDay=null;
  months.forEach(ym=>{ const td=monthData[ym].topDay; if(td&&(!allTimeTopDay||td.net>allTimeTopDay.net)) allTimeTopDay=td; });

  // ── This Month summary ────────────────────────────────────────────────────
  const target=targetHrs||250;
  const remaining=Math.max(0,target-curData.days*0+0); // placeholder — use hrs
  const hrsWorked=parseFloat(
    (() => {
      let h=0;
      const dInM=new Date(curY,curMo+1,0).getDate();
      for(let d=1;d<=dInM;d++){
        const ds=mkds(curY,curMo,d);
        if(ds>todayStr)break;
        h+=autoEff(ds,logs);
      }
      return h.toFixed(1);
    })()
  );
  const hrsRemaining=Math.max(0,target-hrsWorked);
  const hrsProgress=Math.min(100,Math.round((hrsWorked/target)*100));
  const avgPerDay=curData.days>0?Math.round(curData.net/curData.days):0;
  const avgHrsPerDay=curData.days>0?+(hrsWorked/curData.days).toFixed(1):0;
  const daysInMonth=new Date(curY,curMo+1,0).getDate();

  const tmRingPct=hrsProgress;
  const avgRingPct=daysInMonth>0?Math.min(100,Math.round((avgHrsPerDay/(target/daysInMonth))*100)):0;

  // ── Anchor data for the 4 stat cards ────────────────────────────────────────
  // Each card gets a real, meaningful bottom line (not decoration) so all four
  // share the Hours-Worked card's complete top-to-bottom structure.

  // Avg Per Day: month-over-month change in average net/day.
  const _avgPrevIdx=months.indexOf(curYM)-1;
  const _prevMonth=_avgPrevIdx>=0?monthData[months[_avgPrevIdx]]:null;
  const _prevAvg=_prevMonth&&_prevMonth.days>0?Math.round(_prevMonth.net/_prevMonth.days):0;
  const avgDeltaPct=(_prevAvg>0&&avgPerDay>0)?((avgPerDay-_prevAvg)/_prevAvg*100):null;

  // Best Month: how much the best past month beats the runner-up, plus the
  // hours/days that actually produced it — same "show your work" treatment
  // the Hours Worked and Avg Per Day cards already get.
  let bestMonthDeltaPct=null;
  if(pastBestYM){
    const _bestNet=monthData[pastBestYM].net;
    const _runnerUp=months.filter(m=>m!==pastBestYM&&m!==curYM)
      .reduce((best,m)=>monthData[m].net>best?monthData[m].net:best,0);
    if(_runnerUp>0) bestMonthDeltaPct=((_bestNet-_runnerUp)/_runnerUp*100);
  }
  const bestMonthHrs=bestMonthYM?monthData[bestMonthYM].hrs:null;
  const bestMonthDays=bestMonthYM?monthData[bestMonthYM].days:null;

  // Best Single Day: hours worked on that day (captured in topDay above),
  // plus how far it sits above a typical working day, all-time.
  const bestDayHrs=allTimeTopDay&&allTimeTopDay.hrs!=null?+allTimeTopDay.hrs.toFixed(1):null;
  let bestDayAbovePct=null;
  if(allTimeTopDay){
    const _allNet=months.reduce((s,m)=>s+monthData[m].net,0);
    const _allDays=months.reduce((s,m)=>s+monthData[m].days,0);
    const _avgAll=_allDays>0?_allNet/_allDays:0;
    if(_avgAll>0) bestDayAbovePct=((allTimeTopDay.net-_avgAll)/_avgAll*100);
  }

  return {
    monthData, months, curYM, curData, curBaseNet, daysInCur,
    buckets: curEntries,
    projection, projectionLow, projectionHigh,
    bestMonthYM, pastBestYM, soleBestMonth, allTimeTopDay,
    chart: { months: chartMonths, values: chartValues },
    target, remaining, hrsWorked, hrsRemaining, hrsProgress,
    avgPerDay, avgHrsPerDay, daysInMonth, tmRingPct, avgRingPct,
    avgDeltaPct, bestMonthDeltaPct, bestMonthHrs, bestMonthDays,
    bestDayHrs, bestDayAbovePct,
  };
}
