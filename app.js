// ── firebase.js integration ──────────────────────────────────────────────────
// scheduleSync() is called after every data mutation so changes automatically
// propagate to Firestore when the user is signed in. If not signed in or offline,
// the call is a no-op and localStorage continues working as usual.
import { signInWithGoogle, signOutUser, scheduleSync, getSyncStatus } from './firebase.js';
import { TR, nightWeekdayEff, satNightEff, satDayEff } from './translations.js';

// ── Auth state (global, set by firebase.js) ─────────────────────────────────
// CURRENT_USER is the single source of truth for auth in the render layer.
// firebase.js calls setCURRENT_USER when onAuthStateChanged fires,
// which triggers render() so every part of the UI derives from this value.
let CURRENT_USER = null;
function setCURRENT_USER(user){ CURRENT_USER = user; render(); }
// updateSyncUI: lightweight badge refresh without full re-render
function updateSyncUI(){
  const badge=document.getElementById('sync-badge');
  if(!badge)return;
  const status=getSyncStatus();
  const icons={synced:'☁',pending:'⏳',offline:'⚡',idle:''};
  const tips={synced:'Synced',pending:'Syncing...',offline:'Offline — saved locally',idle:''};
  badge.textContent=icons[status]||'☁';
  badge.title=tips[status]||'';
  badge.dataset.status=status;
  badge.className='sync-badge sync-badge--'+status;
}
// Expose to window so firebase.js (a separate ES module) can call these.
// ES modules have isolated scopes — window is the only shared global.
window._appBridge = { setCURRENT_USER, updateSyncUI, get render(){ return render; } };

// ── Dynamic Korean Public Holidays ───────────────────────────────────────────
// Source: data.go.kr — Ministry of the Interior and Safety official holiday API.
// Includes all public holidays AND substitute holidays (대체공휴일) correctly.
// Cache key prefix changed to 'wt4_gov_' to avoid conflicts with old nager.at cache.

const GOV_API_KEY = '924a3cd75530bcef9d2c22f449897f23360fd49af3e16b085a170277ec1840ac';
const GOV_API_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';

let HOLIDAYS = {};    // "YYYY-MM-DD" → English name
let HOL_KO_DYN = {};  // "YYYY-MM-DD" → Korean name (dateName from API)
let HOL_LOADING = false;
const HOL_FETCHING = new Set(); // years currently in-flight — prevents duplicate concurrent fetches

// May 1st — Labour Day (근로자의 날) is under a separate act, not in the gov API.
// Always inject it manually for every year we load.
function applyFixedHolidays(years){
  years.forEach(y => {
    HOLIDAYS[`${y}-05-01`]    = 'Labour Day';
    HOL_KO_DYN[`${y}-05-01`] = '근로자의 날';
  });
}

// Parse the government API XML response into {enObj, koObj}
// The API returns <item> elements with <locdate> (YYYYMMDD) and <dateName> (Korean name).
function parseGovXML(xmlText){
  const enObj = {}, koObj = {};
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  // Check for API error
  const errMsg = doc.querySelector('returnReasonCode,errMsg');
  if(errMsg && errMsg.textContent !== '00') {
    console.warn('Gov API error:', errMsg.textContent);
    return {enObj, koObj};
  }
  const items = doc.querySelectorAll('item');
  items.forEach(item => {
    const locdate = item.querySelector('locdate')?.textContent?.trim();
    const dateName = item.querySelector('dateName')?.textContent?.trim();
    const isHoliday = item.querySelector('isHoliday')?.textContent?.trim();
    if(!locdate || !dateName || isHoliday === 'N') return;
    // Convert YYYYMMDD → YYYY-MM-DD
    const ds = `${locdate.slice(0,4)}-${locdate.slice(4,6)}-${locdate.slice(6,8)}`;
    koObj[ds] = dateName;
    // Best-effort English translation for common holidays
    enObj[ds] = translateHolidayName(dateName);
  });
  return {enObj, koObj};
}

// Translate Korean holiday names to English
function translateHolidayName(ko){
  const map = {
    '신정':           "New Year's Day",
    '설날':           'Lunar New Year',
    '설날 연휴':      'Lunar New Year Holiday',
    '삼일절':         'Independence Movement Day',
    '어린이날':       "Children's Day",
    '부처님오신날':   "Buddha's Birthday",
    '현충일':         'Memorial Day',
    '광복절':         'Liberation Day',
    '추석':           'Chuseok',
    '추석 연휴':      'Chuseok Holiday',
    '개천절':         'National Foundation Day',
    '한글날':         'Hangul Day',
    '성탄절':         'Christmas',
    '대체공휴일':     'Substitute Holiday',
    '근로자의 날':    'Labour Day',
  };
  // Exact match first, then partial
  if(map[ko]) return map[ko];
  for(const [k,v] of Object.entries(map)){
    if(ko.includes(k)) return v;
  }
  return ko; // fall back to Korean if no translation found
}

// Fetch all 12 months of a year from the gov API (one request per month, run in parallel)
async function fetchHolidaysForYear(year){
  // Skip if already in-flight for this year
  if(HOL_FETCHING.has(year)) return;
  const cacheKey = 'wt4_gov_' + year;
  const cached = localStorage.getItem(cacheKey);
  if(cached){
    try{
      const {en, ko} = JSON.parse(cached);
      Object.assign(HOLIDAYS, en);
      Object.assign(HOL_KO_DYN, ko);
      return;
    }catch(e){}
  }
  HOL_FETCHING.add(year);
  try{
    // Fetch months sequentially in small batches to avoid 429s.
    // 3 at a time with a small gap is well within typical rate limits.
    const months = Array.from({length:12}, (_,i) => String(i+1).padStart(2,'0'));
    const enObj = {}, koObj = {};
    for(let i = 0; i < months.length; i += 3){
      const batch = months.slice(i, i+3);
      const results = await Promise.all(batch.map(async mm => {
        const url = `${GOV_API_BASE}?serviceKey=${GOV_API_KEY}&solYear=${year}&solMonth=${mm}&numOfRows=20&_type=xml`;
        const res = await fetch(url);
        if(!res.ok){
          if(res.status === 429) console.warn('[holidays] Rate limited for', year, mm, '— will retry on next load');
          return {enObj:{}, koObj:{}};
        }
        const xml = await res.text();
        return parseGovXML(xml);
      }));
      results.forEach(({enObj:e, koObj:k}) => { Object.assign(enObj, e); Object.assign(koObj, k); });
      // Small gap between batches to stay under rate limit
      if(i + 3 < months.length) await new Promise(r => setTimeout(r, 120));
    }
    Object.assign(HOLIDAYS, enObj);
    Object.assign(HOL_KO_DYN, koObj);
    // Only cache if we got actual data (partial 429 responses shouldn't overwrite a good cache)
    if(Object.keys(enObj).length > 0 || Object.keys(koObj).length > 0){
      localStorage.setItem(cacheKey, JSON.stringify({en:enObj, ko:koObj, fetchedAt: Date.now()}));
    }
    applyFixedHolidays([year]);
  }catch(e){
    console.warn('Gov holiday fetch failed for', year, e.message);
  }finally{
    HOL_FETCHING.delete(year);
  }
}

// Seed from cache immediately on startup (zero network, zero flicker)
(function seedFromCache(){
  const y = new Date().getFullYear();
  for(let yr = y-1; yr <= y+2; yr++){
    // Clear old nager.at cache entries if still present
    localStorage.removeItem('wt4_hol_'+yr);
    localStorage.removeItem('wt4_hol_ko_'+yr);
    // Load from new gov cache
    const cached = localStorage.getItem('wt4_gov_'+yr);
    if(cached){
      try{
        const {en, ko} = JSON.parse(cached);
        Object.assign(HOLIDAYS, en);
        Object.assign(HOL_KO_DYN, ko);
      }catch(e){}
    }
  }
  applyFixedHolidays([y-1, y, y+1, y+2]);
})();

// Ensures holidays for the years we need are loaded; fetches missing years async.
async function ensureHolidays(years){
  applyFixedHolidays(years);
  // A year needs fetch if: not cached, or cached data is over 30 days old, AND not already in-flight
  const missing = years.filter(y => {
    if(HOL_FETCHING.has(y)) return false; // already being fetched — skip
    const raw = localStorage.getItem('wt4_gov_'+y);
    if(!raw) return true;
    try{
      const {fetchedAt} = JSON.parse(raw);
      const thirtyDays = 30 * 24 * 3600 * 1000;
      return (Date.now() - (fetchedAt||0)) > thirtyDays;
    }catch(e){ return true; }
  });
  if(!missing.length) return;
  HOL_LOADING = true;
  await Promise.all(missing.map(fetchHolidaysForYear));
  HOL_LOADING = false;
  render();
}

// Prefetch on startup in the background
function prefetchHolidays(){
  const y = new Date().getFullYear();
  ensureHolidays([y-1, y, y+1, y+2]);
}


