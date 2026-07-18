// ─────────────────────────────────────────────────────────────────────────────
// domain/wizard-core.js — the pay-rules wizard's PURE layer (Phase 6).
//
// Chip state ⇄ compiler answers ⇄ compiled profile, plus the stepper/break
// detent math and the live engine-probe preview rows. No DOM, no storage, no
// S — every function is deterministic over its (state, lang, pattern) inputs
// (verified: zero `S.` references in the extracted range). Bodies are verbatim
// from app.js; the app keeps thin sliced adapters for the five oracle-tracked
// names (wizT / WIZ_DEFAULT_RULES / wizardAnswersFrom / wizardProfileFrom /
// rulesStateFromProfile).
// ─────────────────────────────────────────────────────────────────────────────

import { TR } from '../translations.js';
import { compileProfileV2, PRESET_ANSWERS_V2 } from '../compile.js';
import { needsNightSchedule, nightHoursOf } from '../profile-v2.js';
import { calcDay } from '../calc.js';

// wiz strings ship in en+ko; the other locales fall back to English until
// natively translated.
export function wizT(lang,k){
  const w=(TR[lang]&&TR[lang].wiz)||TR.en.wiz;
  return w[k]!==undefined?w[k]:TR.en.wiz[k];
}
export function WIZ_DEFAULT_RULES(){ return { preset:'kr-statutory-5plus', night:'idk', sat:'idk', hol:'idk', ot:'idk', rest:'idk' }; }
// Answers from chip state. "I don't know" → Korean statutory defaults
// (minimum-leaning, per the wizard answerability audit): night +50%, Saturday
// same as weekdays, worked holidays ×1.5, OT ×1.5, paid rest day yes.
export function wizardAnswersFrom(rules){
  if(rules.preset&&PRESET_ANSWERS_V2[rules.preset]){
    const a=structuredClone(PRESET_ANSWERS_V2[rules.preset]);
    // User configuration rides on top of preset pay rules:
    if(rules.window) a.nightWindow={...rules.window};
    return a;
  }
  const pick=(v,d)=>v==='idk'?d:v;
  // Unanswered rules → Standard Korean workplace defaults (researched): night
  // +50% (overlap), Saturday 1.5×, worked holiday 1.5×, OT 1.5×, paid rest day.
  const night=pick(rules.night,1.5), sat=pick(rules.sat,1.5), hol=pick(rules.hol,1.5), ot=pick(rules.ot,1.5);
  const rest=rules.rest==='idk'?true:!!rules.rest;
  // Custom night uses OVERLAP mode (statutory-correct, schedule-driven). The
  // stepper multiplier is the additive night premium (×1.5 → prem 0.5).
  // Threshold rulebooks (the factory's 5.68h) arrive via presets only.
  return {
    v:2, shiftHours:8,
    nightModel: night>1?'overlap':'none',
    nightPrem: night>1?+(night-1).toFixed(4):0,
    nightWindow: rules.window ? {...rules.window} : {start:'22:00',end:'06:00'},
    saturday: sat>1?{extra:true,mult:sat}:{extra:false},
    holiday: {paidCredit:true, creditHours:8, workedMult:hol},
    otDay:ot, otNight:ot,
    restDay:{dow:0,paidCredit:rest,hours:8},
  };
}
export function wizardProfileFrom(rules, pattern){
  const answers=wizardAnswersFrom(rules);
  // Attach the user's night schedule (asked once) so overlap mode can compute.
  if(rules.schedule&&rules.schedule.night) answers.schedule={night:{...rules.schedule.night}};
  const p=compileProfileV2(answers,{id:rules.preset||'custom'});
  p.source={kind:rules.preset?'preset':'wizard',...(rules.preset?{presetId:rules.preset}:{}),answers};
  return p;
}
// Reopen the wizard from a stored profile's source.answers (round-trip).
export function rulesStateFromProfile(profile){
  const src=profile&&profile.source;
  if(src&&src.kind==='preset'&&PRESET_ANSWERS_V2[src.presetId]){
    // The Small-workplace and Legal-minimum presets no longer exist as
    // choices — they weren't workplaces, just answer combinations. Reopen a
    // profile saved with one of them as Customize with the closest chip values
    // so the stored rules keep round-tripping.
    if(src.presetId==='kr-small-under5'||src.presetId==='kr-legal-minimum'){
      const st={...WIZ_DEFAULT_RULES(),preset:null};
      if(src.presetId==='kr-small-under5'){ st.night=1;  st.sat=1; st.hol=1;  st.ot=1;  st.rest=true; }
      else                                { st.night=1.5;st.sat=1; st.hol=1.5;st.ot=1.5;st.rest=true; }
      if(src.answers&&src.answers.schedule) st.schedule=src.answers.schedule;
      const w0=src.answers&&src.answers.nightWindow;
      if(w0&&(w0.start!=='22:00'||w0.end!=='06:00')) st.window={...w0};
      return st;
    }
    const st={...WIZ_DEFAULT_RULES(),preset:src.presetId};
    if(src.answers&&src.answers.schedule) st.schedule=src.answers.schedule;
    const w=src.answers&&src.answers.nightWindow;
    if(w&&(w.start!=='22:00'||w.end!=='06:00')) st.window={...w};
    return st;
  }
  const a=src&&src.answers;
  if(!a) return WIZ_DEFAULT_RULES(); // grandfathered default profile
  const isCustomWin=a.nightWindow&&(a.nightWindow.start!=='22:00'||a.nightWindow.end!=='06:00');
  const st={
    preset:null,
    night:(a.nightModel&&a.nightModel!=='none')?+(1+(a.nightPrem||0)).toFixed(2):1,
    sat:a.saturday&&a.saturday.extra?a.saturday.mult:1,
    hol:(a.holiday&&a.holiday.workedMult)!==undefined?a.holiday.workedMult:1.5,
    ot:(a.otDay!=null)?a.otDay:1.5,
    rest:!!(a.restDay&&a.restDay.paidCredit),
  };
  if(a.schedule) st.schedule=a.schedule;
  if(isCustomWin) st.window={...a.nightWindow};
  return st;
}

