// ─────────────────────────────────────────────────────────────────────────────
// data/holidays.js — the Korean public-holiday data service (Phase 5).
// Source: data.go.kr — Ministry of the Interior and Safety official holiday
// API. Includes all public holidays AND substitute holidays (대체공휴일).
//
// DESIGN (deliberate, see the architecture contracts): the service FILLS
// APP-OWNED MAPS — it never owns them. app.js keeps `HOLIDAYS`/`HOL_KO_DYN`
// and its `isHol`/`holName` readers (the golden oracle injects those maps per
// fixture; a map-owning service would break that). The service owns the
// network/cache lifecycle: gov-API fetch batching, wt4_gov_* caching with a
// 30-day TTL, failure cooldowns, Labour-Day injection, and the boot-time cache
// seed. When a fetch actually lands new data it calls onUpdate() — exactly
// where the old inline code called render().
//
// Module top level touches NO browser APIs (localStorage/DOMParser are only
// used inside functions), so Node test imports of export.js stay safe.
// ─────────────────────────────────────────────────────────────────────────────

import { TR } from '../translations.js';
import { pd, mkds } from '../core/dates.js';

const GOV_API_KEY = '924a3cd75530bcef9d2c22f449897f23360fd49af3e16b085a170277ec1840ac';
const GOV_API_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';

// Parse the government API XML response into {enObj, koObj}.
// The API returns <item> elements with <locdate> (YYYYMMDD) and <dateName>.
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
    enObj[ds] = dateName;
  });
  return {enObj, koObj};
}