const DEFAULT_WAGE=10320,TAX=0.033;
function ld(k,d){try{const v=localStorage.getItem(k);return v!==null?JSON.parse(v):d;}catch{return d;}}
function sv(k,v){localStorage.setItem(k,JSON.stringify(v));}
function pad(n){return String(n).padStart(2,'0');}
function mkds(y,m,d){return`${y}-${pad(m+1)}-${pad(d)}`;}
function pd(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
function today(){const d=new Date();return mkds(d.getFullYear(),d.getMonth(),d.getDate());}
function dowOf(s){return pd(s).getDay();}
function getLogs(){return ld('wt4_logs',{});}
function saveLogs(l){sv('wt4_logs',l);scheduleSync();}
function getShifts(){return ld('wt4_shifts',{});}
function saveShifts(s){sv('wt4_shifts',s);scheduleSync();}
// ── Wage history ──────────────────────────────────────────────────────────────
// Stored as wt4_wages: [{date:'YYYY-MM-DD', amount:number}, ...] sorted by date.
// wageFor(dateStr) returns the wage active on that date (most recent entry ≤ date).
// Migration: if the old scalar wt4_wage key is present, import it as the
// initial entry dated '2000-01-01' so all historical logs keep their value.
function getWages(){
  const wages = ld('wt4_wages', null);
  if(wages){
    // Migrate: replace the placeholder 2000-01-01 origin date with the real minimum wage effective date
    let dirty = false;
    wages.forEach(e=>{ if(e.date==='2000-01-01'){e.date='2026-01-01';dirty=true;} });
    if(dirty) sv('wt4_wages', wages);
    return wages;
  }
  // Migrate from legacy scalar key
  const legacy = ld('wt4_wage', null);
  const initial = [{date:'2026-01-01', amount: legacy !== null ? legacy : DEFAULT_WAGE}];
  sv('wt4_wages', initial);
  localStorage.removeItem('wt4_wage');
  return initial;
}
function saveWages(wages){ sv('wt4_wages', wages); scheduleSync(); }
function wageFor(dateStr){
  const wages = getWages();
  // wages is sorted ascending by date; find the last entry whose date ≤ dateStr
  let active = DEFAULT_WAGE;
  for(const {date, amount} of wages){
    if(date <= dateStr) active = amount;
    else break;
  }
  return active;
}
// Current wage (for display in settings / modal default)
function getWage(){ return wageFor(today()); }
function isHol(s){return!!HOLIDAYS[s];}
// The API returns the Korean local name directly (localName field).
// We use that for all languages since it's already in Korean from the government API.
// For English/Indonesian we use the English name (name field) which we store as the value.
// Since date.nager.at gives localName (Korean) as the value, we store both.
// Implementation: we store localName as primary. To get English, we keep a parallel en map.
function holName(s){
  if(S.lang==='ko') return HOL_KO_DYN[s] || HOLIDAYS[s] || s;
  return HOLIDAYS[s] || s;
}
function isSun(s){return dowOf(s)===0;}
function isSat(s){return dowOf(s)===6;}
function applyTax(g){return Math.round(g*(1-TAX));}

// ── Shift: anchor-based propagation forward indefinitely ─────────────────────
function getMonday(s){
  const d=pd(s),day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);
  const m=new Date(d);m.setDate(diff);
  return mkds(m.getFullYear(),m.getMonth(),m.getDate());
}

function shiftFor(s){
  const sh=getShifts(),ws=getMonday(s);
  const keys=Object.keys(sh).filter(k=>k<=ws).sort();
  if(!keys.length)return'day';
  const anchor=keys[keys.length-1];
  const anchorShift=sh[anchor];
  // Fixed-shift detection: if the two most recent anchors at or before this week
  // share the same value, the user is on a fixed pattern — skip the alternating formula.
  if(keys.length>=2 && sh[keys[keys.length-2]]===anchorShift) return anchorShift;
  const msPerWeek=7*24*3600*1000;
  const weeks=Math.round((pd(ws)-pd(anchor))/msPerWeek);
  return weeks%2===0?anchorShift:(anchorShift==='day'?'night':'day');
}

function setShiftFromWeek(ws,shift){
  // Remove anchors set after ws (they're superseded), set new anchor
  const sh=getShifts();
  Object.keys(sh).filter(k=>k>=ws).forEach(k=>delete sh[k]);
  sh[ws]=shift;
  saveShifts(sh);
}

function toggleShift(ws){
  setShiftFromWeek(ws, shiftFor(ws)==='day'?'night':'day');
}

// ── Sunday auto-credit: all Mon–Fri of that week must be logged ──────────────
function allWeekdaysLogged(s){
  // Monday through Friday only — Saturday ignored.
  // Public holidays are also ignored.

  const logs = getLogs();
  const ws = getMonday(s);

  for(let i = 0; i <= 4; i++){
    const d = pd(ws);
    d.setDate(d.getDate() + i);

    const ds = mkds(
      d.getFullYear(),
      d.getMonth(),
      d.getDate()
    );

    // If not logged and not a holiday → incomplete
    if(!logs[ds] && !isHol(ds)){
      return false;
    }
  }

  return true;
}

// ── Wage calculation ──────────────────────────────────────────────────────────
// calcSatLike: used for Saturday, Holidays (worked), and Sundays (worked).
// mode: 'saturday' | 'holiday' | 'sunday' — controls display labels only, not formulas.
function calcSatLike(shift,regHrs,otHrs,tr,mode){
  let eff=0,notes=[];
  // Pick label functions based on mode — formulas are identical regardless
  const labelBase = mode==='holiday' ? (shift==='day'?tr.nHolDay:tr.nHolNight)
                  : mode==='sunday'  ? (shift==='day'?tr.nSunDay:tr.nSunNight)
                  :                    (shift==='day'?tr.nSatDay:tr.nSatNight);
  const labelOT   = mode==='holiday' ? (shift==='day'?tr.nHolDayOT:tr.nHolNightOT)
                  : mode==='sunday'  ? (shift==='day'?tr.nSunDayOT:tr.nSunNightOT)
                  :                    (shift==='day'?tr.nSatDayOT:tr.nSatNightOT);
  if(shift==='day'){
    eff=satDayEff(regHrs);notes.push(labelBase(regHrs));
    if(otHrs>0){const e=+(otHrs*1.5).toFixed(2);eff=+(eff+e).toFixed(2);notes.push(labelOT(otHrs));}
  }else{
    eff=satNightEff(regHrs);notes.push(labelBase(regHrs));
    if(otHrs>0){const e=+(otHrs*2).toFixed(2);eff=+(eff+e).toFixed(2);notes.push(labelOT(otHrs));}
  }
  return{eff,notes};
}

function calcWage(dateStr,regHrs,otHrs,wage,shiftOverride){
  const shift=shiftOverride||shiftFor(dateStr);
  const holDay=isHol(dateStr),sun=isSun(dateStr)&&!isHol(dateStr),sat=isSat(dateStr)&&!isHol(dateStr);
  const tr=TR[S.lang];
  let eff=0,notes=[];

  // ── Double shift ────────────────────────────────────────────────────────────
  // Fixed formula regardless of day type — no regHrs/otHrs inputs.
  // Weekday : 8 day  + nightWeekdayEff(8) night = 8 + 9.16 = 17.16... wait,
  // per spec: weekday=21.16, sat=25.16, sun/hol=33.16
  // 21.16 = 8 (day weekday) + 13.16 (sat night eff of 8) = correct
  // 25.16 = 12 (sat day eff of 8) + 13.16 = correct
  // 33.16 = 8 (auto) + 12 + 13.16 = correct
  if(shift==='double'){
    const nightEff=+(satNightEff(8)).toFixed(2); // 13.16
    const dayWeekdayEff=8;
    const daySatEff=+(8/8*12).toFixed(2);        // 12
    if(sun||holDay){
      eff=+(8+daySatEff+nightEff).toFixed(2);    // 8+12+13.16=33.16
      notes.push(tr.nDoubleHolSun);
    }else if(sat){
      eff=+(daySatEff+nightEff).toFixed(2);      // 12+13.16=25.16
      notes.push(tr.nDoubleSat);
    }else{
      eff=+(dayWeekdayEff+nightEff).toFixed(2);  // 8+13.16=21.16
      notes.push(tr.nDoubleWeekday);
    }
    const g=Math.round(eff*wage);return{gross:g,net:applyTax(g),eff,notes};
  }

  // Sunday: auto 8h base always; if worked (regHrs>0 or otHrs>0), calc like Saturday
  if(sun){
    const hasWork=(regHrs>0||otHrs>0);
    if(hasWork){
      // 8h auto-base + worked hours calculated like Saturday
      notes.push(tr.nHolBase);// reuse "8h auto-credited" note
      eff=8;
      const worked=calcSatLike(shift,regHrs,otHrs,tr,'sunday');
      // Sunday worked: the worked portion is on top of the 8h base
      eff=+(8+worked.eff).toFixed(2);
      notes.push(...worked.notes);
    }else{
      notes.push(tr.nSun);
      eff=8;
    }
    const g=Math.round(eff*wage);return{gross:g,net:applyTax(g),eff,notes};
  }

  // Public Holiday: always 8h base; worked hours calc like Saturday (same shift multipliers)
  if(holDay){
    notes.push(tr.nHolBase);
    eff=8;
    if(regHrs>0||otHrs>0){
      const worked=calcSatLike(shift,regHrs,otHrs,tr,'holiday');
      eff=+(8+worked.eff).toFixed(2);
      notes.push(...worked.notes);
    }
    const g=Math.round(eff*wage);return{gross:g,net:applyTax(g),eff,notes};
  }

  // Saturday
  if(sat){
    const r=calcSatLike(shift,regHrs,otHrs,tr,'saturday');
    eff=r.eff;notes=r.notes;
    const g=Math.round(eff*wage);return{gross:g,net:applyTax(g),eff,notes};
  }

  // Normal weekday
  if(shift==='day'){
    eff=regHrs;notes.push(tr.nDay(regHrs));
    if(otHrs>0){const e=+(otHrs*1.5).toFixed(2);eff=+(eff+e).toFixed(2);notes.push(tr.nDayOT(otHrs));}
  }else{
    // Night weekday: 5.68+(H-5.68)*1.5 when H>5.68
    eff=nightWeekdayEff(regHrs);notes.push(tr.nNight(regHrs));
    if(otHrs>0){const e=+(otHrs*2).toFixed(2);eff=+(eff+e).toFixed(2);notes.push(tr.nNightOT(otHrs));}
  }
  const g=Math.round(eff*wage);return{gross:g,net:applyTax(g),eff,notes};
}

