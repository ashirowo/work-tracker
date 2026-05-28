// ── Dynamic Korean Public Holidays ───────────────────────────────────────────
// Source: data.go.kr — Ministry of the Interior and Safety official holiday API.
// Includes all public holidays AND substitute holidays (대체공휴일) correctly.
// Cache key prefix changed to 'wt4_gov_' to avoid conflicts with old nager.at cache.

const GOV_API_KEY = '924a3cd75530bcef9d2c22f449897f23360fd49af3e16b085a170277ec1840ac';
const GOV_API_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';

let HOLIDAYS = {};    // "YYYY-MM-DD" → English name
let HOL_KO_DYN = {};  // "YYYY-MM-DD" → Korean name (dateName from API)
let HOL_LOADING = false;

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
  try{
    // Fetch all 12 months in parallel
    const months = Array.from({length:12}, (_,i) => String(i+1).padStart(2,'0'));
    const results = await Promise.all(months.map(async mm => {
      const url = `${GOV_API_BASE}?serviceKey=${GOV_API_KEY}&solYear=${year}&solMonth=${mm}&numOfRows=20&_type=xml`;
      const res = await fetch(url);
      if(!res.ok) return {enObj:{}, koObj:{}};
      const xml = await res.text();
      return parseGovXML(xml);
    }));
    const enObj = {}, koObj = {};
    results.forEach(({enObj:e, koObj:k}) => {
      Object.assign(enObj, e);
      Object.assign(koObj, k);
    });
    Object.assign(HOLIDAYS, enObj);
    Object.assign(HOL_KO_DYN, koObj);
    // Cache the full year — also store timestamp so we can refresh annually
    localStorage.setItem(cacheKey, JSON.stringify({en:enObj, ko:koObj, fetchedAt: Date.now()}));
    applyFixedHolidays([year]);
  }catch(e){
    console.warn('Gov holiday fetch failed for', year, e.message);
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
  // A year needs refresh if: not cached, or cached data is over 30 days old
  const missing = years.filter(y => {
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

const TR={
en:{
  appTitle:"Work Hour Tracker",thisWeek:"This week",dayShift:"Day",nightShift:"Night",
  tabCal:"Calendar",tabLogs:"Records",tabSet:"Settings",
  statDays:"Days",statHours:"Hours",statNet:"Net Pay (after 3.3% tax)",
  calHint:"Built by Ashiro at 3AM. 💻",
  shiftHint:"Click a week button to toggle ☀ Day / ☾ Night. All following weeks auto-alternate.",
  logTitle:"Work Records",logNone:"No records yet.",logTotal:"Total (net)",logEdit:"Edit",
  setTitle:"Settings",wageLabel:"Hourly wage",wageDefault:"Default: ₩10,320",
  savWage:"Save wage",wageSaved:"Wage saved — all records recalculated.",rulesTitle:"Wage Calculation Rules",
  cancel:"Cancel",del:"Delete",save:"Save",
  regHrs:"Regular hours",otHrs:"Overtime hours",otHint:"(0 if none)",
  sunAuto:"All weekdays this week are logged — Sunday is automatically credited 8 hours.",
  sunNotYet:"Sunday auto-credits 8h once all Mon–Fri of this week are logged.",
  sunWorkedInfo:"If you also worked on this Sunday, enter your hours below (calculated like Saturday).",
  holInfo:"Public holiday — 8 hours are always auto-credited. If you worked overtime, enter those hours below.",
  holOtLabel:"Overtime hours worked on this holiday:",
  gross:"Gross",taxLine:"Tax (3.3%)",net:"Net pay",eff:"Effective hours",rateLabel:"Rate",
  mn:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
  dn:["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],
  dh:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],
  workedH:"h worked",
  nDay:r=>`Regular (day): ${r}h`,
  nDayOT:x=>`Overtime: ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nNight:r=>`Regular (night): ${r}h → ${nightWeekdayEff(r).toFixed(2)}h effective`,
  nNightOT:x=>`Overtime: ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nSatDay:r=>`Saturday (day): ${r}h → ${+(r/8*12).toFixed(2)}h effective`,
  nSatDayOT:x=>`Overtime: ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nSatNight:r=>`Saturday (night): ${r}h → ${satNightEff(r).toFixed(2)}h effective`,
  nSatNightOT:x=>`Overtime: ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nHolDay:r=>`Holiday worked (day): ${r}h → ${+(r/8*12).toFixed(2)}h effective`,
  nHolNight:r=>`Holiday worked (night): ${r}h → ${satNightEff(r).toFixed(2)}h effective`,
  nHolDayOT:x=>`Overtime: ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nHolNightOT:x=>`Overtime: ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nSunDay:r=>`Sunday worked (day): ${r}h → ${+(r/8*12).toFixed(2)}h effective`,
  nSunNight:r=>`Sunday worked (night): ${r}h → ${satNightEff(r).toFixed(2)}h effective`,
  nSunDayOT:x=>`Overtime: ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nSunNightOT:x=>`Overtime: ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nHolBase:"Holiday base: 8h auto-credited",
  nHolOTday:x=>`Holiday OT (day): ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nHolOTnight:x=>`Holiday OT (night): ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nSun:"Sunday auto-credit: 8h",
  rules:[
    ["☀ Day — Weekday","Regular 8h base paid as 8h + overtime × 1.5"],
    ["☀ Day — Saturday","Regular 8h → 12h effective + overtime × 1.5"],
    ["☾ Night — Weekday","Regular 8h → 9.16h effective + overtime × 2"],
    ["☾ Night — Saturday","Regular 8h → 13.16h effective + overtime × 2"],
    ["● Sunday","Auto 8h credited when all Mon–Fri that week are logged"],
    ["🔴 Holiday (absent)","Auto 8h credited — no action needed"],
    ["🔴 Holiday (worked OT)","8h auto-credited + overtime hours × shift multiplier"],
    ["💰 Tax","3.3% deducted from all gross pay"],
  ]
},
ko:{
  appTitle:"근무 시간 관리",thisWeek:"이번 주",dayShift:"주간",nightShift:"야간",
  tabCal:"캘린더",tabLogs:"기록",tabSet:"설정",
  statDays:"근무일",statHours:"총 시간",statNet:"실수령액 (3.3% 공제)",
  calHint:"아시로가 새벽 3시에 제작함. 💻",
  shiftHint:"주 버튼 클릭으로 ☀ 주간 / ☾ 야간 전환. 이후 모든 주 자동 교체.",
  logTitle:"근무 기록",logNone:"기록된 근무가 없습니다.",logTotal:"합계 (실수령)",logEdit:"수정",
  setTitle:"설정",wageLabel:"시급",wageDefault:"기본: ₩10,320",
  savWage:"시급 저장",wageSaved:"시급이 저장되고 모든 기록이 재계산되었습니다.",rulesTitle:"급여 계산 규칙",
  cancel:"취소",del:"삭제",save:"저장",
  regHrs:"기본 시간",otHrs:"초과 시간",otHint:"(없으면 0)",
  sunAuto:"이번 주 평일이 모두 기록되어 일요일 8시간이 자동 인정됩니다.",
  sunNotYet:"월~금 전부 기록되면 일요일 8시간이 자동 인정됩니다.",
  sunWorkedInfo:"이번 일요일에 근무하셨다면 시간을 입력하세요 (토요일과 동일하게 계산됩니다).",
  holInfo:"공휴일 — 항상 8시간이 자동 인정됩니다. 추가로 근무했다면 초과 시간을 입력하세요.",
  holOtLabel:"공휴일 초과 근무 시간:",
  gross:"총액",taxLine:"공제 (3.3%)",net:"실수령액",eff:"환산 시간",rateLabel:"시급",
  mn:["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"],
  dn:["일요일","월요일","화요일","수요일","목요일","금요일","토요일"],
  dh:["일","월","화","수","목","금","토"],
  workedH:"h 근무",
  nDay:r=>`기본 (주간): ${r}h`,
  nDayOT:x=>`초과: ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nNight:r=>`기본 (야간): ${r}h → ${nightWeekdayEff(r).toFixed(2)}h 환산`,
  nNightOT:x=>`초과: ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nSatDay:r=>`토요일 (주간): ${r}h → ${+(r/8*12).toFixed(2)}h 환산`,
  nSatDayOT:x=>`초과: ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nSatNight:r=>`토요일 (야간): ${r}h → ${satNightEff(r).toFixed(2)}h 환산`,
  nSatNightOT:x=>`초과: ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nHolDay:r=>`공휴일 근무 (주간): ${r}h → ${+(r/8*12).toFixed(2)}h 환산`,
  nHolNight:r=>`공휴일 근무 (야간): ${r}h → ${satNightEff(r).toFixed(2)}h 환산`,
  nHolDayOT:x=>`초과: ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nHolNightOT:x=>`초과: ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nSunDay:r=>`일요일 근무 (주간): ${r}h → ${+(r/8*12).toFixed(2)}h 환산`,
  nSunNight:r=>`일요일 근무 (야간): ${r}h → ${satNightEff(r).toFixed(2)}h 환산`,
  nSunDayOT:x=>`초과: ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nSunNightOT:x=>`초과: ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nHolBase:"공휴일 기본: 8시간 자동 인정",
  nHolOTday:x=>`공휴일 초과 (주간): ${x}h × 1.5 = ${+(x*1.5).toFixed(2)}h`,
  nHolOTnight:x=>`공휴일 초과 (야간): ${x}h × 2 = ${+(x*2).toFixed(2)}h`,
  nSun:"일요일 자동 인정: 8h",
  rules:[
    ["☀ 주간 — 평일","기본 8h → 8h 인정 + 초과 × 1.5"],
    ["☀ 주간 — 토요일","기본 8h → 12h 인정 + 초과 × 1.5"],
    ["☾ 야간 — 평일","기본 8h → 9.16h 인정 + 초과 × 2"],
    ["☾ 야간 — 토요일","기본 8h → 13.16h 인정 + 초과 × 2"],
    ["● 일요일","해당 주 월~금 전체 기록 시 자동 8h 인정"],
    ["🔴 공휴일 (미출근)","자동 8h 인정 — 별도 입력 불필요"],
    ["🔴 공휴일 (초과 근무)","8h 자동 인정 + 초과 시간 × 교대 배수"],
    ["💰 세금","전체 급여의 3.3% 공제"],
  ]
},
id:{
  appTitle:"Pelacak Jam Kerja",thisWeek:"Minggu ini",dayShift:"Siang",nightShift:"Malam",
  tabCal:"Kalender",tabLogs:"Riwayat",tabSet:"Pengaturan",
  statDays:"Hari Kerja",statHours:"Total Jam",statNet:"Gaji Bersih (pajak 3,3%)",
  calHint:"Dibuat oleh Ashref jam 3 pagi. 💻",
  shiftHint:"Klik tombol minggu untuk beralih ☀ Siang / ☾ Malam. Minggu berikutnya otomatis bergantian.",
  logTitle:"Riwayat Kerja",logNone:"Belum ada catatan.",logTotal:"Total (bersih)",logEdit:"Edit",
  setTitle:"Pengaturan",wageLabel:"Upah per jam",wageDefault:"Default: ₩10.320",
  savWage:"Simpan upah",wageSaved:"Upah disimpan — semua catatan dihitung ulang.",rulesTitle:"Aturan Perhitungan Upah",
  cancel:"Batal",del:"Hapus",save:"Simpan",
  regHrs:"Jam reguler",otHrs:"Jam lembur",otHint:"(0 jika tidak ada)",
  sunAuto:"Semua hari kerja minggu ini tercatat — Minggu dikreditkan 8 jam otomatis.",
  sunNotYet:"Minggu dikreditkan 8j otomatis setelah semua Sen–Jum tercatat.",
  sunWorkedInfo:"Jika Anda juga bekerja hari Minggu ini, isi jam kerja di bawah (dihitung seperti Sabtu).",
  holInfo:"Hari libur — 8 jam selalu dikreditkan otomatis. Jika lembur, isi jam lembur di bawah.",
  holOtLabel:"Jam lembur saat hari libur:",
  gross:"Kotor",taxLine:"Pajak (3,3%)",net:"Gaji bersih",eff:"Jam efektif",rateLabel:"Upah/jam",
  mn:["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"],
  dn:["Minggu","Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"],
  dh:["Min","Sen","Sel","Rab","Kam","Jum","Sab"],
  workedH:"j kerja",
  nDay:r=>`Reguler (siang): ${r}j`,
  nDayOT:x=>`Lembur: ${x}j × 1,5 = ${+(x*1.5).toFixed(2)}j`,
  nNight:r=>`Reguler (malam): ${r}j → ${nightWeekdayEff(r).toFixed(2)}j efektif`,
  nNightOT:x=>`Lembur: ${x}j × 2 = ${+(x*2).toFixed(2)}j`,
  nSatDay:r=>`Sabtu (siang): ${r}j → ${+(r/8*12).toFixed(2)}j efektif`,
  nSatDayOT:x=>`Lembur: ${x}j × 1,5 = ${+(x*1.5).toFixed(2)}j`,
  nSatNight:r=>`Sabtu (malam): ${r}j → ${satNightEff(r).toFixed(2)}j efektif`,
  nSatNightOT:x=>`Lembur: ${x}j × 2 = ${+(x*2).toFixed(2)}j`,
  nHolDay:r=>`Libur bekerja (siang): ${r}j → ${+(r/8*12).toFixed(2)}j efektif`,
  nHolNight:r=>`Libur bekerja (malam): ${r}j → ${satNightEff(r).toFixed(2)}j efektif`,
  nHolDayOT:x=>`Lembur: ${x}j × 1,5 = ${+(x*1.5).toFixed(2)}j`,
  nHolNightOT:x=>`Lembur: ${x}j × 2 = ${+(x*2).toFixed(2)}j`,
  nSunDay:r=>`Minggu bekerja (siang): ${r}j → ${+(r/8*12).toFixed(2)}j efektif`,
  nSunNight:r=>`Minggu bekerja (malam): ${r}j → ${satNightEff(r).toFixed(2)}j efektif`,
  nSunDayOT:x=>`Lembur: ${x}j × 1,5 = ${+(x*1.5).toFixed(2)}j`,
  nSunNightOT:x=>`Lembur: ${x}j × 2 = ${+(x*2).toFixed(2)}j`,
  nHolBase:"Dasar libur: 8j otomatis",
  nHolOTday:x=>`Lembur libur (siang): ${x}j × 1,5 = ${+(x*1.5).toFixed(2)}j`,
  nHolOTnight:x=>`Lembur libur (malam): ${x}j × 2 = ${+(x*2).toFixed(2)}j`,
  nSun:"Kredit otomatis Minggu: 8j",
  rules:[
    ["☀ Siang — Hari Kerja","Reguler 8j → 8j + lembur × 1,5"],
    ["☀ Siang — Sabtu","Reguler 8j → 12j efektif + lembur × 1,5"],
    ["☾ Malam — Hari Kerja","Reguler 8j → 9,16j efektif + lembur × 2"],
    ["☾ Malam — Sabtu","Reguler 8j → 13,16j efektif + lembur × 2"],
    ["● Minggu","Otomatis 8j jika semua Sen–Jum minggu itu tercatat"],
    ["🔴 Libur (tidak masuk)","Otomatis 8j — tidak perlu input"],
    ["🔴 Libur (lembur)","8j otomatis + jam lembur × pengganda shift"],
    ["💰 Pajak","3,3% dipotong dari semua gaji kotor"],
  ]
}
};

const DEFAULT_WAGE=10320,TAX=0.033;
function ld(k,d){try{const v=localStorage.getItem(k);return v!==null?JSON.parse(v):d;}catch{return d;}}
function sv(k,v){localStorage.setItem(k,JSON.stringify(v));}
function pad(n){return String(n).padStart(2,'0');}
function mkds(y,m,d){return`${y}-${pad(m+1)}-${pad(d)}`;}
function pd(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
function today(){const d=new Date();return mkds(d.getFullYear(),d.getMonth(),d.getDate());}
function dowOf(s){return pd(s).getDay();}
function getLogs(){return ld('wt4_logs',{});}
function saveLogs(l){sv('wt4_logs',l);}
function getShifts(){return ld('wt4_shifts',{});}
function saveShifts(s){sv('wt4_shifts',s);}
function getWage(){return ld('wt4_wage',DEFAULT_WAGE);}
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
// Night weekday formula: H<=5.68 → H as-is; H>5.68 → 5.68+(H-5.68)*1.5
function nightWeekdayEff(h){
  return h<=5.68 ? h : +(5.68+(h-5.68)*1.5).toFixed(2);
}
// Sat night formula: H<=5.68 → H*1.5; H>5.68 → 5.68*1.5+(H-5.68)*2
function satNightEff(h){
  return h<=5.68 ? +(h*1.5).toFixed(2) : +(5.68*1.5+(h-5.68)*2).toFixed(2);
}
// Sat day: linear scale 8h→12h
function satDayEff(h){ return +(h/8*12).toFixed(2); }

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

// Gross for a date including auto-credits (for stats)
function autoGross(ds,wage){
  const logs=getLogs();
  if(logs[ds])return logs[ds].gross||0;
  if(isHol(ds)&&!logs[ds]&&ds<=today())return Math.round(8*wage); // holiday (incl. holiday Sundays)
  if(isSun(ds)&&!isHol(ds)&&ds<=today()&&allWeekdaysLogged(ds))return Math.round(8*wage); // plain Sunday
  return 0;
}
function autoEff(ds){
  const logs=getLogs();
  if(logs[ds])return logs[ds].eff||0;
  if(isHol(ds)&&!logs[ds]&&ds<=today())return 8; // holiday (incl. holiday Sundays)
  if(isSun(ds)&&!isHol(ds)&&ds<=today()&&allWeekdaysLogged(ds))return 8; // plain Sunday
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
  return`<div class="hdr">
    <div>
      <div class="hdr-title">${t('appTitle')}</div>
      <div class="hdr-sub">${t('thisWeek')}: ${shift==='day'?'☀ '+t('dayShift'):'☾ '+t('nightShift')}</div>
    </div>
    <div class="hdr-right">
      <div class="lang-group">${['en','ko','id'].map(l=>`<button class="lang-btn${S.lang===l?' on':''}" data-lang="${l}">${l==='en'?'EN':l==='ko'?'한국':'ID'}</button>`).join('')}</div>
      <button class="theme-btn" id="theme-toggle">${S.theme==='dark'?'☀':'🌙'}</button>
    </div>
  </div>
  ${buildStats()}
  <div class="tab-row">
    <button class="tab${S.tab==='calendar'?' on':''}" data-tab="calendar">${t('tabCal')}</button>
    <button class="tab${S.tab==='logs'?' on':''}" data-tab="logs">${t('tabLogs')}</button>
    <button class="tab${S.tab==='settings'?' on':''}" data-tab="settings">${t('tabSet')}</button>
  </div>
  ${S.tab==='calendar'?buildCal():S.tab==='logs'?buildLogs():buildSettings()}`;
}

function buildStats(){
  const wage=getWage(),daysInM=new Date(S.calY,S.calM+1,0).getDate();
  let days=0,hrs=0,gross=0;
  const logs=getLogs();
  for(let d=1;d<=daysInM;d++){
    const ds=mkds(S.calY,S.calM,d);
    const g=autoGross(ds,wage),e=autoEff(ds);
    if(g>0||(logs[ds]&&logs[ds].gross===0)){days++;gross+=g;hrs+=e;}
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

function buildLogs(){
  const logs=getLogs(),sorted=Object.entries(logs).sort((a,b)=>b[0].localeCompare(a[0]));
  if(!sorted.length)return`<div class="card"><div class="empty-st">${t('logNone')}</div></div>`;
  const dn=t('dn');
  const items=sorted.map(([ds,l])=>{
    const dw=dowOf(ds),hol=isHol(ds),sh=l.shiftOverride||shiftFor(ds);
    const r=l.regHrs!==undefined?l.regHrs:8,o=l.otHrs!==undefined?l.otHrs:0;
    return`<div class="log-item">
      <div>
        <div class="log-d">${ds} (${dn[dw].slice(0,3)}) ${hol?`<span style="color:var(--danger);font-size:11px;">● ${holName(ds)}</span>`:''}</div>
        <div class="log-sub">${sh==='day'?'☀':'☾'} ${sh==='day'?t('dayShift'):t('nightShift')}${l.shiftOverride?' ✎':''} · ${r}h reg${o>0?' + '+o+'h OT':''} · ${l.eff}h eff</div>
      </div>
      <div style="display:flex;align-items:center;">
        <div class="log-pay">₩${(l.net||0).toLocaleString()}</div>
        <span class="log-edit" data-date="${ds}">${t('logEdit')}</span>
      </div>
    </div>`;
  }).join('');
  const totalNet=sorted.reduce((a,[,l])=>a+(l.net||0),0);
  return`<div class="card">
    <div class="card-title">${t('logTitle')}</div>
    ${items}
    <div style="display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:0.5px solid var(--border);margin-top:4px;">
      <span style="font-weight:600;">${t('logTotal')}</span>
      <span style="font-size:18px;font-weight:700;color:var(--success);">₩${totalNet.toLocaleString()}</span>
    </div>
  </div>`;
}

function buildSettings(){
  const wage=getWage(),rules=t('rules');
  return`<div class="card">
    <div class="card-title">${t('setTitle')}</div>
    ${S.success?`<div class="success-banner">${S.success}</div>`:''}
    <div class="wage-row">
      <div>
        <div style="font-size:14px;font-weight:600;">${t('wageLabel')}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${t('wageDefault')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:7px;">
        <input class="wage-inp" id="wage-in" type="number" value="${wage}" min="0" step="100">
        <span style="font-size:13px;color:var(--text-muted);">₩</span>
      </div>
    </div>
    <button class="btn-pri" id="save-wage" style="width:100%;margin-top:14px;">${t('savWage')}</button>
  </div>
  <div class="card">
    <div class="card-title">${t('rulesTitle')}</div>
    <table class="rules-table">
      <thead><tr><th style="width:40%">Type</th><th>Rule</th></tr></thead>
      <tbody>${rules.map(([type,rule])=>`<tr><td><strong>${type}</strong></td><td>${rule}</td></tr>`).join('')}</tbody>
    </table>
  </div>`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function buildModal(){
  const{date,existing}=S.modal;
  const holDay=isHol(date),sun=isSun(date)&&!isHol(date),sat=isSat(date)&&!isHol(date);
  const weekShift=shiftFor(date);
  // Per-day shift: use saved override if editing, or state override, or week default
  const defShift=existing?.shiftOverride||weekShift;
  const shift=S.mShift!==undefined?S.mShift:defShift;
  const wage=getWage(),dn=t('dn'),dw=dowOf(date);
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
    </div>`;

  let bodyHTML='';
  if(sun){
    // Sunday: show auto-credit info; always allow worked hours input (same as holiday)
    const sunInfoCls=autoSunQual?'info-box':' info-box';
    bodyHTML=`<div class="info-box">${autoSunQual?t('sunAuto'):t('sunNotYet')}</div>
    <div class="info-box warn" style="margin-top:0;">${t('sunWorkedInfo')}</div>
    <div class="fg-row">
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
    <div class="fg-row">
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
    bodyHTML=`<div class="fg-row">
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
    const r=regIn?Math.min(parseFloat(regIn.value)||0,8):0;
    const o=otIn?parseFloat(otIn.value)||0:0;
    S.mReg=r;S.mOT=o;
    const prev=document.getElementById('m-preview');
    if(prev)prev.innerHTML=previewHTML(r,o,curShift());
  }
  if(regIn)regIn.addEventListener('input',upd);
  if(otIn)otIn.addEventListener('input',upd);

  function applyShiftToggle(newShift){
    S.mShift=newShift;
    // Update button styles
    const dBtn=document.getElementById('m-shift-day');
    const nBtn=document.getElementById('m-shift-night');
    if(dBtn){dBtn.className='shift-tog'+(newShift==='day'?' shift-tog-on-day':'');}
    if(nBtn){nBtn.className='shift-tog'+(newShift==='night'?' shift-tog-on-night':'');}
    upd();
  }
  const sdBtn=document.getElementById('m-shift-day');
  const snBtn=document.getElementById('m-shift-night');
  if(sdBtn)sdBtn.addEventListener('click',()=>applyShiftToggle('day'));
  if(snBtn)snBtn.addEventListener('click',()=>applyShiftToggle('night'));

  const saveBtn=document.getElementById('m-save');
  if(saveBtn)saveBtn.addEventListener('click',()=>{
    const r=regIn?Math.min(parseFloat(regIn.value)||0,8):0;
    const o=otIn?parseFloat(otIn.value)||0:0;
    const sh=curShift();
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
  document.getElementById('theme-toggle').addEventListener('click',()=>{
    S.theme=S.theme==='dark'?'light':'dark';sv('wt4_theme',S.theme);render();
  });
  document.querySelectorAll('[data-lang]').forEach(b=>b.addEventListener('click',()=>{
    S.lang=b.dataset.lang;sv('wt4_lang',S.lang);render();
  }));
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
  const sw=document.getElementById('save-wage');
  if(sw)sw.addEventListener('click',()=>{
    const w=parseInt(document.getElementById('wage-in').value);
    if(isNaN(w)||w<0)return;
    sv('wt4_wage',w);
    const logs=getLogs();
    Object.entries(logs).forEach(([s,l])=>{
      const r=l.regHrs!==undefined?l.regHrs:8,o=l.otHrs!==undefined?l.otHrs:0;
      const c=calcWage(s,r,o,w);
      logs[s]={...l,gross:c.gross,net:c.net,eff:c.eff};
    });
    saveLogs(logs);S.success=t('wageSaved');render();
  });
}

applyTheme();
// Seed cache into HOLIDAYS synchronously (already done above), then render.
// prefetchHolidays runs in the background and re-renders if new data arrives.
render();
prefetchHolidays();