// ── Rate steppers — the ×0.25 detent grid ────────────────────────────────────
// Legacy profiles may hold off-grid multipliers (×1.6), so a step first snaps
// to the grid in the direction of travel instead of drifting by a fixed inc.
export const WZ_STEP={min:1,max:5,inc:0.25};
export function wzStepNext(v,dir){
  const q=v/WZ_STEP.inc, eps=1e-9;
  const n=dir>0?Math.floor(q+eps)+1:Math.ceil(q-eps)-1;
  return Math.min(WZ_STEP.max,Math.max(WZ_STEP.min,+(n*WZ_STEP.inc).toFixed(2)));
}
// Display value: unanswered ('idk') renders — and saves — as the Korean
// standard default, so what the row shows is exactly what saving compiles.
export function wzRuleVal(st,q){ return typeof st[q]==='number'?st[q]:1.5; }
export function wzRestOn(st){ return st.rest==='idk'?true:!!st.rest; }
export function wzFmtMult(v){ return '×'+(+v.toFixed(2)); }
export function wzCapText(lang,v){ return v>1?`+${Math.round((v-1)*100)}%`:wizT(lang,'cNone'); }
// Break durations tick within [0, 4h]: the total in 15-minute detents, the
// night portion in finer 5-minute detents (the overlap is fiddly to get exact).
export const WZ_BRK={min:0,max:240,inc:15,incNight:5};
export function wzDurNext(v,dir,inc){
  inc=inc||WZ_BRK.inc;
  const q=v/inc, eps=1e-9;
  const n=dir>0?Math.floor(q+eps)+1:Math.ceil(q-eps)-1;
  return Math.min(WZ_BRK.max,Math.max(WZ_BRK.min,Math.round(n*inc)));
}
export function wzFmtDur(lang,min){ return wizT(lang,'dur')(Math.floor(min/60),min%60); }
// Current break state, normalized: night portion defaults to "all of it" (a
// night shift's break usually falls at night) and can never exceed the total.
export function wzBreakOf(n){
  const tot=Math.max(0,n&&n.breakMin||0);
  const night=Math.min(tot,(n&&n.breakNightMin!=null)?Math.max(0,n.breakNightMin):tot);
  return {tot,night};
}
// One-time migration of older stored break forms into the duration pair the UI
// authors, derived through the SAME engine math that priced them — so the
// converted numbers reproduce the exact night/plain hours the user was paid.
export function wzNormBreak(st){
  const n=st.schedule&&st.schedule.night;
  if(!n) return;
  const win=st.window||{start:'22:00',end:'06:00'};
  const anchored=n.break&&n.break.start&&n.break.end;
  if(!anchored&&!((n.breakMin||0)>0&&n.breakNightMin==null)) return;
  const nh0=nightHoursOf({start:n.start,end:n.end},win);
  const nh1=nightHoursOf(n,win);
  if(nh0&&nh1){
    n.breakNightMin=Math.max(0,Math.round((nh0.nightHours-nh1.nightHours)*60));
    if(anchored)
      n.breakMin=Math.max(0,Math.round((nh0.nightHours+nh0.plainHours-nh1.nightHours-nh1.plainHours)*60));
  }
  delete n.break;
}
// Live preview rows: honest engine probes of the compiled profile — hours only
// (the wage isn't known yet on the onboarding rules step). Attaches the
// schedule exactly like wizardProfileFrom so the preview matches what SAVING
// would produce. Day-pattern users get day-relevant probes instead of a night line.
export function wzPreviewRows(st,lang,pattern){
  try{
    const answers=wizardAnswersFrom(st);
    if(pattern!=='day'&&st.schedule&&st.schedule.night) answers.schedule={night:{...st.schedule.night}};
    const p=compileProfileV2(answers);
    const g=(TR[lang]&&TR[lang].seg)||TR.en.seg;
    const probe=(cls,sh,h,hc)=>g.num(+(calcDay(p,{dayClass:cls,shift:sh,regHrs:h,otHrs:0,holCredit:hc!==false}).eff).toFixed(2));
    const W=k=>wizT(lang,k);
    // The night probe uses the schedule's PAID hours (shift minus unpaid break)
    // when overlap rules have one — so editing the times or toggling the break
    // moves the number, exactly as it will move real pay. Threshold/preset
    // rulebooks and day patterns keep the plain 8h probe.
    let nightH=8;
    if(p.night&&p.night.mode==='overlap'&&p.schedule&&p.schedule.night){
      const nh=nightHoursOf(p.schedule.night,p.night.window);
      if(nh) nightH=+((nh.plainHours+nh.nightHours).toFixed(2))||8;
    }
    const nightK=W('prevNightK').replace('8',g.num(nightH));
    // Day-pattern users AND profiles without a night rule (all new Customize
    // profiles) get day-relevant probes — a night line would just echo 8h→8h.
    const hasNight=!!(p.night&&p.night.mode&&p.night.mode!=='none'&&p.night.prem);
    return (pattern==='day'||!hasNight)
      ?[{cls:'sat',  k:W('prevSatK'),  v:W('prevV')(probe('saturday','day',8))},
        {cls:'hol',  k:W('prevHolK'),  v:W('prevV')(probe('holiday','day',8,false))}]
      :[{cls:'night',k:nightK,         v:W('prevV')(probe('weekday','night',nightH))},
        {cls:'sat',  k:W('prevSatK'),  v:W('prevV')(probe('saturday','day',8))}];
  }catch(e){ return []; }
}
// Does the current chip state compile to an overlap-mode night profile that
// needs the user's schedule? (Threshold presets like the factory never do.)
export function wizNeedsSchedule(st){
  try{ return needsNightSchedule(compileProfileV2(wizardAnswersFrom(st))); }
  catch(e){ return false; }
}