// ── State ─────────────────────────────────────────────────────────────────────
let S={
  lang:ld('wt4_lang','en'),theme:ld('wt4_theme','dark'),
  tab:'calendar',calY:new Date().getFullYear(),calM:new Date().getMonth(),
  modal:null,mReg:undefined,mOT:undefined,mShift:undefined,success:''
};
function t(k,...a){const fn=TR[S.lang][k];return typeof fn==='function'?fn(...a):(fn||k);}
function applyTheme(){document.documentElement.setAttribute('data-theme',S.theme);}

// ── Single source of truth for earnings on a given date ────────────────────────────
// liveGross(ds, logs?) always recomputes gross from stored hours × wageFor(ds).
// This ensures wage history changes are reflected everywhere immediately —
// no stale gross/net values baked into log entries are ever used for display.
//
// For logged days:  recompute via calcWage using stored regHrs/otHrs/shiftOverride.
// For auto-credits: 8h × wageFor(ds) (holidays and qualifying Sundays).
// For everything else: 0.
//
// Pass a pre-fetched logs object to avoid repeated localStorage reads in loops.
function liveGross(ds, logsArg){
  const logs = logsArg !== undefined ? logsArg : getLogs();
  const w = wageFor(ds);
  if(logs[ds]){
    const l = logs[ds];
    // Recompute from the raw inputs saved with the entry.
    // regHrs/otHrs are present in all entries saved after the wage-history feature.
    // Older entries used a single 'hrs' field — fall back gracefully.
    const reg = l.regHrs !== undefined ? l.regHrs : (l.hrs || 0);
    const ot  = l.otHrs  !== undefined ? l.otHrs  : 0;
    return calcWage(ds, reg, ot, w, l.shiftOverride).gross;
  }
  const todayStr = today();
  if(isHol(ds) && ds <= todayStr) return Math.round(8 * w);
  if(isSun(ds) && !isHol(ds) && ds <= todayStr && allWeekdaysLogged(ds)) return Math.round(8 * w);
  return 0;
}