// Translate a Korean holiday name using the given language's holidays map.
// Falls back to the original Korean name for unknown/irregular holidays.
export function translateHolidayName(ko, lang){
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

// Returns the cutoff date string (YYYY-MM-DD) for upcoming-holiday windows.
// Rule: end of current year, unless that's less than 6 months away — in which
// case 6 months from today (whichever is later).
export function upcomingHolCutoff() {
  const now = new Date();
  const endOfYear = new Date(now.getFullYear(), 11, 31); // Dec 31 this year
  const sixMonths = new Date(now.getFullYear(), now.getMonth() + 6, now.getDate());
  const cutoff = sixMonths > endOfYear ? sixMonths : endOfYear;
  return mkds(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate());
}

// The next `limit` holidays strictly after todayStr within the cutoff window,
// as {ds, diffDays} — the caller attaches display names (holName is app-side).
export function getUpcomingIn(holidays, todayStr, limit = 3) {
  const cutoff = upcomingHolCutoff();
  return Object.keys(holidays)
    .filter(ds => ds > todayStr && ds <= cutoff)
    .sort()
    .slice(0, limit)
    .map(ds => {
      const d = pd(ds);
      const diffMs = d - new Date(new Date().setHours(0,0,0,0));
      const diffDays = Math.round(diffMs / 86400000);
      return { ds, diffDays };
    });
}

// Snapshot of all gov-cached Korean holiday names across the relevant years
// (+ the fixed Labour Day injection) — export.js's report-side holiday map,
// read fresh from wt4_gov_* on every call.
export function govCacheSnapshot() {
  const hols = {};
  const curY = new Date().getFullYear();
  for (let yr = curY - 3; yr <= curY + 2; yr++) {
    try {
      const raw = localStorage.getItem('wt4_gov_' + yr);
      if (raw) {
        const { ko } = JSON.parse(raw);
        if (ko) Object.assign(hols, ko);
      }
    } catch (e) {}
    // Labour Day
    hols[`${yr}-05-01`] = '근로자의 날';
  }
  return hols;
}

// ── The service — fills the maps the app owns ────────────────────────────────
export function createHolidayService({ holidays, holidaysKo, onUpdate }){
  const FETCHING = new Set();     // years in-flight — prevents duplicate fetches
  const FAIL_UNTIL = new Map();   // year → timestamp; back off after failures
  let loading = false;

  // May 1st — Labour Day (근로자의 날) is under a separate act, not in the gov
  // API. Always inject it manually for every year we load.
  function applyFixedHolidays(years){
    years.forEach(y => {
      holidays[`${y}-05-01`]   = 'Labour Day';
      holidaysKo[`${y}-05-01`] = '근로자의 날';
    });
  }

  // Fetch all 12 months of a year from the gov API (batched to avoid 429s).
  async function fetchHolidaysForYear(year){
    if(FETCHING.has(year)) return false;
    const cacheKey = 'wt4_gov_' + year;
    const cached = localStorage.getItem(cacheKey);
    if(cached){
      try{
        const {en, ko} = JSON.parse(cached);
        Object.assign(holidays, en);
        Object.assign(holidaysKo, ko);
        return false; // already had it — no new data, no re-render needed
      }catch(e){}
    }
    FETCHING.add(year);
    try{
      // 3 months at a time with a small gap — well within typical rate limits.
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
        if(i + 3 < months.length) await new Promise(r => setTimeout(r, 120));
      }
      const gotData = Object.keys(enObj).length > 0 || Object.keys(koObj).length > 0;
      if(gotData){
        Object.assign(holidays, enObj);
        Object.assign(holidaysKo, koObj);
        localStorage.setItem(cacheKey, JSON.stringify({en:enObj, ko:koObj, fetchedAt: Date.now()}));
        FAIL_UNTIL.delete(year);
        applyFixedHolidays([year]);
        return true;
      }
      // No data: back off — longer when it was a network failure (offline).
      const cooldown = anyNetworkError ? 5*60*1000 : 60*1000;
      FAIL_UNTIL.set(year, Date.now() + cooldown);
      return false;
    }catch(e){
      console.warn('Gov holiday fetch failed for', year, e.message);
      FAIL_UNTIL.set(year, Date.now() + 5*60*1000);
      return false;
    }finally{
      FETCHING.delete(year);
    }
  }

  // Seed from cache immediately on startup (zero network, zero flicker); also
  // clears old nager.at cache keys.
  function seedFromCache(){
    const y = new Date().getFullYear();
    for(let yr = y-1; yr <= y+2; yr++){
      localStorage.removeItem('wt4_hol_'+yr);
      localStorage.removeItem('wt4_hol_ko_'+yr);
      const cached = localStorage.getItem('wt4_gov_'+yr);
      if(cached){
        try{
          const {en, ko} = JSON.parse(cached);
          Object.assign(holidays, en);
          Object.assign(holidaysKo, ko);
        }catch(e){}
      }
    }
    applyFixedHolidays([y-1, y, y+1, y+2]);
  }

  // Ensure the given years are loaded; fetches missing/stale ones async and
  // calls onUpdate() ONLY when new data actually arrived (a failed attempt
  // must not retrigger render → fetch → render).
  async function ensureYears(years){
    applyFixedHolidays(years);
    // Don't hammer the network when offline — fixed holidays are already
    // applied and the fetch would just fail 12×/year on every render.
    if(typeof navigator!=='undefined' && navigator.onLine===false) return;
    const now = Date.now();
    const missing = years.filter(y => {
      if(FETCHING.has(y)) return false;              // already being fetched
      const failUntil = FAIL_UNTIL.get(y) || 0;
      if(now < failUntil) return false;              // recently failed — back off
      const raw = localStorage.getItem('wt4_gov_'+y);
      if(!raw) return true;
      try{
        const {fetchedAt} = JSON.parse(raw);
        const thirtyDays = 30 * 24 * 3600 * 1000;
        return (now - (fetchedAt||0)) > thirtyDays;
      }catch(e){ return true; }
    });
    if(!missing.length) return;
    loading = true;
    const results = await Promise.all(missing.map(fetchHolidaysForYear));
    loading = false;
    if(results.some(Boolean)) onUpdate();
  }

  function prefetch(){
    const y = new Date().getFullYear();
    ensureYears([y-1, y, y+1, y+2]);
  }

  return { seedFromCache, ensureYears, prefetch };
}
