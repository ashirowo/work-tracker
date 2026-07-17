// ── firebase.js integration ──────────────────────────────────────────────────
// scheduleSync() is called after every data mutation so changes automatically
// propagate to Firestore when the user is signed in. If not signed in or offline,
// the call is a no-op and localStorage continues working as usual.
import { signInWithGoogle, signOutUser, scheduleSync, getSyncStatus, deleteCloudData,
         createShare, fetchShare, deleteShare, listMyShares } from './firebase.js';
import { packShare, unpackShare, normalizeShareCode, formatShareCode } from './share.js';
import { TR, nightWeekdayEff, satNightEff, satDayEff } from './translations.js';
import { calcWage as calcWageCore, buildRulesRows, calcDay as calcDayCore, classifyDay as classifyDayCore } from './calc.js';
import { compileProfile, PRESET_ANSWERS, compileProfileV2, PRESET_ANSWERS_V2 } from './compile.js';
import { DEFAULT_PROFILE, isUsableProfile } from './profile.js';
import { needsNightSchedule, nightHoursOf } from './profile-v2.js';
import { buildExportCard, wireExportCard, buildRows, exportCSV, exportPDF, showExportToast, monthsWithData as expMonthsWithData } from './export.js';

// ── App signature footer ─────────────────────────────────────────────────────
// Premium credit footer shared beneath the last card on the Calendar, Overview,
// and Settings tabs. Bump APP_VERSION on release — it surfaces in the pill on
// the right. The credit text stays localized via t('calHint').
const APP_VERSION = 'v2.1.4';
function appFooter(){
  return `
  <footer class="app-footer">
    <div class="app-footer-rule"><span class="app-footer-spark"></span></div>
    <div class="app-footer-pill">
      <span class="app-footer-credit">${t('calHint')}</span>
      <span class="app-footer-div"></span>
      <span class="app-footer-ver">${APP_VERSION}</span>
    </div>
  </footer>`;
}

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
  const isOffline=!navigator.onLine;
  // When the network is gone, always show the offline icon regardless of
  // what firebase.js reports (it may not have fired its 'offline' event yet).
  const effectiveStatus=isOffline?'offline':status;
  const tips={synced:'Synced',pending:'Syncing…',offline:'Offline — saved locally',idle:''};
  // SYNC_ICONS is defined later in module scope (function hoisting isn't in play
  // for const, but updateSyncUI only ever runs after first render, by which time
  // the constant is initialised).
  badge.innerHTML=SYNC_ICONS[effectiveStatus]||SYNC_ICONS.synced;
  badge.title=tips[effectiveStatus]||'';
  badge.setAttribute('aria-label',tips[effectiveStatus]||'');
  badge.dataset.status=effectiveStatus;
  badge.className='sync-badge sync-badge--'+effectiveStatus;
  updateSyncedTime();
}
// Refresh the "Last synced Xm ago" label in place (web header). Cheap; safe to
// call frequently. Also swaps the whole block in/out if sync state appears.
function updateSyncedTime(){
  const el=document.getElementById('hdr-synced-time');
  if(!el)return;
  const lbl=lastSyncedLabel();
  if(lbl) el.textContent=lbl;
}
// Tick the relative sync time so it updates live (e.g. 55s → 56s → 57s) without
// any reload. Cheap textContent swap; runs every second.
let _syncTick=null;
function startSyncTicker(){
  if(_syncTick)clearInterval(_syncTick);
  _syncTick=setInterval(updateSyncedTime,1000); // every second — instant feel
}
// updateOfflineBanner: sets the banner text in the current language.
// Called from render() and whenever the language changes.
function updateOfflineBanner(){
  const el=document.getElementById('offline-banner-text');
  if(!el)return;
  // Fall back to English if key missing in a language block
  const lang=S?.lang||localStorage.getItem('wt4_lang')||'en';
  el.textContent=(TR[lang]?.offlineBanner)||TR.en.offlineBanner;
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
const HOL_FAIL_UNTIL = new Map(); // year -> timestamp; don't re-attempt a failed year until then

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
    // enObj is used purely as a presence-check map (for isHol()).
    // Store the Korean name as the value; holName() handles display translation.
    enObj[ds] = dateName;
  });
  return {enObj, koObj};
}

// Translate a Korean holiday name using the current language's holidays map.
// Falls back to the original Korean name for unknown/irregular holidays.
function translateHolidayName(ko, lang){
  const map = TR[lang]?.holidays;
  if(!map) return ko; // Korean or missing map — return as-is
  // Exact match first
  if(map[ko]) return map[ko];
  // Partial match (e.g. '대체공휴일' inside '어린이날 대체공휴일')
  for(const [k,v] of Object.entries(map)){
    if(ko.includes(k)) return v;
  }
  return ko; // unknown holiday — fall back to Korean name
}