// autoGross / autoEff: wrappers used throughout the render layer.
// autoGross delegates entirely to liveGross — one definition, no divergence.
function autoGross(ds, logsArg){
  return liveGross(ds, logsArg);
}
function autoEff(ds, logsArg){
  const logs = logsArg !== undefined ? logsArg : getLogs();
  if(logs[ds]) return logs[ds].eff || 0;
  const todayStr = today();
  if(isHol(ds) && ds <= todayStr) return 8;
  if(isSun(ds) && !isHol(ds) && ds <= todayStr && allWeekdaysLogged(ds)) return 8;
  return 0;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(){
  applyTheme();
  document.getElementById('app').innerHTML=buildApp();
  attachListeners();
  if(S.modal)buildModal();
}

function buildApp(){
  const shift=shiftFor(today());
  // Sync badge — only shown when signed in; status from firebase.js
  const ss=getSyncStatus();
  const ssIcon={synced:'☁',pending:'⏳',offline:'⚡',idle:''}[ss]||'';
  const ssTip={synced:'Synced',pending:'Syncing...',offline:'Offline — saved locally',idle:''}[ss]||'';
  const syncHTML=CURRENT_USER
    ?`<span id="sync-badge" class="sync-badge sync-badge--${ss}" title="${ssTip}">${ssIcon}</span>`
    :'';
  // Account trigger — avatar or initial; dropdown is a body-level portal (see attachListeners)
  const accountHTML=CURRENT_USER
    ?`<button class="hdr-icon-btn" id="account-btn" title="${CURRENT_USER.displayName||CURRENT_USER.email}">
        ${CURRENT_USER.photoURL
          ?`<img src="${CURRENT_USER.photoURL}" class="avatar" alt="">`
          :`<span class="avatar-initials">${(CURRENT_USER.displayName||CURRENT_USER.email||'?')[0].toUpperCase()}</span>`}
      </button>`
    :`<button id="auth-login" class="auth-btn auth-btn-in">${t('signIn')}</button>`;
  // Language trigger only — dropdown is a body-level portal (see attachListeners)
  const langHTML=`<button class="hdr-icon-btn" id="lang-btn" title="Language">🌐</button>`;
  return`<div class="hdr">
    <div>
      <div class="hdr-title">${t('appTitle')}</div>
      <div class="hdr-sub">${t('thisWeek')}: ${shift==='day'?'☀ '+t('dayShift'):'☾ '+t('nightShift')}</div>
    </div>
    <div class="hdr-right">
      ${syncHTML}
      <button class="hdr-icon-btn" id="theme-toggle" title="Toggle theme">${S.theme==='dark'?'☀':'🌙'}</button>
      ${langHTML}
      ${accountHTML}
    </div>
  </div>
  ${buildStats()}
  <div class="tab-row">
    <button class="tab${S.tab==='calendar'?' on':''}" data-tab="calendar">${t('tabCal')}</button>
    <button class="tab${S.tab==='overview'?' on':''}" data-tab="overview">${t('tabOverview')}</button>
    <button class="tab${S.tab==='settings'?' on':''}" data-tab="settings">${t('tabSet')}</button>
  </div>
  ${S.tab==='calendar'?buildCal():S.tab==='overview'?buildOverview():buildSettings()}`;
}

function buildStats(){
  const daysInM=new Date(S.calY,S.calM+1,0).getDate();
  let days=0,hrs=0,gross=0;
  const logs=getLogs();
  for(let d=1;d<=daysInM;d++){
    const ds=mkds(S.calY,S.calM,d);
    const g=autoGross(ds,logs),e=autoEff(ds,logs);
    // Count a day if it earned anything, OR if it was explicitly logged with 0 hours
    if(g>0||(logs[ds]&&(logs[ds].regHrs===0&&logs[ds].otHrs===0))){days++;gross+=g;hrs+=e;}
  }
  const net=applyTax(gross);
  return`<div class="stats-row">
    <div class="stat"><div class="stat-lbl">${t('statDays')} — ${t('mn')[S.calM]}</div><div class="stat-val">${days}</div></div>
    <div class="stat"><div class="stat-lbl">${t('statHours')} — ${t('mn')[S.calM]}</div><div class="stat-val blu">${hrs.toFixed(1)}h</div></div>
    <div class="stat"><div class="stat-lbl">${t('statNet')} — ${t('mn')[S.calM]}</div><div class="stat-val grn">₩${net.toLocaleString()}</div></div>
  </div>`;
}

function getWeekStarts(y,m){
  const days=new Date(y,m+1,0).getDate(),seen=new Set(),weeks=[];
  for(let d=1;d<=days;d++){const s=mkds(y,m,d),mon=getMonday(s);if(!seen.has(mon)){seen.add(mon);weeks.push(mon);}}
  return weeks;
}

function buildCal(){
  const y=S.calY,m=S.calM,firstDay=new Date(y,m,1).getDay(),daysInM=new Date(y,m+1,0).getDate();
  // Ensure holidays for this year (and adjacent) are loaded; re-renders when done if needed
  ensureHolidays([y-1, y, y+1]);
  const todayStr=today(),logs=getLogs(),dh=t('dh');
  const weeks=getWeekStarts(y,m);
  const wkBtns=weeks.map(ws=>{
    const sh=shiftFor(ws),d=pd(ws);
    return`<button class="wsb ${sh==='day'?'day-on':'night-on'}" data-ws="${ws}">${sh==='day'?'☀':'☾'} ${d.getMonth()+1}/${d.getDate()}</button>`;
  }).join('');
  let cells='';
  for(let i=0;i<firstDay;i++)cells+=`<div class="dc empty"></div>`;
  for(let d=1;d<=daysInM;d++){
    const s=mkds(y,m,d),dw=new Date(y,m,d).getDay();
    const future=s>todayStr,logged=!!logs[s],hol=isHol(s),tod=s===todayStr;
    const sun=dw===0,autoSun=sun&&!hol&&!logged&&!future&&allWeekdaysLogged(s);
    const autoHol=hol&&!logged&&!future; // includes holiday Sundays
    let cls='dc';
    if(future)cls+=' future';if(dw===0)cls+=' csun';if(dw===6)cls+=' csat';
    if(hol)cls+=' hol';
    if(logged)cls+=' logged';
    else if(autoSun||autoHol)cls+=' auto-cred';
    if(tod)cls+=' today';
    const dot=logged?`<div class="dot"></div>`:(autoSun||autoHol)?`<div class="adot"></div>`:hol?`<div class="hdot"></div>`:'';
    cells+=`<div class="${cls}" data-date="${s}"><div class="dn">${d}</div>${dot}</div>`;
  }
  const holChips=Object.entries(HOLIDAYS).filter(([s])=>s.startsWith(`${y}-${pad(m+1)}`))
    .map(([s])=>`<span class="hchip">● ${pd(s).getDate()} ${holName(s)}</span>`).join('');
  return`<div class="card">
    <div class="cal-hdr">
      <button class="cal-nav" id="cal-prev">‹</button>
      <div class="cal-month">${t('mn')[m]} ${y}</div>
      <button class="cal-nav" id="cal-next">›</button>
    </div>
    <div class="shift-hint">${t('shiftHint')}</div>
    <div class="week-bar">${wkBtns}</div>
    <div class="cal-grid">
      ${dh.map((d,i)=>`<div class="dh${i===0?' sun':i===6?' sat':''}">${d}</div>`).join('')}
      ${cells}
    </div>
    ${holChips?`<div class="hol-list">${holChips}</div>`:''}
  </div>
  <div style="font-size:11px;color:var(--text-hint);text-align:center;margin-top:-6px;">${t('calHint')}</div>`;
}

function buildOverview(){
  const logs=getLogs(),todayStr=today();
  const allEntries=Object.entries(logs);
  if(!allEntries.length) return`<div class="ov-empty">${t('ovNoData')}</div>`;

  // ── Per-month aggregation ──────────────────────────────────────────────────
  // Mirrors buildStats() exactly: iterate every calendar day up to today,
  // using autoGross() so auto-credited holidays and Sundays are included in
  // ALL months, not just the current one. This ensures Best Month always
  // matches the Calendar tab's monthly total.
  const monthData={};
  function ensureMonth(ym){ if(!monthData[ym]) monthData[ym]={net:0,gross:0,days:0,overtimeNet:0,topDay:null}; }

  // Derive the range of months to scan from the log keys (plus current month).
  const now=new Date(),curY=now.getFullYear(),curMo=now.getMonth();
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
      const isZeroDay=isLogged&&(logs[ds].regHrs===0&&logs[ds].otHrs===0);
      if(g>0||isZeroDay){
        ensureMonth(ym);
        const m=monthData[ym];
        const net=applyTax(g);
        m.net+=net; m.gross+=g; m.days++;
        // Overtime = earnings beyond the plain base for that day type
        const l=logs[ds];
        const sh=(l&&l.shiftOverride)||shiftFor(ds);
        const baseEff=sh==='double'
          ? ((isSun(ds)||isHol(ds)) ? 33.16 : isSat(ds) ? 25.16 : 21.16)
          : sh==='night'?nightWeekdayEff(8):8;  // 9.16 derived, not hardcoded
        const basePay=applyTax(Math.round(Math.min(e,baseEff)*wageFor(ds)));
        m.overtimeNet+=Math.max(0,net-basePay);
        if(!m.topDay||net>m.topDay.net) m.topDay={ds,net};
      }
    }
  });

  const daysInCur=new Date(curY,curMo+1,0).getDate();

  const months=Object.keys(monthData).sort();
  const curData=monthData[curYM]||{net:0,gross:0,days:0,overtimeNet:0,topDay:null};
  const curBaseNet=Math.max(0,curData.net-curData.overtimeNet);

  // ── Pattern-based projection ───────────────────────────────────────────────
  // Days are classified into three buckets:
  //   'weekday'  — Mon–Fri that are NOT public holidays
  //   'sat'      — Saturdays that are NOT public holidays
  //   'sunhol'   — Sundays (plain or holiday) AND weekday/Saturday public holidays
  // This matches how wages are actually calculated (holiday rules apply regardless of DOW).
  function classifyDay(ds){
    if(isHol(ds)) return 'sunhol';   // holiday overrides DOW (Mon holiday → sunhol rate)
    if(isSun(ds)) return 'sunhol';
    if(isSat(ds)) return 'sat';
    return 'weekday';
  }

  // Weighted average: 70% recent half, 30% older half (entries sorted oldest→newest).
  function weightedAvg(entries){
    if(!entries.length) return 0;
    if(entries.length===1) return entries[0].net;
    const mid=Math.ceil(entries.length/2);
    const recent=entries.slice(mid), older=entries.slice(0,mid);
    const avg=arr=>arr.reduce((s,e)=>s+e.net,0)/arr.length;
    return (recent.length && older.length)
      ? avg(recent)*0.7 + avg(older)*0.3
      : avg(entries);
  }

  // Build an earnings bucket for a given year-month string.
  // Includes both manually logged entries AND auto-credited sun/hol days (8h × wage).
  // Auto-credited days are what actually appear in the user's income — omitting them
  // would make avgSunhol ≈ 0, projecting ₩0 for every future Sunday/holiday.
  function buildMonthEntries(ym){
    const [yStr,mStr]=ym.split('-');
    const y=parseInt(yStr),mo=parseInt(mStr)-1;
    const daysInMo=new Date(y,mo+1,0).getDate();
    const isCurrent=ym===curYM;
    const cutoff=isCurrent?todayStr:`${ym}-${pad(daysInMo)}`; // whole month for past months
    const bucket={weekday:[],sat:[],sunhol:[]};

    for(let d=1;d<=daysInMo;d++){
      const ds=mkds(y,mo,d);
      if(ds>cutoff) break;
      const cls=classifyDay(ds);
      // Always use liveGross so projection averages reflect current wage history
      const g=autoGross(ds,logs);
      // Exclude double-shift days from the average — they're outliers that would
      // inflate projections. They still count toward actual earned totals via curData.
      if(g>0 && logs[ds]?.shiftOverride!=='double') bucket[cls].push({net:applyTax(g), ds});
    }
    // Sort oldest→newest within each bucket so the 70/30 weight is time-ordered
    ['weekday','sat','sunhol'].forEach(k=>bucket[k].sort((a,b)=>a.ds.localeCompare(b.ds)));
    return bucket;
  }

  const curEntries=buildMonthEntries(curYM);
  const curWorkedTotal=curEntries.weekday.length+curEntries.sat.length+curEntries.sunhol.length;
  const FALLBACK_THRESHOLD=5;

  // Fall back to the most recent previous month with sufficient data (<5 days this month).
  function getPrevMonthEntries(){
    const prevMonths=months.filter(ym=>ym<curYM).sort().reverse(); // newest first
    for(const ym of prevMonths){
      const e=buildMonthEntries(ym);
      const total=e.weekday.length+e.sat.length+e.sunhol.length;
      if(total>=FALLBACK_THRESHOLD) return e;
    }
    return null;
  }

  let avgSrc=curEntries;
  let usingFallback=false;
  if(curWorkedTotal<FALLBACK_THRESHOLD){
    const prev=getPrevMonthEntries();
    if(prev){avgSrc=prev; usingFallback=true;}
  }

  const avgWeekday=weightedAvg(avgSrc.weekday);
  const avgSat    =weightedAvg(avgSrc.sat);
  // For sunhol: if current month has no logged sunhol data at all, blend with a
  // plain 8h-day estimate so the projection doesn't collapse to ₩0.
  const avgSunholRaw=weightedAvg(avgSrc.sunhol);
  // Fallback: use the wage active at end-of-month rather than today,
  // so a mid-month wage change is reflected in the projection.
  const avgSunhol=avgSunholRaw>0
    ? avgSunholRaw
    : applyTax(Math.round(8*wageFor(`${curYM}-${pad(daysInCur)}`)));

  // Count remaining days of each type after today (future logs already counted in curData).
  let remWeekday=0,remSat=0,remSunhol=0;
  for(let d=1;d<=daysInCur;d++){
    const ds=mkds(curY,curMo,d);
    if(ds<=todayStr) continue;      // past/today already in curData.net
    if(logs[ds]) continue;          // manually logged future day already in curData.net
    const cls=classifyDay(ds);
    if(cls==='weekday') remWeekday++;
    else if(cls==='sat') remSat++;
    else remSunhol++;
  }

  // Projected = actual earned so far + remaining days × per-type weighted average
  const projection=Math.round(
    curData.net
    + remWeekday * avgWeekday
    + remSat     * avgSat
    + remSunhol  * avgSunhol
  );

  // Best month (exclude current for the "past best" card)
  let bestYM=null,bestNet=0;
  months.forEach(ym=>{ if(monthData[ym].net>bestNet){bestNet=monthData[ym].net;bestYM=ym;} });
  const pastBestYM = bestYM===curYM ? (months.length>1?months.slice(0,-1).reduce((a,b)=>monthData[a].net>monthData[b].net?a:b):null) : bestYM;

  const mnames=t('mn');
  function fmtYM(ym){ const[y,m]=ym.split('-'); return`${mnames[parseInt(m)-1]} ${y}`; }

  // Chart data — up to 7 months, oldest→newest; current month uses projection.
  // Stored on a module-level var so renderTrendChart() reads the same values
  // without re-computing separately (which caused the mismatch).
  const chartMonths=months.slice(-7);
  const chartLabels=chartMonths.map(ym=>{ const[,m]=ym.split('-'); return mnames[parseInt(m)-1]; });
  const chartValues=chartMonths.map(ym=>ym===curYM?projection:monthData[ym].net);
  _trendChartData={labels:chartLabels,values:chartValues,curYM};

  // Best Single Day across ALL logged days (not just current month)
  let allTimeTopDay=null;
  months.forEach(ym=>{ const td=monthData[ym].topDay; if(td&&(!allTimeTopDay||td.net>allTimeTopDay.net)) allTimeTopDay=td; });

  return`<div class="ov-wrap">

    <div class="ov-month-label">${fmtYM(curYM)}</div>

    <!-- Hero: total estimate -->
    <div class="ov-hero">
      <div class="ov-hero-label">${t('ovEstTotal')}</div>
      <div class="ov-hero-value">₩${projection.toLocaleString()}</div>
      <div class="ov-hero-pills">
        <span class="ov-pill ov-pill--base">⬜ ${t('ovBaseEarnings')} <strong>₩${curBaseNet.toLocaleString()}</strong></span>
        <span class="ov-pill ov-pill--ot">✦ ${t('ovOvertimeDesc')} <strong>₩${curData.overtimeNet.toLocaleString()}</strong></span>
      </div>
    </div>

    <!-- Best Month + Highest Day — side by side premium cards -->
    <div class="ov-pair-row">
      ${pastBestYM?`
      <div class="ov-pair-card">
        <div class="ov-pair-icon">🏆</div>
        <div class="ov-pair-label">${t('ovBestMonth')}</div>
        <div class="ov-pair-sub">${fmtYM(pastBestYM)}</div>
        <div class="ov-pair-val ov-pair-val--gold">₩${monthData[pastBestYM].net.toLocaleString()}</div>
      </div>`:`<div class="ov-pair-card ov-pair-card--empty"><div class="ov-pair-icon">🏆</div><div class="ov-pair-label">${t('ovBestMonth')}</div><div class="ov-pair-val">—</div></div>`}
      <div class="ov-pair-card">
        <div class="ov-pair-icon">💎</div>
        <div class="ov-pair-label">${t('ovHighestDay')}</div>
        <div class="ov-pair-sub">${allTimeTopDay?allTimeTopDay.ds:'—'}</div>
        <div class="ov-pair-val ov-pair-val--blue">${allTimeTopDay?'₩'+allTimeTopDay.net.toLocaleString():'—'}</div>
      </div>
    </div>

    <!-- Earnings trend line chart -->
    ${chartMonths.length>1?`
    <div class="ov-chart-card">
      <div class="ov-chart-header">
        <span class="ov-chart-title">Earnings Trend</span>
        <span class="ov-chart-cur-badge">● ${fmtYM(curYM)}</span>
      </div>
      <div class="ov-chart-wrap">
        <canvas id="ov-trend-chart" height="160"></canvas>
      </div>
    </div>`:''}

  </div>
  <div style="font-size:11px;color:var(--text-hint);text-align:center;margin-top:-6px;">${t('calHint')}</div>`;
  // Chart is rendered after the DOM is injected — see renderTrendChart() called from attachListeners
}

