// ─────────────────────────────────────────────────────────────────────────────
// core/holidays.js
// Korean public-holiday data + API client.
//
// Extracted from the top of app.js, where the gov-API fetch/cache/retry logic
// sat interleaved with view code. This module owns ONLY the data concern:
//   • the in-memory HOLIDAYS / HOL_KO_DYN maps
//   • seeding them from localStorage cache (synchronous, flicker-free)
//   • fetching missing years from the government open-data API (batched, with
//     rate-limit backoff and a failure-cooldown so render loops can't storm it)
//   • presence/name accessors the rest of the app reads
//
// It does NOT build any UI and does NOT import app.js. When freshly-fetched data
// arrives it calls an injected onData() callback (app.js passes render()), so
// there's no circular dependency between the data layer and the view layer.
// ─────────────────────────────────────────────────────────────────────────────

import { LS } from './constants.js';
import { mkds, pd, today } from './datetime.js';
import { TR } from '../translations.js';

const GOV_API_KEY  = '924a3cd75530bcef9d2c22f449897f23360fd49af3e16b085a170277ec1840ac';
const GOV_API_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';

// "YYYY-MM-DD" → name maps. HOLIDAYS doubles as the presence set for isHol().
const HOLIDAYS   = {};   // → English/Korean name (used only as a presence-check value)
const HOL_KO_DYN = {};   // → Korean name (dateName from the API), source of truth

let HOL_LOADING = false;
const HOL_FETCHING   = new Set(); // years currently in-flight — dedupes concurrent fetches
const HOL_FAIL_UNTIL = new Map();  // year → timestamp; don't retry a failed year until then

// Callback fired when a fetch brings in NEW data (app.js wires this to render()).
let _onData = () => {};
export function setOnData(fn) { _onData = typeof fn === 'function' ? fn : (() => {}); }

// ── Accessors ────────────────────────────────────────────────────────────────
export function isHol(s) { return !!HOLIDAYS[s]; }
export function holidayKo(s) { return HOL_KO_DYN[s]; }
export function holidayNameFallback(s) { return HOLIDAYS[s] || s; }
export function allHolidayKeys() { return Object.keys(HOLIDAYS); }
export function isHolLoading() { return HOL_LOADING; }

// Translate a raw Korean holiday name into `lang`, falling back to Korean for
// unknown/irregular names. Shared by the calendar and the exported reports.
export function translateHolidayName(ko, lang) {
  const map = TR[lang]?.holidays;
  if (!map) return ko;
  if (map[ko]) return map[ko];
  for (const [k, v] of Object.entries(map)) {
    if (ko.includes(k)) return v;
  }
  return ko;
}

// ── Fixed holidays not in the gov API ────────────────────────────────────────
// May 1st — Labour Day (근로자의 날) is under a separate act. Inject it manually.
function applyFixedHolidays(years) {
  years.forEach(y => {
    HOLIDAYS[`${y}-05-01`]   = 'Labour Day';
    HOL_KO_DYN[`${y}-05-01`] = '근로자의 날';
  });
}

// Parse the government XML response into { enObj, koObj }.
function parseGovXML(xmlText) {
  const enObj = {}, koObj = {};
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const errMsg = doc.querySelector('returnReasonCode,errMsg');
  if (errMsg && errMsg.textContent !== '00') {
    console.warn('Gov API error:', errMsg.textContent);
    return { enObj, koObj };
  }
  const items = doc.querySelectorAll('item');
  items.forEach(item => {
    const locdate  = item.querySelector('locdate')?.textContent?.trim();
    const dateName = item.querySelector('dateName')?.textContent?.trim();
    const isHoliday = item.querySelector('isHoliday')?.textContent?.trim();
    if (!locdate || !dateName || isHoliday === 'N') return;
    const ds = `${locdate.slice(0,4)}-${locdate.slice(4,6)}-${locdate.slice(6,8)}`;
    koObj[ds] = dateName;
    enObj[ds] = dateName; // presence-check value; display translation is holName()'s job
  });
  return { enObj, koObj };
}