// ── Night Schedule page data — engine truth for the timeline preview ─────────
// Hours via nightHoursOf() (the exact function that prices real shifts) and the
// effective total via a calcDay probe of the compiled profile.
export function obxNightData(st){
  const n=st.schedule&&st.schedule.night;
  if(!n) return null;
  const win=st.window||{start:'22:00',end:'06:00'};
  const P=t=>{ const m=/^(\d{1,2}):(\d{2})$/.exec(t||''); return m?+m[1]*60+ +m[2]:null; };
  const s=P(n.start),e0=P(n.end),ws=P(win.start),we0=P(win.end);
  if(s==null||e0==null||ws==null||we0==null) return null;
  let e=e0; if(e<=s)e+=1440;
  let we=we0; if(we<=ws)we+=1440;
  // Premium/plain runs over the shift timeline — same sweep as nightHoursOf.
  const spans=[];
  for(const off of [-1440,0,1440]){
    const a=Math.max(s,ws+off),b=Math.min(e,we+off);
    if(b>a) spans.push([a,b]);
  }
  spans.sort((x,y)=>x[0]-y[0]);
  const runs=[]; let cur=s;
  for(const [a,b] of spans){
    if(a>cur) runs.push({prem:false,a:cur,b:a});
    runs.push({prem:true,a,b}); cur=b;
  }
  if(cur<e) runs.push({prem:false,a:cur,b:e});
  // Carve the unpaid break out of the tail of its runs (night portion from
  // premium, remainder from plain, spill mirrors the engine's eat() order) so
  // the bar shows break slices where the deduction actually lands.
  const {tot,night:bn}=wzBreakOf(n);
  const segs=runs.map(r=>({kind:r.prem?'prem':'plain',min:r.b-r.a}));
  const carve=(kind,amt)=>{
    for(let i=segs.length-1;i>=0&&amt>0;i--){
      if(segs[i].kind!==kind||!segs[i].min) continue;
      const take=Math.min(segs[i].min,amt);
      segs[i].min-=take; amt-=take;
      segs.splice(i+1,0,{kind:'brk',min:take});
    }
    return amt;
  };
  const nMin=Math.min(bn,tot);
  let rem=carve('prem',nMin);
  rem+=carve('plain',tot-nMin);
  if(rem>0) carve('prem',carve('plain',rem));
  const dur=e-s;
  const fmt=m=>{ const mm=((m%1440)+1440)%1440; return String(Math.floor(mm/60)).padStart(2,'0')+':'+String(mm%60).padStart(2,'0'); };
  // Clock labels at the run boundaries (positions are % of the shift).
  let labels=[{at:0,t:fmt(s)}];
  runs.forEach(r=>labels.push({at:(r.b-s)/dur*100,t:fmt(r.b)}));
  labels=labels.filter((l,i)=>i===0||l.at-labels[i-1].at>=0.5);
  // Prune middles that crowd the edges or each other (first/last always stay).
  labels=labels.filter((l,i)=>i===0||i===labels.length-1||(l.at>=10&&l.at<=90));
  const nh=nightHoursOf(n,win)||{plainHours:0,nightHours:0};
  const paidH=+(nh.plainHours+nh.nightHours).toFixed(2);
  let eff=paidH, mult=1;
  try{
    const answers=wizardAnswersFrom(st);
    answers.schedule={night:{...n}};
    const p=compileProfileV2(answers);
    mult=1+((p.night&&p.night.prem)||0);
    eff=+(calcDay(p,{dayClass:'weekday',shift:'night',regHrs:paidH,otHrs:0,holCredit:true}).eff).toFixed(2);
  }catch(err){}
  return {
    segs:segs.filter(x=>x.min>0), dur, labels, tot, bn,
    plainH:nh.plainHours, nightH:nh.nightHours,
    paidH, eff, bonus:Math.max(0,+(eff-paidH).toFixed(2)), mult,
    shiftTxt:`${n.start} – ${n.end}`,
  };
}