// ── Trend chart (Chart.js, lazy-loaded) ──────────────────────────────────────
// A single module-level ref so we can destroy before re-creating on each render.
let _trendChart = null;
// Populated by buildOverview() so renderTrendChart() shares the same numbers.
let _trendChartData = null;

async function renderTrendChart(){
  const canvas = document.getElementById('ov-trend-chart');
  if(!canvas) return;

  // Lazy-load Chart.js from CDN — cached after first load
  if(!window.Chart){
    try{
      await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js');
    }catch(e){
      console.warn('[chart] Chart.js load failed:', e);
      return;
    }
  }

  // Destroy previous instance to prevent memory leaks on re-render
  if(_trendChart){ _trendChart.destroy(); _trendChart=null; }

  // Use the data already computed by buildOverview() — single source of truth.
  // This guarantees chart bars match the Calendar tab totals exactly.
  if(!_trendChartData) return;
  const {labels, values} = _trendChartData;
  if(labels.length<2) return;

  // Theme-aware colours
  const isDark=S.theme==='dark';
  const lineColor  = isDark ? 'rgba(108,142,255,1)'    : 'rgba(58,95,255,1)';
  const glowColor  = isDark ? 'rgba(108,142,255,0.18)' : 'rgba(58,95,255,0.1)';
  const dotColor   = isDark ? '#6c8eff'                : '#3a5fff';
  const lastColor  = isDark ? '#34d47a'                : '#18a958';
  const labelColor = isDark ? 'rgba(107,117,153,0.9)'  : 'rgba(99,112,160,0.9)';
  const gridColor  = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(99,115,177,0.06)';

  // Point colors: last point is green (current/projected), rest are primary
  const pointBg  = values.map((_,i)=>i===values.length-1?lastColor:dotColor);
  const pointBdr = values.map((_,i)=>i===values.length-1?lastColor:dotColor);
  const pointR   = values.map((_,i)=>i===values.length-1?6:4);
  const pointHR  = values.map((_,i)=>i===values.length-1?8:6);

  // Custom gradient fill
  const ctx=canvas.getContext('2d');
  const grad=ctx.createLinearGradient(0,0,0,canvas.offsetHeight||160);
  if(isDark){
    grad.addColorStop(0,'rgba(108,142,255,0.22)');
    grad.addColorStop(1,'rgba(108,142,255,0)');
  }else{
    grad.addColorStop(0,'rgba(58,95,255,0.12)');
    grad.addColorStop(1,'rgba(58,95,255,0)');
  }

  _trendChart = new window.Chart(ctx,{
    type:'line',
    data:{
      labels,
      datasets:[{
        data: values,
        borderColor: lineColor,
        borderWidth: 2,
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
      animation:{ duration:700, easing:'easeInOutQuart' },
      plugins:{
        legend:{ display:false },
        tooltip:{
          backgroundColor: isDark?'rgba(16,20,34,0.95)':'rgba(255,255,255,0.97)',
          borderColor: isDark?'rgba(255,255,255,0.1)':'rgba(99,115,177,0.15)',
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
          display:false,
          grid:{ color:gridColor, drawBorder:false },
          ticks:{ display:false },
          beginAtZero:false,
        }
      },
      interaction:{ intersect:false, mode:'index' },
    }
  });
}

function buildSettings(){
  const wages=getWages(),rules=t('rules');
  const historyRows=wages.slice().reverse().map((w,i)=>{
    const idx=wages.length-1-i; // actual index in forward array
    const isFirst=idx===0;
    return`<tr>
      <td style="font-size:13px;color:var(--text-muted);">${w.date}</td>
      <td style="font-size:13px;font-weight:600;">₩${w.amount.toLocaleString()}</td>
      <td style="text-align:right;">${!isFirst?`<button class="btn-del-sm" data-wage-del="${idx}">${t('del')}</button>`:''}</td>
    </tr>`;
  }).join('');
  return`<div class="card">
    <div class="card-title">${t('setTitle')}</div>
    ${S.success?`<div class="success-banner">${S.success}</div>`:''}
    <div style="font-size:13px;font-weight:600;margin-bottom:10px;">${t('wageLabel')}</div>
    <table class="rules-table" style="margin-bottom:16px;">
      <thead><tr>
        <th>${t('wageEffFrom')}</th>
        <th>${t('wageAmount')}</th>
        <th></th>
      </tr></thead>
      <tbody>${historyRows}</tbody>
    </table>
    <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px;letter-spacing:0.04em;text-transform:uppercase;">${t('wageAddNew')}</div>
    <div class="wage-row" style="align-items:flex-end;gap:8px;">
      <div class="fg" style="flex:1.2;">
        <label style="font-size:11px;">${t('wageEffFrom')}</label>
        <input class="wage-inp" id="wage-date-in" type="date" value="${today()}">
      </div>
      <div class="fg" style="flex:1;">
        <label style="font-size:11px;">${t('wageAmount')}</label>
        <div style="display:flex;align-items:center;gap:5px;">
          <input class="wage-inp" id="wage-in" type="number" value="${getWage()}" min="0" step="100">
          <span style="font-size:13px;color:var(--text-muted);">₩</span>
        </div>
      </div>
    </div>
    <button class="btn-pri" id="save-wage" style="width:100%;margin-top:12px;">${t('savWage')}</button>
    <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">${t('wageHistoryHint')}</div>
  </div>
  <div class="card">
    <div class="card-title">${t('rulesTitle')}</div>
    <table class="rules-table">
      <thead><tr><th style="width:40%">Type</th><th>Rule</th></tr></thead>
      <tbody>${rules.map(([type,rule])=>`<tr><td><strong>${type}</strong></td><td>${rule}</td></tr>`).join('')}</tbody>
    </table>
  </div>
  <div style="font-size:11px;color:var(--text-hint);text-align:center;margin-top:-6px;">${t('calHint')}</div>`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function buildModal(){
  const{date,existing}=S.modal;
  const holDay=isHol(date),sun=isSun(date)&&!isHol(date),sat=isSat(date)&&!isHol(date);
  const weekShift=shiftFor(date);
  // Per-day shift: use saved override if editing, or state override, or week default
  const defShift=existing?.shiftOverride||weekShift;
  const shift=S.mShift!==undefined?S.mShift:defShift;
  const wage=wageFor(date),dn=t('dn'),dw=dowOf(date);
  let badges='';
  if(holDay)badges+=`<span class="mbadge b-hol">● ${holName(date)}</span>`;
  if(isSun(date))badges+=`<span class="mbadge b-sun">${dn[0]}</span>`; // always show Sunday badge
  if(sat)badges+=`<span class="mbadge b-sat">${dn[6]}</span>`;

  const defReg = existing?.regHrs !== undefined
  ? existing.regHrs
  : ((holDay || sun) ? 0 : 8); // holDay already covers holiday Sundays
  const defOT=existing?.otHrs!==undefined?existing.otHrs:0;
  const reg=S.mReg!==undefined?S.mReg:defReg;
  const ot=S.mOT!==undefined?S.mOT:defOT;
  const autoSunQual=sun&&allWeekdaysLogged(date);

  function previewHTML(r,o,sh){
    const c=calcWage(date,r,o,wage,sh),tax=c.gross-c.net;
    return`<div class="calc-box">
      ${c.notes.map(n=>`<div class="cr"><span>${n}</span></div>`).join('')}
      <div class="cr"><span>${t('gross')}</span><span>₩${c.gross.toLocaleString()}</span></div>
      <div class="cr tax"><span>${t('taxLine')}</span><span>-₩${tax.toLocaleString()}</span></div>
      <div class="cr tot"><span>${t('net')}</span><span>₩${c.net.toLocaleString()}</span></div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">${t('eff')}: ${c.eff}h · ${t('rateLabel')}: ₩${wage.toLocaleString()}</div>
    </div>`;
  }

  // Shift toggle HTML (shown in all day types)
  const shiftToggleHTML=`
    <div style="display:flex;gap:6px;margin-bottom:14px;">
      <button id="m-shift-day" class="shift-tog ${shift==='day'?'shift-tog-on-day':''}">
        ☀ ${t('dayShift')}
      </button>
      <button id="m-shift-night" class="shift-tog ${shift==='night'?'shift-tog-on-night':''}">
        ☾ ${t('nightShift')}
      </button>
      <button id="m-shift-double" class="shift-tog ${shift==='double'?'shift-tog-on-double':''}">
        🌀 ${t('doubleShift')}
      </button>
    </div>`;

  let bodyHTML='';
  if(sun){
    // Sunday: show auto-credit info; always allow worked hours input (same as holiday)
    const sunInfoCls=autoSunQual?'info-box':' info-box';
    bodyHTML=`<div class="info-box">${autoSunQual?t('sunAuto'):t('sunNotYet')}</div>
    <div class="info-box warn" style="margin-top:0;">${t('sunWorkedInfo')}</div>
    <div class="fg-row" ${shift==='double'?'style="display:none"':''}>
      <div class="fg">
        <label>${t('regHrs')}</label>
        <input id="m-reg" type="number" value="${reg}" min="0" step="0.5">
      </div>
      <div class="fg">
        <label>${t('otHrs')} <span style="font-size:10px;color:var(--text-hint);">${t('otHint')}</span></label>
        <input id="m-ot" type="number" value="${ot}" min="0" max="24" step="0.5">
      </div>
    </div>
    <div id="m-preview">${previewHTML(reg,ot,shift)}</div>`;
  }else if(holDay){
    // Holiday: 8h auto-credited; worked hours use sat-like calc
    bodyHTML=`<div class="info-box warn">${t('holInfo')}</div>
    <div class="fg-row" ${shift==='double'?'style="display:none"':''}>
      <div class="fg">
        <label>${t('regHrs')}</label>
        <input id="m-reg" type="number" value="${reg}" min="0" step="0.5">
      </div>
      <div class="fg">
        <label>${t('otHrs')} <span style="font-size:10px;color:var(--text-hint);">${t('otHint')}</span></label>
        <input id="m-ot" type="number" value="${ot}" min="0" max="24" step="0.5">
      </div>
    </div>
    <div id="m-preview">${previewHTML(reg,ot,shift)}</div>`;
  }else{
    // Normal/Saturday: two inputs
    bodyHTML=`<div class="fg-row" ${shift==='double'?'style="display:none"':''}>
      <div class="fg">
        <label>${t('regHrs')}</label>
        <input id="m-reg" type="number" value="${reg}" min="0" step="0.5">
      </div>
      <div class="fg">
        <label>${t('otHrs')} <span style="font-size:10px;color:var(--text-hint);">${t('otHint')}</span></label>
        <input id="m-ot" type="number" value="${ot}" min="0" max="24" step="0.5">
      </div>
    </div>
    <div id="m-preview">${previewHTML(reg,ot,shift)}</div>`;
  }

  const ov=document.createElement('div');
  ov.className='modal-overlay';ov.id='modal-ov';
  ov.innerHTML=`<div class="modal">
    <h3>${date}</h3>
    <div class="modal-sub">${dn[dw]}</div>
    <div style="margin-bottom:12px;">${badges}</div>
    ${shiftToggleHTML}
    ${bodyHTML}
    <div class="m-actions">
      <button class="btn-sec" id="m-cancel">${t('cancel')}</button>
      ${existing?`<button class="btn-del" id="m-del">${t('del')}</button>`:''}
      <button class="btn-pri" id="m-save">${t('save')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);

  ov.addEventListener('click',e=>{if(e.target.id==='modal-ov')closeModal();});
  document.getElementById('m-cancel').addEventListener('click',closeModal);
  const delBtn=document.getElementById('m-del');
  if(delBtn)delBtn.addEventListener('click',()=>{const l=getLogs();delete l[date];saveLogs(l);closeModal();});

  const regIn=document.getElementById('m-reg'),otIn=document.getElementById('m-ot');
  function curShift(){return S.mShift!==undefined?S.mShift:shift;}
  function upd(){
    const sh=curShift();
    const r=sh==='double'?0:(regIn?Math.min(parseFloat(regIn.value)||0,8):0);
    const o=sh==='double'?0:(otIn?parseFloat(otIn.value)||0:0);
    S.mReg=r;S.mOT=o;
    const prev=document.getElementById('m-preview');
    if(prev)prev.innerHTML=previewHTML(r,o,sh);
  }
  if(regIn)regIn.addEventListener('input',upd);
  if(otIn)otIn.addEventListener('input',upd);

  function applyShiftToggle(newShift){
    S.mShift=newShift;
    // Update button styles
    const dBtn=document.getElementById('m-shift-day');
    const nBtn=document.getElementById('m-shift-night');
    const xBtn=document.getElementById('m-shift-double');
    if(dBtn){dBtn.className='shift-tog'+(newShift==='day'?' shift-tog-on-day':'');}
    if(nBtn){nBtn.className='shift-tog'+(newShift==='night'?' shift-tog-on-night':'');}
    if(xBtn){xBtn.className='shift-tog'+(newShift==='double'?' shift-tog-on-double':'');}
    // Show/hide the hour inputs row
    const fgRow=document.querySelector('#modal-ov .fg-row');
    if(fgRow){fgRow.style.display=newShift==='double'?'none':'grid';}
    upd();
  }
  const sdBtn=document.getElementById('m-shift-day');
  const snBtn=document.getElementById('m-shift-night');
  const sxBtn=document.getElementById('m-shift-double');
  if(sdBtn)sdBtn.addEventListener('click',()=>applyShiftToggle('day'));
  if(snBtn)snBtn.addEventListener('click',()=>applyShiftToggle('night'));
  if(sxBtn)sxBtn.addEventListener('click',()=>applyShiftToggle('double'));

  const saveBtn=document.getElementById('m-save');
  if(saveBtn)saveBtn.addEventListener('click',()=>{
    const sh=curShift();
    const r=sh==='double'?0:(regIn?Math.min(parseFloat(regIn.value)||0,8):0);
    const o=sh==='double'?0:(otIn?parseFloat(otIn.value)||0:0);
    const c=calcWage(date,r,o,wage,sh);
    const logs=getLogs();
    // Store shiftOverride only when it differs from the week default
    const override=sh!==weekShift?sh:undefined;
    logs[date]={regHrs:r,otHrs:o,hrs:r+o,gross:c.gross,net:c.net,eff:c.eff,shiftOverride:override};
    saveLogs(logs);closeModal();
  });
}

function closeModal(){
  const ov=document.getElementById('modal-ov');if(ov)ov.remove();
  S.modal=null;S.mReg=undefined;S.mOT=undefined;S.mShift=undefined;render();
}

// ── Listeners ─────────────────────────────────────────────────────────────────
function attachListeners(){
  // Render chart if overview tab is active (async, non-blocking)
  if(S.tab==='overview') renderTrendChart();

  document.getElementById('theme-toggle').addEventListener('click',()=>{
    S.theme=S.theme==='dark'?'light':'dark';sv('wt4_theme',S.theme);scheduleSync();render();
  });
  // lang buttons are wired inside the portal (see portal dropdown system above)
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{
    S.tab=b.dataset.tab;S.success='';render();
  }));
  const cp=document.getElementById('cal-prev');
  if(cp)cp.addEventListener('click',()=>{S.calM--;if(S.calM<0){S.calM=11;S.calY--;}render();});
  const cn=document.getElementById('cal-next');
  if(cn)cn.addEventListener('click',()=>{S.calM++;if(S.calM>11){S.calM=0;S.calY++;}render();});
  document.querySelectorAll('.wsb[data-ws]').forEach(b=>b.addEventListener('click',()=>{
    toggleShift(b.dataset.ws);render();
  }));
  document.querySelectorAll('.dc[data-date]').forEach(el=>el.addEventListener('click',()=>{
    const s=el.dataset.date;if(s>today())return;
    const logs=getLogs();
    S.modal={date:s,existing:logs[s]||null};S.mReg=undefined;S.mOT=undefined;S.mShift=undefined;render();
  }));
  document.querySelectorAll('.log-edit[data-date]').forEach(el=>el.addEventListener('click',()=>{
    const s=el.dataset.date,logs=getLogs();
    S.modal={date:s,existing:logs[s]||null};S.mReg=undefined;S.mOT=undefined;S.mShift=undefined;render();
  }));
  // ── Auth ────────────────────────────────────────────────────────────────────
  const loginBtn=document.getElementById('auth-login');
  if(loginBtn)loginBtn.addEventListener('click',()=>signInWithGoogle());
  const logoutBtn=document.getElementById('auth-logout');
  if(logoutBtn)logoutBtn.addEventListener('click',()=>signOutUser());

  // ── Portal dropdown system ────────────────────────────────────────────────────
  // Dropdowns are appended directly to <body> so they are never clipped by
  // backdrop-filter or overflow:hidden on ancestor elements (like .hdr, .card).
  // Each render() removes old portals and re-creates fresh ones.
  document.querySelectorAll('.portal-dropdown').forEach(el=>el.remove());

  function createPortalDropdown(id, html){
    const el=document.createElement('div');
    el.id=id;
    el.className='hdr-dropdown portal-dropdown';
    el.innerHTML=html;
    document.body.appendChild(el);
    return el;
  }

  function positionDropdown(menu, trigger){
    const r=trigger.getBoundingClientRect();
    menu.style.position='fixed';
    menu.style.top=(r.bottom+6)+'px';
    // Align right edge of menu to right edge of trigger
    const menuW=menu.offsetWidth||200;
    let left=r.right-menuW;
    if(left<8)left=8; // don't go off-screen left
    menu.style.left=left+'px';
    menu.style.right='auto';
  }

  function closeAllPortals(){
    document.querySelectorAll('.portal-dropdown').forEach(m=>m.classList.remove('open'));
  }

  // ── Language portal ──────────────────────────────────────────────────────────
  const langBtn=document.getElementById('lang-btn');
  if(langBtn){
    const langPortal=createPortalDropdown('lang-menu',
      ['en','ko','id','th','ru','ne'].map(l=>{
        const labels={en:'🇺🇸 English',ko:'🇰🇷 한국어',id:'🇮🇩 Indonesia',th:'🇹🇭 ภาษาไทย',ru:'🇷🇺 Русский',ne:'🇳🇵 नेपाली'};
        return `<button class="hdr-dropdown-item${S.lang===l?' hdr-dropdown-item--active':''}" data-lang="${l}">${labels[l]}</button>`;
      }).join(''));
    // Wire language buttons inside portal
    langPortal.querySelectorAll('[data-lang]').forEach(b=>b.addEventListener('click',e=>{
      e.stopPropagation();
      S.lang=b.dataset.lang;sv('wt4_lang',S.lang);scheduleSync();
      closeAllPortals();
      render();
    }));
    langBtn.addEventListener('click',e=>{
      e.stopPropagation();
      const wasOpen=langPortal.classList.contains('open');
      closeAllPortals();
      if(!wasOpen){langPortal.classList.add('open');positionDropdown(langPortal,langBtn);}
    });
  }

  // ── Account portal ───────────────────────────────────────────────────────────
  const accountBtn=document.getElementById('account-btn');
  if(accountBtn&&CURRENT_USER){
    const accountPortal=createPortalDropdown('account-menu',
      `<div class="hdr-dropdown-user">
        <div class="hdr-dropdown-name">${CURRENT_USER.displayName||''}</div>
        <div class="hdr-dropdown-email">${CURRENT_USER.email||''}</div>
       </div>
       <div class="hdr-dropdown-divider"></div>
       <button class="hdr-dropdown-item hdr-dropdown-item--danger" id="auth-logout-portal">${t('signOut')}</button>`);
    accountPortal.querySelector('#auth-logout-portal')?.addEventListener('click',()=>signOutUser());
    accountBtn.addEventListener('click',e=>{
      e.stopPropagation();
      const wasOpen=accountPortal.classList.contains('open');
      closeAllPortals();
      if(!wasOpen){accountPortal.classList.add('open');positionDropdown(accountPortal,accountBtn);}
    });
  }

  // Close portals on outside click
  document.addEventListener('click',closeAllPortals);

  const sw=document.getElementById('save-wage');
  if(sw)sw.addEventListener('click',()=>{
    const w=parseInt(document.getElementById('wage-in').value);
    const dateIn=document.getElementById('wage-date-in');
    const effDate=dateIn?dateIn.value:today();
    if(isNaN(w)||w<0||!effDate)return;
    const wages=getWages();
    // Remove any existing entry for the exact same date, then insert sorted
    const filtered=wages.filter(e=>e.date!==effDate);
    filtered.push({date:effDate,amount:w});
    filtered.sort((a,b)=>a.date.localeCompare(b.date));
    saveWages(filtered);
    S.success=t('wageSaved');render();
  });

  // Wage history delete buttons
  document.querySelectorAll('[data-wage-del]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const idx=parseInt(btn.dataset.wageDel);
      const wages=getWages();
      if(wages.length<=1)return; // always keep at least one entry
      wages.splice(idx,1);
      saveWages(wages);render();
    });
  });
}

applyTheme();
// Seed cache into HOLIDAYS synchronously (already done above), then render.
// prefetchHolidays runs in the background and re-renders if new data arrives.

// ── Onboarding ────────────────────────────────────────────────────────────────
// Shown only to genuinely new users. Existing users (any saved data) are
// auto-flagged as onboarded so they never see this flow.
(function initOnboarding(){
  // Backward-compat: if user already has data BUT onboarding was never explicitly
  // completed, mark them as onboarded silently — they pre-date this flow.
  // IMPORTANT: we only do this when there is NO active in-progress onboarding session
  // (wt4_ob_state). Otherwise a mid-session refresh would wrongly skip onboarding.
  const hasActiveSession = localStorage.getItem('wt4_ob_state') !== null;
  if(!hasActiveSession){
    const hasData = (
      Object.keys(ld('wt4_logs',{})).length > 0 ||
      Object.keys(ld('wt4_shifts',{})).length > 0 ||
      ld('wt4_wages', null) !== null ||
      ld('wt4_wage', null) !== null
    );
    if(hasData && localStorage.getItem('wt4_onboarding') === null){
      localStorage.setItem('wt4_onboarding','done');
    }
  }
  if(localStorage.getItem('wt4_onboarding') === 'done') return;

  // ── Onboarding state ────────────────────────────────────────────────────────
  // Restored from localStorage on refresh so the user resumes at their step.
  // We never persist lang/theme to their normal keys until completeOnboarding().
  function loadOBState(){
    try{
      const raw=localStorage.getItem('wt4_ob_state');
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return null;
  }
  function saveOBState(){
    try{
      localStorage.setItem('wt4_ob_state', JSON.stringify({
        step: OB.step,
        lang: OB.lang,
        pattern: OB.pattern,
        currentShift: OB.currentShift,
        wage: OB.wage,
      }));
    }catch(e){}
  }

  const saved = loadOBState();
  const OB = {
    step:         saved?.step         ?? 1,
    lang:         saved?.lang         ?? S.lang,
    pattern:      saved?.pattern      ?? null,
    currentShift: saved?.currentShift ?? null,
    wage:         saved?.wage         ?? DEFAULT_WAGE,
    signingIn: false,   // transient — never persisted
  };

  // Sync app language to whatever OB has (so ot() works correctly on resume)
  S.lang = OB.lang;

  // Total steps: rotation → 6 steps (1,2,3,4,5,6), others → 5 steps (1,2,4,5,6)
  function totalSteps(){ return OB.pattern==='rotation' ? 6 : 5; }
  // Displayed progress position (1-based, skips step 3 if not rotation)
  function stepPos(){
    if(OB.pattern!=='rotation' && OB.step>=3) return OB.step-1;
    return OB.step;
  }

  function ot(k){ const fn=TR[OB.lang][k]; return typeof fn==='function'?fn():(fn||k); }

  // ── Build step body HTML only (not the full overlay) ────────────────────────
  function buildStepHTML(){
    let inner='';

    if(OB.step===1){
      const langs=[
        {code:'en',flag:'🇺🇸',label:'English'},
        {code:'ko',flag:'🇰🇷',label:'한국어'},
        {code:'id',flag:'🇮🇩',label:'Indonesia'},
        {code:'th',flag:'🇹🇭',label:'ภาษาไทย'},
        {code:'ru',flag:'🇷🇺',label:'Русский'},
        {code:'ne',flag:'🇳🇵',label:'नेपाली'},
      ];
      inner=`
        <div class="ob-icon">🌐</div>
        <h2 class="ob-title">${ot('obStep1Title')}</h2>
        <div class="ob-lang-grid">
          ${langs.map(l=>`
            <button class="ob-lang-btn${OB.lang===l.code?' ob-lang-btn--active':''}" data-lang="${l.code}">
              <span class="ob-lang-flag">${l.flag}</span>
              <span class="ob-lang-label">${l.label}</span>
            </button>
          `).join('')}
        </div>
        <button class="ob-btn-pri ob-next" ${OB.lang?'':'disabled'}>${ot('obNext')} →</button>`;

    }else if(OB.step===2){
      const opts=[
        {val:'rotation',icon:'🌀',title:ot('obStep2Rotation'),sub:ot('obStep2RotationSub')},
        {val:'day',icon:'🌞',title:ot('obStep2DayOnly'),sub:ot('obStep2DayOnlySub')},
        {val:'night',icon:'🌙',title:ot('obStep2NightOnly'),sub:ot('obStep2NightOnlySub')},
      ];
      inner=`
        <div class="ob-icon">📅</div>
        <h2 class="ob-title">${ot('obStep2Title')}</h2>
        <div class="ob-option-list">
          ${opts.map(o=>`
            <button class="ob-option${OB.pattern===o.val?' ob-option--active':''}" data-pattern="${o.val}">
              <span class="ob-option-icon">${o.icon}</span>
              <span class="ob-option-text">
                <span class="ob-option-title">${o.title}</span>
                <span class="ob-option-sub">${o.sub}</span>
              </span>
            </button>
          `).join('')}
        </div>
        <div class="ob-row">
          <button class="ob-btn-sec ob-back">${ot('obBack')}</button>
          <button class="ob-btn-pri ob-next" ${OB.pattern?'':'disabled'}>${ot('obNext')} →</button>
        </div>`;

    }else if(OB.step===3){
      const opts=[
        {val:'day',icon:'🌞',title:ot('obStep3Day')},
        {val:'night',icon:'🌙',title:ot('obStep3Night')},
      ];
      inner=`
        <div class="ob-icon">🌀</div>
        <h2 class="ob-title">${ot('obStep3Title')}</h2>
        <div class="ob-option-list">
          ${opts.map(o=>`
            <button class="ob-option${OB.currentShift===o.val?' ob-option--active':''}" data-curshift="${o.val}">
              <span class="ob-option-icon">${o.icon}</span>
              <span class="ob-option-text">
                <span class="ob-option-title">${o.title}</span>
              </span>
            </button>
          `).join('')}
        </div>
        <div class="ob-row">
          <button class="ob-btn-sec ob-back">${ot('obBack')}</button>
          <button class="ob-btn-pri ob-next" ${OB.currentShift?'':'disabled'}>${ot('obNext')} →</button>
        </div>`;

    }else if(OB.step===4){
      inner=`
        <div class="ob-icon">💰</div>
        <h2 class="ob-title">${ot('obStep4Title')}</h2>
        <p class="ob-sub">${ot('obStep4Sub')}</p>
        <div class="ob-wage-wrap">
          <span class="ob-wage-currency">₩</span>
          <input class="ob-wage-input" id="ob-wage-in" type="number" value="${OB.wage}" min="0" step="100">
        </div>
        <div class="ob-row">
          <button class="ob-btn-sec ob-back">${ot('obBack')}</button>
          <button class="ob-btn-pri ob-next">${ot('obNext')} →</button>
        </div>`;

    }else if(OB.step===5){
      inner=`
        <div class="ob-icon">☁</div>
        <h2 class="ob-title">${ot('obStep5Title')}</h2>
        <p class="ob-sub">${ot('obStep5Sub')}</p>
        ${CURRENT_USER
          ?`<div class="ob-signed-in">
              ${CURRENT_USER.photoURL?`<img src="${CURRENT_USER.photoURL}" class="avatar" alt="">`:
                `<span class="avatar-initials">${(CURRENT_USER.displayName||CURRENT_USER.email||'?')[0].toUpperCase()}</span>`}
              <span>${ot('obStep5Done')} <strong>${CURRENT_USER.displayName||CURRENT_USER.email}</strong></span>
            </div>`
          :`<button class="ob-btn-google ob-google-signin" ${OB.signingIn?'disabled':''}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              ${OB.signingIn?'…':ot('obStep5Signin')}
            </button>`
        }
        <div class="ob-row ob-row--cloud">
          <button class="ob-btn-sec ob-back">${ot('obBack')}</button>
          <button class="ob-btn-pri ob-next">${CURRENT_USER?ot('obNext')+' →':ot('obStep5Skip')}</button>
        </div>`;

    }else if(OB.step===6){
      inner=`
        <div class="ob-done-icon">🎉</div>
        <h2 class="ob-title">${ot('obDoneTitle')}</h2>
        <p class="ob-sub">${ot('obDoneSub')}</p>
        <button class="ob-btn-pri ob-finish" style="width:100%;margin-top:8px;">${ot('obDoneBtn')}</button>`;
    }

    return inner;
  }

  // ── Initial mount: insert overlay once, never remove/recreate it ─────────────
  function mountOB(){
    const pos=stepPos(), total=totalSteps();
    const dots=Array.from({length:total},(_,i)=>
      `<div class="ob-dot${i<pos?' ob-dot-done':i===pos-1?' ob-dot-active':''}"></div>`
    ).join('');

    const ov=document.createElement('div');
    ov.className='ob-overlay';
    ov.id='ob-overlay';
    ov.innerHTML=`<div class="ob-card">
      <div class="ob-progress" id="ob-progress">${dots}</div>
      <div class="ob-body" id="ob-body">${buildStepHTML()}</div>
    </div>`;
    document.body.appendChild(ov);
    wireOB();
  }

  // ── Transition to a new step: update only progress dots + body content ───────
  function transitionTo(newStep, direction){
    // direction: 1 = forward, -1 = backward
    const body = document.getElementById('ob-body');
    const progress = document.getElementById('ob-progress');
    if(!body) { mountOB(); return; }

    // Update OB step and persist
    OB.step = newStep;
    saveOBState();

    // Rebuild progress dots
    const pos=stepPos(), total=totalSteps();
    progress.innerHTML=Array.from({length:total},(_,i)=>
      `<div class="ob-dot${i<pos?' ob-dot-done':i===pos-1?' ob-dot-active':''}"></div>`
    ).join('');

    // Animate body: slide out old, slide in new
    const outClass = direction >= 0 ? 'ob-slide-out-left' : 'ob-slide-out-right';
    const inClass  = direction >= 0 ? 'ob-slide-in-right' : 'ob-slide-in-left';

    body.classList.add(outClass);
    body.addEventListener('animationend', function handler(){
      body.removeEventListener('animationend', handler);
      body.classList.remove(outClass);
      body.innerHTML = buildStepHTML();
      wireStepEvents();
      body.classList.add(inClass);
      body.addEventListener('animationend', function h2(){
        body.removeEventListener('animationend', h2);
        body.classList.remove(inClass);
      }, {once:true});
    }, {once:true});
  }

  // ── Wire step-level events (called after every body swap) ────────────────────
  function wireStepEvents(){
    const body = document.getElementById('ob-body');

    // Step 1: language buttons — update selection highlight in-place (no transition)
    body.querySelectorAll('[data-lang]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.lang = btn.dataset.lang;
        S.lang  = OB.lang;
        saveOBState();
        // Update active highlight without a full step transition
        body.querySelectorAll('[data-lang]').forEach(b=>{
          b.classList.toggle('ob-lang-btn--active', b.dataset.lang===OB.lang);
        });
        // Enable the Next button
        const nx=body.querySelector('.ob-next');
        if(nx) nx.disabled=false;
      });
    });

    // Step 2: pattern buttons — update highlight in-place
    body.querySelectorAll('[data-pattern]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.pattern = btn.dataset.pattern;
        if(OB.pattern!=='rotation') OB.currentShift=null;
        saveOBState();
        body.querySelectorAll('[data-pattern]').forEach(b=>{
          b.classList.toggle('ob-option--active', b.dataset.pattern===OB.pattern);
        });
        const nx=body.querySelector('.ob-next');
        if(nx) nx.disabled=false;
      });
    });

    // Step 3: current shift buttons — update highlight in-place
    body.querySelectorAll('[data-curshift]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.currentShift = btn.dataset.curshift;
        saveOBState();
        body.querySelectorAll('[data-curshift]').forEach(b=>{
          b.classList.toggle('ob-option--active', b.dataset.curshift===OB.currentShift);
        });
        const nx=body.querySelector('.ob-next');
        if(nx) nx.disabled=false;
      });
    });

    // Wage input — live-sync to OB state
    const wageIn=document.getElementById('ob-wage-in');
    if(wageIn){
      wageIn.addEventListener('input',()=>{
        const v=parseInt(wageIn.value);
        if(!isNaN(v)&&v>=0){ OB.wage=v; saveOBState(); }
      });
    }

    // Google sign-in button
    body.querySelector('.ob-google-signin')?.addEventListener('click',async()=>{
      OB.signingIn=true;
      const btn=body.querySelector('.ob-google-signin');
      if(btn){btn.disabled=true;btn.textContent='…';}
      await signInWithGoogle();
      OB.signingIn=false;
      // Refresh step 5 body in-place to show signed-in state
      body.innerHTML=buildStepHTML();
      wireStepEvents();
    });

    // Back button
    body.querySelector('.ob-back')?.addEventListener('click',()=>{
      const prev = (OB.step===4 && OB.pattern!=='rotation') ? 2 : OB.step-1;
      transitionTo(prev, -1);
    });

    // Next / skip button
    body.querySelector('.ob-next')?.addEventListener('click',()=>{
      if(OB.step===4){
        const wIn=document.getElementById('ob-wage-in');
        if(wIn){ const v=parseInt(wIn.value); if(!isNaN(v)&&v>=0) OB.wage=v; }
      }
      const next = (OB.step===2 && OB.pattern!=='rotation') ? 4 : OB.step+1;
      transitionTo(next, 1);
    });

    // Finish button
    body.querySelector('.ob-finish')?.addEventListener('click',()=>{
      completeOnboarding();
    });
  }

  // ── Wire overlay-level events (once, on initial mount) ───────────────────────
  function wireOB(){
    wireStepEvents();
    // No overlay-click-to-dismiss — onboarding is required
  }

  // ── Apply onboarding choices and finish ─────────────────────────────────────
  function completeOnboarding(){
    // 1. Save language
    sv('wt4_lang', OB.lang);
    S.lang = OB.lang;

    // 2. Initialize shift pattern — write directly to wt4_shifts.
    //    Anchors must cover ALL historical weeks (not just current/future),
    //    otherwise shiftFor() defaults to 'day' for any week before the anchor.
    const ws = getMonday(today());
    const sh = {};

    if(OB.pattern==='rotation'){
      // Write a single far-past anchor (2000-01-03 is a Monday) whose shift value
      // is chosen so that week-parity from that anchor correctly yields OB.currentShift
      // for this week — and alternates correctly for every past and future week.
      // We do NOT write a second anchor for the current week: two anchors with the
      // same value would falsely trigger fixed-mode detection in shiftFor().
      const EPOCH = '2000-01-03'; // a known Monday
      const msPerWeek = 7*24*3600*1000;
      const weeksFromEpoch = Math.round((pd(ws) - pd(EPOCH)) / msPerWeek);
      // If distance is even → epoch shift = currentShift (0 alternations = same)
      // If distance is odd  → epoch shift = opposite    (1 alternation = flipped)
      const epochShift = weeksFromEpoch % 2 === 0
        ? OB.currentShift
        : (OB.currentShift === 'day' ? 'night' : 'day');
      sh[EPOCH] = epochShift;

    }else{
      // Fixed day or night: write two consecutive-week anchors with the same shift.
      // shiftFor() detects two adjacent same-value anchors → fixed mode (no alternation).
      // Place them far in the past so every historical week is covered.
      const fixedShift = OB.pattern === 'day' ? 'day' : 'night';
      const EPOCH  = '2000-01-03'; // Monday
      const EPOCH2 = '2000-01-10'; // Monday, 1 week later
      sh[EPOCH]  = fixedShift;
      sh[EPOCH2] = fixedShift;
    }

    sv('wt4_shifts', sh);

    // 3. Save wage
    const wages = [{date:'2026-01-01', amount:OB.wage}];
    sv('wt4_wages', wages);

    // 4. Mark onboarding complete — ONLY here, never earlier
    localStorage.setItem('wt4_onboarding', 'done');
    // Clean up in-progress session key
    localStorage.removeItem('wt4_ob_state');

    // 5. Dismiss overlay and render the full app
    document.getElementById('ob-overlay')?.remove();
    render();
    prefetchHolidays();
    if(CURRENT_USER) scheduleSync();
  }

  // ── Show onboarding ─────────────────────────────────────────────────────────
  // Seed wt4_ob_state NOW (before render() is called) so that on any subsequent
  // page load — even before the user has clicked anything — hasActiveSession is
  // true and the backward-compat hasData check is skipped. Without this, render()
  // calls getWages() which writes wt4_wages as a side-effect, making hasData=true
  // on the next load and wrongly auto-completing onboarding.
  saveOBState();
  // Render a minimal shell behind the overlay. Do NOT call prefetchHolidays() here —
  // that would fire 48 concurrent API requests (12 months × 4 years) immediately on
  // first visit, causing 429 rate-limit errors. Holidays are fetched in
  // completeOnboarding() after the user has finished the flow.
  render();
  mountOB();
  // Return early — normal startup render() below must not fire again.
  return;
})();

// Normal startup (only reached if onboarding is already done)
render();
prefetchHolidays();