// Fetch all 12 months of a year (batched 3-at-a-time to avoid 429s).
async function fetchHolidaysForYear(year) {
  if (HOL_FETCHING.has(year)) return false;
  const cacheKey = LS.govPrefix + year;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const { en, ko } = JSON.parse(cached);
      Object.assign(HOLIDAYS, en);
      Object.assign(HOL_KO_DYN, ko);
      return false; // already had it
    } catch (e) {}
  }
  HOL_FETCHING.add(year);
  try {
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
    const enObj = {}, koObj = {};
    let anyNetworkError = false;
    for (let i = 0; i < months.length; i += 3) {
      const batch = months.slice(i, i + 3);
      const results = await Promise.all(batch.map(async mm => {
        const url = `${GOV_API_BASE}?serviceKey=${GOV_API_KEY}&solYear=${year}&solMonth=${mm}&numOfRows=20&_type=xml`;
        try {
          const res = await fetch(url);
          if (!res.ok) {
            if (res.status === 429) console.warn('[holidays] Rate limited for', year, mm, '— will retry later');
            return { enObj: {}, koObj: {} };
          }
          return parseGovXML(await res.text());
        } catch (err) {
          anyNetworkError = true;
          return { enObj: {}, koObj: {} };
        }
      }));
      results.forEach(({ enObj: e, koObj: k }) => { Object.assign(enObj, e); Object.assign(koObj, k); });
      if (i + 3 < months.length) await new Promise(r => setTimeout(r, 120));
    }
    const gotData = Object.keys(enObj).length > 0 || Object.keys(koObj).length > 0;
    if (gotData) {
      Object.assign(HOLIDAYS, enObj);
      Object.assign(HOL_KO_DYN, koObj);
      localStorage.setItem(cacheKey, JSON.stringify({ en: enObj, ko: koObj, fetchedAt: Date.now() }));
      HOL_FAIL_UNTIL.delete(year);
      applyFixedHolidays([year]);
      return true;
    }
    // No data: back off (longer when it looked like an offline failure).
    const cooldown = anyNetworkError ? 5 * 60 * 1000 : 60 * 1000;
    HOL_FAIL_UNTIL.set(year, Date.now() + cooldown);
    return false;
  } catch (e) {
    console.warn('Gov holiday fetch failed for', year, e.message);
    HOL_FAIL_UNTIL.set(year, Date.now() + 5 * 60 * 1000);
    return false;
  } finally {
    HOL_FETCHING.delete(year);
  }
}

// Seed from cache immediately on startup (zero network, zero flicker).
// Call this once at module import time from app.js.
export function seedFromCache() {
  const y = new Date().getFullYear();
  for (let yr = y - 1; yr <= y + 2; yr++) {
    // Clear stale nager.at-era cache entries if still present.
    localStorage.removeItem(LS.holPrefix + yr);
    localStorage.removeItem(LS.holKoPrefix + yr);
    const cached = localStorage.getItem(LS.govPrefix + yr);
    if (cached) {
      try {
        const { en, ko } = JSON.parse(cached);
        Object.assign(HOLIDAYS, en);
        Object.assign(HOL_KO_DYN, ko);
      } catch (e) {}
    }
  }
  applyFixedHolidays([y - 1, y, y + 1, y + 2]);
}

// Ensure holidays for `years` are loaded; fetch missing years async.
// Fires onData() only if a fetch actually brought in new data (never on a failed
// offline attempt — otherwise render → ensure → fetch → render would loop).
export async function ensureHolidays(years) {
  applyFixedHolidays(years);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const now = Date.now();
  const missing = years.filter(y => {
    if (HOL_FETCHING.has(y)) return false;
    const failUntil = HOL_FAIL_UNTIL.get(y) || 0;
    if (now < failUntil) return false;
    const raw = localStorage.getItem(LS.govPrefix + y);
    if (!raw) return true;
    try {
      const { fetchedAt } = JSON.parse(raw);
      const thirtyDays = 30 * 24 * 3600 * 1000;
      return (now - (fetchedAt || 0)) > thirtyDays;
    } catch (e) { return true; }
  });
  if (!missing.length) return;
  HOL_LOADING = true;
  const results = await Promise.all(missing.map(fetchHolidaysForYear));
  HOL_LOADING = false;
  if (results.some(Boolean)) _onData();
}

// Background prefetch on startup.
export function prefetchHolidays() {
  const y = new Date().getFullYear();
  ensureHolidays([y - 1, y, y + 1, y + 2]);
}

// ── Upcoming-holiday helpers (data only; UI lives in app.js) ──────────────────
// Cutoff for "upcoming" windows: end of the current year, or 6 months out,
// whichever is later.
export function upcomingHolCutoff() {
  const now = new Date();
  const endOfYear = new Date(now.getFullYear(), 11, 31);
  const sixMonths = new Date(now.getFullYear(), now.getMonth() + 6, now.getDate());
  const cutoff = sixMonths > endOfYear ? sixMonths : endOfYear;
  return mkds(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate());
}

// Next `limit` holidays strictly after today. `nameOf(ds)` is injected so the
// data layer stays out of language/display concerns.
export function getUpcomingHolidays(limit = 3, nameOf = holidayNameFallback) {
  const td = today();
  const cutoff = upcomingHolCutoff();
  return allHolidayKeys()
    .filter(ds => ds > td && ds <= cutoff)
    .sort()
    .slice(0, limit)
    .map(ds => {
      const d = pd(ds);
      const diffMs = d - new Date(new Date().setHours(0, 0, 0, 0));
      const diffDays = Math.round(diffMs / 86400000);
      return { ds, name: nameOf(ds), diffDays };
    });
}