// Fetch all 12 months of a year from the gov API (one request per month, run in parallel)
async function fetchHolidaysForYear(year){
  // Skip if already in-flight for this year
  if(HOL_FETCHING.has(year)) return false;
  const cacheKey = 'wt4_gov_' + year;
  const cached = localStorage.getItem(cacheKey);
  if(cached){
    try{
      const {en, ko} = JSON.parse(cached);
      Object.assign(HOLIDAYS, en);
      Object.assign(HOL_KO_DYN, ko);
      return false; // already had it — no new data, no re-render needed
    }catch(e){}
  }
  HOL_FETCHING.add(year);
  try{
    // Fetch months sequentially in small batches to avoid 429s.
    // 3 at a time with a small gap is well within typical rate limits.
    const months = Array.from({length:12}, (_,i) => String(i+1).padStart(2,'0'));
    const enObj = {}, koObj = {};
    let anyNetworkError = false;
    for(let i = 0; i < months.length; i += 3){
      const batch = months.slice(i, i+3);
      const results = await Promise.all(batch.map(async mm => {
        const url = `${GOV_API_BASE}?serviceKey=${GOV_API_KEY}&solYear=${year}&solMonth=${mm}&numOfRows=20&_type=xml`;
        try{
          const res = await fetch(url);
          if(!res.ok){
            if(res.status === 429) console.warn('[holidays] Rate limited for', year, mm, '— will retry later');
            return {enObj:{}, koObj:{}};
          }
          const xml = await res.text();
          return parseGovXML(xml);
        }catch(err){
          anyNetworkError = true; // offline / DNS / abort
          return {enObj:{}, koObj:{}};
        }
      }));
      results.forEach(({enObj:e, koObj:k}) => { Object.assign(enObj, e); Object.assign(koObj, k); });
      // Small gap between batches to stay under rate limit
      if(i + 3 < months.length) await new Promise(r => setTimeout(r, 120));
    }
    const gotData = Object.keys(enObj).length > 0 || Object.keys(koObj).length > 0;
    if(gotData){
      Object.assign(HOLIDAYS, enObj);
      Object.assign(HOL_KO_DYN, koObj);
      localStorage.setItem(cacheKey, JSON.stringify({en:enObj, ko:koObj, fetchedAt: Date.now()}));
      HOL_FAIL_UNTIL.delete(year);
      applyFixedHolidays([year]);
      return true;
    }
    // No data. If it was a network failure (offline), back off longer so we don't
    // retry on every render; if it was just an empty-but-successful response,
    // a short cooldown still prevents tight loops.
    const cooldown = anyNetworkError ? 5*60*1000 : 60*1000; // 5 min offline, 1 min otherwise
    HOL_FAIL_UNTIL.set(year, Date.now() + cooldown);
    return false;
  }catch(e){
    console.warn('Gov holiday fetch failed for', year, e.message);
    HOL_FAIL_UNTIL.set(year, Date.now() + 5*60*1000);
    return false;
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
  // Don't hammer the network when offline — fixed holidays are already applied,
  // and the gov API fetch would just fail 12×/year and re-trigger on every render.
  if(typeof navigator!=='undefined' && navigator.onLine===false) return;
  const now = Date.now();
  // A year needs fetch if: not cached (or cache >30d old), not in-flight, and not
  // in a post-failure cooldown window.
  const missing = years.filter(y => {
    if(HOL_FETCHING.has(y)) return false;            // already being fetched
    const failUntil = HOL_FAIL_UNTIL.get(y) || 0;
    if(now < failUntil) return false;                // recently failed — back off
    const raw = localStorage.getItem('wt4_gov_'+y);
    if(!raw) return true;
    try{
      const {fetchedAt} = JSON.parse(raw);
      const thirtyDays = 30 * 24 * 3600 * 1000;
      return (now - (fetchedAt||0)) > thirtyDays;
    }catch(e){ return true; }
  });
  if(!missing.length) return;
  HOL_LOADING = true;
  const results = await Promise.all(missing.map(fetchHolidaysForYear));
  HOL_LOADING = false;
  // Only re-render if at least one year actually brought in data. A failed
  // (offline) attempt returns false and must NOT trigger render() — otherwise
  // render → ensureHolidays → fetch → render becomes an infinite retry storm.
  if(results.some(Boolean)) render();
}

// Prefetch on startup in the background
function prefetchHolidays(){
  const y = new Date().getFullYear();
  ensureHolidays([y-1, y, y+1, y+2]);
}

// ── Upcoming holidays ─────────────────────────────────────────────────────────
// Returns the next `limit` public holidays strictly after today, sorted by date.
// Returns the cutoff date string (YYYY-MM-DD) for upcoming holiday windows.
// Rule: end of current year, unless that's less than 6 months away —
// in which case use 6 months from today (whichever is later).
function upcomingHolCutoff() {
  const now = new Date();
  const endOfYear = new Date(now.getFullYear(), 11, 31); // Dec 31 this year
  const sixMonths = new Date(now.getFullYear(), now.getMonth() + 6, now.getDate());
  const cutoff = sixMonths > endOfYear ? sixMonths : endOfYear;
  return mkds(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate());
}

function getUpcomingHolidays(limit = 3) {
  const td = today();
  const cutoff = upcomingHolCutoff();
  return Object.keys(HOLIDAYS)
    .filter(ds => ds > td && ds <= cutoff)
    .sort()
    .slice(0, limit)
    .map(ds => {
      const d = pd(ds);
      const diffMs = d - new Date(new Date().setHours(0,0,0,0));
      const diffDays = Math.round(diffMs / 86400000);
      return { ds, name: holName(ds), diffDays };
    });
}

// ── All-Holidays modal ────────────────────────────────────────────────────────
function buildAllHolidaysModal() {
  const td = today();
  const cutoff = upcomingHolCutoff();
  const upcoming = Object.keys(HOLIDAYS).filter(ds => ds >= td && ds <= cutoff).sort();

  function rowHTML(ds) {
    const d = pd(ds);
    const tr2 = TR[S.lang] || TR.en;
    const dow = (tr2.dh || TR.en.dh)[d.getDay()];
    const mo  = (tr2.mn || TR.en.mn)[d.getMonth()];
    const day = d.getDate();
    const diffMs = d - new Date(new Date().setHours(0,0,0,0));
    const diffDays = Math.round(diffMs / 86400000);
    const isToday = ds === td;
    const pill = isToday
      ? `<span class="hol-modal-pill hol-modal-pill--today">${t('today')||'Today'}</span>`
      : `<span class="hol-modal-pill">${t('holInDays', diffDays)}</span>`;
    return `<div class="hol-modal-row">
      <div class="hol-modal-dot"></div>
      <div class="hol-modal-date">
        <span class="hol-modal-dow">${dow}</span>
        <span class="hol-modal-mday">${mo} ${day}</span>
      </div>
      <div class="hol-modal-name">${holName(ds)}</div>
      <div class="hol-modal-right">
        ${pill}
        
      </div>
    </div>`;
  }

  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'all-hol-modal-ov';
  document.body.classList.add('modal-open');

  ov.innerHTML = `<div class="modal wm-modal hol-modal">
    <div class="wm-glow" aria-hidden="true"></div>
    <div class="wm-scroll">
    <div class="modal-header">
      <div class="modal-badge">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      </div>
      <div class="modal-header-text">
        <h3 class="modal-title">${t('holModalTitle')}</h3>
        <div class="modal-subtitle">${t('holCreditCount', upcoming.length)}</div>
      </div>
      <button class="asm-close-btn modal-close" id="all-hol-close" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-divider"></div>
    <div class="hol-modal-body">
      ${upcoming.length
        ? `<div class="hol-modal-list">${upcoming.map(rowHTML).join('')}</div>`
        : `<div class="hol-modal-empty">${t('holModalEmpty')}</div>`
      }
    </div>
    </div>
  </div>`;

  document.querySelectorAll('#all-hol-modal-ov').forEach(el => el.remove());
  document.body.appendChild(ov);

  const close = () => {
    ov.remove();
    document.body.classList.remove('modal-open');
  };
  document.getElementById('all-hol-close').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
}


const DEFAULT_WAGE=10320,DEFAULT_TAX=3.3;

// ── Language flag icons ────────────────────────────────────────────────────────
// Emoji flags (🇺🇸 etc.) are regional-indicator pairs, and Windows ships no flag
// glyphs — every Windows browser falls back to rendering the bare letters ("US",
// "KR", …). These inline SVG data-URIs (flag-icons, MIT) render identically on
// every platform and stay offline-safe (no CDN, cached with the shell). Keyed by
// language code, so en→US, ko→KR, zh→CN, ne→NP.
const FLAGS={
    en:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-us%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23bd3d44%22%20d%3D%22M0%200h640v480H0%22%2F%3E%3Cpath%20stroke%3D%22%23fff%22%20stroke-width%3D%2237%22%20d%3D%22M0%2055.3h640M0%20129h640M0%20203h640M0%20277h640M0%20351h640M0%20425h640%22%2F%3E%3Cpath%20fill%3D%22%23192f5d%22%20d%3D%22M0%200h364.8v258.5H0%22%2F%3E%3Cmarker%20id%3D%22us-a%22%20markerHeight%3D%2230%22%20markerWidth%3D%2230%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22m14%200%209%2027L0%2010h28L5%2027z%22%2F%3E%3C%2Fmarker%3E%3Cpath%20fill%3D%22none%22%20marker-mid%3D%22url(%23us-a)%22%20d%3D%22m0%200%2016%2011h61%2061%2061%2061%2060L47%2037h61%2061%2060%2061L16%2063h61%2061%2061%2061%2060L47%2089h61%2061%2060%2061L16%20115h61%2061%2061%2061%2060L47%20141h61%2061%2060%2061L16%20166h61%2061%2061%2061%2060L47%20192h61%2061%2060%2061L16%20218h61%2061%2061%2061%2060z%22%2F%3E%3C%2Fsvg%3E',
    ko:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20id%3D%22flag-icons-kr%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3CclipPath%20id%3D%22kr-a%22%3E%3Cpath%20fill-opacity%3D%22.7%22%20d%3D%22M-95.8-.4h682.7v512H-95.8z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3Cg%20fill-rule%3D%22evenodd%22%20clip-path%3D%22url(%23kr-a)%22%20transform%3D%22translate(89.8%20.4)scale(.9375)%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M-95.8-.4H587v512H-95.8Z%22%2F%3E%3Cg%20transform%3D%22rotate(-56.3%20361.6%20-101.3)scale(10.66667)%22%3E%3Cg%20id%3D%22kr-c%22%3E%3Cpath%20id%3D%22kr-b%22%20fill%3D%22%23000001%22%20d%3D%22M-6-26H6v2H-6Zm0%203H6v2H-6Zm0%203H6v2H-6Z%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23kr-b%22%20width%3D%22100%25%22%20height%3D%22100%25%22%20y%3D%2244%22%2F%3E%3C%2Fg%3E%3Cpath%20stroke%3D%22%23fff%22%20d%3D%22M0%2017v10%22%2F%3E%3Cpath%20fill%3D%22%23cd2e3a%22%20d%3D%22M0-12a12%2012%200%200%201%200%2024Z%22%2F%3E%3Cpath%20fill%3D%22%230047a0%22%20d%3D%22M0-12a12%2012%200%200%200%200%2024A6%206%200%200%200%200%200Z%22%2F%3E%3Ccircle%20cy%3D%22-6%22%20r%3D%226%22%20fill%3D%22%23cd2e3a%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22rotate(-123.7%20191.2%2062.2)scale(10.66667)%22%3E%3Cuse%20xlink%3Ahref%3D%22%23kr-c%22%20width%3D%22100%25%22%20height%3D%22100%25%22%2F%3E%3Cpath%20stroke%3D%22%23fff%22%20d%3D%22M0-23.5v3M0%2017v3.5m0%203v3%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    id:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-id%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23e70011%22%20d%3D%22M0%200h640v240H0Z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%20240h640v240H0Z%22%2F%3E%3C%2Fsvg%3E',
    th:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-th%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cg%20fill-rule%3D%22evenodd%22%3E%3Cpath%20fill%3D%22%23f4f5f8%22%20d%3D%22M0%200h640v480H0z%22%2F%3E%3Cpath%20fill%3D%22%232d2a4a%22%20d%3D%22M0%20162.5h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%23a51931%22%20d%3D%22M0%200h640v82.5H0zm0%20400h640v80H0z%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    ru:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-ru%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M0%200h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%230039a6%22%20d%3D%22M0%20160h640v160H0z%22%2F%3E%3Cpath%20fill%3D%22%23d52b1e%22%20d%3D%22M0%20320h640v160H0z%22%2F%3E%3C%2Fsvg%3E',
    zh:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20id%3D%22flag-icons-cn%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3Cpath%20id%3D%22cn-a%22%20fill%3D%22%23ff0%22%20d%3D%22M-.6.8%200-1%20.6.8-1-.3h2z%22%2F%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%22%23ee1c25%22%20d%3D%22M0%200h640v480H0z%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(71.9991%200%200%2072%20120%20120)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(-12.33562%20-20.5871%2020.58684%20-12.33577%20240.3%2048)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(-3.38573%20-23.75998%2023.75968%20-3.38578%20288%2095.8)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(6.5991%20-23.0749%2023.0746%206.59919%20288%20168)%22%2F%3E%3Cuse%20xlink%3Ahref%3D%22%23cn-a%22%20width%3D%2230%22%20height%3D%2220%22%20transform%3D%22matrix(14.9991%20-18.73557%2018.73533%2014.99929%20240%20216)%22%2F%3E%3C%2Fsvg%3E',
    fr:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-fr%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cpath%20fill%3D%22%23000091%22%20d%3D%22M0%200h213.3v480H0z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M213.3%200h213.4v480H213.3z%22%2F%3E%3Cpath%20fill%3D%22%23e1000f%22%20d%3D%22M426.7%200H640v480H426.7z%22%2F%3E%3C%2Fsvg%3E',
    ne:'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20id%3D%22flag-icons-np%22%20viewBox%3D%220%200%20640%20480%22%3E%3Cdefs%3E%3CclipPath%20id%3D%22np-a%22%3E%3Cpath%20fill-opacity%3D%22.7%22%20d%3D%22M0-16h512v512H0z%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3Cg%20clip-path%3D%22url(%23np-a)%22%20transform%3D%22translate(0%2015)scale(.9375)%22%3E%3Cg%20fill-rule%3D%22evenodd%22%3E%3Cpath%20fill%3D%22%23ce0000%22%20stroke%3D%22%23000063%22%20stroke-width%3D%2213.8%22%20d%3D%22M6.5%20489.5h378.8L137.4%20238.1l257.3.3L6.6-9.5v499z%22%2F%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22m180.7%20355.8-27%209%2021.2%2019.8-28.5-1.8%2011.7%2026.2-25.5-12.3.5%2028.6-18.8-20.9-10.7%2026.6-9.2-26.3-20.3%2020.6%201.8-27.7L49%20409l12.6-25-29.3.6%2021.5-18.3-27.3-10.5%2027-9L32.2%20327l28.4%201.8L49%20302.6l25.6%2012.3-.5-28.6%2018.8%2020.9%2010.7-26.6%209.1%2026.3%2020.4-20.6-1.9%2027.7%2027-11.4-12.7%2025%2029.4-.6-21.5%2018.3zm-32.4-184.7-11.3%208.4%205.6%204.6a94%2094%200%200%200%2030.7-36c1.8%2021.3-17.7%2069-68.7%2069.5a70.6%2070.6%200%200%201-71.5-70.3c10%2018.2%2016.2%2027%2032%2036.5l4.7-4.4-10.6-8.9%2013.7-3.6-7.4-12.4%2014.4%201-1.8-14.4%2012.6%207.4%204-13.5%209%2010.8%208.5-10.3%204.6%2014%2011.8-8.2-1.5%2014.3%2014.2-1.7-6.7%2013.2z%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E',
};
// Renders a language flag as an isolated <img> (data-URI SVG), so each flag's
// internal element ids can't collide when the same flag appears more than once.
const flagImg=(code,cls)=>`<img class="${cls}" src="${FLAGS[code]||''}" alt="" aria-hidden="true" draggable="false">`;

// ── Deductions ───────────────────────────────────────────────────────────────
// Two mutually-exclusive modes decide what's subtracted from gross pay:
//   'tax'       → a single flat withholding % (default; Korea's 3.3% freelancer
//                 withholding is the out-of-the-box value)
//   'insurance' → Korea's 4대 보험 employee-side contributions, summed
// Only ONE mode is ever active, so net = gross × (1 − activeRate) in both cases;
// only the source of activeRate differs. Mode defaults to 'tax' so existing
// users see zero change until they opt in.
//
// Insurance rates are stored as editable employee-side percentages. Defaults are
// the 2026 statutory employee shares (산재/industrial-accident is 100% employer-
// paid, so it is intentionally excluded). Long-term care (care) is legally a
// percentage OF the health premium (13.14%), not of gross — so it's stored as
// that ratio and derived from the health rate, staying correct if health changes.
const DEFAULT_INSURANCE = {
  pension:    4.75,    // 국민연금 — employee half of 9.5%
  health:     3.595,   // 건강보험 — employee half of 7.19%
  careOfHealth: 13.14, // 장기요양 — % OF the health premium (not of gross)
  employment: 0.9,     // 고용보험 — employee share (frozen for 2026)
};
function getDeductionMode(){ return ld('wt4_deduction_mode', 'tax'); }
function getInsurance(){
  const s = ld('wt4_insurance', null);
  return s ? { ...DEFAULT_INSURANCE, ...s } : { ...DEFAULT_INSURANCE };
}
// Effective long-term-care rate as a % of GROSS = health × (careOfHealth/100).
function careRateOfGross(ins){
  ins = ins || getInsurance();
  return ins.health * (ins.careOfHealth/100);
}
// Combined employee insurance deduction as a fraction of gross (0..1).
function insuranceRate(ins){
  ins = ins || getInsurance();
  const pct = ins.pension + ins.health + careRateOfGross(ins) + ins.employment;
  return pct/100;
}
// Tax rate is stored as a percentage (e.g. 3.3) in wt4_tax_rate
function getTax(){return ld('wt4_tax_rate',DEFAULT_TAX)/100;}
// The single active deduction fraction, per current mode.
function deductionRate(){
  return getDeductionMode()==='insurance' ? insuranceRate() : getTax();
}
// Display-facing versions of the above: whatever mode is active (tax vs.
// 4대 보험 insurance), these give the correct percentage AND the correct
// localized noun so UI copy never says "X% tax" while insurance is active.
// Use these (not getTaxPct()/hardcoded "tax" strings) for any user-facing
// label that shows the deduction rate.
function getActiveDeductionPct(){return Math.round(deductionRate()*100*100)/100;}
function getDeductionNoun(){return t(getDeductionMode()==='insurance'?'deductionModeInsurance':'deductionModeTax');}
function ld(k,d){try{const v=localStorage.getItem(k);return v!==null?JSON.parse(v):d;}catch{return d;}}
function sv(k,v){localStorage.setItem(k,JSON.stringify(v));}
function pad(n){return String(n).padStart(2,'0');}
function mkds(y,m,d){return`${y}-${pad(m+1)}-${pad(d)}`;}
function pd(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
function today(){const d=new Date();return mkds(d.getFullYear(),d.getMonth(),d.getDate());}
function dowOf(s){return pd(s).getDay();}
function getLogs(){return ld('wt4_logs',{});}
function saveLogs(l){sv('wt4_logs',l);scheduleSync();}

// ── One-tap default inference ─────────────────────────────────────────────────
// Work out the user's "usual" hours so a single tap can log a normal shift.
// Strategy (strongest signal first):
//   1. Look at recent logs of the SAME shift type (day/night) as the target date.
//   2. Find the modal (most common) regular-hours value among them.
//   3. Only trust it if it's consistent enough (the confidence gate) — otherwise
//      the user is irregular and we should NOT offer one-tap (they use the modal).
// Overtime is never assumed (unpredictable): the default is always OT = 0.
// Returns null when there isn't enough confident signal to offer a one-tap log.
const QUICK_LOG_MIN_SAMPLES = 3;     // need at least this many same-type logs
const QUICK_LOG_MIN_CONFIDENCE = 0.7; // ≥70% must share the modal hours value
function defaultLogFor(dateStr){
  const shift = shiftFor(dateStr); // day/night/(double never auto-defaulted)
  if(shift==='double') return null; // doubles are deliberate — never one-tap
  const logs = getLogs();
  // Gather regular-hours from recent logs of the same shift type, newest first.
  const sameType = Object.keys(logs)
    .filter(d => d <= today())
    .sort().reverse()
    .map(d => ({ d, log: logs[d] }))
    .filter(({d, log}) => {
      if(!log || typeof log.regHrs !== 'number' || log.regHrs <= 0) return false;
      const s = log.shiftOverride || shiftFor(d);
      return s === shift;
    })
    .slice(0, 12); // recent window

  if(sameType.length < QUICK_LOG_MIN_SAMPLES) return null;

  // Modal (most frequent) regular-hours value.
  const counts = {};
  sameType.forEach(({log}) => { counts[log.regHrs] = (counts[log.regHrs]||0)+1; });
  let bestHrs = null, bestCount = 0;
  Object.entries(counts).forEach(([hrs, n]) => { if(n > bestCount){ bestCount = n; bestHrs = parseFloat(hrs); } });

  // Confidence gate: the modal value must dominate, else the user is irregular.
  const confidence = bestCount / sameType.length;
  if(confidence < QUICK_LOG_MIN_CONFIDENCE) return null;

  return { regHrs: bestHrs, otHrs: 0, shift };
}

// Build a full log entry (same shape as the modal's save path) for a one-tap log.
function buildQuickLogEntry(dateStr){
  const def = defaultLogFor(dateStr);
  if(!def) return null;
  const wage = wageFor(dateStr);
  const c = calcWage(dateStr, def.regHrs, def.otHrs, wage, def.shift, undefined);
  const weekShift = shiftFor(dateStr);
  const override = def.shift !== weekShift ? def.shift : undefined;
  return {
    regHrs: def.regHrs, otHrs: def.otHrs, hrs: def.regHrs + def.otHrs,
    gross: c.gross, net: c.net, eff: c.eff,
    ...(override && { shiftOverride: override }),
  };
}
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
  // Always look up the Korean name first (source of truth from the API)
  const ko = HOL_KO_DYN[s];
  if(!ko) return HOLIDAYS[s] || s; // legacy fallback for pre-fetched data
  if(S.lang === 'ko') return ko;
  return translateHolidayName(ko, S.lang);
}
function isSun(s){return dowOf(s)===0;}
function isSat(s){return dowOf(s)===6;}
// Applies whichever deduction mode is active (tax or insurance).
// Named applyTax for backward-compat with existing call sites.
function applyDeductions(g){return Math.round(g*(1-deductionRate()));}
function applyTax(g){return applyDeductions(g);}

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
// Phase 1: the calculator moved VERBATIM to calc.js (single source of truth,
// shared with export.js). This adapter keeps the original call signature so
// every existing call site is untouched; it packages the app-side environment
// (language, holiday set, shift inference, holAuto, active deduction) into the
// explicit ctx that calc.js's pure implementation requires.
// Phase 2a: the calculator is profile-driven. getProfile() reads wt4_profile
// and falls back WHOLESALE to the default (today's rulebook) when absent or
// unrecognized — every existing user is grandfathered with zero change.
// wt4_profile does not sync yet; it joins SYNC_KEYS a release after the
// merge:true fix in firebase.js has rolled out (see that file).
function getProfile(){
  const p = ld('wt4_profile', null);
  return isUsableProfile(p) ? p : DEFAULT_PROFILE;
}
// Phase 4: projection primitives — every number the Overview projections use
// now comes from an engine probe of the ACTIVE profile. The last hardcoded
// rule constants (21.16/25.16/33.16/9.16) leave app.js with this change.
// The representative day length is the profile's composite part hours.
function probeHours(){
  const p=getProfile();
  return (p.composites&&p.composites.double&&p.composites.double.parts[0].hours)||8;
}
function engineDayClass(ds){ return classifyDayCore(ds, isHol(ds), getProfile()); }
// Plain-base effective hours for a day (OT excluded), for the overtime split:
// doubles use the full composite for the day's class; single shifts use the
// WEEKDAY table regardless of day class — deliberately preserving the
// historical definition of "base pay" the OT split has always used.
function baseEffFor(ds, sh){
  const profile=getProfile();
  if(sh==='double')
    return calcDayCore(profile,{dayClass:engineDayClass(ds),shift:'double',regHrs:0,otHrs:0,holCredit:isHolAuto()}).eff;
  return calcDayCore(profile,{dayClass:'weekday',shift:sh,regHrs:probeHours(),otHrs:0,holCredit:false}).eff;
}
// Projection buckets: one per (shift × own-table class) + restday + holiday.
// Aliased classes (workedAs) pool into their target's buckets — same formula,
// same statistics. The default profile yields the historical six buckets.
function bucketKeys(){
  const p=getProfile(); const keys=[];
  for(const cls of ['weekday','saturday']) if(!p.rates[cls].workedAs)
    for(const sh of p.shifts) keys.push(sh+'|'+cls);
  keys.push('restday','holiday'); return keys;
}
function bucketFor(ds){
  const p=getProfile(); const cls=engineDayClass(ds);
  if(cls==='restday'||cls==='holiday') return cls;
  const pooled=(p.rates[cls].workedAs)||cls;
  return shiftFor(ds)+'|'+pooled;
}
// Deterministic projection floor: a representative plain day of this bucket.
function bucketDeterministicEff(bucket){
  const profile=getProfile();
  if(bucket==='restday')
    return calcDayCore(profile,{dayClass:'restday',shift:profile.shifts[0],regHrs:0,otHrs:0,holCredit:false}).eff;
  if(bucket==='holiday')
    return calcDayCore(profile,{dayClass:'holiday',shift:profile.shifts[0],regHrs:0,otHrs:0,holCredit:isHolAuto()}).eff;
  const i=bucket.indexOf('|');
  return calcDayCore(profile,{dayClass:bucket.slice(i+1),shift:bucket.slice(0,i),regHrs:probeHours(),otHrs:0,holCredit:true}).eff;
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 5: pay-rules wizard — the authoring UI over compile.js.
// Pure state → HTML → answers → compiled profile. Shared verbatim between the
// onboarding step and the Settings "Edit pay rules" editor.
// ═════════════════════════════════════════════════════════════════════════════
// wiz strings ship in en+ko; the other locales fall back to English until
// natively translated (flagged in the Phase 5 report).
function wizT(lang,k){
  const w=(TR[lang]&&TR[lang].wiz)||TR.en.wiz;
  return w[k]!==undefined?w[k]:TR.en.wiz[k];
}
function WIZ_DEFAULT_RULES(){ return { preset:'kr-statutory-5plus', night:'idk', sat:'idk', hol:'idk', ot:'idk', rest:'idk' }; }
// Answers from chip state. "I don't know" → Korean statutory defaults
// (minimum-leaning, per the wizard answerability audit): night +50%, Saturday
// same as weekdays, worked holidays ×1.5, OT ×1.5, paid rest day yes.
function wizardAnswersFrom(rules){
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
function wizardProfileFrom(rules, pattern){
  const answers=wizardAnswersFrom(rules);
  // Attach the user's night schedule (asked once) so overlap mode can compute.
  if(rules.schedule&&rules.schedule.night) answers.schedule={night:{...rules.schedule.night}};
  const p=compileProfileV2(answers,{id:rules.preset||'custom'});
  p.source={kind:rules.preset?'preset':'wizard',...(rules.preset?{presetId:rules.preset}:{}),answers};
  return p;
}
// Reopen the wizard from a stored profile's source.answers (round-trip).
function rulesStateFromProfile(profile){
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
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// The workplace form \u2014 a configuration panel, not a form. Shared verbatim by
// onboarding step 3 and the Settings "Edit workplace" modal.
//
// RENDERS ONCE. Every interaction after mount is a surgical DOM update: class
// toggles for selection, textContent swaps for the live preview, and animated
// grid-row FOLDS for the progressive sections (Customize questions, the night
// panel, the unpaid break). The form is never re-rendered, so scroll position,
// focus, and the glass panels never jump.
//
// Context-aware: pass {pattern:'day'} and everything night-related \u2014 the night
// question, the schedule panel, the night preview line \u2014 simply doesn't exist.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
const WZI={
  factory:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>',
  std:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
  custom:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  check:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  moon:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  prem:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>',
  info:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  coffee:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>',
  spark:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  cal:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  sun:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  clock:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  rest:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 12a11.05 11.05 0 0 0-22 0zm-5 7a3 3 0 0 1-6 0v-7"/></svg>',
  minus:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  plus:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  // Split-onboarding additions: preset-card + section glyphs
  users:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  gear:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  restore:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  office:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>',
  shield:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  cycle:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>',
  lock:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  arrowR:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>',
};
// \u2500\u2500 Rate steppers \u2014 the Customize interaction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Each pay rule is one row: icon \u00b7 label \u00b7 plain-language caption ("+50%") \u00b7
// a \u00d7-multiplier stepper that snaps along a \u00d70.25 detent grid. Legacy profiles
// may hold off-grid multipliers (\u00d71.6), so a step first snaps to the grid in
// the direction of travel instead of drifting by a fixed increment.
const WZ_STEP={min:1,max:5,inc:0.25};
function wzStepNext(v,dir){
  const q=v/WZ_STEP.inc, eps=1e-9;
  const n=dir>0?Math.floor(q+eps)+1:Math.ceil(q-eps)-1;
  return Math.min(WZ_STEP.max,Math.max(WZ_STEP.min,+(n*WZ_STEP.inc).toFixed(2)));
}
// Display value: unanswered ('idk') renders \u2014 and saves \u2014 as the Korean
// standard default, so what the row shows is exactly what saving compiles.
function wzRuleVal(st,q){ return typeof st[q]==='number'?st[q]:1.5; }
function wzRestOn(st){ return st.rest==='idk'?true:!!st.rest; }
function wzFmtMult(v){ return '\u00d7'+(+v.toFixed(2)); }
function wzCapText(lang,v){ return v>1?`+${Math.round((v-1)*100)}%`:wizT(lang,'cNone'); }
// Break durations tick within [0, 4h]: the total in 15-minute detents, the
// night portion in finer 5-minute detents (the overlap is fiddly to get exact).
// Legacy profiles may hold off-grid minute counts, so a step snaps to the grid
// in the direction of travel (same rule as the rate steppers).
const WZ_BRK={min:0,max:240,inc:15,incNight:5};
function wzDurNext(v,dir,inc){
  inc=inc||WZ_BRK.inc;
  const q=v/inc, eps=1e-9;
  const n=dir>0?Math.floor(q+eps)+1:Math.ceil(q-eps)-1;
  return Math.min(WZ_BRK.max,Math.max(WZ_BRK.min,Math.round(n*inc)));
}
function wzFmtDur(lang,min){ return wizT(lang,'dur')(Math.floor(min/60),min%60); }
// Current break state, normalized: night portion defaults to "all of it" (a
// night shift's break usually falls at night) and can never exceed the total.
function wzBreakOf(n){
  const tot=Math.max(0,n&&n.breakMin||0);
  const night=Math.min(tot,(n&&n.breakNightMin!=null)?Math.max(0,n.breakNightMin):tot);
  return {tot,night};
}
// One-time migration of older stored break forms into the duration pair the UI
// authors, derived through the SAME engine math that priced them \u2014 so the
// converted numbers reproduce the exact night/plain hours the user was paid:
//  \u2022 anchored {start,end} \u2192 total minutes inside the shift + minutes that fell
//    in premium runs;
//  \u2022 bare breakMin (count-only, plain-first) \u2192 its effective night portion.
function wzNormBreak(st){
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
function wzRuleRowHTML(lang,q,st){
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
// Live preview rows: honest engine probes of the compiled profile — hours only
// (the wage isn't known yet on the onboarding rules step). Attaches the
// schedule exactly like wizardProfileFrom so the preview matches what SAVING
// would produce (overlap-mode premium + break deduction, never a stale guess).
// Day-pattern users get day-relevant probes instead of a night line.
function wzPreviewRows(st,lang,pattern){
  try{
    const answers=wizardAnswersFrom(st);
    if(pattern!=='day'&&st.schedule&&st.schedule.night) answers.schedule={night:{...st.schedule.night}};
    const p=compileProfileV2(answers);
    const g=(TR[lang]&&TR[lang].seg)||TR.en.seg;
    const probe=(cls,sh,h,hc)=>g.num(+(calcDayCore(p,{dayClass:cls,shift:sh,regHrs:h,otHrs:0,holCredit:hc!==false}).eff).toFixed(2));
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
function wzPreviewHTML(st,lang,pattern){
  const rows=wzPreviewRows(st,lang,pattern);
  if(!rows.length) return '';
  return `<div class="wz-pv-head"><span class="wz-pv-spark">${WZI.spark}</span>${wizT(lang,'prevTitle')}</div>
    ${rows.map(r=>`<div class="wz-pv-row wz-pv-row--${r.cls}"><span class="wz-pv-k">${r.k}</span><span class="wz-pv-v" data-wz-pv="${r.cls}">${r.v}</span></div>`).join('')}`;
}
// Does the current chip state compile to an overlap-mode night profile that
// needs the user's schedule? (Threshold presets like the factory never do.)
function wizNeedsSchedule(st){
  try{ return needsNightSchedule(compileProfileV2(wizardAnswersFrom(st))); }
  catch(e){ return false; }
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
function wzSchedHTML(st,lang){
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
function wzFoldEl(el,open){
  if(!el) return;
  el.classList.toggle('wz-fold--open',!!open);
  el.setAttribute('aria-hidden',open?'false':'true');
  if(el.firstElementChild) el.firstElementChild.inert=!open;
}
function wzPopEl(el){ if(!el) return; el.classList.remove('wz-pop'); void el.offsetWidth; el.classList.add('wz-pop'); }
function wzSyncRules(root,st,lang,animate){
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
function wzSyncBreak(root,st,lang,animate){
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

function workplaceFormHTML(st,lang,opts){
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
function wireWorkplaceForm(root,st,opts){
  const lang=(opts&&opts.lang)||S.lang;
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
function obxNeedsSchedPage(st,pattern){
  return pattern!=='day' && wizNeedsSchedule(st);
}

function obxWorkplaceHTML(st,lang,pattern){
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
function obxWireWorkplace(root,st,opts){
  const lang=(opts&&opts.lang)||S.lang;
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

// ── Night Schedule page — data + markup + wiring ─────────────────────────────
// Everything the preview shows is engine truth: hours via nightHoursOf() (the
// exact function that prices real shifts) and the effective total via a
// calcDayCore probe of the compiled profile — never a hand-rolled estimate.
function obxNightData(st){
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
    eff=+(calcDayCore(p,{dayClass:'weekday',shift:'night',regHrs:paidH,otHrs:0,holCredit:true}).eff).toFixed(2);
  }catch(err){}
  return {
    segs:segs.filter(x=>x.min>0), dur, labels, tot, bn,
    plainH:nh.plainHours, nightH:nh.nightHours,
    paidH, eff, bonus:Math.max(0,+(eff-paidH).toFixed(2)), mult,
    shiftTxt:`${n.start} – ${n.end}`,
  };
}
function obxNightPreviewHTML(st,lang){
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
function obxNightHTML(st,lang){
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
function obxWireNight(root,st,opts){
  const lang=(opts&&opts.lang)||S.lang;
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

// Phase 3b: the "Wage Calculation Rules" card is generated from the ACTIVE
// profile via engine probes — correct for any custom profile, not just the
// factory default (verified against the legacy table by tests/rules-replay).
function rulesRows(){
  return buildRulesRows(getProfile(), TR[S.lang].seg,
    { holAuto: isHolAuto(), dedPct: getActiveDeductionPct(), dedNoun: getDeductionNoun() });
}
function calcWage(dateStr,regHrs,otHrs,wage,shiftOverride,holCreditOverride){
  return calcWageCore(
    { tr: TR[S.lang], holAuto: isHolAuto(), isHol, shiftFor, applyTax, profile: getProfile() },
    dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride
  );
}

// ── State ─────────────────────────────────────────────────────────────────────
let S={
  lang:ld('wt4_lang','en'),theme:ld('wt4_theme','dark'),holAuto:ld('wt4_hol_auto',true),
  taxRate:ld('wt4_tax_rate',DEFAULT_TAX),
  targetHrs:ld('wt4_target_hrs',250),
  tab:'calendar',calY:new Date().getFullYear(),calM:new Date().getMonth(),
  modal:null,success:'',
  chartRange:'3m',   // '3m' | '6m' | '1y'
  wageModal:null,   // transient: {mode:'add'|'edit'|'delete', idx?:number} or null
  resetModal:false, // transient: whether the "Reset all data" confirmation modal is open
  rulesCollapsed:ld('wt4_rules_collapsed',false), // settings: Wage Calc Rules card collapsed?
};
function t(k,...a){const fn=TR[S.lang][k];return typeof fn==='function'?fn(...a):(fn||k);}
// Success feedback uses the same floating toast as exports (showExportToast):
// a self-dismissing checkmark pill at the bottom of the screen, instead of an
// inline message inside the card. Call sites may pass either a ready-made
// message string (e.g. t('wageSaved')) or one of the keys mapped below.
//
// We also re-render here so the rest of the UI (hero stats, the holiday
// switch, etc.) immediately reflects the change that was just saved — every
// caller of showSuccess() has just mutated state and expects a refresh.
const _SUCCESS_MSG={
  taxRate:   ()=>t('taxRateSaved'),
  insurance: ()=>t('insuranceSaved'),
  targetHrs: ()=>t('monthlyTargetSaved'),
  holAuto:   ()=>t('holAutoSaved'),
};
function showSuccess(val){
  const msg=_SUCCESS_MSG[val]?_SUCCESS_MSG[val]():val;
  render();
  if(msg) showExportToast(msg);
}

// ── Interactive undo toast ──────────────────────────────────────────────────
// Like showExportToast, but carries an "Undo" action button and stays a little
// longer so the user has time to react. Used by the week-shift flip so a tap
// that re-alternates every following week is always recoverable.
let _undoToastTimer=null;
function showUndoToast(message,onUndo){
  document.getElementById('undo-toast')?.remove();
  clearTimeout(_undoToastTimer);

  const el=document.createElement('div');
  el.id='undo-toast';
  el.className='undo-toast';
  el.innerHTML=`<svg class="undo-toast__ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>`+
    `<span class="undo-toast__msg">${message}</span>`+
    `<button type="button" class="undo-toast__btn">${t('undo')}</button>`;
  document.body.appendChild(el);

  const dismiss=()=>{
    el.classList.remove('undo-toast--visible');
    setTimeout(()=>el.remove(),220);
  };
  el.querySelector('.undo-toast__btn').addEventListener('click',()=>{
    clearTimeout(_undoToastTimer);
    dismiss();
    onUndo?.();
  });

  requestAnimationFrame(()=>el.classList.add('undo-toast--visible'));
  _undoToastTimer=setTimeout(dismiss,4500);
}
function isHolAuto(){return S.holAuto!==false;}
function getTaxPct(){return S.taxRate;} // percentage for display (e.g. 3.3)
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
    return calcWage(ds, reg, ot, w, l.shiftOverride, l.holCreditOverride).gross;
  }
  const todayStr = today();
  // Holiday auto-credit is suppressed when the holiday falls on a Saturday —
  // Saturdays follow the separate 50% Saturday pay rule, not the 8h credit.
  if(isHol(ds) && !isSat(ds) && ds <= todayStr){
    const logEntry=logs[ds];
    const credit = logEntry?.holCreditOverride !== undefined ? logEntry.holCreditOverride : isHolAuto();
    if(credit && !logEntry) return Math.round(8 * w); // auto-credit, no manual log
  }
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
  if(logs[ds]){
    const l = logs[ds];
    const reg = l.regHrs !== undefined ? l.regHrs : (l.hrs || 0);
    const ot  = l.otHrs  !== undefined ? l.otHrs  : 0;
    return calcWage(ds, reg, ot, wageFor(ds), l.shiftOverride, l.holCreditOverride).eff;
  }
  const todayStr = today();
  // Holiday auto-credit is suppressed when the holiday falls on a Saturday —
  // Saturdays follow the separate 50% Saturday pay rule, not the 8h credit.
  if(isHol(ds) && !isSat(ds) && ds <= todayStr){
    const logEntry=getLogs()[ds];
    const credit = logEntry?.holCreditOverride !== undefined ? logEntry.holCreditOverride : isHolAuto();
    if(credit && !logEntry) return 8;
  }
  if(isSun(ds) && !isHol(ds) && ds <= todayStr && allWeekdaysLogged(ds)) return 8;
  return 0;
}

// ── Holiday separator visibility ─────────────────────────────────────────────
// Hides a .hol-sep when it has wrapped to the start of a new row — i.e. when
// its top offset differs from the chip that follows it. Called after render
// and on resize so it stays correct on all screen sizes.
let _holSepObserver = null;
function updateHolSeps(){
  const list = document.querySelector('.hol-list');
  if(!list) return;
  const seps = list.querySelectorAll('.hol-sep');
  seps.forEach(sep => {
    const next = sep.nextElementSibling; // the .hchip after this sep
    const prev = sep.previousElementSibling; // the .hchip before this sep
    if(!next || !prev) { sep.style.display='none'; return; }
    // If the sep's top matches the previous chip's top, they're on the same row → show
    // If the sep wrapped to a new row (its top > prev chip's top), hide it
    const sepTop  = sep.getBoundingClientRect().top;
    const prevTop = prev.getBoundingClientRect().top;
    sep.style.visibility = Math.abs(sepTop - prevTop) < 4 ? '' : 'hidden';
    sep.style.margin     = Math.abs(sepTop - prevTop) < 4 ? '' : '0';
    sep.style.width      = Math.abs(sepTop - prevTop) < 4 ? '' : '0';
  });
  // Watch for container resize and re-evaluate
  if(_holSepObserver) _holSepObserver.disconnect();
  _holSepObserver = new ResizeObserver(() => {
    const l = document.querySelector('.hol-list');
    if(!l){ _holSepObserver.disconnect(); return; }
    l.querySelectorAll('.hol-sep').forEach(sep => {
      const next = sep.nextElementSibling;
      const prev = sep.previousElementSibling;
      if(!next || !prev){ sep.style.visibility='hidden'; sep.style.width='0'; sep.style.margin='0'; return; }
      const sepTop  = sep.getBoundingClientRect().top;
      const prevTop = prev.getBoundingClientRect().top;
      const same = Math.abs(sepTop - prevTop) < 4;
      sep.style.visibility = same ? '' : 'hidden';
      sep.style.width      = same ? '' : '0';
      sep.style.margin     = same ? '' : '0';
    });
  });
  _holSepObserver.observe(list);
}

// ── Header icons ──────────────────────────────────────────────────────────────
// Inline SVGs so header controls match the app's stroked iconography instead of
// emoji (which render inconsistently across platforms and clash with the UI).
// All share: 16px box, currentColor, stroke-width 2, round caps/joins.
const _svg=(inner,w=16)=>`<svg class="hdr-svg" width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_SUN   =_svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>');
const ICON_MOON  =_svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');
const ICON_GLOBE =_svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>');
// Google "G" — multicolor, matches the OAuth provider. Fixed colors (not currentColor).
const ICON_GOOGLE=`<svg class="hdr-svg" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>`;
const ICON_OFFLINE=_svg('<path d="M18 10h-1.26a8 8 0 0 0-3.4-4.5"/><path d="M6.3 6.3A8 8 0 0 0 9 20h9a5 5 0 0 0 1.9-.37"/><path d="M2 2l20 20"/>',15);
// Sync states — cloud (synced), cloud with arrows (pending), cloud-off (offline)
const SYNC_ICONS={
  synced:  _svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',15),
  pending: _svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><path d="M9.5 14.5l1.6 1.6 3-3.2"/>',15),
  offline: _svg('<path d="M18 10h-1.26a8 8 0 0 0-3.4-4.5"/><path d="M6.3 6.3A8 8 0 0 0 9 20h9a5 5 0 0 0 1.9-.37"/><path d="M2 2l20 20"/>',15),
  idle:    '',
};

// ── Header helpers: greeting + relative sync time ─────────────────────────────
// Time-based greeting for the brand's secondary label. Falls back to English if
// a locale hasn't defined the key (t() returns the key itself when missing).
function greeting(){
  const h=new Date().getHours();
  // Morning 5–11, Afternoon 12–17, Evening 18–4 (no "good night").
  const key=h<5?'greetEvening':h<12?'greetMorning':h<18?'greetAfternoon':'greetEvening';
  const fallback={greetMorning:'Good morning',greetAfternoon:'Good afternoon',greetEvening:'Good evening'}[key];
  const v=t(key);
  const text=v===key?fallback:v;
  // Punctuation: '~!' for en/ko/fr/zh, plain '!' elsewhere.
  const lang=S?.lang||localStorage.getItem('wt4_lang')||'en';
  const suffix=['en','ko','fr','zh'].includes(lang)?'~!':'!';
  return text+suffix;
}
// "Last synced 2m ago" style relative label from the wt4_syncedAt timestamp.
// Returns null when there's nothing to show (never synced / not signed in).
function lastSyncedLabel(){
  const ts=Number(localStorage.getItem('wt4_syncedAt')||0);
  if(!ts) return null;
  const secs=Math.max(0,Math.floor((Date.now()-ts)/1000));
  if(secs<10)  return t2('syncJustNow','Just now');
  if(secs<60)  return t2('syncSecsAgo','{n}s ago').replace('{n}',secs);
  const mins=Math.floor(secs/60);
  if(mins<60)  return t2('syncMinsAgo','{n}m ago').replace('{n}',mins);
  const hrs=Math.floor(mins/60);
  if(hrs<24)   return t2('syncHrsAgo','{n}h ago').replace('{n}',hrs);
  const days=Math.floor(hrs/24);
  return t2('syncDaysAgo','{n}d ago').replace('{n}',days);
}
// t2: translate-with-fallback (t() returns the key when a string is missing).
function t2(key,fallback){ const v=t(key); return v===key?fallback:v; }

// ── Render ────────────────────────────────────────────────────────────────────
function render(){
  applyTheme();
  document.title = t('pageTitle');
  // If a modal is open, don't rebuild #app — the modal is self-contained.
  // Rebuilding #app while a modal is open re-stacks event listeners and
  // causes the page to visually flash behind the overlay.
  const modalOpen = !!(S.modal || S.wageModal || S.resetModal || document.getElementById('all-shifts-ov'));
  if(!modalOpen){
    _headerBound=false;   // header nodes are about to be recreated
    document.getElementById('app').innerHTML=buildApp();
    attachListeners();
  }
  if(S.modal)buildModal();
  if(S.wageModal)buildWageModal();
  if(S.resetModal)buildResetModal();
  updateOfflineBanner();
}

function buildApp(){
  // Sync badge — only shown when signed in; status from firebase.js.
  const ss=getSyncStatus();
  const ssTip={synced:'Synced',pending:'Syncing…',offline:'Offline — saved locally',idle:''}[ss]||'';
  const syncHTML=CURRENT_USER
    ?`<span id="sync-badge" class="sync-badge sync-badge--${ss}" title="${ssTip}" aria-label="${ssTip}">${SYNC_ICONS[ss]||SYNC_ICONS.synced}</span>`
    :'';
  // Account trigger — avatar or initial; dropdown is a body-level portal (see attachListeners)
  const accountHTML=CURRENT_USER
    ?`<button class="hdr-icon-btn hdr-avatar-btn" id="account-btn" title="${CURRENT_USER.displayName||CURRENT_USER.email}" aria-label="Account">
        ${CURRENT_USER.photoURL
          ?`<img src="${CURRENT_USER.photoURL}" class="avatar" alt="">`
          :`<span class="avatar-initials">${(CURRENT_USER.displayName||CURRENT_USER.email||'?')[0].toUpperCase()}</span>`}
      </button>`
    :`<button id="auth-login" class="hdr-signin${!navigator.onLine?' hdr-signin--disabled':''}"${!navigator.onLine?' disabled aria-disabled="true"':''} aria-label="${t('signIn')}">
        ${navigator.onLine?ICON_GOOGLE:ICON_OFFLINE}
        <span class="hdr-signin-label">${!navigator.onLine?t('offlineShort'):t('signIn')}</span>
      </button>`;
  // Theme + language triggers use inline SVGs to match the rest of the UI.
  const themeHTML=`<button class="hdr-icon-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme">${S.theme==='dark'?ICON_SUN:ICON_MOON}</button>`;
  const langHTML=`<button class="hdr-icon-btn" id="lang-btn" title="Language" aria-label="Language">${ICON_GLOBE}</button>`;
  // Brand secondary label — a time-based greeting for a premium, personal feel.
  const greet=greeting();
  // Last-synced sits in the left section, right after the greeting, separated by
  // a faded vertical divider. Desktop only (hidden on mobile via CSS).
  const syncedLbl=CURRENT_USER?lastSyncedLabel():null;
  const lastSyncedHTML=syncedLbl
    ?`<span class="hdr-sub-divider" aria-hidden="true"></span>
      <span class="hdr-synced" id="hdr-synced" aria-live="polite">
        <span class="hdr-synced-dot" aria-hidden="true"></span>
        <span class="hdr-synced-text">${t2('lastSynced','Last synced')}</span>
        <span class="hdr-synced-time" id="hdr-synced-time">${syncedLbl}</span>
      </span>`
    :'';
  const logoSrc=S.theme==='dark'?'./logo-dark.svg':'./logo-light.svg';
  return`<div class="hdr">
    <div class="hdr-glow" aria-hidden="true"></div>
    <div class="hdr-brand">
      <span class="hdr-mark" aria-hidden="true">
        <img src="${logoSrc}" width="100%" height="100%" alt="" draggable="false">
      </span>
      <div class="hdr-brand-text">
        <div class="hdr-title">
          <span class="hdr-logo" role="img" aria-label="Shiftr">Shift<span class="hdr-logo-r">r</span></span>
        </div>
        <div class="hdr-subrow">
          <span class="hdr-greeting">${greet}</span>
          ${lastSyncedHTML}
        </div>
      </div>
    </div>
    <div class="hdr-right">
      <div class="hdr-cluster">
        ${syncHTML}
        ${themeHTML}
        ${langHTML}
        ${CURRENT_USER?`<span class="hdr-cluster-sep" aria-hidden="true"></span>${accountHTML}`:''}
      </div>
      ${CURRENT_USER?'':accountHTML}
    </div>
  </div>
  ${buildStats()}
  <div class="tab-row" id="tab-row">
    <button class="tab${S.tab==='calendar'?' on':''}" data-tab="calendar">${t('tabCal')}</button>
    <button class="tab${S.tab==='overview'?' on':''}" data-tab="overview">${t('tabOverview')}</button>
    <button class="tab${S.tab==='settings'?' on':''}" data-tab="settings">${t('tabSet')}</button>
    <span class="tab-underline" id="tab-underline" aria-hidden="true"></span>
  </div>
  <div id="tab-content">${buildTabContent()}</div>`;
}

// Just the active tab's content — split out so tab switches can update this
// region alone instead of rebuilding the whole app (header, stats, etc.).
function buildTabContent(){
  return S.tab==='calendar'?buildCal():S.tab==='overview'?buildOverview():buildSettings();
}

// Switch tabs WITHOUT rebuilding the header/stats. Only the #tab-content region
// is replaced, so the header's glass, glow, sync dot animation, and portal
// listeners stay intact (no flicker, no re-mount). Content listeners are
// re-attached via attachListeners(), which is guarded to bind one-time header
// handlers only once (see _headerBound in attachListeners).
function switchTab(tab){
  // Clicking the already-active tab must be a no-op: re-mounting identical
  // content would needlessly replay the Overview entrance choreography.
  if(S.tab===tab) return;
  S.tab=tab;
  S.success='';
  // Update tab-button active states in place
  document.querySelectorAll('.tab[data-tab]').forEach(b=>{
    b.classList.toggle('on', b.dataset.tab===tab);
  });
  // Slide the shared underline to the newly active tab (animated). Flag it so the
  // attachListeners() placement below doesn't snap-override the in-flight slide.
  _tabSwitching=true;
  positionTabUnderline(true);
  // Swap only the content region
  const host=document.getElementById('tab-content');
  if(host){
    host.innerHTML=buildTabContent();
  }else{
    // Fallback: if the container is missing for any reason, do a full render
    render();
    _tabSwitching=false;
    return;
  }
  // Re-wire listeners (header handlers are guarded to attach only once)
  attachListeners();
  // Clear the flag after the placement rAF has had its chance to run.
  requestAnimationFrame(()=>{ requestAnimationFrame(()=>{ _tabSwitching=false; }); });
}
let _tabSwitching=false;

// Position the single sliding tab indicator under the active tab. The bar uses a
// real px width (--tu-w) and slides via translateX (--tu-x) — the translate is
// GPU-composited for a smooth slide, while width animates crisply (no 1px-texture
// stretching, so no blur). Width and transform share the same easing/duration.
function positionTabUnderline(animate){
  const row=document.getElementById('tab-row');
  const bar=document.getElementById('tab-underline');
  if(!row||!bar) return;
  const active=row.querySelector('.tab.on')||row.querySelector('.tab');
  if(!active) return;
  const rowRect=row.getBoundingClientRect();
  const r=active.getBoundingClientRect();
  const x=Math.round((r.left-rowRect.left)*100)/100;
  const w=Math.round(r.width*100)/100;
  // On first placement (or when explicitly non-animated), disable the transition
  // for one frame so the bar appears in position instead of sliding in from 0.
  if(!animate){
    const prevTransition=bar.style.transition;
    bar.style.transition='none';
    bar.style.setProperty('--tu-x', x+'px');
    bar.style.setProperty('--tu-w', w+'px');
    bar.style.setProperty('--tu-o', '1');
    // force style flush, then restore the transition
    void bar.offsetWidth;
    bar.style.transition=prevTransition;
  }else{
    bar.style.setProperty('--tu-x', x+'px');
    bar.style.setProperty('--tu-w', w+'px');
    bar.style.setProperty('--tu-o', '1');
  }
}

// Animates the net-pay hero: the ₩ amount counts up, the ring arc sweeps from
// empty to its target, and the % text counts in lockstep. Driven by a single
// rAF loop with an easeOutExpo curve for a smooth, premium settle. Reads targets
// off the data-* attributes stamped by buildStats(), so it works both on first
// mount and after an in-place .stats-hero refresh (e.g. deduction-mode switch).
// Honors prefers-reduced-motion by snapping straight to the final values.
//
// Guards against replaying the entrance animation when nothing actually
// changed: render() can fire twice in quick succession on startup (once
// synchronously, once again when firebase.js's onAuthStateChanged resolves
// and calls setCURRENT_USER → render()), which rebuilds the same hero markup
// with identical targets. Without this check the count-up/ring-sweep would
// visibly replay a second time right after the first.
let _statsHeroRAF=0;
let _statsHeroLastKey=null;
// Remembers the last values actually shown, so a data change (log today, tax
// tweak, month nav) tweens from the old figure to the new one instead of
// resetting to 0 and counting up again. Seeded null → first paint starts at 0.
let _statsHeroPrev=null;
// Timestamp the current run started at, and the key it's animating toward. When
// a re-render (e.g. auth resolving) rebuilds the cards mid-animation with the
// SAME target values, we resume on the fresh nodes from this elapsed point
// instead of snapping — otherwise the entrance appears to cut short. Null when
// nothing is animating.
let _statsHeroStartTS=0;
let _statsHeroRunKey=null;
function animateStatsHero(){
  const valEl=document.getElementById('stat-pay-value');
  const arcEl=document.getElementById('stat-pay-arc');
  const pctEl=document.getElementById('stat-pay-pct');
  if(!valEl&&!arcEl&&!pctEl)return;

  // Cancel any in-flight loop: it's bound by closure to the PREVIOUS (now
  // detached) DOM nodes after a rebuild, so it can't keep driving the visible
  // cards. We may immediately restart it below on the fresh nodes — possibly
  // resuming from the same elapsed time so the motion is continuous.
  const wasRunning=!!_statsHeroRAF;
  if(_statsHeroRAF){ cancelAnimationFrame(_statsHeroRAF); _statsHeroRAF=0; }

  const netTarget=valEl?parseFloat(valEl.dataset.target)||0:0;
  const pctTarget=arcEl?parseFloat(arcEl.dataset.target)||0
                 :pctEl?parseFloat(pctEl.dataset.target)||0:0;
  const circ=arcEl?parseFloat(arcEl.dataset.circ)||0:0;

  // Mini-card counters (Days / Hours values) and their progress bars. Both the
  // desktop cards and the mobile compact strip carry .stat-count nodes; only
  // one set is visible at a time (CSS), but painting all of them is harmless
  // and keeps whichever is shown in sync. Each stores its own numeric target
  // and decimal-place count (data-dp) so Days stays integer and Hours keeps .1.
  const countEls=[...document.querySelectorAll('.stats-hero .stat-count')].map(el=>({
    el, target:parseFloat(el.dataset.target)||0, dp:parseInt(el.dataset.dp)||0
  }));
  const barEls=[...document.querySelectorAll('.stats-hero .stat-bar')].map(el=>({
    el, target:parseFloat(el.dataset.target)||0
  }));

  // Starting values for this run. On the very first animation (or after a full
  // reset) there's no history, so everything starts at 0 and counts up. On a
  // later data change we start from the previously-shown numbers, so the motion
  // reads as the value smoothly moving to its new amount — up OR down.
  const from = _statsHeroPrev || {
    net:0, pct:0,
    counts:countEls.map(()=>0),
    bars:barEls.map(()=>0)
  };
  // Guard against a stale history whose array lengths don't match the current
  // DOM (e.g. layout swapped between desktop cards and the compact strip): fall
  // back to that metric's target as its own start (no motion) rather than
  // indexing undefined.
  const fromCount=i=> (from.counts&&from.counts.length===countEls.length) ? from.counts[i] : countEls[i].target;
  const fromBar  =i=> (from.bars  &&from.bars.length  ===barEls.length)   ? from.bars[i]   : barEls[i].target;

  const lerp=(a,b,e)=>a+(b-a)*e;

  const paint=(prog)=>{
    const net=lerp(from.net,netTarget,prog);
    const pct=lerp(from.pct,pctTarget,prog);
    if(valEl)valEl.textContent='₩'+Math.round(net).toLocaleString();
    if(arcEl){
      const dash=(Math.min(pct,100)/100)*circ;
      arcEl.setAttribute('stroke-dasharray',dash+' '+(circ-dash));
    }
    if(pctEl)pctEl.textContent=Math.round(pct)+'%';
    for(let i=0;i<countEls.length;i++){
      const c=countEls[i];
      const v=lerp(fromCount(i),c.target,prog);
      c.el.textContent=c.dp?v.toFixed(c.dp):Math.round(v).toString();
    }
    for(let i=0;i<barEls.length;i++){
      const b=barEls[i];
      const v=lerp(fromBar(i),b.target,prog);
      b.el.style.width=v.toFixed(1)+'%';
    }
  };

  // Snapshot the final state so the NEXT run can start from here.
  const commit=()=>{ _statsHeroPrev={
    net:netTarget, pct:pctTarget,
    counts:countEls.map(c=>c.target),
    bars:barEls.map(b=>b.target)
  }; };

  // Replay only when the underlying DATA changed. An auth-triggered re-render
  // (setCURRENT_USER → render() when signed in) rebuilds the header + cards, but
  // the stats numbers are identical — CURRENT_USER never feeds buildStats(). So
  // an identical key snaps the freshly-rebuilt nodes (which render at 0) to
  // final rather than animating a second time. Same rule collapses the startup
  // double-render and redundant rAF batches.
  const miniKey=countEls.map(c=>c.target).join(',')+'#'+barEls.map(b=>b.target).join(',');
  const key=netTarget+'|'+pctTarget+'|'+miniKey;

  const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Was a run for THESE SAME targets already in progress when we got called
  // again (i.e. a rebuild interrupted it)? If so, resume on the fresh nodes from
  // the same elapsed time so the entrance plays through continuously rather than
  // being cut short and snapped. This is the common first-load case: the initial
  // render starts the tween, then auth resolves ~100-400ms later and rebuilds
  // the cards with identical numbers.
  const resuming = wasRunning && _statsHeroRunKey===key && !reduce;

  // Snap-to-final (no animation) only when the data is unchanged AND nothing was
  // mid-flight — e.g. a redundant re-render after the entrance already finished,
  // or the auth rebuild landing after completion. Paint the fresh nodes (which
  // render at 0) straight to final.
  if(!resuming && _statsHeroLastKey===key){ paint(1); commit(); return; }
  _statsHeroLastKey=key;

  if(reduce){ paint(1); commit(); return; }

  // Critically-damped spring step response: x(t)=1−e^(−λt)(1+λt). No
  // oscillation (so no bounce — this must read as precise, not playful) and,
  // unlike the previous under-damped curve, the motion is spread evenly across
  // the whole duration instead of front-loading ~90% into the first third and
  // crawling invisibly afterward. That front-loading was what made the old
  // animation FEEL near-instant despite its 900ms length. λ=5.5 lands at
  // ~99.6% by t=1; the final commit paint snaps the sub-pixel remainder.
  const DUR=1000;
  const spring=x=>{ if(x>=1)return 1; const l=5.5; return 1-Math.exp(-l*x)*(1+l*x); };
  // This run animates toward `key`; remember it so a mid-flight rebuild for the
  // same targets resumes rather than snaps.
  _statsHeroRunKey=key;
  // When resuming an interrupted run, keep the original start timestamp so the
  // elapsed progress carries over seamlessly; otherwise start a fresh clock.
  const carriedStart = resuming ? _statsHeroStartTS : 0;
  let start=carriedStart;
  // Paint the correct current state SYNCHRONOUSLY before yielding to rAF, so the
  // freshly-rebuilt nodes (which render at 0) never show a 0-frame. Fresh start
  // → progress 0; resume → the elapsed progress, so the rebuilt cards appear
  // exactly where the interrupted animation had reached and continue from there.
  if(resuming && start){
    paint(spring(Math.min((performance.now()-start)/DUR,1)));
  }else{
    paint(0);
  }
  const step=ts=>{
    if(!start){ start=ts; _statsHeroStartTS=ts; }
    const p=Math.min((ts-start)/DUR,1);
    const e=spring(p);
    // One eased progress drives every metric from its own start to its own
    // target (see paint/lerp), so the whole block moves as one coordinated
    // settle and the ring reads as filled by the number.
    paint(e);
    if(p<1)_statsHeroRAF=requestAnimationFrame(step);
    else{
      _statsHeroRAF=0;
      _statsHeroRunKey=null;
      paint(1); // snap exact final
      commit();
      heroSettlePulse();
    }
  };
  _statsHeroRAF=requestAnimationFrame(step);
}

// Completion micro-interaction for the net-pay hero: a single, restrained
// scale tick (1.00 → 1.02 → 1.00) with a soft glow swell that fades fast —
// a "value locked in" confirmation, not a celebration. Runs only when the
// full count-up actually played (the reduced-motion and identical-key snap
// paths never reach here). The keyframes animate the standalone `scale`
// property, not `transform`, so it composes cleanly with the pointer-tilt
// transform instead of fighting it.
function heroSettlePulse(){
  const card=document.querySelector('.stat-pay-card');
  if(!card)return;
  card.classList.remove('hero-settle');
  void card.offsetWidth; // restart if a previous pulse is mid-flight
  card.classList.add('hero-settle');
  card.addEventListener('animationend',function h(e){
    if(e.animationName!=='heroSettle')return;
    card.classList.remove('hero-settle');
    card.removeEventListener('animationend',h);
  });
}

// ── Glass-card tilt (desktop only) ────────────────────────────────────────────
// A physical hover interaction for the header glass cards: slight lift + scale,
// cursor-relative tilt (≤ ~3.5°), and a specular highlight that tracks the
// pointer across the glass. All motion is integrated through a real spring
// (semi-implicit Euler, ζ≈0.84 — softly damped, near-zero visible overshoot)
// so it eases toward the cursor and settles back to neutral on leave, rather
// than snapping via CSS transitions.
//
// Gating:
//  • (hover:hover) and (pointer:fine) only — never on touch devices, where the
//    CSS :active tap feedback takes over instead (see style.css).
//  • prefers-reduced-motion disables it entirely.
// Performance:
//  • Only `transform` and two custom props (glare position) are written —
//    compositor-only work, no layout, no paint on the card contents.
//  • The rAF loop runs solely while the card is moving; `will-change` is added
//    on pointerenter and removed once the card has fully settled at rest.
//  • The card rect is cached on pointerenter (cards don't move mid-hover).
// Idempotency: cards are rebuilt on every full render(), so this is re-run from
// attachListeners(); the data-tilt-bound flag prevents double-binding on the
// header cards that survive tab switches.
function initCardTilt(){
  if(!(window.matchMedia&&window.matchMedia('(hover: hover) and (pointer: fine)').matches))return;
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;

  document.querySelectorAll('.stat-pay-card, .stat-mini-card, .ov-stat4-card, .ov-proj-card, .ov-panel').forEach(card=>{
    if(card.dataset.tiltBound)return;
    card.dataset.tiltBound='1';

    // Specular highlight layer — a soft radial gradient positioned via CSS
    // vars, faded in/out with the .card-tilting class.
    const glare=document.createElement('div');
    glare.className='card-glare';
    card.appendChild(glare);

    // Motion scales inversely with surface size: the wide Overview panels get
    // barely-perceptible dimensionality (a large plane visibly rotating reads
    // as gimmicky), the small stat cards a touch more, the header cards keep
    // their original tuning. All share the same spring, so the whole page
    // moves with one physical character.
    const isHero=card.classList.contains('stat-pay-card');
    const isWide=card.classList.contains('ov-proj-card')||card.classList.contains('ov-panel');
    const isOvStat=card.classList.contains('ov-stat4-card');
    const MAX_TILT=isHero?3.2:isWide?1.1:isOvStat?2.6:4;   // deg — bigger card, gentler angle
    const LIFT=isHero?-4:isWide?-2:-3;                     // px
    const SCALE=isWide?1.004:isOvStat?1.015:1.02;

    // Spring state per axis: rotX, rotY, translateY, scale
    const cur={rx:0,ry:0,ty:0,s:1};
    const vel={rx:0,ry:0,ty:0,s:0};
    const tgt={rx:0,ry:0,ty:0,s:1};
    const K=170,D=22;              // stiffness / damping → ζ = D/2√K ≈ 0.84
    let rect=null,raf=0,last=0,hovering=false;

    const settledAxis=k=>Math.abs(tgt[k]-cur[k])<0.0015&&Math.abs(vel[k])<0.0015;

    const step=ts=>{
      const dt=Math.min((ts-(last||ts))/1000,1/30);last=ts;
      let done=true;
      for(const k in cur){
        vel[k]+=(K*(tgt[k]-cur[k])-D*vel[k])*dt;
        cur[k]+=vel[k]*dt;
        if(!settledAxis(k))done=false;
      }
      card.style.transform=
        `perspective(900px) translateY(${cur.ty.toFixed(2)}px) `+
        `rotateX(${cur.rx.toFixed(3)}deg) rotateY(${cur.ry.toFixed(3)}deg) `+
        `scale(${cur.s.toFixed(4)})`;
      if(!done){raf=requestAnimationFrame(step);return;}
      raf=0;last=0;
      if(!hovering){
        // Fully at rest and un-hovered: return the card to a clean stylesheet
        // state so nothing composited lingers (battery / memory friendly).
        for(const k in cur){cur[k]=tgt[k];vel[k]=0;}
        card.style.transform='';
        card.style.willChange='';
      }
    };
    // Start the loop if it isn't already running. Crucially, this does NOT
    // reset `last` — the running loop owns the frame clock. Resetting it here
    // on every pointermove made each subsequent frame compute dt=0 (ts-ts),
    // which froze the integrator except on frames where the mouse was still.
    const kick=()=>{if(!raf)raf=requestAnimationFrame(step);};

    card.addEventListener('pointerenter',e=>{
      // Hybrid (touch+trackpad) devices pass the fine-pointer media query but
      // still emit touch pointer events — those must not trigger hover motion.
      if(e.pointerType==='touch')return;
      hovering=true;
      rect=card.getBoundingClientRect();
      card.style.willChange='transform';
      card.classList.add('card-tilting');
      // Seed the glow position from the entry point so it eases out from the
      // top-right rest spot to where the cursor actually is, rather than
      // jumping only once the first pointermove lands.
      if(rect){
        const nx=Math.max(-1,Math.min(1,((e.clientX-rect.left)/rect.width)*2-1));
        const ny=Math.max(-1,Math.min(1,((e.clientY-rect.top)/rect.height)*2-1));
        card.style.setProperty('--gx',(((nx+1)/2)*100).toFixed(1)+'%');
        card.style.setProperty('--gy',(((ny+1)/2)*100).toFixed(1)+'%');
      }
      tgt.ty=LIFT;tgt.s=SCALE;
      kick();
    });

    card.addEventListener('pointermove',e=>{
      if(!hovering||!rect)return;
      const nx=Math.max(-1,Math.min(1,((e.clientX-rect.left)/rect.width)*2-1));
      const ny=Math.max(-1,Math.min(1,((e.clientY-rect.top)/rect.height)*2-1));
      tgt.ry=nx*MAX_TILT;
      tgt.rx=-ny*MAX_TILT;
      // Glare tracks the raw cursor (not the spring) — light reacts instantly,
      // the glass mass follows behind it. Compositor-only var writes.
      card.style.setProperty('--gx',(((nx+1)/2)*100).toFixed(1)+'%');
      card.style.setProperty('--gy',(((ny+1)/2)*100).toFixed(1)+'%');
      kick();
    });

    card.addEventListener('pointerleave',()=>{
      hovering=false;
      card.classList.remove('card-tilting');
      tgt.rx=0;tgt.ry=0;tgt.ty=0;tgt.s=1;
      kick();
    });
  });
}


function buildStats(){
  const daysInM=new Date(S.calY,S.calM+1,0).getDate();
  const totalDays=daysInM;
  let days=0,hrs=0,gross=0;
  const logs=getLogs();
  for(let d=1;d<=daysInM;d++){
    const ds=mkds(S.calY,S.calM,d);
    const g=autoGross(ds,logs),e=autoEff(ds,logs);
    if(g>0||(logs[ds]&&(logs[ds].regHrs===0&&logs[ds].otHrs===0))){days++;gross+=g;hrs+=e;}
  }
  const net=applyTax(gross);
  const target=S.targetHrs||250;
  const hrsProgress=Math.min(100,Math.round((hrs/target)*100));
  const daysProgress=Math.min(100,Math.round((days/totalDays)*100));
  const mn=t('mn')[S.calM];

  // Delta vs previous month
  let prevNet=0;
  const prevM=S.calM===0?11:S.calM-1,prevY=S.calM===0?S.calY-1:S.calY;
  const daysInPrev=new Date(prevY,prevM+1,0).getDate();
  for(let d=1;d<=daysInPrev;d++){
    const ds=mkds(prevY,prevM,d);
    prevNet+=applyTax(autoGross(ds,logs));
  }
  const delta=net-prevNet;
  const prevMn=t('mn')[prevM];
  const deltaHTML=prevNet>0
    ?`<div class="stat-pay-delta${delta<0?' stat-pay-delta--neg':''}">
        ${delta>=0?'▲ +':'▼ '}₩${Math.abs(delta).toLocaleString()} ${t('deltaFrom', prevMn)}
      </div>`
    :'';

  // Circular ring for pay card — thicker stroke, gradient, integrated glow
  const RING_R=46,RING_C=58,RING_STROKE=9;
  const circumference=2*Math.PI*RING_R;

  return`<div class="stats-hero">
    <div class="stat-pay-card">
      <div class="stat-pay-left">
        <div class="stat-pay-label">${t('statEstPayLabel', getActiveDeductionPct(), getDeductionNoun())} ${mn.toUpperCase()}</div>
        <div class="stat-pay-value" id="stat-pay-value" data-target="${net}">₩0</div>
        ${deltaHTML}
      </div>
      <div class="stat-pay-ring">
        <svg viewBox="0 0 ${RING_C*2} ${RING_C*2}" width="124" height="124">
          <defs>
            <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#6c86ff"/>
              <stop offset="100%" stop-color="#a78bfa"/>
            </linearGradient>
          </defs>
          <circle cx="${RING_C}" cy="${RING_C}" r="${RING_R}" fill="none" stroke="var(--ring-track)" stroke-width="${RING_STROKE}"/>
          <circle id="stat-pay-arc" cx="${RING_C}" cy="${RING_C}" r="${RING_R}" fill="none" stroke="url(#ring-grad)" stroke-width="${RING_STROKE}"
            data-target="${hrsProgress}" data-circ="${circumference}"
            stroke-dasharray="0 ${circumference}" stroke-dashoffset="${circumference/4}"
            stroke-linecap="round"/>
          <text id="stat-pay-pct" x="${RING_C}" y="${RING_C+1}" text-anchor="middle" dominant-baseline="middle"
            data-target="${hrsProgress}"
            fill="var(--text)" font-size="19" font-weight="700" font-family="'Space Grotesk',Inter,system-ui,sans-serif">0%</text>
        </svg>
        <div class="stat-pay-ring-sub">${hrs.toFixed(1)} / ${target}${t('hoursUnit')}</div>
      </div>
    </div>
    <div class="stat-mini-col">
      <div class="stat-mini-card">
        <div>
          <div class="stat-mini-top"><div class="stat-mini-icon"><i class="fa-solid fa-calendar-days"></i></div></div>
          <div class="stat-mini-label">${t('statDays').toUpperCase()}</div>
          <div class="stat-mini-value stat-count" data-target="${days}" data-dp="0">0</div>
          <div class="stat-mini-sub">/ ${t('dayCount', totalDays)}</div>
        </div>
        <div class="stat-progress-bar"><div class="stat-progress-fill stat-progress-fill--blue stat-bar" data-target="${daysProgress}" style="width:0%"></div></div>
      </div>
      <div class="stat-mini-card">
        <div>
          <div class="stat-mini-top"><div class="stat-mini-icon stat-mini-icon--purple"><i class="fa-solid fa-clock"></i></div></div>
          <div class="stat-mini-label">${t('statHours').toUpperCase()}</div>
          <div class="stat-mini-value stat-count" data-target="${hrs.toFixed(1)}" data-dp="1">0.0</div>
          <div class="stat-mini-sub">/ ${target}${t('hoursUnit')}</div>
        </div>
        <div class="stat-progress-bar"><div class="stat-progress-fill stat-progress-fill--purple stat-bar" data-target="${hrsProgress}" style="width:0%"></div></div>
      </div>
    </div>
    <div class="stat-mini-compact">
      <div class="smc-item">
        <div class="stat-mini-icon"><i class="fa-solid fa-calendar-days"></i></div>
        <div class="smc-text">
          <div class="smc-value stat-count" data-target="${days}" data-dp="0">0</div>
          <div class="smc-sub">${t('statDays').toUpperCase()} / ${totalDays}</div>
        </div>
      </div>
      <div class="smc-divider"></div>
      <div class="smc-item">
        <div class="stat-mini-icon stat-mini-icon--purple"><i class="fa-solid fa-clock"></i></div>
        <div class="smc-text">
          <div class="smc-value stat-count" data-target="${hrs.toFixed(1)}" data-dp="1">0.0</div>
          <div class="smc-sub">${t('statHours').toUpperCase()} / ${target}${t('hoursUnit')}</div>
        </div>
      </div>
    </div>
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
  // ── One-tap "Log today" eligibility ──────────────────────────────────────────
  // Offer a quick-log CTA only when: today is in this displayed month, not yet
  // logged, and we have a confident default (defaultLogFor passed its gate).
  // Skip Sundays and public holidays — those are auto-credited (see autoGross/
  // autoEff), so a manual "log today" prompt doesn't apply.
  const _td=today();
  const _tdInMonth = pd(_td).getFullYear()===y && pd(_td).getMonth()===m;
  const _tdLogged = !!logs[_td];
  const _tdAutoDay = isSun(_td) || isHol(_td);
  const _quickDef = (_tdInMonth && !_tdLogged && !_tdAutoDay) ? defaultLogFor(_td) : null;
  let quickLogCTA='';
  if(_quickDef){
    const shIcon = _quickDef.shift==='night' ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
    const shLabel = _quickDef.shift==='night' ? t('nightShift') : t('dayShift');
    quickLogCTA = `<button class="quick-log-cta" id="quick-log-today" data-date="${_td}">
      <span class="quick-log-cta__ico">${shIcon}</span>
      <span class="quick-log-cta__text">
        <span class="quick-log-cta__title">${t('quickLogToday')}</span>
        <span class="quick-log-cta__sub">${shLabel} · ${_quickDef.regHrs}${t('hoursUnit')}</span>
      </span>
      <span class="quick-log-cta__plus">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </span>
    </button>`;
  }
  const wkBtns=weeks.map(ws=>{
    const sh=shiftFor(ws),d=pd(ws);
    return`<button class="wsb ${sh==='day'?'day-on':'night-on'}" data-ws="${ws}"><i class="fa-solid ${sh==='day'?'fa-sun':'fa-moon'}"></i> ${d.getMonth()+1}/${d.getDate()}</button>`;
  }).join('');
  let cells='';
  let hasDoubleThisMonth=false;
  for(let i=0;i<firstDay;i++)cells+=`<div class="dc empty"></div>`;
  for(let d=1;d<=daysInM;d++){
    const s=mkds(y,m,d),dw=new Date(y,m,d).getDay();
    const future=s>todayStr,logged=!!logs[s],hol=isHol(s),tod=s===todayStr;
    // A "credit-only" holiday: a holiday whose log entry is a pure 8h auto-credit
    // (no worked hours) — either created live by holAuto, or baked in when the
    // user turned holAuto OFF (so the credit is preserved). These must keep the
    // auto-credit blue-dot identity, NOT render as a worked day/night shift.
    const _le=logs[s];
    const creditOnlyHol = hol && !!_le && (_le.holCreditOverride===true)
      && !(_le.regHrs>0) && !(_le.otHrs>0);
    // "logged" for display purposes = an actual worked entry (excludes credit-only)
    const workedLog = logged && !creditOnlyHol;
    const sun=dw===0,autoSun=sun&&!hol&&!logged&&!future&&allWeekdaysLogged(s);
    // Auto-credited holiday: live (holAuto ON, no entry) OR a baked credit-only entry.
    // The live auto-credit is suppressed on Saturdays (dw===6): those fall under the
    // separate 50% Saturday pay rule and pay 0 when unworked, so no auto-cred marker.
    const autoHol=hol&&!future&&((!logged&&isHolAuto()&&dw!==6)||creditOnlyHol);
    const dayShift=logs[s]?.shiftOverride||shiftFor(s);
    const isNight=dayShift==='night';
    const isDouble=dayShift==='double';
    let cls='dc';
    if(future)cls+=' future';if(dw===0)cls+=' csun';if(dw===6)cls+=' csat';
    if(hol)cls+=' hol';
    if(workedLog)cls+=' logged';
    else if(autoSun||autoHol)cls+=' auto-cred';
    if(tod)cls+=' today';
    if(isNight&&(workedLog||autoSun||autoHol))cls+=' night-shift';
    if(isDouble&&(workedLog||autoSun||autoHol))cls+=' double-shift';
    // Shift icon
    let shiftIcon='';
    if(workedLog){
      if(dayShift==='double'){ shiftIcon=`<div class="dc-shift dc-shift--double"><i class="fa-solid fa-rotate"></i></div>`; hasDoubleThisMonth=true; }
      else if(dayShift==='night') shiftIcon=`<div class="dc-shift dc-shift--night"><i class="fa-solid fa-moon"></i></div>`;
      else shiftIcon=`<div class="dc-shift dc-shift--day"><i class="fa-solid fa-sun"></i></div>`;
    } else if(autoSun||autoHol){
      shiftIcon=`<div class="dc-shift dc-shift--auto"><i class="fa-solid fa-circle"></i></div>`;
    } else if(!future&&!hol&&dw!==0){
      shiftIcon=`<div class="dc-shift dc-shift--off">·</div>`;
    }
    // Holiday dot in top-right corner
    const holDot=hol?`<div class="dc-hol-dot"></div>`:'';
    const todayBadge=tod?`<div class="dc-today-badge">${t('todayBadge')}</div>`:'';
    // Effective hours pill — shown on logged/auto-credited days (not rest or sunday-only)
    let effPill='';
    if(!future&&dw!==0){
      const effHrs=autoEff(s,logs);
      if(effHrs>0){
        let pillCls='dc-eff-pill';
        if(autoSun||autoHol) pillCls+=' dc-eff-pill--auto';
        else if(dayShift==='night') pillCls+=' dc-eff-pill--night';
        else if(dayShift==='double') pillCls+=' dc-eff-pill--double';
        else pillCls+=' dc-eff-pill--day';
        effPill=`<div class="${pillCls}">${effHrs%1===0?effHrs:effHrs.toFixed(1)}h</div>`;
      }
    }
    cells+=`<div class="${cls}" data-date="${s}">${todayBadge}${holDot}<div class="dn">${d}</div>${shiftIcon}${effPill}</div>`;
  }
  const monthHols=Object.entries(HOLIDAYS).filter(([s])=>s.startsWith(`${y}-${pad(m+1)}`));
  const holChips=monthHols.map(([s],i)=>{
    const day=pd(s).getDate();
    const sep=i>0?`<span class="hol-sep" aria-hidden="true"></span>`:'';
    return`${sep}<span class="hchip"><span class="hchip-num">${day}</span>${holName(s)}</span>`;
  }).join('');

  // Show Today button only when not on the current month
  const nowD=new Date(), nowY=nowD.getFullYear(), nowM=nowD.getMonth();
  const isCurrentMonth=(y===nowY&&m===nowM);
  const todayBtn=isCurrentMonth?'':
    `<button class="cal-nav cal-nav--today" id="cal-today">${t('todayBadge')}</button>`;

  return`<div class="card">
    <div class="cal-hdr">
      <div class="cal-hdr-left">
        <button class="cal-nav" id="cal-prev">‹</button>
        ${todayBtn}
      </div>
      <div class="cal-month">${t('mn')[m]} ${y}</div>
      <button class="cal-nav" id="cal-next">›</button>
    </div>
    <div class="cal-legend">
      <span class="cal-leg-item cal-leg-item--day"><i class="fa-solid fa-sun"></i> ${t('dayShift')}</span>
      <span class="cal-leg-item cal-leg-item--night"><i class="fa-solid fa-moon"></i> ${t('nightShift')}</span>
      ${hasDoubleThisMonth?`<span class="cal-leg-item cal-leg-item--double"><i class="fa-solid fa-rotate"></i> ${t('doubleShift')}</span>`:''}
      <span class="cal-leg-item cal-leg-item--auto"><i class="fa-solid fa-circle"></i> ${t('dayOff')}</span>
    </div>
    <div class="shift-hint">${t('shiftHint')}</div>
    <div class="week-bar">${wkBtns}</div>
    ${quickLogCTA}
    <div class="cal-grid">
      ${dh.map((d,i)=>`<div class="dh${i===0?' sun':i===6?' sat':''}">${d}</div>`).join('')}
      ${cells}
    </div>
    ${holChips?`<div class="hol-list">${holChips}</div>`:''}
  </div>
  ${appFooter()}`;
}
function buildOverview(){
  const logs=getLogs(),todayStr=today();
  const allEntries=Object.entries(logs);
  if(!allEntries.length) return buildOverviewEmpty();

  // ── Per-month aggregation ──────────────────────────────────────────────────
  // Mirrors buildStats() exactly: iterate every calendar day up to today,
  // using autoGross() so auto-credited holidays and Sundays are included in
  // ALL months, not just the current one. This ensures Best Month always
  // matches the Calendar tab's monthly total.
  const monthData={};
  function ensureMonth(ym){ if(!monthData[ym]) monthData[ym]={net:0,gross:0,days:0,hrs:0,overtimeNet:0,topDay:null}; }

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

  const mnames=t('mn');
  function fmtYM(ym){ const[y,m]=ym.split('-'); return`${mnames[parseInt(m)-1]} ${y}`; }

  // Chart data — up to 7 months, oldest→newest; current month uses projection.
  // Chart data — all months oldest→newest; current month uses projection.
  // Stored on a module-level var so renderTrendChart() reads the same values
  // without re-computing separately. All months are stored; renderTrendChart()
  // slices based on S.chartRange ('3m' | '6m' | '1y').
  const chartMonths=months.slice();
  // Smart labels: include year suffix only when the visible slice spans multiple years.
  // renderTrendChart() re-runs this logic after slicing, so we store raw ym keys too.
  const chartValues=chartMonths.map(ym=>ym===curYM?projection:monthData[ym].net);
  _trendChartData={months:chartMonths,values:chartValues,curYM,mnames};

  // Best Single Day across ALL logged days (not just current month)
  let allTimeTopDay=null;
  months.forEach(ym=>{ const td=monthData[ym].topDay; if(td&&(!allTimeTopDay||td.net>allTimeTopDay.net)) allTimeTopDay=td; });

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
    const reg=l.regHrs!==undefined?l.regHrs:(l.hrs||0);
    const ot=l.otHrs||0;
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

  // ── This Month summary + bar chart ────────────────────────────────────────
  const target=S.targetHrs||250;
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

  // Mini ring SVG helper
  function miniRing(pct,color='#6c8eff'){
    const r=18,circ=2*Math.PI*r,dash=Math.round((Math.min(100,pct)/100)*circ);
    return`<svg viewBox="0 0 44 44" width="44" height="44" style="flex-shrink:0;transform:rotate(-90deg)">
      <circle cx="22" cy="22" r="18" fill="none" stroke="var(--ring-track)" stroke-width="4"/>
      <circle cx="22" cy="22" r="18" fill="none" stroke="${color}" stroke-width="4"
        stroke-dasharray="${dash} ${circ-dash}" stroke-linecap="round"/>
    </svg>`;
  }

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
  // Charts rendered after DOM injection — see renderTrendChart() called from attachListeners
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
function buildOverviewEmpty(){
  const oLang=getLang();
  // Onboarding-specific copy only — a lightweight hero, not a modal. Every
  // DASHBOARD label below is pulled from the SAME t() keys the live Overview
  // uses, so this reads as the real dashboard waiting for data, not a preview.
  const OV={
    en:{title:'Your dashboard is ready.',
      sub:'Log your first shift and this fills with live pay, overtime and trends.',
      cta:'Log your first shift'},
    ko:{title:'대시보드가 준비됐어요',
      sub:'첫 근무를 기록하면 실시간 급여·초과근무·추세로 채워져요.',
      cta:'첫 근무 기록하기'},
    id:{title:'Dasbor Anda sudah siap.',
      sub:'Catat shift pertama, dan ini terisi gaji, lembur, dan tren langsung.',
      cta:'Catat shift pertama'},
    th:{title:'แดชบอร์ดของคุณพร้อมแล้ว',
      sub:'บันทึกกะแรก แล้วหน้านี้จะเต็มไปด้วยค่าจ้าง ล่วงเวลา และแนวโน้มแบบสด',
      cta:'บันทึกกะแรก'},
    ru:{title:'Ваш дашборд готов.',
      sub:'Отметьте первую смену — и он заполнится зарплатой, переработками и трендами.',
      cta:'Отметить первую смену'},
    zh:{title:'你的仪表盘已就绪。',
      sub:'记录第一次班次，这里就会填满实时工资、加班与趋势。',
      cta:'记录第一次班次'},
    fr:{title:'Votre tableau de bord est prêt.',
      sub:'Enregistrez votre premier service et tout se remplit : paie, heures supp., tendances.',
      cta:'Enregistrer mon premier service'},
    ne:{title:'तपाईंको ड्यासबोर्ड तयार छ।',
      sub:'पहिलो शिफ्ट रेकर्ड गर्नुहोस्, यो प्रत्यक्ष तलब, ओभरटाइम र प्रवृत्तिले भरिन्छ।',
      cta:'पहिलो शिफ्ट रेकर्ड गर्नुहोस्'},
  };
  const ot=k=>(OV[oLang]||OV.en)[k]||OV.en[k];

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
      <h2 class="ovb-title">${ot('title')}</h2>
      <p class="ovb-sub">${ot('sub')}</p>
      <button class="ovb-cta" id="ov-onboard-cta">
        <span class="ovb-cta-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
        <span>${ot('cta')}</span>
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
    S.modal={date:ds,existing:getLogs()[ds]||null};
    buildModal();
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
    if(g>0||(logs[ds]&&logs[ds].regHrs===0&&logs[ds].otHrs===0)){
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

// ── Rules rows (Settings card + import preview) ──────────────────────────────
// Icons are keyed by the rule KIND buildRulesRows tags each row with — never
// by row position, which shifts as optional rules (Saturday, Sunday credit…)
// drop out of the profile. Module-scope so the workplace-import preview
// (Phase 6.3) renders a candidate profile with the exact same card rows.
const RULE_ICONS={
  // Day — gold sun (matches the app's day-shift ☀ convention)
  day:    {color:'#fbbf24',glow:'rgba(251,191,36,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`},
  // Night — purple moon (matches the app's night-shift convention)
  night:  {color:'#a78bfa',glow:'rgba(138,100,255,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`},
  // Double — teal rotate (matches the app's double-shift convention)
  double: {color:'#00d2be',glow:'rgba(0,210,190,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`},
  // Sunday rest credit — pink sparkle
  sunday: {color:'#f472b6',glow:'rgba(244,114,182,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/></svg>`},
  // Holiday credit — red alert circle
  holiday:{color:'#f87171',glow:'rgba(248,113,113,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`},
  // Tax/deduction — yellow percent
  tax:    {color:'#fbbf24',glow:'rgba(251,191,36,0.28)',svg:`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`},
};
function ruleRowsHTML(rows){
  return rows.map(([type,rule,kind])=>{
    const ic=RULE_ICONS[kind]||RULE_ICONS.tax;
    return`<div class="sr-row">
      <div class="sr-icon-wrap" style="--ic:${ic.color};--ig:${ic.glow};">${ic.svg}</div>
      <div class="sr-name">${type}</div>
      <div class="sr-desc">${rule}</div>
    </div>`;
  }).join('');
}

function buildSettings(){
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
  const todayStr=today();
  let activeIdx=0;
  wages.forEach((w,idx)=>{ if(w.date<=todayStr) activeIdx=idx; });
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
        <div class="s3-icon-badge s3-icon-badge--blue s3-icon-badge--lg" style="font-size:15px;font-weight:800;color:#5ba8ff;">%</div>
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

// ── Inline export card ────────────────────────────────────────────────────────
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
    const eLang=getLang();
    const EE={
      en:{
        head:'Your export starts here',
        desc:'Log a few shifts and Shiftr turns your hours, pay and holidays into a clean spreadsheet or a polished PDF — ready to download or share.',
        start:'Start logging work',
        locked:'Export',
        lockedHint:'Locked',
        learn:'What you can export',
        earnT:'Earnings',        earnS:'Gross, deductions & net pay, day by day',
        holT:'Public holidays',  holS:'Auto-credited holiday pay included',
        monthT:'Monthly summary', monthS:'Totals and hours rolled up per month',
        formats:'Arrives as CSV & PDF — 100% private, generated on your device',
      },
      ko:{
        head:'내보내기가 여기서 시작돼요',
        desc:'근무를 몇 번만 기록하면 근무 시간·급여·공휴일이 깔끔한 스프레드시트나 세련된 PDF로 정리돼 언제든 내보내거나 공유할 수 있어요.',
        start:'근무 기록 시작하기',
        locked:'내보내기',
        lockedHint:'잠김',
        learn:'무엇을 내보낼 수 있나요',
        earnT:'급여',          earnS:'일별 총급여·공제·실수령액',
        holT:'공휴일',          holS:'자동 반영된 공휴일 수당 포함',
        monthT:'월별 요약',      monthS:'월 단위 합계와 근무 시간',
        formats:'CSV와 PDF로 제공 — 기기에서 생성되는 100% 비공개 파일',
      },
      id:{
        head:'Ekspor Anda dimulai di sini',
        desc:'Catat beberapa shift dan Shiftr mengubah jam kerja, gaji, dan hari libur Anda menjadi spreadsheet yang rapi atau PDF yang elegan — siap diunduh atau dibagikan.',
        start:'Mulai catat kerja',
        locked:'Ekspor',
        lockedHint:'Terkunci',
        learn:'Yang bisa diekspor',
        earnT:'Penghasilan',       earnS:'Kotor, potongan & gaji bersih per hari',
        holT:'Hari libur nasional', holS:'Termasuk upah libur otomatis',
        monthT:'Ringkasan bulanan', monthS:'Total dan jam kerja per bulan',
        formats:'Tersedia dalam CSV & PDF — 100% privat, dibuat di perangkat Anda',
      },
      th:{
        head:'การส่งออกของคุณเริ่มต้นที่นี่',
        desc:'บันทึกกะการทำงานสักสองสามครั้ง แล้ว Shiftr จะเปลี่ยนชั่วโมงทำงาน ค่าจ้าง และวันหยุดของคุณให้เป็นสเปรดชีตที่เป็นระเบียบหรือรายงาน PDF ที่สวยงาม — พร้อมดาวน์โหลดหรือแชร์',
        start:'เริ่มบันทึกงาน',
        locked:'ส่งออก',
        lockedHint:'ล็อก',
        learn:'สิ่งที่ส่งออกได้',
        earnT:'รายได้',            earnS:'ค่าจ้างรวม รายการหัก และสุทธิ รายวัน',
        holT:'วันหยุดราชการ',       holS:'รวมค่าจ้างวันหยุดอัตโนมัติ',
        monthT:'สรุปรายเดือน',      monthS:'ยอดรวมและชั่วโมงต่อเดือน',
        formats:'มีให้ในรูปแบบ CSV และ PDF — เป็นส่วนตัว 100% สร้างบนอุปกรณ์ของคุณ',
      },
      ru:{
        head:'Ваш экспорт начинается здесь',
        desc:'Отметьте несколько смен, и Shiftr превратит ваши часы, зарплату и праздники в аккуратную таблицу или изящный PDF-отчёт — готовый к загрузке или отправке.',
        start:'Начать учёт работы',
        locked:'Экспорт',
        lockedHint:'Заблокировано',
        learn:'Что можно экспортировать',
        earnT:'Заработок',          earnS:'Начисления, вычеты и «на руки» по дням',
        holT:'Государственные праздники', holS:'С автоначислением за праздники',
        monthT:'Сводка по месяцам', monthS:'Итоги и часы по каждому месяцу',
        formats:'Доступно в CSV и PDF — на 100% приватно, создаётся на вашем устройстве',
      },
      zh:{
        head:'你的导出从这里开始',
        desc:'记录几次班次，Shiftr 就会把你的工时、工资和假日整理成清晰的表格或精美的 PDF 报告——随时可下载或分享。',
        start:'开始记录工作',
        locked:'导出',
        lockedHint:'已锁定',
        learn:'可导出的内容',
        earnT:'收入',              earnS:'每日的税前、扣除与实发工资',
        holT:'法定节假日',          holS:'含自动计入的节假日工资',
        monthT:'月度汇总',          monthS:'按月汇总的合计与工时',
        formats:'提供 CSV 和 PDF 格式——100% 私密，在你的设备上生成',
      },
      fr:{
        head:'Votre export commence ici',
        desc:'Enregistrez quelques services et Shiftr transforme vos heures, votre salaire et vos jours fériés en un tableur soigné ou un PDF élégant — prêt à télécharger ou à partager.',
        start:'Commencer le suivi',
        locked:'Exporter',
        lockedHint:'Verrouillé',
        learn:'Ce que vous pouvez exporter',
        earnT:'Revenus',            earnS:'Brut, déductions et net, jour par jour',
        holT:'Jours fériés',        holS:'Paie des jours fériés incluse automatiquement',
        monthT:'Récapitulatif mensuel', monthS:'Totaux et heures regroupés par mois',
        formats:'Disponible en CSV et PDF — 100 % privé, généré sur votre appareil',
      },
      ne:{
        head:'तपाईंको निर्यात यहाँबाट सुरु हुन्छ',
        desc:'केही शिफ्टहरू रेकर्ड गर्नुहोस्, अनि Shiftr ले तपाईंको काम गरेको घण्टा, तलब र बिदाहरूलाई सफा स्प्रेडसिट वा राम्रो PDF रिपोर्टमा बदल्छ — डाउनलोड वा सेयर गर्न तयार।',
        start:'काम रेकर्ड सुरु गर्नुहोस्',
        locked:'निर्यात',
        lockedHint:'बन्द',
        learn:'के निर्यात गर्न सकिन्छ',
        earnT:'कमाइ',              earnS:'दैनिक कुल, कटौती र खुद तलब',
        holT:'सार्वजनिक बिदा',      holS:'स्वतः गणना गरिएको बिदा तलब समावेश',
        monthT:'मासिक सारांश',      monthS:'महिना अनुसार जम्मा र घण्टा',
        formats:'CSV र PDF मा उपलब्ध — १००% निजी, तपाईंकै यन्त्रमा बनाइन्छ',
      },
    };
    const et=k=>(EE[eLang]||EE.en)[k]||EE.en[k];
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
        <div class="sexp-empty-title">${et('head')}</div>
        <p class="sexp-empty-desc">${et('desc')}</p>
      </div>

      <button class="sexp-empty-cta" id="sexp-empty-start">
        <span class="sexp-empty-cta-ico">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </span>
        <span>${et('start')}</span>
        <svg class="sexp-empty-cta-arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>

      <div class="sexp-empty-foot">
        <div class="sexp-empty-locked" title="${et('lockedHint')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span>${et('locked')}</span>
          <span class="sexp-empty-locked-tag">${et('lockedHint')}</span>
        </div>
        <button class="sexp-empty-learn" id="sexp-empty-learn" aria-expanded="false" aria-controls="sexp-empty-more">
          <span>${et('learn')}</span>
          <svg class="sexp-empty-learn-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>

      <div class="sexp-empty-more" id="sexp-empty-more">
        <div class="sexp-empty-more-inner">
          <div class="sexp-empty-list">
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',et('earnT'),et('earnS'))}
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',et('holT'),et('holS'))}
            ${eItem('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',et('monthT'),et('monthS'))}
          </div>
          <div class="sexp-empty-formats">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
            <span>${et('formats')}</span>
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
function getLang(){return S?.lang||localStorage.getItem('wt4_lang')||'en';}
function getReportLanguageOptions(){
  return[{code:'en',label:'English'},{code:'ko',label:'한국어'},{code:'id',label:'Indonesia'},{code:'th',label:'ภาษาไทย'},{code:'ru',label:'Русский'},{code:'zh',label:'中文'},{code:'fr',label:'Français'},{code:'ne',label:'नेपाली'}];
}

// ── Modal ─────────────────────────────────────────────────────────────────────
// Fully self-contained: no render() calls. All DOM updates happen in-place.
// State is kept in a local `ms` object attached to the overlay element.
function buildModal(){
  const{date,existing}=S.modal;
  const holDay=isHol(date),sun=isSun(date)&&!isHol(date),sat=isSat(date)&&!isHol(date);
  const weekShift=shiftFor(date);
  const wage=wageFor(date),dn=t('dn'),mn=t('mn'),dw=dowOf(date);
  const dObj=pd(date);

  // ── Local modal state (never stored in S) ──────────────────────────────────
  const ms={
    shift: existing?.shiftOverride || weekShift,
    holCredit: holDay
      ? (existing?.holCreditOverride ?? isHolAuto())
      : undefined,
    breakdownOpen:false,
  };

  // Default input values
  const defReg = existing?.regHrs !== undefined
    ? existing.regHrs
    : (sun ? 0 : holDay ? (ms.holCredit ? 0 : 8) : 8);
  const defOT = existing?.otHrs !== undefined ? existing.otHrs : 0;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getReg(){ const el=document.getElementById('m-reg'); return el ? parseFloat(el.value)||0 : 0; }
  function getOT(){  const el=document.getElementById('m-ot');  return el ? parseFloat(el.value)||0 : 0; }
  const fmtH=h=>(h%1===0?String(h):h.toFixed(2).replace(/0$/,''));

  // Patch the live preview in place (build-once DOM; textContent swaps only) so
  // the disclosure stays open across refreshes and the net value can animate.
  let _lastNet=null;
  function refreshPreview(){
    const r = ms.shift==='double' ? 0 : getReg();
    const o = getOT();
    const c = calcWage(date,r,o,wage,ms.shift,ms.holCredit);
    const tax=c.gross-c.net;
    const netEl=document.getElementById('wm2-net');
    if(netEl){
      const txt='₩'+c.net.toLocaleString();
      if(netEl.textContent!==txt){
        netEl.textContent=txt;
        if(_lastNet!==null){ // no tick on first paint
          netEl.classList.remove('wm2-tick');
          void netEl.offsetWidth; // restart animation
          netEl.classList.add('wm2-tick');
        }
      }
      _lastNet=c.net;
    }
    const grossEl=document.getElementById('wm2-gross');
    if(grossEl) grossEl.textContent=`${t('gross')} ₩${c.gross.toLocaleString()}`;
    const taxEl=document.getElementById('wm2-taxv');
    if(taxEl) taxEl.textContent=`${t('taxLine',getActiveDeductionPct(),getDeductionNoun())} −₩${tax.toLocaleString()}`;
    // Effective-hours transform: show "input → effective" when they differ
    const effEl=document.getElementById('wm2-effv');
    if(effEl){
      const inputTotal=r+o;
      const hu=t('hoursUnit');
      effEl.textContent=(ms.shift!=='double' && Math.abs(inputTotal-c.eff)>0.001)
        ? `${fmtH(inputTotal)}${hu} → ${fmtH(c.eff)}${hu}`
        : `${fmtH(c.eff)}${hu}`;
    }
    const notesEl=document.getElementById('wm2-notes');
    if(notesEl) notesEl.innerHTML=c.notes.map(n=>`<div class="wm2-note">${n}</div>`).join('');
  }

  // ── Header pieces ──────────────────────────────────────────────────────────
  let badges='';
  if(holDay) badges+=`<span class="mbadge b-hol">● ${holName(date)}</span>`;
  if(isSun(date)) badges+=`<span class="mbadge b-sun">${dn[0]}</span>`;
  if(sat) badges+=`<span class="mbadge b-sat">${dn[6]}</span>`;

  // ── Stepper field ──────────────────────────────────────────────────────────
  function stepperHTML(id,label,value,hint,extraAttrs=''){
    return`<div class="fg">
      <label for="${id}">${label}${hint?` <span style="font-size:10px;color:var(--text-hint);text-transform:none;letter-spacing:0;">${hint}</span>`:''}</label>
      <div class="wm2-stepper">
        <button type="button" class="wm2-step-btn" data-step="${id}" data-dir="-1" aria-label="−0.5">−</button>
        <input id="${id}" type="number" value="${value}" min="0" step="0.5"${extraAttrs} inputmode="decimal">
        <button type="button" class="wm2-step-btn" data-step="${id}" data-dir="1" aria-label="+0.5">+</button>
      </div>
    </div>`;
  }

  function buildRegOtRows(sh){
    return`<div class="fg-row wm2-hours-row${sh==='double'?' wm2-hours-row--solo':''}" id="m-hours-row" style="margin-bottom:0;">
      <div id="m-reg-row" class="wm2-reg-row${sh==='double'?' wm2-reg-row--collapsed':''}"${sh==='double'?' aria-hidden="true"':''}>
        ${stepperHTML('m-reg',t('regHrs'),defReg,'')}
      </div>
      <div id="m-ot-row">
        ${stepperHTML('m-ot',t('otHrs'),defOT,t('otHint'),' max="24"')}
      </div>
    </div>`;
  }

  // Holiday credit — the app's real switch, not an emoji button
  function buildHolCreditToggle(hc){
    if(isHolAuto()) return '';
    return`<div class="wm2-credit-row">
      <span class="wm2-credit-lbl">${t('holCreditToggle')}</span>
      <button id="m-hol-credit" class="s3-toggle${hc?' s3-toggle--on':''}" role="switch" aria-checked="${!!hc}" aria-label="${t('holCreditToggle')}">
        <span class="s3-toggle-knob"></span>
      </button>
    </div>`;
  }

  // ── Live pay preview (static skeleton; values patched by refreshPreview) ───
  const previewHTMLShell=`<div class="wm2-preview" id="m-preview">
    <div class="wm2-net-lbl">${t('net')}</div>
    <div class="wm2-net" id="wm2-net"></div>
    <div class="wm2-sub">
      <span id="wm2-gross"></span>
      <span class="wm2-sub-dot">·</span>
      <span class="wm2-tax" id="wm2-taxv"></span>
    </div>
    <div class="wm2-eff">
      <span>${t('eff')}</span>
      <span class="wm2-eff-val" id="wm2-effv"></span>
    </div>
    <div class="wm2-eff" style="border-top:none;margin-top:2px;padding-top:0;">
      <span>${t('rateLabel')}</span>
      <span class="wm2-eff-val" style="color:var(--text-muted);">₩${wage.toLocaleString()}</span>
    </div>
    <div class="wm2-disc" id="wm2-disc">
      <button type="button" class="wm2-disc-btn" id="wm2-disc-btn" aria-expanded="false">
        <span class="wm2-disc-chev">▶</span>${t('mBreakdown')}
      </button>
      <div class="wm2-notes" id="wm2-notes"></div>
    </div>
  </div>`;

  // ── Body per day type ──────────────────────────────────────────────────────
  let bodyHTML='';
  if(sun){
    const autoSunQual=allWeekdaysLogged(date);
    bodyHTML=`<div class="info-box">${autoSunQual?t('sunAuto'):t('sunNotYet')}</div>
    <div class="info-box accent" style="margin-top:0;">${t('sunWorkedInfo')}</div>
    ${buildRegOtRows(ms.shift)}
    ${previewHTMLShell}`;
  }else if(holDay){
    const holInfoKey=(ms.holCredit && dw!==6)?'holInfo':'holInfoNoAuto';
    bodyHTML=`<div class="info-box warn" id="m-hol-info">${t(holInfoKey)}</div>
    ${buildHolCreditToggle(ms.holCredit)}
    ${buildRegOtRows(ms.shift)}
    ${previewHTMLShell}`;
  }else{
    bodyHTML=`${buildRegOtRows(ms.shift)}
    ${previewHTMLShell}`;
  }

  // ── Note field (optional, free text, max 120 chars) ────────────────────────
  const existingNote = existing?.note || '';
  const noteHTML=`<div class="wm2-note-field" id="m-note-field">
    <div class="wm2-note-head">
      <svg class="wm2-note-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
      <span class="wm2-note-lbl">${t('noteLabel')} <span class="wm2-note-opt">${t('otHint')}</span></span>
      <span class="wm2-note-count" id="m-note-count">${existingNote.length} / 120</span>
    </div>
    <textarea id="m-note" class="wm2-note-input" maxlength="120" rows="2" placeholder="${t('notePlaceholder')}">${existingNote.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
  </div>`;

  const _segPos={day:0,night:1,double:2};
  const shiftToggleHTML=`<div class="wm2-seg" role="radiogroup" aria-label="${t('dayShift')}/${t('nightShift')}/${t('doubleShift')}">
    <div class="wm2-seg-pill wm2-seg-pill--${ms.shift}" id="m-seg-pill" style="--seg-pos:${_segPos[ms.shift]};" aria-hidden="true"></div>
    <button id="m-shift-day" class="shift-tog${ms.shift==='day'?' shift-tog-on-day':''}" role="radio" aria-checked="${ms.shift==='day'}"><i class="fa-solid fa-sun"></i> ${t('dayShift')}</button>
    <button id="m-shift-night" class="shift-tog${ms.shift==='night'?' shift-tog-on-night':''}" role="radio" aria-checked="${ms.shift==='night'}"><i class="fa-solid fa-moon"></i> ${t('nightShift')}</button>
    <button id="m-shift-double" class="shift-tog${ms.shift==='double'?' shift-tog-on-double':''}" role="radio" aria-checked="${ms.shift==='double'}"><i class="fa-solid fa-rotate"></i> ${t('doubleShift')}</button>
  </div>`;

  // ── Build and mount overlay ────────────────────────────────────────────────
  document.querySelectorAll('#modal-ov').forEach(el=>el.remove());
  const ov=document.createElement('div');
  ov.className='modal-overlay';ov.id='modal-ov';
  document.body.classList.add('modal-open');
  ov.innerHTML=`<div class="modal wm-modal">
    <div class="wm-glow" aria-hidden="true"></div>
    <div class="wm-scroll">
    <div class="wm-header">
      <div class="wm-header-badge">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2.5"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>
      </div>
      <div class="wm-header-text">
        <div class="wm2-eyebrow">${dn[dw]} · ${dObj.getFullYear()}</div>
        <h3 class="wm2-title">${mn[dObj.getMonth()]} ${dObj.getDate()}</h3>
      </div>
      <button class="asm-close-btn wm-close" id="m-cancel-x" aria-label="${t('cancel')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="wm-divider"></div>
    <div class="wm2-badges">${badges}</div>
    ${shiftToggleHTML}
    ${bodyHTML}
    ${noteHTML}
    <div class="m-actions">
      <button class="btn-sec" id="m-cancel">${t('cancel')}</button>
      ${existing?`<button class="btn-del" id="m-del">${t('del')}</button>`:''}
      <button class="btn-pri" id="m-save">${t('save')}</button>
    </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  refreshPreview(); // first paint of the live values

  // ── Wire events — all update modal DOM only, never call render() ───────────

  // Backdrop click
  ov.addEventListener('click',e=>{if(e.target.id==='modal-ov')closeModal();});
  document.getElementById('m-cancel').addEventListener('click',()=>closeModal());
  document.getElementById('m-cancel-x')?.addEventListener('click',()=>closeModal());

  // Keyboard: Enter saves, Escape closes (fires while focus is inside the panel)
  ov.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();closeModal();}
    else if(e.key==='Enter' && e.target.tagName!=='BUTTON'){
      e.preventDefault();document.getElementById('m-save')?.click();
    }
  });

  // Delete
  const delBtn=document.getElementById('m-del');
  if(delBtn) delBtn.addEventListener('click',()=>{
    const l=getLogs();
    const removed=l[date]; // capture for undo
    delete l[date];
    saveLogs(l);
    closeModal(true);
    if(removed!==undefined){
      showUndoToast(t('logDeletedToast'),()=>{
        const cur=getLogs();
        cur[date]=removed;
        saveLogs(cur);
        render();
      });
    }
  });

  // Hour inputs → refresh preview only
  const regIn=document.getElementById('m-reg');
  const otIn=document.getElementById('m-ot');
  if(regIn) regIn.addEventListener('input',refreshPreview);
  if(otIn)  otIn.addEventListener('input',refreshPreview);

  // Stepper buttons: ±0.5, clamped to 0–24, snapped to the 0.5 grid
  ov.querySelectorAll('.wm2-step-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const input=document.getElementById(btn.dataset.step);
      if(!input) return;
      const cur=parseFloat(input.value)||0;
      let next=Math.round((cur+0.5*Number(btn.dataset.dir))*2)/2;
      next=Math.min(24,Math.max(0,next));
      input.value=next;
      refreshPreview();
    });
  });

  // Shift toggle → update button styles, show/hide reg row, refresh preview
  function applyShiftToggle(newShift){
    ms.shift=newShift;
    // Slide the pill to the new slot and swap its color variant
    const pill=document.getElementById('m-seg-pill');
    if(pill){
      pill.style.setProperty('--seg-pos',_segPos[newShift]);
      pill.className='wm2-seg-pill wm2-seg-pill--'+newShift;
    }
    ['day','night','double'].forEach(s=>{
      const btn=document.getElementById('m-shift-'+s);
      if(btn){
        btn.className='shift-tog'+(newShift===s?' shift-tog-on-'+s:'');
        btn.setAttribute('aria-checked',String(newShift===s));
      }
    });
    // ── Show/hide the reg-hours field when switching to/from Double ──
    // Layout snaps instantly (no height animation).
    const regRow=document.getElementById('m-reg-row');
    const hoursRow=document.getElementById('m-hours-row');
    const toDouble=newShift==='double';

    if(regRow){
      regRow.classList.toggle('wm2-reg-row--collapsed',toDouble);
      regRow.setAttribute('aria-hidden',String(toDouble));
    }
    if(hoursRow) hoursRow.classList.toggle('wm2-hours-row--solo',toDouble);

    refreshPreview();
  }
  ['day','night','double'].forEach(s=>{
    const btn=document.getElementById('m-shift-'+s);
    if(btn) btn.addEventListener('click',()=>applyShiftToggle(s));
  });

  // Holiday credit switch → flip knob, patch info text + default hours, refresh
  const holCreditBtn=document.getElementById('m-hol-credit');
  if(holCreditBtn) holCreditBtn.addEventListener('click',()=>{
    ms.holCredit=!ms.holCredit;
    holCreditBtn.classList.toggle('s3-toggle--on',ms.holCredit);
    holCreditBtn.setAttribute('aria-checked',String(ms.holCredit));
    const infoBox=document.getElementById('m-hol-info');
    if(infoBox) infoBox.textContent=t(ms.holCredit?'holInfo':'holInfoNoAuto');
    // Update default reg hours if no value has been entered yet
    if(regIn && (parseFloat(regIn.value)||0)===0){
      regIn.value=ms.holCredit?0:8;
    }
    refreshPreview();
  });

  // Note field → live char counter
  const noteIn=document.getElementById('m-note');
  const noteCount=document.getElementById('m-note-count');
  if(noteIn && noteCount){
    noteIn.addEventListener('input',()=>{
      noteCount.textContent=`${noteIn.value.length} / 120`;
    });
  }

  // Calculation-details disclosure
  const discBtn=document.getElementById('wm2-disc-btn');
  if(discBtn) discBtn.addEventListener('click',()=>{
    ms.breakdownOpen=!ms.breakdownOpen;
    document.getElementById('wm2-disc')?.classList.toggle('wm2-disc--open',ms.breakdownOpen);
    discBtn.setAttribute('aria-expanded',String(ms.breakdownOpen));
  });

  // Save
  const saveBtn=document.getElementById('m-save');
  if(saveBtn) saveBtn.addEventListener('click',()=>{
    const sh=ms.shift;
    const r=sh==='double'?0:getReg();
    const o=getOT();
    const c=calcWage(date,r,o,wage,sh,ms.holCredit);
    const logs=getLogs();
    const override=sh!==weekShift?sh:undefined;
    const creditOverride=(holDay && ms.holCredit!==undefined && ms.holCredit!==isHolAuto())
      ? ms.holCredit : undefined;
    const noteVal=(document.getElementById('m-note')?.value||'').trim();

    // Plain auto-credited holiday with no work logged: don't persist a log entry.
    // Writing one would flip the calendar cell from the blue "auto-credited" tint
    // to a regular day/night shift tint. Keep it auto-credited instead — and clear
    // any pre-existing entry so it reverts cleanly to the auto-credit state.
    // Exception: if the user typed a note, keep a minimal entry so the note isn't lost.
    if(holDay && isHolAuto() && r===0 && o===0 && creditOverride===undefined && !noteVal){
      if(logs[date]!==undefined){ delete logs[date]; saveLogs(logs); }
      closeModal(true);
      return;
    }

    logs[date]={regHrs:r,otHrs:o,hrs:r+o,gross:c.gross,net:c.net,eff:c.eff,
      shiftOverride:override,...(creditOverride!==undefined&&{holCreditOverride:creditOverride}),
      ...(noteVal&&{note:noteVal})};
    saveLogs(logs);closeModal(true);
  });
}



// ── Animated modal close helper ───────────────────────────────────────────────
// Adds .closing to the overlay (triggers CSS exit animation), then removes it
// and runs the callback after the animation ends (~180ms).
function animateModalClose(selector, callback) {
  const overlays = document.querySelectorAll(selector);
  if (!overlays.length) { callback(); return; }
  overlays.forEach(el => el.classList.add('closing'));
  // Use the animation duration from CSS (180ms). A small buffer ensures it's done.
  setTimeout(() => {
    overlays.forEach(el => el.remove());
    callback();
  }, 190);
}

function closeModal(changed){
  const ret = S.modal?._returnToAllShifts;
  animateModalClose('#modal-ov', () => {
    document.body.classList.remove('modal-open');
    S.modal=null;
    // Only re-render the app when the modal actually changed data (save/delete).
    // Cancel / backdrop / Escape close without a render to avoid a jarring repaint.
    if (changed || ret) render();
    if (ret) {
      _allShiftsPage   = ret.page;
      _allShiftsSort   = ret.sort;
      _allShiftsFilter = ret.filter;
      _allShiftsPerPage = ret.perPage;
      buildAllShiftsModal();
    }
  });
}

// ── Wage modal (add / edit / delete) ─────────────────────────────────────────
function closeWageModal(changed){
  animateModalClose('#wage-modal-ov', () => {
    document.body.classList.remove('modal-open');
    S.wageModal=null;
    if(changed) render();
  });
}

// ── Workplace modal (Settings → Edit workplace) ──────────────────────────────
// A premium configuration panel: pinned glass header + footer with the shared
// workplace form scrolling between them, over the app's standard blurred
// backdrop. Settings underneath never re-renders or shifts while it's open.
// Fixed-day users (every shift anchor is 'day') get the day-pattern form:
// no night question, no night panel, day-relevant preview probes.
function storedPatternIsFixedDay(){
  // Mirrors shiftFor()'s fixed-mode rule for the current week: the two most
  // recent anchors share a value → fixed pattern. A single anchor is rotation
  // parity (its value alone says nothing about the pattern).
  const sh=ld('wt4_shifts',{});
  const keys=Object.keys(sh).filter(k=>k<=getMonday(today())).sort();
  if(keys.length<2) return false;
  return sh[keys[keys.length-1]]==='day'&&sh[keys[keys.length-2]]==='day';
}
function closeWorkplaceModal(){
  animateModalClose('#wp-modal-ov',()=>{document.body.classList.remove('modal-open');});
}
function buildWorkplaceModal(){
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
const escHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SHARE_LOCALE={en:'en-US',ko:'ko-KR',id:'id-ID',th:'th-TH',ru:'ru-RU',zh:'zh-CN',fr:'fr-FR',ne:'ne-NP'};
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

// ── Shared share-code entry (Settings import modal ⟷ onboarding join) ────────
// ONE implementation of the code mask, the lookup/error mapping, and the
// stage-state markup, so the two entry points cannot drift apart.
const SHM_IC_CHECK='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SHM_IC_SEARCH='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

// The XXXX-XXXX mask. Typing inserts the hyphen after the 4th character;
// pasting accepts JDAYJ9KW, JDAY-J9KW, or a whole share link (everything
// after 'join=' — the field itself only ever holds a code); Backspace/Delete
// hop over the auto-hyphen instead of fighting it. After every edit
// onChange(complete, changed) fires — `complete` gates the lookup button,
// `changed` lets the caller disarm a stale preview. Enter calls onEnter.
function wireShareCodeInput(inp,{onChange,onEnter}){
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
async function shareLookupByCode(code,W){
  let env;
  try{ env=await fetchShare(code); }
  catch(e){ console.warn('[share] fetch failed',e); return {ok:false,msg:W('imErrNet')}; }
  if(!env) return {ok:false,msg:W('imErrNotFound')};
  const r=unpackShare(env);                        // envelope is UNTRUSTED
  if(!r.ok) return {ok:false,msg:W(r.error==='version'?'imErrVersion':r.error==='format'?'imErrNotFound':'imErrInvalid')};
  return {ok:true,r};
}

// Stage-state markup shared by both entry points.
const shmEmptyHTML=(icon,title,desc)=>`<div class="shm-empty">
  <span class="shm-empty-ic" aria-hidden="true">${icon}</span>
  <div class="shm-empty-t">${title}</div>
  <div class="shm-empty-s">${desc}</div>
</div>`;
const shmFoundHeadHTML=(title,hintHTML)=>`<div class="shm-card-head">
  <span class="shm-card-badge is-fresh" aria-hidden="true">${SHM_IC_CHECK}</span>
  <div class="shm-card-headtxt">
    <div class="shm-card-title">${title}</div>
    <div class="shm-card-hint">${hintHTML}</div>
  </div>
</div>`;
// Shared modal scaffolding: overlay + glass header + body + footer, with the
// exact close/Escape/focus behavior of the workplace modal.
function buildShareLikeModal({ovId,badgeSVG,title,sub,bodyHTML,footHTML}){
  document.querySelectorAll('#'+ovId).forEach(el=>el.remove());
  const W=k=>wizT(S.lang,k);
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

// ── Share workplace ───────────────────────────────────────────────────────────
function buildShareModal(){
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
  if(!CURRENT_USER){
    const m=buildShareLikeModal({
      ovId:'sh-modal-ov',badgeSVG:badge,title:W('shTitle'),sub:W('shSub'),
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
    ovId:'sh-modal-ov',badgeSVG:badge,title:W('shTitle'),sub:W('shSub'),
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
function buildImportModal(prefill,opts){
  const W=k=>wizT(S.lang,k);
  const badge='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const m=buildShareLikeModal({
    ovId:'im-modal-ov',badgeSVG:badge,title:W('imTitle'),sub:W('imSub'),
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

function buildWageModal(){
  const{mode,idx}=S.wageModal;
  const wages=getWages();
  const entry=idx!==undefined?wages[idx]:null;
  const LANG_LOCALE={en:'en-US',ko:'ko-KR',id:'id-ID',th:'th-TH',ru:'ru-RU',zh:'zh-CN',fr:'fr-FR',ne:'ne-NP'};
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

  ov.innerHTML=`<div class="modal wm-modal">
    <div class="wm-glow" aria-hidden="true"></div>
    <div class="wm-scroll">
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
    </div>
  </div>`;

  document.querySelectorAll('#wage-modal-ov').forEach(el=>el.remove());
  document.body.appendChild(ov);
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

// ── Reset all data modal ─────────────────────────────────────────────────────
// Destructive action: clears all wt4_* localStorage keys (app data + settings),
// optionally deletes the user's Firestore document, then reloads so onboarding
// runs fresh. Requires typing a confirmation word to enable the final button.
function closeResetModal(changed){
  animateModalClose('#reset-modal-ov', () => {
    document.body.classList.remove('modal-open');
    S.resetModal=false;
    if(changed) render();
  });
}

function buildResetModal(){
  const cw=t('resetConfirmWord');
  const signedIn=!!CURRENT_USER;

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
    const uid=CURRENT_USER?.uid; // capture before sign-out clears CURRENT_USER

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

// ── All Shifts modal ─────────────────────────────────────────────────────────
// Premium glass panel: sorting, shift-type filtering, pagination.
let _allShiftsSort   = 'date-desc';
let _allShiftsFilter = 'all';   // 'all' | 'day' | 'night' | 'double'
let _allShiftsPage   = 1;
let _allShiftsPerPage = 10;

// ── All Shifts modal — self-contained, no full rebuilds ───────────────────────
// State lives in module-level vars (already existed). The overlay is created
// once; sort/filter/page changes only patch the body, pagination, and badges.

function _asmComputeData() {
  const logs     = getLogs();
  const todayStr = today();
  const mn       = t('mn');

  let allEntries = Object.entries(logs)
    .filter(([ds]) => ds <= todayStr)
    .map(([ds, l]) => {
      const sh     = l.shiftOverride || shiftFor(ds);
      const reg    = l.regHrs !== undefined ? l.regHrs : (l.hrs || 0);
      const ot     = l.otHrs || 0;
      const totalH = sh === 'double' ? 0 : reg + ot;
      const net    = applyTax(liveGross(ds, logs));
      return { ds, sh, totalH, net };
    });

  const filtered = _allShiftsFilter === 'all'
    ? allEntries
    : allEntries.filter(e => e.sh === _allShiftsFilter);

  const [sortKey, sortDir] = _allShiftsSort.split('-');
  filtered.sort((a, b) => {
    const va = sortKey === 'date' ? a.ds : sortKey === 'pay' ? a.net : a.totalH;
    const vb = sortKey === 'date' ? b.ds : sortKey === 'pay' ? b.net : b.totalH;
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ?  1 : -1;
    return 0;
  });

  const total     = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / _allShiftsPerPage));
  if (_allShiftsPage > pageCount) _allShiftsPage = pageCount;
  const start     = (_allShiftsPage - 1) * _allShiftsPerPage;
  const pageItems = filtered.slice(start, start + _allShiftsPerPage);

  return { pageItems, total, pageCount, mn, todayStr, allEntries };
}

function _asmRowsHTML({ pageItems, todayStr, mn }) {
  if (!pageItems.length) return `<div class="rs-empty">${t('ovNoData')}</div>`;
  return pageItems.map(({ ds, sh, totalH, net }) => {
    const shLabel =
      sh === 'double' ? `<i class="fa-solid fa-rotate"></i><span class="rs-shift-text"> ${t('doubleShift')}</span>` :
      sh === 'night'  ? `<i class="fa-solid fa-moon"></i><span class="rs-shift-text"> ${t('nightShift')}</span>` :
                        `<i class="fa-solid fa-sun"></i><span class="rs-shift-text"> ${t('dayShift')}</span>`;
    const shCls = sh === 'double' ? 'rs-shift--double' : sh === 'night' ? 'rs-shift--night' : 'rs-shift--day';
    const isToday = ds === todayStr;
    const dateLabel = `${mn[parseInt(ds.slice(5,7))-1]} ${parseInt(ds.slice(8,10))}, ${ds.slice(0,4)}`;
    return `<div class="asm-row" data-date="${ds}">
      <div class="asm-row-left">
        ${isToday ? `<span class="rs-today-badge">${t('todayBadge')}</span>` : ''}
        <span class="asm-row-date">${dateLabel}</span>
        <span class="rs-shift ${shCls}">${shLabel}</span>
      </div>
      <span class="asm-row-hrs">${totalH > 0 ? totalH + t('hoursUnit') : '0' + t('hoursUnit')}</span>
      <span class="asm-row-pay">₩${net.toLocaleString()}</span>
      <span class="asm-row-chevron"><i class="fa-solid fa-chevron-right"></i></span>
    </div>`;
  }).join('');
}

function _asmPaginationHTML(pageCount) {
  if (pageCount <= 1) return '';
  const wing = window.innerWidth <= 600 ? 1 : 2;
  const visible = new Set([1, pageCount]);
  for (let i = Math.max(1, _allShiftsPage - wing); i <= Math.min(pageCount, _allShiftsPage + wing); i++) visible.add(i);
  const pages = [...visible].sort((a, b) => a - b);

  function pageBtn(p, label, active, disabled) {
    const cls = 'asm-page-btn' + (active ? ' asm-page-btn--active' : '');
    return `<button class="${cls}" data-page="${p}"${disabled ? ' disabled' : ''}>${label}</button>`;
  }

  let pageNums = '', lastP = 0;
  for (const p of pages) {
    if (lastP && p - lastP > 1) pageNums += `<span style="color:var(--text-hint);padding:0 2px;font-size:12px;">…</span>`;
    pageNums += pageBtn(p, p, p === _allShiftsPage, false);
    lastP = p;
  }

  const perPageSizes = [10, 20, 50];
  return `<div class="asm-pagination">
    ${pageBtn('prev', '<i class="fa-solid fa-chevron-left"></i>', false, _allShiftsPage === 1)}
    ${pageNums}
    ${pageBtn('next', '<i class="fa-solid fa-chevron-right"></i>', false, _allShiftsPage === pageCount)}
    <div class="asm-pp-dropdown" id="asm-pp-wrap">
      <button class="asm-pp-trigger" id="asm-pp-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="asm-pp-value">${_allShiftsPerPage} ${t('perPage')}</span>
        <svg class="asm-sort-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <ul class="asm-pp-menu" id="asm-pp-menu" role="listbox">
        ${perPageSizes.map(n => `<li class="asm-sort-opt${n === _allShiftsPerPage ? ' asm-sort-opt--active' : ''}" data-pp="${n}" role="option">${n} ${t('perPage')}${n === _allShiftsPerPage ? '<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</li>`).join('')}
      </ul>
    </div>
  </div>`;
}

// Wire row clicks — called after every body patch
function _asmWireRows(ov) {
  ov.querySelectorAll('.asm-row[data-date]').forEach(row => {
    row.addEventListener('click', () => {
      const s = row.dataset.date;
      const savedPage = _allShiftsPage;
      const savedSort = _allShiftsSort;
      const savedFilter = _allShiftsFilter;
      const savedPerPage = _allShiftsPerPage;
      animateModalClose('#all-shifts-ov', () => {
        document.body.classList.remove('modal-open');
        S.modal = {
          date: s,
          existing: getLogs()[s] || null,
          _returnToAllShifts: { page: savedPage, sort: savedSort, filter: savedFilter, perPage: savedPerPage }
        };
        render();
      });
    });
  });
}

// Patch only the dynamic parts of the already-open modal
function _asmRefresh() {
  const ov = document.getElementById('all-shifts-ov');
  if (!ov) return;

  const data = _asmComputeData();

  // Rows
  const body = ov.querySelector('.asm-body');
  const tableHdr = body.querySelector('.asm-table-hdr').outerHTML;
  body.innerHTML = tableHdr + _asmRowsHTML(data);
  _asmWireRows(ov);
  body.scrollTop = 0;

  // Pagination — swap or remove
  const oldPag = ov.querySelector('.asm-pagination');
  const newPagHTML = _asmPaginationHTML(data.pageCount);
  if (newPagHTML) {
    const tmp = document.createElement('div');
    tmp.innerHTML = newPagHTML;
    const newPag = tmp.firstElementChild;
    if (oldPag) oldPag.replaceWith(newPag);
    else ov.querySelector('.modal').appendChild(newPag);
    // Wire per-page custom dropdown
    (function() {
      const ppTrigger = newPag.querySelector('#asm-pp-trigger');
      const ppMenu    = newPag.querySelector('#asm-pp-menu');
      if (!ppTrigger || !ppMenu) return;
      function togglePP(forceClose) {
        const isOpen = ppMenu.classList.contains('asm-sort-menu--open');
        if (forceClose || isOpen) { ppMenu.classList.remove('asm-sort-menu--open'); ppTrigger.setAttribute('aria-expanded','false'); }
        else { ppMenu.classList.add('asm-sort-menu--open'); ppTrigger.setAttribute('aria-expanded','true'); }
      }
      ppTrigger.addEventListener('click', e => { e.stopPropagation(); togglePP(); });
      ppMenu.querySelectorAll('[data-pp]').forEach(opt => {
        opt.addEventListener('click', e => {
          e.stopPropagation();
          _allShiftsPerPage = parseInt(opt.dataset.pp);
          _allShiftsPage = 1;
          togglePP(true);
          _asmRefresh();
        });
      });
    })();
    // Wire page buttons in new pagination
    const currentPageCount = data.pageCount;
    newPag.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const p = btn.dataset.page;
        if (p === 'prev') _allShiftsPage = Math.max(1, _allShiftsPage - 1);
        else if (p === 'next') _allShiftsPage = Math.min(currentPageCount, _allShiftsPage + 1);
        else _allShiftsPage = parseInt(p);
        _asmRefresh();
      });
    });
  } else if (oldPag) {
    oldPag.remove();
  }

  // Filter pill active state + mobile dropdown label
  ov.querySelectorAll('[data-filter]').forEach(el => {
    const isActive = el.dataset.filter === _allShiftsFilter;
    el.classList.toggle('asm-filter-pill--active', isActive);
    el.classList.toggle('asm-sort-opt--active', isActive);
    const existingCheck = el.querySelector('.asm-sort-check');
    if (isActive && !existingCheck) {
      el.insertAdjacentHTML('beforeend', '<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    } else if (!isActive && existingCheck) {
      existingCheck.remove();
    }
  });
  const filterValEl = ov.querySelector('#asm-filter-value');
  if (filterValEl) {
    const activeOpt = ov.querySelector(`[data-filter="${_allShiftsFilter}"]`);
    if (activeOpt) filterValEl.textContent = activeOpt.textContent.trim();
  }

  // Count badge
  const badge = ov.querySelector('.asm-count-badge');
  if (badge) badge.textContent = `${t('dayCount', data.total)}`;

  // Subtitle
  const sub = ov.querySelector('.asm-subtitle');
  if (sub) sub.textContent = t('allShiftsCount', data.total);

  // Sort dropdown — update value label and active option
  const sortValueEl = ov.querySelector('#asm-sort-value');
  if (sortValueEl) {
    const sortMenu = ov.querySelector('#asm-sort-menu');
    // Find label for current sort
    const activeOpt = sortMenu?.querySelector(`[data-sort="${_allShiftsSort}"]`);
    if (activeOpt) sortValueEl.textContent = activeOpt.textContent.trim();
    // Toggle active class + checkmark
    sortMenu?.querySelectorAll('[data-sort]').forEach(opt => {
      const isActive = opt.dataset.sort === _allShiftsSort;
      opt.classList.toggle('asm-sort-opt--active', isActive);
      const existingCheck = opt.querySelector('.asm-sort-check');
      if (isActive && !existingCheck) {
        opt.insertAdjacentHTML('beforeend', '<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      } else if (!isActive && existingCheck) {
        existingCheck.remove();
      }
    });
  }
}

function buildAllShiftsModal() {
  // If overlay already exists, just refresh the dynamic parts
  if (document.getElementById('all-shifts-ov')) {
    _asmRefresh();
    return;
  }

  const data = _asmComputeData();
  const { total, pageCount, mn } = data;

  const sortOptions = [
    { v:'date-desc', label: t('sortNewest') },
    { v:'date-asc',  label: t('sortOldest') },
    { v:'hrs-desc',  label: t('sortHrsHigh') },
    { v:'hrs-asc',   label: t('sortHrsLow') },
    { v:'pay-desc',  label: t('sortPayHigh') },
    { v:'pay-asc',   label: t('sortPayLow') },
  ];
  // Determine which shift types actually exist in data
  const _existingShifts = new Set(data.allEntries.map(e => e.sh));
  const allFilterOptions = [
    { v:'all',    label: t('filterAll') },
    { v:'day',    label: t('dayShift') },
    { v:'night',  label: t('nightShift') },
    { v:'double', label: t('doubleShift') },
  ];
  const filterOptions = allFilterOptions.filter(f => f.v === 'all' || _existingShifts.has(f.v));
  const isMob = window.innerWidth <= 600;
  const activeFilterLabel = filterOptions.find(f => f.v === _allShiftsFilter)?.label ?? filterOptions[0].label;

  const filterIconSvg = `<svg class="asm-filter-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" fill="none" stroke="currentColor"/></svg>`;

  const filterDropdownHTML = `<div class="asm-sort-dropdown asm-filter-dropdown" id="asm-filter-wrap">
        <button class="asm-sort-trigger" id="asm-filter-trigger" aria-haspopup="listbox" aria-expanded="false">
          ${filterIconSvg}
          <span class="asm-sort-value" id="asm-filter-value">${activeFilterLabel}</span>
          <svg class="asm-sort-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <ul class="asm-sort-menu" id="asm-filter-menu" role="listbox">
          ${filterOptions.map(f => `<li class="asm-sort-opt${_allShiftsFilter === f.v ? ' asm-sort-opt--active' : ''}" data-filter="${f.v}" role="option">${f.label}${_allShiftsFilter === f.v ? '<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</li>`).join('')}
        </ul>
      </div>`;

  const filterPillsHTML = filterOptions.map(f =>
    `<button class="asm-filter-pill${_allShiftsFilter === f.v ? ' asm-filter-pill--active' : ''}" data-filter="${f.v}">${f.label}</button>`
  ).join('');

  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'all-shifts-ov';
  document.body.classList.add('modal-open');

  ov.innerHTML = `<div class="modal asm-modal">
    <div class="asm-header">
      <div class="asm-header-left">
        <div class="modal-badge asm-badge">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </div>
        <div class="asm-header-titles">
          <div class="asm-title">${t('allShiftsTitle')}</div>
          <div class="asm-subtitle">${t('allShiftsCount', total)}</div>
        </div>
      </div>
      <button class="asm-close-btn" id="asm-close" aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="asm-toolbar">
      <div class="asm-sort-dropdown" id="asm-sort-wrap">
        <button class="asm-sort-trigger" id="asm-sort-trigger" aria-haspopup="listbox" aria-expanded="false">
          <span class="asm-select-label">${t('sortBy')}</span>
          <span class="asm-sort-value" id="asm-sort-value">${sortOptions.find(o => o.v === _allShiftsSort)?.label ?? sortOptions[0].label}</span>
          <svg class="asm-sort-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <ul class="asm-sort-menu" id="asm-sort-menu" role="listbox">
          ${sortOptions.map(o => `<li class="asm-sort-opt${_allShiftsSort === o.v ? ' asm-sort-opt--active' : ''}" data-sort="${o.v}" role="option">${o.label}${_allShiftsSort === o.v ? '<svg class="asm-sort-check" width="12" height="9" viewBox="0 0 12 9" fill="none"><path d="M1 4l3.5 3.5L11 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</li>`).join('')}
        </ul>
      </div>
      <div class="asm-toolbar-divider"></div>
      ${isMob ? filterDropdownHTML : filterPillsHTML}
      <span class="asm-count-badge">${t('dayCount', total)}</span>
    </div>
    <div class="asm-body">
      <div class="asm-table-hdr">
        <span class="asm-th">${t('date')} / ${t('shift')}</span>
        <span class="asm-th asm-th--right asm-th-hrs">${t('statHours')}</span>
        <span class="asm-th asm-th--right">${t('net')}</span>
        <span class="asm-th asm-th-chevron"></span>
      </div>
      ${_asmRowsHTML(data)}
    </div>
    ${_asmPaginationHTML(pageCount)}
  </div>`;

  document.body.appendChild(ov);

  // Backdrop
  ov.addEventListener('click', e => { if (e.target.id === 'all-shifts-ov') closeAllShiftsModal(); });

  // Close button
  ov.querySelector('#asm-close').addEventListener('click', closeAllShiftsModal);

  // Sort — custom dropdown
  (function() {
    const trigger = ov.querySelector('#asm-sort-trigger');
    const menu    = ov.querySelector('#asm-sort-menu');
    if (!trigger || !menu) return;

    function toggleMenu(forceClose) {
      const isOpen = menu.classList.contains('asm-sort-menu--open');
      if (forceClose || isOpen) {
        menu.classList.remove('asm-sort-menu--open');
        trigger.setAttribute('aria-expanded', 'false');
      } else {
        menu.classList.add('asm-sort-menu--open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    }

    trigger.addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });

    menu.querySelectorAll('[data-sort]').forEach(opt => {
      opt.addEventListener('click', e => {
        e.stopPropagation();
        _allShiftsSort = opt.dataset.sort;
        _allShiftsPage = 1;
        toggleMenu(true); // close
        _asmRefresh();
      });
    });

    // Close on outside click
    document.addEventListener('click', function closeSort(e) {
      if (!ov.contains(e.target) || !menu.classList.contains('asm-sort-menu--open')) {
        menu.classList.remove('asm-sort-menu--open');
        trigger.setAttribute('aria-expanded', 'false');
      }
      if (!document.body.contains(ov)) document.removeEventListener('click', closeSort);
    });
  })();

  // Filter pills (desktop) + filter dropdown (mobile)
  ov.querySelectorAll('[data-filter]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      _allShiftsFilter = el.dataset.filter;
      _allShiftsPage = 1;
      // Close mobile filter dropdown if open
      const fm = ov.querySelector('#asm-filter-menu');
      const ft = ov.querySelector('#asm-filter-trigger');
      if (fm) { fm.classList.remove('asm-sort-menu--open'); ft?.setAttribute('aria-expanded','false'); }
      _asmRefresh();
    });
  });

  // Mobile filter dropdown toggle
  (function() {
    const ft = ov.querySelector('#asm-filter-trigger');
    const fm = ov.querySelector('#asm-filter-menu');
    if (!ft || !fm) return;
    ft.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = fm.classList.contains('asm-sort-menu--open');
      if (isOpen) { fm.classList.remove('asm-sort-menu--open'); ft.setAttribute('aria-expanded','false'); }
      else { fm.classList.add('asm-sort-menu--open'); ft.setAttribute('aria-expanded','true'); }
    });
    document.addEventListener('click', function closeFilter(e) {
      if (!ov.contains(e.target)) { fm.classList.remove('asm-sort-menu--open'); ft.setAttribute('aria-expanded','false'); }
      if (!document.body.contains(ov)) document.removeEventListener('click', closeFilter);
    });
  })();

  // Per-page custom dropdown (in pagination, if rendered)
  (function() {
    const ppTrigger = ov.querySelector('#asm-pp-trigger');
    const ppMenu    = ov.querySelector('#asm-pp-menu');
    if (!ppTrigger || !ppMenu) return;
    function togglePP(forceClose) {
      const isOpen = ppMenu.classList.contains('asm-sort-menu--open');
      if (forceClose || isOpen) { ppMenu.classList.remove('asm-sort-menu--open'); ppTrigger.setAttribute('aria-expanded','false'); }
      else { ppMenu.classList.add('asm-sort-menu--open'); ppTrigger.setAttribute('aria-expanded','true'); }
    }
    ppTrigger.addEventListener('click', e => { e.stopPropagation(); togglePP(); });
    ppMenu.querySelectorAll('[data-pp]').forEach(opt => {
      opt.addEventListener('click', e => {
        e.stopPropagation();
        _allShiftsPerPage = parseInt(opt.dataset.pp);
        _allShiftsPage = 1;
        togglePP(true);
        _asmRefresh();
      });
    });
    document.addEventListener('click', function closePP(e) {
      if (!ov.contains(e.target)) { ppMenu.classList.remove('asm-sort-menu--open'); ppTrigger.setAttribute('aria-expanded','false'); }
      if (!document.body.contains(ov)) document.removeEventListener('click', closePP);
    });
  })();

  // Pagination buttons (initial render — subsequent renders wire in _asmRefresh)
  ov.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const p = btn.dataset.page;
      if (p === 'prev') _allShiftsPage = Math.max(1, _allShiftsPage - 1);
      else if (p === 'next') _allShiftsPage = Math.min(pageCount, _allShiftsPage + 1);
      else _allShiftsPage = parseInt(p);
      _asmRefresh();
    });
  });

  _asmWireRows(ov);
}


function closeAllShiftsModal(){
  animateModalClose('#all-shifts-ov', () => {
    document.body.classList.remove('modal-open');
  });
}

// ── Listeners ─────────────────────────────────────────────────────────────────
// _headerBound guards listeners on nodes that survive a tab switch (the header
// controls, portals, and document-level handlers). Those must bind exactly once
// per full render; otherwise switchTab()'s re-attach would stack duplicates.
let _headerBound=false;
function attachListeners(){
  // Render charts if overview tab is active (async, non-blocking).
  // initOverviewMotion() runs first: on a first-load entrance it paints every
  // animated number to its zero state synchronously (before the browser paints
  // the freshly injected DOM, so finals never flash) and arms an
  // IntersectionObserver that reveals each card as it scrolls into view.
  if(S.tab==='overview'){ initOverviewMotion(); renderTrendChart(); renderMonthBarChart(); wireOverviewEmpty(); }
  updateHolSeps();

  // Animate the net-pay hero (amount count-up + ring sweep + % count), but only
  // on a full render — NOT on tab switches. switchTab() calls attachListeners()
  // too, and the hero (in the always-present header) survives that swap, so
  // replaying here would re-animate it on every tab change. _tabSwitching is set
  // by switchTab() for exactly this window.
  if(!_tabSwitching) requestAnimationFrame(animateStatsHero);

  // Desktop glass-card tilt/glare — idempotent (data-tilt-bound guard), so safe
  // on both full renders and tab switches.
  initCardTilt();

  // Place the sliding tab indicator. On a fresh render, snap it under the active
  // tab without animating. Skip during an animated tab switch (switchTab already
  // kicked off the slide) so we don't snap-override it.
  requestAnimationFrame(()=>{ if(!_tabSwitching) positionTabUnderline(false); });
  // Reposition on viewport changes (labels can wrap/reflow) — attach once.
  if(!window._tabUnderlineResizeBound){
    window._tabUnderlineResizeBound=true;
    let rt=0;
    window.addEventListener('resize',()=>{
      clearTimeout(rt);
      rt=setTimeout(()=>positionTabUnderline(false),120);
    });
  }
  // Re-measure once web fonts finish loading — attach once. The first placement
  // above runs before Inter swaps in, so the cells reflow slightly afterward and
  // the bar would otherwise keep its pre-font (narrower) width. Snap it to the
  // settled full-cell width once fonts are ready.
  if(!window._tabUnderlineFontsBound && document.fonts && document.fonts.ready){
    window._tabUnderlineFontsBound=true;
    document.fonts.ready.then(()=>{ if(!_tabSwitching) positionTabUnderline(false); });
  }

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
    buildAllShiftsModal();
  });

  const cp=document.getElementById('cal-prev');
  if(cp)cp.addEventListener('click',()=>{S.calM--;if(S.calM<0){S.calM=11;S.calY--;}render();});
  const cn=document.getElementById('cal-next');
  if(cn)cn.addEventListener('click',()=>{S.calM++;if(S.calM>11){S.calM=0;S.calY++;}render();});
  const ct=document.getElementById('cal-today');
  if(ct)ct.addEventListener('click',()=>{const nd=new Date();S.calY=nd.getFullYear();S.calM=nd.getMonth();render();});
  const wsbBtns=[...document.querySelectorAll('.wsb[data-ws]')];
  // Highlight every week from the hovered/focused one onward, so the user can
  // SEE that flipping a week re-alternates all later weeks (not just this one).
  function setDownstreamCue(fromWs,on){
    wsbBtns.forEach(btn=>{
      if(btn.dataset.ws>=fromWs) btn.classList.toggle('wsb--affected',on);
    });
  }
  wsbBtns.forEach(b=>{
    const ws=b.dataset.ws;
    b.addEventListener('mouseenter',()=>setDownstreamCue(ws,true));
    b.addEventListener('mouseleave',()=>setDownstreamCue(ws,false));
    b.addEventListener('focus',()=>setDownstreamCue(ws,true));
    b.addEventListener('blur',()=>setDownstreamCue(ws,false));
    b.addEventListener('click',()=>{
      // Snapshot the entire shifts map so Undo can fully restore it — the flip
      // deletes all superseded anchors, so a simple inverse toggle isn't enough.
      const prev=JSON.parse(JSON.stringify(getShifts()));
      toggleShift(ws);
      const newShift=shiftFor(ws);
      render();
      const label=t(newShift==='day'?'dayShift':'nightShift');
      showUndoToast(t('weekFlipUndo').replace('{0}',label),()=>{
        saveShifts(prev);
        render();
      });
    });
  });
  document.querySelectorAll('.dc[data-date]').forEach(el=>el.addEventListener('click',()=>{
    const s=el.dataset.date;if(s>today())return;
    const logs=getLogs();
    S.modal={date:s,existing:logs[s]||null};buildModal();
  }));
  // ── One-tap "Log today" ──────────────────────────────────────────────────────
  const quickBtn=document.getElementById('quick-log-today');
  if(quickBtn) quickBtn.addEventListener('click',()=>{
    const s=quickBtn.dataset.date;
    const entry=buildQuickLogEntry(s);
    if(!entry) return; // gate no longer met (shouldn't happen) — fail safe
    const logs=getLogs();
    const prev=logs[s]; // capture for undo (normally undefined)
    logs[s]=entry;
    saveLogs(logs);
    if(navigator.vibrate) navigator.vibrate(12); // subtle haptic tick
    render();
    showUndoToast(t('quickLoggedToast'),()=>{
      const l=getLogs();
      if(prev!==undefined) l[s]=prev; else delete l[s];
      saveLogs(l);
      render();
    });
  });
  document.querySelectorAll('.log-edit[data-date]').forEach(el=>el.addEventListener('click',()=>{
    const s=el.dataset.date,logs=getLogs();
    S.modal={date:s,existing:logs[s]||null};buildModal();
  }));

  // ── Header + portal + document-level listeners: bind once per full render ─────
  if(!_headerBound){
    _headerBound=true;
    attachHeaderListeners();
  }

  // Content-scoped listeners that live inside the swappable region — these must
  // re-bind on every tab switch because their nodes are recreated.
  attachContentListeners();
}

// Header controls, auth, portals, and the outside-click closer. Nodes here
// persist across tab switches, so this runs only once per full render.
function attachHeaderListeners(){
  document.getElementById('theme-toggle').addEventListener('click',()=>{
    S.theme=S.theme==='dark'?'light':'dark';sv('wt4_theme',S.theme);scheduleSync();render();
  });
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{
    if(b.dataset.tab===S.tab)return;      // already active — do nothing
    switchTab(b.dataset.tab);
  }));

  // ── Auth ────────────────────────────────────────────────────────────────────
  const loginBtn=document.getElementById('auth-login');
  if(loginBtn)loginBtn.addEventListener('click',()=>signInWithGoogle());
  const logoutBtn=document.getElementById('auth-logout');
  if(logoutBtn)logoutBtn.addEventListener('click',()=>signOutUser());

  // ── Portal dropdown system ────────────────────────────────────────────────────
  // Dropdowns are appended directly to <body> so they are never clipped by
  // backdrop-filter or overflow:hidden on ancestor elements (like .hdr, .card).
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
      ['en','ko','id','th','ru','zh','fr','ne'].map(l=>{
        const names={en:'English',ko:'한국어',id:'Indonesia',th:'ภาษาไทย',ru:'Русский',zh:'中文',fr:'Français',ne:'नेपाली'};
        return `<button class="hdr-dropdown-item${S.lang===l?' hdr-dropdown-item--active':''}" data-lang="${l}">${flagImg(l,'flag-ico')}${names[l]}</button>`;
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

  // Close portals on outside click (document-level — bind once)
  document.addEventListener('click',closeAllPortals);
}

// Listeners for nodes inside #tab-content (recreated on every tab switch).
function attachContentListeners(){
  // Toggle fade mask on timeline scroll wrapper
  const swScroll=document.querySelector('.sw-timeline-scroll');
  if(swScroll){
    const checkFull=()=>swScroll.classList.toggle('sw-timeline-scroll--full',swScroll.scrollHeight<=swScroll.clientHeight+2);
    checkFull();
    swScroll.addEventListener('scroll',checkFull,{passive:true});
  }

  // Show wage add modal
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
      buildWorkplaceModal();
    });
    // Phase 6.3: share/import this workplace by code.
    const shareBtn=card.querySelector('#pr-share-btn');
    if(shareBtn) shareBtn.addEventListener('click',e=>{
      e.stopPropagation();
      buildShareModal();
    });
    const importBtn=card.querySelector('#pr-import-btn');
    if(importBtn) importBtn.addEventListener('click',e=>{
      e.stopPropagation();
      buildImportModal();
    });
    header.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}
    });
  })();

  // Tax rate save
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
    // Persist
    S.taxRate=v;sv('wt4_tax_rate',v);scheduleSync();
  }

  // Save button — reads input and applies
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

  // Save insurance rates
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
  // Target hours save
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
  document.getElementById('hol-view-all-btn')?.addEventListener('click', () => { buildAllHolidaysModal(); });
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

  // Danger Zone — open reset confirmation modal
  const openResetBtn=document.getElementById('open-reset-modal');
  if(openResetBtn)openResetBtn.addEventListener('click',()=>{
    S.resetModal=true;render();
  });

  // Export card — wire premium UI with live summary, filtered export, persistence
  if(S.tab==='settings'){
    wireExportCard();

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

applyTheme();
// Seed cache into HOLIDAYS synchronously (already done above), then render.
// prefetchHolidays runs in the background and re-renders if new data arrives.

// ── Onboarding ────────────────────────────────────────────────────────────────
// Fullscreen first-run experience. Shown only to genuinely new users; existing
// users (any saved data) are auto-flagged as onboarded so they never see it.
//
// Flow (6 screens; the Night Schedule one is conditional):
//   1 Welcome   — brand hero, language, and a "restore from Google" fast path
//   2 Pattern   — rotation / fixed day / fixed night (+ inline "which week?")
//   3 Workplace — preset picker + pay-rule steppers under Customize (the WHAT)
//   4 Night     — shift times, premium window, breaks, live preview (the WHEN);
//                 skipped for day-only users and non-schedule-driven rules
//   5 Pay       — wage + tax + holiday auto-credit, with a live net-pay preview
//   6 Finish    — celebration, optional cloud backup, enter the app
//
// A returning user who restores on screen 1 jumps straight to screen 6 —
// zero setup questions. Their cloud pull already rehydrated localStorage.
(function initOnboarding(){
  // Phase 6.4: #join=CODE deep link (share links, Phase 6.3's shareLink()).
  // Captured before any routing decision and stripped from the URL so a
  // refresh doesn't re-trigger it; the code itself persists via OB state
  // (pendingJoin) for the not-yet-onboarded path.
  let PENDING_JOIN_CODE=null;
  try{
    const jm=/[#&]join=([^&\s]+)/.exec(location.hash||'');
    if(jm){
      PENDING_JOIN_CODE=normalizeShareCode(decodeURIComponent(jm[1]));
      history.replaceState(null,'',location.pathname+location.search);
    }
  }catch(e){}

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
  if(localStorage.getItem('wt4_onboarding') === 'done'){
    // Grandfathered/returning user — clear the first-run guard the inline script
    // may have set (its cheap heuristic can't run the full hasData check) so the
    // app shell and splash resolve correctly.
    document.documentElement.removeAttribute('data-onboarding');
    document.getElementById('ob-splash')?.remove();
    // A share link opened by an already-onboarded user → the Settings import
    // modal, prefilled and auto-looked-up (imports replace, so it previews +
    // warns exactly like a manual import).
    if(PENDING_JOIN_CODE){
      const code=PENDING_JOIN_CODE;
      setTimeout(()=>{ try{ buildImportModal(formatShareCode(code),{auto:true}); }catch(e){ console.warn('[share] join-link modal failed',e); } },400);
    }
    return;
  }

  // ── Session state ────────────────────────────────────────────────────────────
  // Restored from localStorage on refresh so the user resumes at their screen.
  // Nothing is persisted to the app's real keys until complete*() runs.
  function loadOBState(){
    try{
      const raw=localStorage.getItem('wt4_ob_state');
      if(!raw) return null;
      const s=JSON.parse(raw);
      // Migrate a session saved by the previous 8-step flow (it had no version
      // field): 1→welcome, 2–3→pattern, 4–6→pay, 7–8→finish. Only UNVERSIONED
      // sessions qualify — matching `v !== 2` also caught current v3 sessions
      // and silently regressed a mid-flow refresh by one step.
      if(s && s.v === undefined){
        const map=[,1,2,2,3,3,3,4,4];
        s.step = map[s.step] || 1;
        s.v = 2;
      }
      // v2 → v3: the pay-rules step was inserted at position 3.
      if(s && s.v === 2){
        if(s.step >= 3) s.step += 1;
        s.v = 3;
      }
      // v3 → v4: the workplace step was split in two — the Night Schedule
      // screen now lives at position 4, pushing pay/finish to 5/6.
      if(s && s.v === 3){
        if(s.step >= 4) s.step += 1;
        s.v = 4;
      }
      // v4 → v5: Phase 6.4 adds importedShare/pendingJoin (workplace-by-code).
      // No step positions changed — pure field addition.
      if(s && s.v === 4){ s.v = 5; }
      return s;
    }catch(e){}
    return null;
  }
  function saveOBState(){
    try{
      localStorage.setItem('wt4_ob_state', JSON.stringify({
        v:5,
        step: OB.step,
        rules: OB.rules,
        lang: OB.lang,
        pattern: OB.pattern,
        currentShift: OB.currentShift,
        wage: OB.wage,
        taxRate: OB.taxRate,
        dedMode: OB.dedMode,
        holAuto: OB.holAuto,
        restored: OB.restored,
        importedShare: OB.importedShare,   // {code,name,profile} or null
        pendingJoin: OB.pendingJoin,       // deep-linked code awaiting lookup
      }));
    }catch(e){}
  }

  const OB_LANGS=[
    {code:'en',label:'English'},
    {code:'ko',label:'한국어'},
    {code:'id',label:'Indonesia'},
    {code:'th',label:'ภาษาไทย'},
    {code:'ru',label:'Русский'},
    {code:'zh',label:'中文'},
    {code:'fr',label:'Français'},
    {code:'ne',label:'नेपाली'},
  ];
  // Best-guess language from the browser so screen 1 usually needs zero taps.
  function detectLang(){
    const cands=navigator.languages||[navigator.language||'en'];
    for(const c of cands){
      const p=String(c).toLowerCase().slice(0,2);
      if(OB_LANGS.some(l=>l.code===p)) return p;
    }
    return 'en';
  }

  const saved = loadOBState();
  const OB = {
    step:         saved?.step         ?? 1,
    lang:         saved?.lang         ?? (ld('wt4_lang',null) ?? detectLang()),
    pattern:      saved?.pattern      ?? null,
    rules:        saved?.rules        ?? WIZ_DEFAULT_RULES(),
    currentShift: saved?.currentShift ?? null,
    wage:         saved?.wage         ?? DEFAULT_WAGE,
    taxRate:      saved?.taxRate      !== undefined ? saved.taxRate : DEFAULT_TAX,
    // Deduction mode: 'tax' (flat %) or 'insurance' (Korea's 4대 보험). Defaults
    // to 'tax' to match the app; individual insurance rates stay editable in Settings.
    dedMode:      saved?.dedMode      ?? ld('wt4_deduction_mode','tax'),
    holAuto:      saved?.holAuto      !== undefined ? saved.holAuto : true, // default: auto-credit ON
    restored:     saved?.restored === true, // cloud fast path — skip setup screens
    importedShare:saved?.importedShare ?? null, // Phase 6.4: confirmed workplace code {code,name,profile}
    pendingJoin:  saved?.pendingJoin   ?? null, // Phase 6.4: deep-linked code awaiting lookup
    signingIn:    false, // transient — never persisted
  };
  // A #join= deep link captured at boot pre-opens the code panel on the
  // workplace step (unless a code was already confirmed this session).
  if(typeof PENDING_JOIN_CODE==='string' && PENDING_JOIN_CODE && !OB.importedShare){
    OB.pendingJoin=PENDING_JOIN_CODE;
  }
  // Combined employee insurance % (statutory defaults) — for the live preview
  // and the "4 Insurances" total chip. Uses the app's own insuranceRate().
  const OB_INS_PCT = Math.round(insuranceRate(DEFAULT_INSURANCE)*100*100)/100;

  // ── Step sequence ─────────────────────────────────────────────────────────────
  // Steps: 1 welcome · 2 pattern · 3 workplace & pay rules · 4 night schedule ·
  // 5 pay · 6 finish. The Night Schedule step exists only when the chosen rules
  // are schedule-driven (overlap-mode night premium) AND the user isn't
  // day-only — otherwise the flow runs 2 → 3 → 5 and shows one fewer segment.
  // Phase 6.4: an imported workplace code decides the schedule question from
  // the IMPORTED profile (the share stripped the sharer's schedule, so overlap
  // workplaces still need this user's own times); wizard flows keep deciding
  // from the chip state as before.
  function obNeedsSched(){
    if(OB.importedShare)
      return OB.pattern!=='day' && needsNightSchedule(OB.importedShare.profile);
    return obxNeedsSchedPage(OB.rules,OB.pattern);
  }
  function obSeq(){
    return obNeedsSched() ? [1,2,3,4,5,6] : [1,2,3,5,6];
  }
  function obTotal(){ return obSeq().length-1; }         // displayed setup steps
  function obStepIdx(step){                              // 1-based display index
    const i=obSeq().indexOf(step);
    return i<0?obSeq().indexOf(step+1):i;                // step 4 removed → show as 3's successor
  }
  function obNextStep(){
    const s=obSeq(), i=s.indexOf(OB.step);
    return i<0 ? 5 : (s[i+1] ?? 6);                      // orphaned step 4 → pay
  }
  function obPrevStep(){
    const s=obSeq(), i=s.indexOf(OB.step);
    return i<0 ? 3 : s[Math.max(0,i-1)];
  }
  // A saved session can sit on step 4 while the rules no longer need it (the
  // user changed presets and refreshed mid-flow) — resume on the pay step.
  if(OB.step===4 && !obNeedsSched()) OB.step=5;

  // Restored sessions: the cloud pull already wrote the user's real language —
  // prefer it over whatever the session captured (covers a refresh mid-finale).
  if(OB.restored) OB.lang = ld('wt4_lang', OB.lang);
  // Sync app language to whatever OB has (so ot() works correctly on resume)
  S.lang = OB.lang;

  function ot(k){ const fn=TR[OB.lang]?TR[OB.lang][k]:undefined; return typeof fn==='function'?fn():(fn||k); }
  const OB_REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ── Icons — the app's stroke-SVG vocabulary, not emoji ───────────────────────
  const oi=(paths,size=18,sw=2)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const OI={
    back:   oi('<path d="M15 18l-6-6 6-6"/>',18,2.2),
    arrow:  oi('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',17,2.2),
    cycle:  oi('<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>',19),
    sun:    oi('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',19),
    moon:   oi('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',18),
    check:  oi('<path d="M20 6L9 17l-5-5"/>',13,3),
    cal:    oi('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M9 15.5l2 2 4-4"/>',18),
    cloud:  oi('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',18), // same glyph as the app's sync badge
    google: `<svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
    spin:   '<span class="obx-spin" aria-hidden="true"></span>',
  };
  // The Shiftr wordmark — identical path to the header logo, unique gradient id
  // so it doesn't collide with the header's <defs> rendered behind the overlay.
  // Monogram tile (logo direction "2e") — a single-letter "S" in the wordmark's
  // own type, set in a rounded dark-glass tile. Built as an SVG path (the "S"
  // glyph lifted straight from the wordmark, re-centred into a 72×72 tile) so it
  // needs no extra webfont and renders identically offline. Reused by the
  // first-run splash so both brand moments match.
  const OB_MARK_S=`M8.034 21.684Q5.928 21.684 4.316 20.93Q2.704 20.176 1.794 18.772Q0.884 17.368 0.884 15.392V14.664H4.264V15.392Q4.264 17.03 5.278 17.849Q6.292 18.668 8.034 18.668Q9.802 18.668 10.673 17.966Q11.544 17.264 11.544 16.172Q11.544 15.418 11.115 14.95Q10.686 14.482 9.867 14.183Q9.048 13.884 7.878 13.624L7.28 13.494Q5.408 13.078 4.069 12.441Q2.73 11.804 2.015 10.764Q1.3 9.724 1.3 8.06Q1.3 6.396 2.093 5.213Q2.886 4.03 4.329 3.393Q5.772 2.756 7.722 2.756Q9.672 2.756 11.193 3.419Q12.714 4.082 13.585 5.395Q14.456 6.708 14.456 8.684V9.464H11.076V8.684Q11.076 7.644 10.673 7.007Q10.27 6.37 9.516 6.071Q8.762 5.772 7.722 5.772Q6.162 5.772 5.421 6.357Q4.68 6.942 4.68 7.956Q4.68 8.632 5.031 9.1Q5.382 9.568 6.084 9.88Q6.786 10.192 7.878 10.426L8.476 10.556Q10.426 10.972 11.869 11.622Q13.312 12.272 14.118 13.338Q14.924 14.404 14.924 16.068Q14.924 17.732 14.079 18.993Q13.234 20.254 11.687 20.969Q10.14 21.684 8.034 21.684Z`;
  // 72×72 tile. Glyph bbox ≈ x0.884–14.924 (w14.04) / y2.756–21.684 (h18.93).
  // Scale 2.05× → 28.8×38.8; centre via translate so the S sits dead-centre.
  const OB_MONOGRAM=`<span class="obx-mark" aria-hidden="true">
    <svg viewBox="0 0 72 72" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="obmk-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7c93ff"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>
      <path d="${OB_MARK_S}" fill="url(#obmk-g)" transform="translate(19.4 10.75) scale(2.05)"/>
    </svg>
  </span>`;

  const OB_WORDMARK=`<svg class="obx-logo" viewBox="0 0 71.9 29.9" role="img" aria-label="Shiftr" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="obwm-g" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#7c93ff"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>
    <path fill="url(#obwm-g)" d="M8.033999999999999 21.684Q5.928 21.684 4.316 20.93Q2.7039999999999997 20.176000000000002 1.7939999999999998 18.772000000000002Q0.884 17.368000000000002 0.884 15.392V14.664000000000001H4.264V15.392Q4.264 17.03 5.2780000000000005 17.849Q6.292 18.668 8.033999999999999 18.668Q9.802 18.668 10.672999999999998 17.966Q11.543999999999999 17.264 11.543999999999999 16.172Q11.543999999999999 15.418 11.114999999999998 14.95Q10.686 14.482 9.867 14.183Q9.048 13.884 7.877999999999999 13.624L7.279999999999999 13.494Q5.4079999999999995 13.078000000000001 4.069 12.441Q2.73 11.804 2.015 10.764Q1.3 9.724 1.3 8.06Q1.3 6.396000000000001 2.093 5.213000000000001Q2.8859999999999997 4.030000000000001 4.329 3.3930000000000007Q5.771999999999999 2.7560000000000002 7.7219999999999995 2.7560000000000002Q9.671999999999999 2.7560000000000002 11.192999999999998 3.4190000000000005Q12.713999999999999 4.082000000000001 13.584999999999999 5.3950000000000005Q14.456 6.708 14.456 8.684000000000001V9.464H11.075999999999999V8.684000000000001Q11.075999999999999 7.644 10.672999999999998 7.007000000000001Q10.27 6.370000000000001 9.516 6.071000000000001Q8.762 5.772 7.7219999999999995 5.772Q6.162 5.772 5.420999999999999 6.357Q4.68 6.942 4.68 7.956000000000001Q4.68 8.632000000000001 5.031 9.100000000000001Q5.382 9.568000000000001 6.084 9.88Q6.786 10.192 7.877999999999999 10.426L8.475999999999999 10.556000000000001Q10.426 10.972000000000001 11.869 11.622Q13.312 12.272 14.117999999999999 13.338000000000001Q14.924 14.404 14.924 16.068Q14.924 17.732 14.079 18.993000000000002Q13.234 20.254 11.687 20.969Q10.139999999999999 21.684 8.033999999999999 21.684Z M17.575999999999997 21.32V3.120000000000001H20.851999999999997V10.010000000000002H21.32Q21.528 9.594000000000001 21.97 9.178Q22.412 8.762 23.153 8.489Q23.894 8.216000000000001 25.037999999999997 8.216000000000001Q26.546 8.216000000000001 27.677 8.905000000000001Q28.808 9.594000000000001 29.432 10.803Q30.055999999999997 12.012 30.055999999999997 13.624V21.32H26.779999999999998V13.884Q26.779999999999998 12.428 26.064999999999998 11.700000000000001Q25.349999999999998 10.972000000000001 24.023999999999997 10.972000000000001Q22.516 10.972000000000001 21.683999999999997 11.973Q20.851999999999997 12.974 20.851999999999997 14.768V21.32Z M33.592 21.32V8.424000000000001H36.867999999999995V21.32ZM35.23 6.916Q34.346 6.916 33.735 6.344Q33.123999999999995 5.772 33.123999999999995 4.836000000000002Q33.123999999999995 3.900000000000002 33.735 3.328000000000001Q34.346 2.7560000000000002 35.23 2.7560000000000002Q36.13999999999999 2.7560000000000002 36.738 3.328000000000001Q37.336 3.900000000000002 37.336 4.836000000000002Q37.336 5.772 36.738 6.344Q36.13999999999999 6.916 35.23 6.916Z M42.63999999999999 21.32V11.128H39.364V8.424000000000001H42.63999999999999V6.032000000000002Q42.63999999999999 4.7059999999999995 43.43299999999999 3.9130000000000003Q44.22599999999999 3.120000000000001 45.49999999999999 3.120000000000001H48.879999999999995V5.824000000000002H46.64399999999999Q45.916 5.824000000000002 45.916 6.604000000000001V8.424000000000001H49.29599999999999V11.128H45.916V21.32Z M56.78399999999999 21.32Q55.50999999999999 21.32 54.71699999999999 20.527Q53.92399999999999 19.734 53.92399999999999 18.408V11.128H50.699999999999996V8.424000000000001H53.92399999999999V4.420000000000002H57.199999999999996V8.424000000000001H60.73599999999999V11.128H57.199999999999996V17.836Q57.199999999999996 18.616 57.928 18.616H60.42399999999999V21.32Z M63.699999999999996 21.32V8.424000000000001H66.92399999999999V9.88H67.392Q67.678 9.100000000000001 68.341 8.736Q69.00399999999999 8.372000000000002 69.88799999999999 8.372000000000002H71.448V11.284H69.836Q68.588 11.284 67.782 11.947000000000001Q66.976 12.610000000000001 66.976 13.988V21.32Z"/>
  </svg>`;

  // ── Small helpers ─────────────────────────────────────────────────────────────
  function obWaitFor(cond,timeout){
    return new Promise(res=>{
      const t0=Date.now();
      (function poll(){
        if(cond()) return res(true);
        if(Date.now()-t0>timeout) return res(false);
        setTimeout(poll,160);
      })();
    });
  }
  function obCanProceed(){
    if(OB.step===2) return !!(OB.pattern && (OB.pattern!=='rotation' || OB.currentShift));
    return true;
  }
  function obDeductPct(){
    // The active deduction as a plain percentage, per the chosen mode.
    return OB.dedMode==='insurance' ? OB_INS_PCT : (OB.taxRate||0);
  }
  function obPreviewNet(){
    // Net pay for a plain 8-hour day shift — a tangible "here's what the app
    // will do for you" moment. Weekend/night multipliers come later, in-app.
    return Math.max(0, Math.round(8 * (OB.wage||0) * (1 - obDeductPct()/100)));
  }

  // ── Step body HTML ────────────────────────────────────────────────────────────
  function buildStepHTML(){
    if(OB.step===1){
      return `
        <div class="obx-hero" style="--i:0">
          ${OB_MONOGRAM}
          ${OB_WORDMARK}
          <p class="obx-tagline">${ot('obTagline')}</p>
        </div>
        <div class="obx-langs" style="--i:1" role="group" aria-label="${ot('obStep1Title')}">
          ${OB_LANGS.map(l=>`
            <button type="button" class="obx-lang${OB.lang===l.code?' obx-lang--active':''}" data-lang="${l.code}" aria-pressed="${OB.lang===l.code}">
              ${flagImg(l.code,'obx-lang-flag')}
              <span class="obx-lang-label">${l.label}</span>
            </button>`).join('')}
        </div>
        <button type="button" class="btn-pri obx-cta obx-start" style="--i:2">${ot('obDoneBtn')} ${OI.arrow}</button>
        <button type="button" class="obx-ghost obx-restore" style="--i:3">${OI.google} <span>${ot('obRestoreLink')}</span></button>`;
    }

    if(OB.step===2){
      const opts=[
        {val:'rotation',cls:'',      ico:OI.cycle,title:ot('obStep2Rotation'), sub:ot('obStep2RotationSub')},
        {val:'day',     cls:' obx-opt--day',  ico:OI.sun,  title:ot('obStep2DayOnly'),  sub:ot('obStep2DayOnlySub')},
        {val:'night',   cls:' obx-opt--night',ico:OI.moon, title:ot('obStep2NightOnly'),sub:ot('obStep2NightOnlySub')},
      ];
      const rotOpen=OB.pattern==='rotation';
      return `
        <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">1 ${ot('obOf')} ${obTotal()}</div>
        <h2 class="obx-title" style="--i:1">${ot('obStep2Title')}</h2>
        <div class="obx-options" style="--i:2" role="group" aria-label="${ot('obStep2Title')}">
          ${opts.map(o=>`
            <button type="button" class="obx-opt${o.cls}${OB.pattern===o.val?' obx-opt--active':''}" data-pattern="${o.val}" aria-pressed="${OB.pattern===o.val}">
              <span class="obx-opt-ico">${o.ico}</span>
              <span class="obx-opt-txt">
                <span class="obx-opt-title">${o.title}</span>
                <span class="obx-opt-sub">${o.sub}</span>
              </span>
              <span class="obx-opt-check">${OI.check}</span>
            </button>`).join('')}
        </div>
        <div class="obx-rotsub${rotOpen?' obx-rotsub--open':''}" id="ob-rot-sub" style="--i:3" aria-hidden="${rotOpen?'false':'true'}">
          <div class="obx-rotsub-in">
            <div class="obx-rotsub-card">
              <div class="obx-rotsub-q">${ot('obStep3Title')}</div>
              <div class="obx-week">
                <button type="button" class="obx-week-btn obx-week-btn--day${OB.currentShift==='day'?' obx-week-btn--active':''}" data-curshift="day" ${rotOpen?'':'tabindex="-1"'}>${OI.sun} <span>${ot('dayShift')}</span></button>
                <button type="button" class="obx-week-btn obx-week-btn--night${OB.currentShift==='night'?' obx-week-btn--active':''}" data-curshift="night" ${rotOpen?'':'tabindex="-1"'}>${OI.moon} <span>${ot('nightShift')}</span></button>
              </div>
            </div>
          </div>
        </div>
        <button type="button" class="btn-pri obx-cta obx-next" style="--i:4" ${obCanProceed()?'':'disabled'}>${ot('obNext')} ${OI.arrow}</button>`;
    }

    // Step 3 — Workplace & Pay Rules: WHAT the workplace pays. Two deliberate
    // paths (Phase 6.4): pick/author rules with the cards, OR flip into a
    // dedicated import mode via the entry card below them — a confirmed code
    // overrides the cards (dimmed until removed) and is stored verbatim at
    // completeOnboarding.
    if(OB.step===3){
      if(obJoinMode()) return objoinModeHTML();
      return `
        <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">2 ${ot('obOf')} ${obTotal()}</div>
        <h2 class="obx-title" style="--i:1">${wizT(OB.lang,'title')}</h2>
        <p class="obx-sub-text" style="--i:2">${wizT(OB.lang,'sub')}</p>
        <div style="--i:3"${OB.importedShare?' class="wpx-overridden" aria-disabled="true"':''}>${obxWorkplaceHTML(OB.rules, OB.lang, OB.pattern)}</div>
        <div style="--i:4">${objoinHTML()}</div>
        <button type="button" class="btn-pri obx-cta obx-next" style="--i:5">${ot('obNext')} ${OI.arrow}</button>
        <button type="button" class="obx-ghost obx-later" style="--i:6"${(OB.rules.preset||OB.importedShare)?' hidden':''}>${wizT(OB.lang,'laterBtn')}</button>
        <p class="obx-flownote" style="--i:7">${WZI.lock}<span>${wizT(OB.lang,'laterNote')}</span></p>`;
    }

    // Step 4 — Night Schedule: WHEN those rules apply. Exists only for
    // schedule-driven rules (see obSeq); day-only users never see it.
    if(OB.step===4){
      return `
        <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">3 ${ot('obOf')} ${obTotal()}</div>
        <h2 class="obx-title" style="--i:1">${wizT(OB.lang,'nsTitle')}</h2>
        <p class="obx-sub-text" style="--i:2">${wizT(OB.lang,'nsSub')}</p>
        <div style="--i:3">${obxNightHTML(OB.rules, OB.lang)}</div>
        <button type="button" class="btn-pri obx-cta obx-next" style="--i:4">${ot('obNext')} ${OI.arrow}</button>`;
    }

    if(OB.step===5){
      const insMode=OB.dedMode==='insurance';
      return `
        <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">${obTotal()-1} ${ot('obOf')} ${obTotal()}</div>
        <h2 class="obx-title" style="--i:1">${ot('obPayTitle')}</h2>
        <p class="obx-sub-text" style="--i:2">${ot('obStep4Sub')}</p>
        <div class="obx-field obx-field--wage" style="--i:3">
          <label class="obx-field-label" for="ob-wage-in">${ot('obWageLabel')}</label>
          <div class="obx-input-wrap">
            <span class="obx-input-affix">₩</span>
            <input class="obx-input obx-input--wage" id="ob-wage-in" type="number" inputmode="numeric" value="${OB.wage}" min="0" step="100">
          </div>
        </div>
        <div class="obx-field" style="--i:4">
          <span class="obx-field-label">${ot('deductionsLabel')}</span>
          <div class="ded-seg obx-ded-seg" role="radiogroup" aria-label="${ot('deductionsLabel')}">
            <div class="ded-seg-pill ded-seg-pill--${OB.dedMode}" id="ob-ded-pill" style="--seg-pos:${insMode?1:0};" aria-hidden="true"></div>
            <button type="button" class="ded-tog${insMode?'':' ded-tog-on'}" role="radio" aria-checked="${!insMode}" data-ded-mode="tax">${ot('deductionModeTax')}</button>
            <button type="button" class="ded-tog${insMode?' ded-tog-on':''}" role="radio" aria-checked="${insMode}" data-ded-mode="insurance">${ot('deductionModeInsurance')}</button>
          </div>
          <!-- Tax body: a single flat % input -->
          <div class="obx-ded-body${insMode?' obx-ded-body--hidden':''}" id="ob-ded-tax">
            <div class="obx-input-wrap">
              <input class="obx-input obx-input--tax" id="ob-tax-in" type="number" inputmode="decimal" value="${OB.taxRate}" min="0" max="45" step="0.1">
              <span class="obx-input-affix">%</span>
            </div>
            <span class="obx-field-hint">${ot('taxRateRange')}</span>
          </div>
          <!-- Insurance body: statutory 4대 보험 total; details editable later in Settings -->
          <div class="obx-ded-body${insMode?'':' obx-ded-body--hidden'}" id="ob-ded-ins">
            <div class="obx-ins-summary">
              <span class="obx-ins-total-label">${ot('insuranceTotalLabel')}</span>
              <span class="obx-ins-total-val">${OB_INS_PCT}%</span>
            </div>
            <span class="obx-field-hint">${ot('obInsHint')}</span>
          </div>
        </div>
        <div class="obx-toggle-row" style="--i:5">
          <span class="obx-toggle-ico">${OI.cal}</span>
          <span class="obx-toggle-txt">
            <span class="obx-toggle-title">${ot('obStep5HolTitle')}</span>
            <span class="obx-toggle-sub">${ot('obHolShort')}</span>
          </span>
          <button type="button" class="s3-toggle${OB.holAuto?' s3-toggle--on':''}" id="ob-hol-toggle" role="switch" aria-checked="${OB.holAuto?'true':'false'}" aria-label="${ot('obStep5HolTitle')}"><span class="s3-toggle-knob"></span></button>
        </div>
        <div class="obx-preview" style="--i:6">
          <span class="obx-preview-label">${ot('obPreviewLabel')}</span>
          <span class="obx-preview-val" id="ob-preview-val">≈ ₩${obPreviewNet().toLocaleString()}</span>
        </div>
        <button type="button" class="btn-pri obx-cta obx-next" style="--i:7">${ot('obNext')} ${OI.arrow}</button>`;
    }

    // Step 6 — finish (normal or cloud-restored)
    const checkSVG=`
      <div class="obx-check" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <defs><linearGradient id="obx-check-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8a9bff"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>
          <circle class="obx-check-ring" cx="32" cy="32" r="28"/>
          <path class="obx-check-tick" d="M21 33.5l7.5 7.5L43 25.5"/>
        </svg>
      </div>`;
    const signedRow=CURRENT_USER
      ?`<div class="obx-signedin" style="--i:2">
          ${CURRENT_USER.photoURL?`<img src="${CURRENT_USER.photoURL}" class="avatar" alt="">`:''}
          <span>${ot('obStep5Done')} <strong>${CURRENT_USER.displayName||CURRENT_USER.email}</strong></span>
        </div>`
      :'';
    if(OB.restored){
      return `
        <div class="obx-finale" style="--i:0">
          ${CURRENT_USER?.photoURL?`<img src="${CURRENT_USER.photoURL}" class="obx-avatar" alt="">`:checkSVG}
          <h2 class="obx-title" style="--i:0">${ot('obWelcomeBackTitle')}</h2>
          <p class="obx-sub-text" style="--i:1">${ot('obWelcomeBackSub')}</p>
        </div>
        ${signedRow}
        <button type="button" class="btn-pri obx-cta obx-finish" style="--i:3">${ot('obDoneBtn')} ${OI.arrow}</button>`;
    }
    const backupCard=CURRENT_USER
      ?signedRow
      :`<div class="obx-backup" style="--i:2">
          <div class="obx-backup-head">
            <span class="obx-backup-ico">${OI.cloud}</span>
            <span class="obx-backup-txt">
              <span class="obx-backup-title">${ot('obStep5Title')}</span>
              <span class="obx-backup-sub">${ot('obStep5Sub')}</span>
            </span>
          </div>
          <button type="button" class="obx-google ob-google-signin" ${OB.signingIn?'disabled':''}>${OB.signingIn?OI.spin:OI.google} <span>${ot('obStep5Signin')}</span></button>
        </div>`;
    return `
      <div class="obx-eyebrow" style="--i:0">${obTotal()} ${ot('obOf')} ${obTotal()}</div>
      <div class="obx-finale" style="--i:1">
        ${checkSVG}
        <h2 class="obx-title">${ot('obDoneTitle')}</h2>
        <p class="obx-sub-text">${ot('obDoneSub')}</p>
      </div>
      ${backupCard}
      <button type="button" class="btn-pri obx-cta obx-finish" style="--i:3">${ot('obDoneBtn')} ${OI.arrow}</button>`;
  }

  // ── Top chrome: back button + tappable progress segments ─────────────────────
  // Segments mirror the LIVE sequence (4 or 5 setup screens): each maps to an
  // actual step id, so jumping back lands on the right screen even when the
  // Night Schedule step doesn't exist for this user.
  function buildChromeHTML(){
    if(OB.step===1 || OB.restored) return '';
    const seq=obSeq(), total=obTotal();
    const pos=Math.max(1,obStepIdx(OB.step));
    const segs=seq.slice(1).map((stp,i)=>{
      const n=i+1;
      const cls=n<pos?' obx-seg--done':n===pos?' obx-seg--active':'';
      return `<button type="button" class="obx-seg${cls}" data-goto="${stp}"${n<pos?'':' disabled tabindex="-1"'} aria-label="${n} ${ot('obOf')} ${total}"><i></i></button>`;
    }).join('');
    return `<button type="button" class="obx-back" aria-label="${ot('obBack')}">${OI.back}</button>
      <div class="obx-progress" role="group" aria-label="${pos} ${ot('obOf')} ${total}">${segs}</div>
      <span class="obx-chrome-spacer" aria-hidden="true"></span>`;
  }

  // Refresh the chrome + eyebrow in place. Called when a choice made ON a step
  // changes the flow's shape (pattern picked, preset/night rule changed) so
  // the progress bar and "2 of 5" never lag behind the sequence.
  function syncFlowChrome(){
    const chrome=document.getElementById('ob-chrome');
    if(chrome){ chrome.innerHTML=buildChromeHTML(); wireChromeEvents(); }
    const eb=document.getElementById('ob-eyebrow');
    if(eb){
      const idx=OB.step===2?1:OB.step===3?2:OB.step===4?3:obTotal()-1;
      eb.textContent=`${idx} ${ot('obOf')} ${obTotal()}`;
    }
  }

  // ── Initial mount ─────────────────────────────────────────────────────────────
  function mountOB(){
    const ov=document.createElement('div');
    // The two configuration screens get a wider column (the preset grid and
    // the schedule panels breathe at 620px); every other screen keeps 470px.
    ov.className='ob-overlay'+(OB.step===3||OB.step===4?' ob-overlay--wide':'');
    ov.id='ob-overlay';
    ov.innerHTML=`
      <div class="obx-ambient" aria-hidden="true"><i class="obx-orb obx-orb--a"></i><i class="obx-orb obx-orb--b"></i></div>
      <div class="obx-chrome" id="ob-chrome">${buildChromeHTML()}</div>
      <div class="obx-stage"><div class="obx-col" id="ob-body">${buildStepHTML()}</div></div>`;
    document.body.appendChild(ov);
    // The overlay is now painting over everything — retire the splash. The app
    // shell stays hidden (data-onboarding kept) so nothing shows through the
    // overlay's fade-in; complete*()/skip clears the attribute at the very end.
    document.getElementById('ob-splash')?.remove();
    wireChromeEvents();
    wireStepEvents();
  }

  // ── Screen transition: soft fade + scale with a whisper of direction ─────────
  function transitionTo(newStep, direction){
    const body=document.getElementById('ob-body');
    OB.step=newStep;
    saveOBState();
    if(!body){ mountOB(); return; }
    const swap=()=>{
      document.getElementById('ob-overlay')?.classList.toggle('ob-overlay--wide',OB.step===3||OB.step===4);
      const chrome=document.getElementById('ob-chrome');
      if(chrome) chrome.innerHTML=buildChromeHTML();
      body.innerHTML=buildStepHTML();
      wireChromeEvents();
      wireStepEvents();
    };
    if(OB_REDUCED){ swap(); return; }
    body.style.setProperty('--dx',(direction>=0?14:-14)+'px');
    body.classList.add('obx-leave');
    let done=false;
    const finish=()=>{
      if(done) return; done=true;
      body.classList.remove('obx-leave');
      swap();
      body.classList.add('obx-enter');
      const clear=()=>body.classList.remove('obx-enter');
      body.addEventListener('animationend',clear,{once:true});
      setTimeout(clear,600); // safety
    };
    body.addEventListener('animationend',finish,{once:true});
    setTimeout(finish,240); // safety if animationend never fires
  }

  // ── Restore fast path (screen 1) ──────────────────────────────────────────────
  // Sign in → wait for firebase's pull to land → if the account has a real setup
  // (shift anchors in the cloud), jump straight to the finale as a welcome-back.
  function setRestoreState(mode){
    const btn=document.querySelector('.obx-restore');
    if(!btn) return;
    if(mode==='idle'){ btn.disabled=false; btn.innerHTML=`${OI.google} <span>${ot('obRestoreLink')}</span>`; }
    else if(mode==='busy'){ btn.disabled=true; btn.innerHTML=`${OI.spin} <span>${ot('obRestoreLink')}</span>`; }
    else{ btn.disabled=true; btn.innerHTML=`${OI.spin} <span>${ot('obRestoring')}</span>`; }
  }
  async function restoreFlow(){
    if(OB.signingIn) return;
    if(!navigator.onLine){ await signInWithGoogle(); return; } // fires its own offline alert
    OB.signingIn=true;
    setRestoreState('busy');
    const syncedAt0=Number(localStorage.getItem('wt4_syncedAt')||0);
    if(!CURRENT_USER) await signInWithGoogle();
    // onAuthStateChanged is async — give it a moment to hand us the user.
    await obWaitFor(()=>!!CURRENT_USER, 3500);
    if(!CURRENT_USER){ OB.signingIn=false; setRestoreState('idle'); return; } // popup dismissed
    setRestoreState('restoring');
    // pullFromCloud either merges cloud data (sets wt4_cloud_pulled) or, for a
    // brand-new account, pushes local up (bumps wt4_syncedAt). Wait for either.
    await obWaitFor(()=>ld('wt4_cloud_pulled',false)===true
        || Number(localStorage.getItem('wt4_syncedAt')||0)>syncedAt0, 9000);
    OB.signingIn=false;
    const hasCloudSetup = ld('wt4_cloud_pulled',false)===true
        && Object.keys(ld('wt4_shifts',{})).length>0;
    if(hasCloudSetup){
      // Returning user: everything is already in localStorage. No questions.
      OB.lang=ld('wt4_lang',OB.lang);
      S.lang=OB.lang;
      OB.restored=true;
      saveOBState();
      transitionTo(6,1); // straight to the welcome-back finale — zero questions
    }else{
      // Signed in but nothing to restore — continue setup; choices back up automatically.
      transitionTo(2,1);
    }
  }

  // ── Wire chrome events (back + progress) ─────────────────────────────────────
  function wireChromeEvents(){
    const chrome=document.getElementById('ob-chrome');
    if(!chrome) return;
    chrome.querySelector('.obx-back')?.addEventListener('click',()=>{
      transitionTo(obPrevStep(),-1);
    });
    chrome.querySelectorAll('.obx-seg--done').forEach(seg=>{
      seg.addEventListener('click',()=>{
        const target=parseInt(seg.dataset.goto);
        if(target && target<OB.step) transitionTo(target,-1);
      });
    });
  }

  // ── Wire step-level events (called after every body swap) ────────────────────
  // Phase 6.4: "I have a workplace code" — the coworker fast path on the
  // workplace step. A ghost toggle folds open the same lookup → preview →
  // confirm pipeline as the Settings import modal (same imm-* components,
  // same share.js gates); a confirmed code renders as an applied-chip and
  // overrides the preset cards until removed. Nothing touches real storage
  // here — the profile is held in OB.importedShare until completeOnboarding.
  function objoinHTML(){
    const W=k=>wizT(OB.lang,k);
    if(OB.importedShare){
      const s=OB.importedShare;
      return `<div class="objoin" id="ob-join">
        <div class="objoin-chip">
          <span class="objoin-chip-ic">${OI.check}</span>
          <span class="objoin-chip-txt">
            <span class="objoin-chip-t">${W('obCodeApplied')}</span>
            <span class="objoin-chip-s">${s.name?escHTML(s.name)+' · ':''}${formatShareCode(s.code)}</span>
          </span>
          <button type="button" class="objoin-remove" id="ob-join-remove">${W('obCodeRemove')}</button>
        </div>
      </div>`;
    }
    // The second path's door: an intentional entry card, not a fourth preset.
    return `<div class="objoin" id="ob-join">
      <button type="button" class="objoin-entry" id="ob-join-enter">
        <span class="objoin-entry-ic" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>
        <span class="objoin-entry-txt">
          <span class="objoin-entry-t">${W('obHaveCode')}</span>
          <span class="objoin-entry-s">${W('obCodeDesc')}</span>
        </span>
        <span class="objoin-entry-chev" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
      </button>
    </div>`;
  }

  // Import mode owns the whole step: the preset UI steps aside and the code
  // path gets a focused screen — the SAME mask/lookup/stage components as the
  // Settings import modal (wireShareCodeInput / shareLookupByCode / shm-*).
  function obJoinMode(){
    return OB.joinMode!==undefined?!!OB.joinMode:(!!OB.pendingJoin&&!OB.importedShare);
  }
  function objoinModeHTML(){
    const W=k=>wizT(OB.lang,k);
    const prefill=OB.pendingJoin?formatShareCode(OB.pendingJoin):(OB._joinDraft||'');
    return `
      <div class="obx-eyebrow" id="ob-eyebrow" style="--i:0">2 ${ot('obOf')} ${obTotal()}</div>
      <button type="button" class="objoin-back" id="ob-join-back" style="--i:1">${OI.back}${W('obBackPresets')}</button>
      <h2 class="obx-title" style="--i:2">${W('imTitle')}</h2>
      <p class="obx-sub-text" style="--i:3">${W('imSub')}</p>
      <div class="objoin-panel" id="ob-join" style="--i:4">
        <div class="imm-row">
          <input type="text" id="ob-join-code" class="imm-input" placeholder="${W('imPlaceholder')}"
                 autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="120"
                 value="${escHTML(prefill)}">
          <button type="button" class="btn-pri" id="ob-join-lookup" disabled>${W('imLookup')}</button>
        </div>
        <div class="imm-err" id="ob-join-err" hidden></div>
        <div class="imm-stage" id="ob-join-stage" aria-live="polite"></div>
      </div>
      <button type="button" class="btn-pri obx-cta" id="ob-join-confirm" style="--i:5" disabled>${W('imConfirm')} ${OI.arrow}</button>`;
  }
  function wireObJoin(root){
    const W=k=>wizT(OB.lang,k);
    const body=document.getElementById('ob-body');
    const rerender=()=>{ body.innerHTML=buildStepHTML(); wireStepEvents(); syncFlowChrome(); };

    // Applied chip → Remove re-enables the preset cards.
    const removeBtn=root.querySelector('#ob-join-remove');
    if(removeBtn){
      removeBtn.addEventListener('click',()=>{
        OB.importedShare=null;
        saveOBState();
        rerender();                       // cards re-enable; flow re-syncs
      });
      return;
    }

    // Default mode: the entry card is the door into import mode.
    const enter=root.querySelector('#ob-join-enter');
    if(enter){
      enter.addEventListener('click',()=>{
        OB.joinMode=true;
        rerender();
        document.getElementById('ob-join-code')?.focus({preventScroll:true});
      });
      return;
    }

    // Import mode — shared mask/lookup/stage; only the found-card CONTENT is
    // onboarding-specific (a high-level what's-included summary instead of
    // the full rules table a Settings user needs).
    const inp=root.querySelector('#ob-join-code');
    const errEl=root.querySelector('#ob-join-err');
    const stage=root.querySelector('#ob-join-stage');
    const lookupBtn=root.querySelector('#ob-join-lookup');
    const confirmBtn=document.getElementById('ob-join-confirm');
    let candidate=null;

    const renderIdle=()=>{stage.innerHTML=shmEmptyHTML(SHM_IC_SEARCH,W('objEmptyTitle'),W('objEmptyDesc'));};
    renderIdle();
    const showErr=msg=>{ errEl.hidden=false; errEl.textContent=msg; renderIdle(); confirmBtn.disabled=true; candidate=null; };

    const oii=p=>`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    const INC=[
      [oii('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>'),'objIncWage'],
      [oii('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),'objIncOt'],
      [oii('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),'objIncNight'],
      [oii('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),'objIncHol'],
    ];
    function presentResult(r,code){
      candidate={ code, name:r.name||null, profile:r.profile };
      errEl.hidden=true;
      stage.innerHTML=`<div class="shm-card">
        ${shmFoundHeadHTML(W('imFound'),`${r.name?`<b>${escHTML(r.name)}</b>`:formatShareCode(code)}<br>${W('objFoundSub')}`)}
        <div class="objoin-inc">${INC.map(([ic,k])=>`<span class="objoin-inc-it">${ic}${W(k)}</span>`).join('')}</div>
      </div>`;
      confirmBtn.disabled=false;
    }

    async function lookup(){
      errEl.hidden=true;
      const code=normalizeShareCode(inp.value);
      if(!code){ showErr(W('imErrFormat')); return; }
      const orig=lookupBtn.innerHTML;
      lookupBtn.disabled=true;
      lookupBtn.innerHTML=`<span class="obx-spin" aria-hidden="true"></span>${W('imChecking')}`;
      const res=await shareLookupByCode(code,W);
      lookupBtn.disabled=false;
      lookupBtn.innerHTML=orig;
      if(!res.ok){ showErr(res.msg); return; }
      presentResult(res.r,code);
    }

    wireShareCodeInput(inp,{
      onChange:(complete,changed)=>{
        lookupBtn.disabled=!complete;
        if(changed&&candidate){ candidate=null; confirmBtn.disabled=true; errEl.hidden=true; renderIdle(); }
      },
      onEnter:()=>{ if(!lookupBtn.disabled) lookup(); },
    });
    lookupBtn.addEventListener('click',lookup);

    document.getElementById('ob-join-back').addEventListener('click',()=>{
      OB._joinDraft=inp.value;            // a typed code survives the hop back
      OB.joinMode=false;
      rerender();
    });

    confirmBtn.addEventListener('click',()=>{
      if(!candidate)return;
      OB.importedShare=candidate;
      OB.pendingJoin=null;
      OB._joinDraft='';
      OB.joinMode=false;
      // Seed the chip state the imported rules imply so the Night Schedule
      // page (when the workplace needs one) previews with the workplace's
      // premium and shows its window — the STORED artifact stays the
      // verbatim imported profile, never a recompile of these chips.
      const nt=candidate.profile.night;
      if(nt&&nt.prem) OB.rules.night=+(1+nt.prem).toFixed(2);
      if(nt&&nt.window&&(nt.window.start!=='22:00'||nt.window.end!=='06:00')) OB.rules.window={...nt.window};
      saveOBState();
      rerender();
    });

    // Deep-linked code: run the prefilled lookup once, automatically.
    if(OB.pendingJoin && !OB._autoLooked && !lookupBtn.disabled){ OB._autoLooked=true; lookup(); }
  }

  function wireStepEvents(){
    const body=document.getElementById('ob-body');
    if(!body) return;

    // Step 1: language chips — rebuild the body so every label retranslates live
    body.querySelectorAll('[data-lang]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.lang=btn.dataset.lang;
        S.lang=OB.lang;
        saveOBState();
        body.innerHTML=buildStepHTML();
        wireStepEvents();
      });
    });
    body.querySelector('.obx-start')?.addEventListener('click',()=>transitionTo(2,1));
    body.querySelector('.obx-restore')?.addEventListener('click',restoreFlow);

    // Step 2: pattern cards — in-place selection so the press never flashes
    const syncNext=()=>{
      const nx=body.querySelector('.obx-next');
      if(nx) nx.disabled=!obCanProceed();
    };
    body.querySelectorAll('[data-pattern]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.pattern=btn.dataset.pattern;
        if(OB.pattern!=='rotation') OB.currentShift=null;
        saveOBState();
        body.querySelectorAll('[data-pattern]').forEach(b=>{
          const on=b.dataset.pattern===OB.pattern;
          b.classList.toggle('obx-opt--active',on);
          b.setAttribute('aria-pressed',on?'true':'false');
        });
        const sub=document.getElementById('ob-rot-sub');
        if(sub){
          const open=OB.pattern==='rotation';
          sub.classList.toggle('obx-rotsub--open',open);
          sub.setAttribute('aria-hidden',open?'false':'true');
          sub.querySelectorAll('[data-curshift]').forEach(b=>{
            b.tabIndex=open?0:-1;
            if(!open) b.classList.remove('obx-week-btn--active');
          });
        }
        syncNext();
        syncFlowChrome(); // day-only trims the Night Schedule step → "1 of 4"
      });
    });
    body.querySelectorAll('[data-curshift]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        OB.currentShift=btn.dataset.curshift;
        saveOBState();
        body.querySelectorAll('[data-curshift]').forEach(b=>{
          b.classList.toggle('obx-week-btn--active',b.dataset.curshift===OB.currentShift);
        });
        syncNext();
      });
    });

    // Step 5 (pay): wage input — live-sync + preview
    const updatePreview=()=>{
      const el=document.getElementById('ob-preview-val');
      if(!el) return;
      el.textContent='≈ ₩'+obPreviewNet().toLocaleString();
      el.classList.remove('obx-pop');
      void el.offsetWidth; // restart the pop animation
      el.classList.add('obx-pop');
    };
    const wageIn=document.getElementById('ob-wage-in');
    if(wageIn){
      wageIn.addEventListener('input',()=>{
        const v=parseInt(wageIn.value);
        if(!isNaN(v)&&v>=0){ OB.wage=v; saveOBState(); updatePreview(); }
      });
    }
    // Deduction-mode switch: Tax ↔ 4 Insurances (mirrors Settings)
    body.querySelectorAll('[data-ded-mode]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const mode=btn.getAttribute('data-ded-mode');
        OB.dedMode=mode;
        saveOBState();
        body.querySelectorAll('[data-ded-mode]').forEach(b=>{
          const on=b.getAttribute('data-ded-mode')===mode;
          b.classList.toggle('ded-tog-on',on);
          b.setAttribute('aria-checked',on?'true':'false');
        });
        const pill=document.getElementById('ob-ded-pill');
        if(pill){ pill.style.setProperty('--seg-pos',mode==='insurance'?1:0); pill.className='ded-seg-pill ded-seg-pill--'+mode; }
        document.getElementById('ob-ded-tax')?.classList.toggle('obx-ded-body--hidden',mode==='insurance');
        document.getElementById('ob-ded-ins')?.classList.toggle('obx-ded-body--hidden',mode!=='insurance');
        updatePreview();
      });
    });
    // Tax rate input — live-sync with clamping
    const taxIn=document.getElementById('ob-tax-in');
    if(taxIn){
      taxIn.addEventListener('input',()=>{
        let v=parseFloat(taxIn.value);
        if(!isNaN(v)){ v=Math.min(45,Math.max(0,parseFloat(v.toFixed(2)))); OB.taxRate=v; saveOBState(); updatePreview(); }
      });
      taxIn.addEventListener('blur',()=>{
        let v=parseFloat(taxIn.value);
        if(isNaN(v))v=DEFAULT_TAX;
        v=Math.min(45,Math.max(0,parseFloat(v.toFixed(2))));
        taxIn.value=v; OB.taxRate=v; saveOBState(); updatePreview();
      });
    }
    // Holiday auto-credit switch
    const hol=document.getElementById('ob-hol-toggle');
    if(hol){
      hol.addEventListener('click',()=>{
        OB.holAuto=!OB.holAuto;
        saveOBState();
        hol.classList.toggle('s3-toggle--on',OB.holAuto);
        hol.setAttribute('aria-checked',OB.holAuto?'true':'false');
      });
    }

    // Step 6 (finish): Google sign-in (backup card)
    body.querySelector('.ob-google-signin')?.addEventListener('click',async()=>{
      if(OB.signingIn) return;
      OB.signingIn=true;
      const btn=body.querySelector('.ob-google-signin');
      if(btn){ btn.disabled=true; btn.innerHTML=`${OI.spin} <span>${ot('obStep5Signin')}</span>`; }
      await signInWithGoogle();
      await obWaitFor(()=>!!CURRENT_USER, 3500); // let onAuthStateChanged land
      OB.signingIn=false;
      body.innerHTML=buildStepHTML(); // refresh in place to show signed-in state
      wireStepEvents();
    });

    // Step 3 — Workplace & Pay Rules: renders once, updates itself surgically.
    // Choices here can reshape the flow (preset ↔ customize, night ×1), so the
    // chrome, eyebrow and the "I'll customize later" escape hatch re-sync too.
    const wpx=document.getElementById('ob-wpx');
    if(wpx){
      obxWireWorkplace(wpx, OB.rules, {lang:OB.lang, pattern:OB.pattern, onChange:()=>{
        saveOBState();
        syncFlowChrome();
        const later=body.querySelector('.obx-later');
        if(later) later.hidden=!!OB.rules.preset;
      }});
      // "I'll customize later" — bail out of Customize back to the standard
      // preset and move on; everything stays editable in Settings.
      body.querySelector('.obx-later')?.addEventListener('click',()=>{
        OB.rules.preset='kr-statutory-5plus';
        saveOBState();
        transitionTo(obNextStep(),1);
      });
    }
    // Step 3 — workplace code panel (Phase 6.4). Present whether or not a
    // code is already applied (the applied-chip wires its Remove button).
    const join=document.getElementById('ob-join');
    if(join) wireObJoin(join);

    // Step 4 — Night Schedule: times, window, breaks, live timeline preview.
    const nsx=document.getElementById('ob-nsx');
    if(nsx){
      obxWireNight(nsx, OB.rules, {lang:OB.lang, onChange:saveOBState});
    }

    // Next / continue
    body.querySelector('.obx-next')?.addEventListener('click',()=>{
      if(OB.step===2 && !obCanProceed()) return;
      if(OB.step===5){
        const wIn=document.getElementById('ob-wage-in');
        if(wIn){ const v=parseInt(wIn.value); if(!isNaN(v)&&v>=0) OB.wage=v; }
        const tIn=document.getElementById('ob-tax-in');
        if(tIn){ let v=parseFloat(tIn.value); if(!isNaN(v)){ v=Math.min(45,Math.max(0,v)); OB.taxRate=v; } }
      }
      transitionTo(obNextStep(),1);
    });

    // Finish
    body.querySelector('.obx-finish')?.addEventListener('click',()=>{
      if(OB.restored) completeRestored();
      else completeOnboarding();
    });
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

    // 3. Save shifts and wages, but only if this is a new user.
    // For returning users who logged in during onboarding, cloud data is already
    // in localStorage — don't overwrite shifts (would corrupt historical anchors)
    // or wages (would lose all but the latest entry).
    const cloudWasPulled = ld('wt4_cloud_pulled', false);
    if (cloudWasPulled) {
      // Returning user: shifts stay untouched. Only write wages if cloud had none.
      const existingWages = ld('wt4_wages', null);
      if (!existingWages || existingWages.length <= 1) sv('wt4_wages', [{date:'2026-01-01', amount:OB.wage}]);
    } else {
      // New user: write freshly computed shifts and the onboarding wage.
      sv('wt4_shifts', sh);
      sv('wt4_wages', [{date:'2026-01-01', amount:OB.wage}]);
    }

    // 3b. Store the pay profile. An imported workplace code (Phase 6.4) wins
    // over BOTH the wizard chips and a cloud-pulled profile — it is the
    // user's most recent explicit choice. The share pipeline stripped the
    // sharer's schedule, so the importer's own times (collected on the Night
    // Schedule step) attach here; the profile is otherwise stored VERBATIM —
    // never recompiled from chips, which would corrupt source-less imports.
    if(OB.importedShare && OB.importedShare.profile){
      try{
        const p=structuredClone(OB.importedShare.profile);
        if(obNeedsSched()){
          if(OB.rules.schedule && OB.rules.schedule.night){
            p.schedule={night:{...OB.rules.schedule.night}};
            if(p.source&&p.source.answers) p.source.answers.schedule={night:{...OB.rules.schedule.night}};
          }
          if(OB.rules.window && p.night){    // user adjusted the window on step 4
            p.night.window={...OB.rules.window};
            if(p.source&&p.source.answers) p.source.answers.nightWindow={...OB.rules.window};
          }
        }
        sv('wt4_profile', p);
      }catch(e){ console.warn('[share] imported profile save failed — default rules apply', e); }
    }else if(!cloudWasPulled || ld('wt4_profile', null) === null){
      // Compile and store the pay profile from the wizard answers. Cloud
      // users keep their existing synced profile; a compile failure falls
      // back to the default rules and never blocks onboarding.
      try{ sv('wt4_profile', wizardProfileFrom(OB.rules, OB.pattern)); }
      catch(e){ console.warn('[wiz] profile compile failed — default rules apply', e); }
    }

    // 4. Save tax rate — always (it's the fallback the user can switch back to)
    const taxVal = (OB.taxRate !== undefined && !isNaN(OB.taxRate))
      ? Math.min(45, Math.max(0, OB.taxRate)) : DEFAULT_TAX;
    sv('wt4_tax_rate', taxVal);
    S.taxRate = taxVal;

    // 4b. Save deduction mode (tax vs 4대 보험). When insurance is chosen and the
    // user has no saved insurance rates yet, seed the statutory defaults so the
    // net figures are correct immediately; individual rates stay editable in Settings.
    const dedMode = OB.dedMode === 'insurance' ? 'insurance' : 'tax';
    sv('wt4_deduction_mode', dedMode);
    if(dedMode === 'insurance' && ld('wt4_insurance', null) === null){
      sv('wt4_insurance', { ...DEFAULT_INSURANCE });
    }

    // 5. Save holiday auto-credit preference (default true if user skipped without choosing)
    sv('wt4_hol_auto', OB.holAuto !== null ? OB.holAuto : true);
    S.holAuto = OB.holAuto !== null ? OB.holAuto : true;

    // 6. Mark onboarding complete — ONLY here, never earlier
    localStorage.setItem('wt4_onboarding', 'done');
    // Clean up in-progress session key and cloud-pull flag
    localStorage.removeItem('wt4_ob_state');
    localStorage.removeItem('wt4_cloud_pulled');

    // 7. Dismiss overlay and render the full app
    document.documentElement.removeAttribute('data-onboarding');
    document.getElementById('ob-overlay')?.remove();
    render();
    prefetchHolidays();
    if(CURRENT_USER) scheduleSync();
  }

  // ── Finish for cloud-restored users ──────────────────────────────────────────
  // The pull already rehydrated every synced key (shifts, wages, lang, theme,
  // tax, holiday preference). We only hydrate S from those values and mark done —
  // writing OB defaults here would clobber the restored settings.
  function completeRestored(){
    S.lang    = ld('wt4_lang', OB.lang);
    S.theme   = ld('wt4_theme', S.theme);
    S.taxRate = ld('wt4_tax_rate', DEFAULT_TAX);
    S.holAuto = ld('wt4_hol_auto', true);

    localStorage.setItem('wt4_onboarding', 'done');
    localStorage.removeItem('wt4_ob_state');
    localStorage.removeItem('wt4_cloud_pulled');

    document.documentElement.removeAttribute('data-onboarding');
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

// ── One-time migration: pin existing users to the Iljitech preset ──────────────
// The selectable preset system ships with this release. Before it, every user's
// pay math WAS the hardcoded factory rulebook — DEFAULT_PROFILE, id
// 'kr-factory-2shift', which is exactly the Iljitech preset (compile.js verifies
// the preset compiles to DEFAULT_PROFILE bit-for-bit). Grandfathered users have
// no explicit wt4_profile, so on opening the new "Edit pay rules" editor,
// rulesStateFromProfile() would fall back to WIZ_DEFAULT_RULES() and pre-select
// the kr-statutory-5plus default — visually wrong, and a save would silently
// switch their math off Iljitech. Pin the Iljitech preset explicitly so the
// editor reflects each existing user's actual (unchanged) rules.
//
// Runs once (guarded by wt4_mig_factory_default). Only existing users — those
// who already completed onboarding — are touched; a genuinely new user is still
// mid-flow (wt4_onboarding !== 'done') and chooses a preset in onboarding itself.
// Placed AFTER initOnboarding so grandfathered users are already flagged 'done',
// and BEFORE the startup render() below so the first paint uses the pinned profile.
(function pinIljitechForExistingUsers(){
  if(localStorage.getItem('wt4_mig_factory_default') === 'done') return;
  if(localStorage.getItem('wt4_onboarding') === 'done'){
    const p = ld('wt4_profile', null);
    const alreadyPinned = !!(p && p.source && p.source.kind === 'preset'
                             && p.source.presetId === 'kr-factory-2shift');
    if(!alreadyPinned){
      try{ sv('wt4_profile', wizardProfileFrom({ ...WIZ_DEFAULT_RULES(), preset:'kr-factory-2shift' }, null)); }
      catch(e){ console.warn('[mig] Iljitech-default pin failed — grandfathered rules apply', e); }
    }
  }
  localStorage.setItem('wt4_mig_factory_default', 'done');
})();

// Normal startup (only reached if onboarding is already done)
render();
prefetchHolidays();
startSyncTicker();
