// ─────────────────────────────────────────────────────────────────────────────
// export.js — CSV + PDF export for Work Hour Tracker
//
// HOW TO INTEGRATE:
//   1. Copy this file next to app.js / firebase.js.
//   2. In app.js, add this import at the top:
//        import { buildExportCard, wireExportCard } from './export.js';
//   3. In buildSettings(), paste this just before the Danger Zone card:
//        ${buildExportCard()}
//   4. In attachListeners() (inside the `if(S.tab==='settings')` block, or
//      at the end of attachListeners since it's always safe), add:
//        wireExportCard();
//
// DEPENDENCIES: none required up front — CSV is a plain Blob download with no
//   external libraries. PDF is generated as a real binary client-side; the
//   first time a user exports a PDF, jsPDF + html2canvas are lazy-loaded from
//   CDN (same pattern app.js uses for Chart.js) and cached by the service
//   worker afterward, so PDF export keeps working offline too.
// ─────────────────────────────────────────────────────────────────────────────

import { TR, nightWeekdayEff, satNightEff, satDayEff } from './translations.js';

// ── Re-use helpers already defined in app.js via a small shared-state bridge ──
// We read from localStorage directly (same keys as app.js) so this module is
// fully self-contained and doesn't need to import app.js internals.

function ld(k, d) {
  try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : d; } catch { return d; }
}
function pad(n) { return String(n).padStart(2, '0'); }
function mkds(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
function pd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function todayStr() { const d = new Date(); return mkds(d.getFullYear(), d.getMonth(), d.getDate()); }
function dowOf(s) { return pd(s).getDay(); }
function isSun(s) { return dowOf(s) === 0; }
function isSat(s) { return dowOf(s) === 6; }

function getLang() { return ld('wt4_lang', 'en'); }
function t(k, ...a) {
  const lang = getLang();
  const fn = TR[lang]?.[k] ?? TR.en?.[k];
  return typeof fn === 'function' ? fn(...a) : (fn || k);
}

function getLogs() { return ld('wt4_logs', {}); }
function getShifts() { return ld('wt4_shifts', {}); }
function getWages() { return ld('wt4_wages', [{ date: '2026-01-01', amount: 10320 }]); }
function getHolidays() {
  // Collect all gov-cached holiday data across relevant years
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
function getTaxRate() { return ld('wt4_tax_rate', 3.3); }
function isHolAuto() { return ld('wt4_hol_auto', true) !== false; }

// Translate a raw Korean holiday name into the current UI language, using the
// same TR[lang].holidays map app.js uses for the Calendar view. Without this,
// exported reports always showed holiday names in Korean regardless of the
// selected language — a gap that matters a lot once exports are meant to be
// genuinely multi-language.
function translateHolidayName(ko) {
  const map = TR[getLang()]?.holidays;
  if (!map || !ko) return ko;
  if (map[ko]) return map[ko];
  for (const [k, v] of Object.entries(map)) {
    if (ko.includes(k)) return v;
  }
  return ko; // unknown/irregular holiday — fall back to the Korean name
}

function wageFor(dateStr) {
  const wages = getWages();
  let active = 10320;
  for (const { date, amount } of wages) {
    if (date <= dateStr) active = amount;
    else break;
  }
  return active;
}

function getMonday(s) {
  const d = pd(s), day = d.getDay(), diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const m = new Date(d); m.setDate(diff);
  return mkds(m.getFullYear(), m.getMonth(), m.getDate());
}

function shiftFor(s) {
  const sh = getShifts(), ws = getMonday(s);
  const keys = Object.keys(sh).filter(k => k <= ws).sort();
  if (!keys.length) return 'day';
  const anchor = keys[keys.length - 1];
  const anchorShift = sh[anchor];
  if (keys.length >= 2 && sh[keys[keys.length - 2]] === anchorShift) return anchorShift;
  const msPerWeek = 7 * 24 * 3600 * 1000;
  const weeks = Math.round((pd(ws) - pd(anchor)) / msPerWeek);
  return weeks % 2 === 0 ? anchorShift : (anchorShift === 'day' ? 'night' : 'day');
}

function applyTax(g) { return Math.round(g * (1 - getTaxRate() / 100)); }

function calcWage(dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride, holidays) {
  const shift = shiftOverride || shiftFor(dateStr);
  const holDay = !!holidays[dateStr];
  const sun = isSun(dateStr) && !holDay;
  const sat = isSat(dateStr) && !holDay;
  const holCredit = holCreditOverride !== undefined ? holCreditOverride : isHolAuto();
  let eff = 0;

  if (shift === 'double') {
    const nightEff = +(satNightEff(8)).toFixed(2);
    const daySatEff = +(8 / 8 * 12).toFixed(2);
    if (sun || holDay) {
      const hasAutoBase = sun || (holDay && holCredit);
      eff = hasAutoBase ? +(8 + daySatEff + nightEff).toFixed(2) : +(daySatEff + nightEff).toFixed(2);
    } else if (sat) {
      eff = +(daySatEff + nightEff).toFixed(2);
    } else {
      eff = +(8 + nightEff).toFixed(2);
    }
    if (otHrs > 0) eff = +(eff + otHrs * 2).toFixed(2);
    const g = Math.round(eff * wage);
    return { gross: g, net: applyTax(g), eff };
  }

  if (sun) {
    eff = 8;
    if (regHrs > 0 || otHrs > 0) {
      const wEff = shift === 'day'
        ? +(satDayEff(regHrs) + (otHrs > 0 ? otHrs * 1.5 : 0)).toFixed(2)
        : +(satNightEff(regHrs) + (otHrs > 0 ? otHrs * 2 : 0)).toFixed(2);
      eff = +(8 + wEff).toFixed(2);
    }
    const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff };
  }

  if (holDay) {
    if (holCredit) eff = 8;
    if (regHrs > 0 || otHrs > 0) {
      const wEff = shift === 'day'
        ? +(satDayEff(regHrs) + (otHrs > 0 ? otHrs * 1.5 : 0)).toFixed(2)
        : +(satNightEff(regHrs) + (otHrs > 0 ? otHrs * 2 : 0)).toFixed(2);
      eff = +(eff + wEff).toFixed(2);
    }
    const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff };
  }

  if (sat) {
    eff = shift === 'day'
      ? +(satDayEff(regHrs) + (otHrs > 0 ? otHrs * 1.5 : 0)).toFixed(2)
      : +(satNightEff(regHrs) + (otHrs > 0 ? otHrs * 2 : 0)).toFixed(2);
    const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff };
  }

  if (shift === 'day') {
    eff = regHrs;
    if (otHrs > 0) eff = +(eff + otHrs * 1.5).toFixed(2);
  } else {
    eff = nightWeekdayEff(regHrs);
    if (otHrs > 0) eff = +(eff + otHrs * 2).toFixed(2);
  }
  const g = Math.round(eff * wage); return { gross: g, net: applyTax(g), eff };
}

// ── Determine which months have any data ──────────────────────────────────────
function monthsWithData() {
  const logs = getLogs();
  const today = todayStr();
  const set = new Set();

  const logDates = Object.keys(logs).sort();
  const earliestLogDate = logDates[0] || null;

  // From logs
  logDates.forEach(ds => {
    if (ds <= today) set.add(ds.slice(0, 7));
  });

  // Auto-credited holidays also produce data for a month — but never before
  // the user's own first logged day. getHolidays() generates entries for a
  // fixed window (curYear-3 .. curYear+2) regardless of when someone actually
  // started tracking, so without this bound a brand-new user would still see
  // export ranges stretching back to whichever years happen to have a
  // New Year's/Labour Day in that window.
  if (earliestLogDate && isHolAuto()) {
    const hols = getHolidays();
    Object.keys(hols).forEach(ds => {
      if (ds >= earliestLogDate && ds <= today) set.add(ds.slice(0, 7));
    });
  }

  return [...set].sort();
}

// ── Build rows for a date range ───────────────────────────────────────────────
function buildRows(fromYM, toYM) {
  const logs = getLogs();
  const holidays = getHolidays();
  const today = todayStr();
  const rows = [];

  // Auto-credit (holiday pay / perfect-attendance Sunday pay) should never
  // reach earlier than the user's own first logged day. Without this, a
  // holiday that happened before someone ever started tracking would still
  // show up as "earned" — e.g. starting on Jan 10 shouldn't auto-credit
  // Jan 1 just because it's a holiday that falls in the same month.
  const earliestLogDate = Object.keys(logs).sort()[0] || null;
  const startedBy = ds => earliestLogDate !== null && ds >= earliestLogDate;

  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);

  // Single loop — iterate months from fromYM through toYM inclusive.
  // Both m and tm are kept 0-based internally to avoid the off-by-one
  // that caused the previous dual-loop to process the final month twice.
  let y = fy, m = fm - 1;        // 0-based month counter
  const endM0 = tm - 1;          // 0-based month of toYM

  while (y < ty || (y === ty && m <= endM0)) {
    const daysInM = new Date(y, m + 1, 0).getDate();

    for (let d = 1; d <= daysInM; d++) {
      const ds = mkds(y, m, d);
      if (ds > today) break;

      const log = logs[ds];
      const isHol = !!holidays[ds];
      const sun = isSun(ds) && !isHol;
      const sat = isSat(ds) && !isHol;
      const wage = wageFor(ds);
      const shift = (log?.shiftOverride) || shiftFor(ds);
      const holCredit = log?.holCreditOverride !== undefined ? log.holCreditOverride : isHolAuto();

      let regHrs = 0, otHrs = 0, gross = 0, net = 0, eff = 0, type = '', autoCredit = false;

      if (log) {
        regHrs = log.regHrs !== undefined ? log.regHrs : (log.hrs || 0);
        otHrs  = log.otHrs  !== undefined ? log.otHrs  : 0;
        const c = calcWage(ds, regHrs, otHrs, wage, log.shiftOverride, log.holCreditOverride, holidays);
        gross = c.gross; net = c.net; eff = c.eff;
      } else if (isHol && holCredit && startedBy(ds)) {
        gross = Math.round(8 * wage); net = applyTax(gross); eff = 8; autoCredit = true;
      } else if (sun && startedBy(ds)) {
        const ws = getMonday(ds);
        let allLogged = true;
        for (let i = 0; i <= 4; i++) {
          const wd = new Date(pd(ws)); wd.setDate(wd.getDate() + i);
          const wds = mkds(wd.getFullYear(), wd.getMonth(), wd.getDate());
          if (!logs[wds] && !holidays[wds]) { allLogged = false; break; }
        }
        if (allLogged) { gross = Math.round(8 * wage); net = applyTax(gross); eff = 8; autoCredit = true; }
      }

      if (gross === 0 && !log) continue; // skip days with no earnings and no log entry

      if (shift === 'double') type = t('doubleShift');
      else if (isHol) type = t('exportLegendHoliday');
      else if (sun)   type = t('exportLegendSunday');
      else if (sat)   type = shift === 'day' ? `${t('exportLegendSaturday')} (${t('dayShift')})` : `${t('exportLegendSaturday')} (${t('nightShift')})`;
      else            type = shift === 'day' ? `${t('exportTypeWeekday')} (${t('dayShift')})` : `${t('exportTypeWeekday')} (${t('nightShift')})`;

      rows.push({
        date: ds,
        dayOfWeek: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dowOf(ds)],
        type,
        shift: shift === 'double' ? t('doubleShift') : shift === 'day' ? t('dayShift') : t('nightShift'),
        holiday: isHol ? translateHolidayName(holidays[ds] || '') : '',
        autoCredit,
        regHrs,
        otHrs,
        effHrs: eff,
        hourlyRate: wage,
        gross,
        taxAmt: gross - net,
        net,
      });
    }

    m++;
    if (m > 11) { m = 0; y++; }
  }

  return rows;
}

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCSV(fromYM, toYM) {
  const rows = buildRows(fromYM, toYM);
  if (!rows.length) { alert(t('exportNoData')); return; }

  const taxPct = getTaxRate();
  const headers = [
    t('exportColDate'), t('exportColDay'), t('exportColType'), t('exportColShift'),
    t('exportLegendHoliday'), 'Auto',
    t('exportColRegH'), t('exportColOTH'), t('exportColEffH'),
    `${t('exportColRate')} (₩)`, `${t('exportColGross')} (₩)`,
    `${t('exportColTax', taxPct)} (₩)`, `${t('exportColNet')} (₩)`
  ];

  const escape = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [
    headers.map(escape).join(','),
    ...rows.map(r => [
      r.date, r.dayOfWeek, r.type, r.shift, r.holiday,
      r.autoCredit ? 'AUTO' : '',
      r.regHrs, r.otHrs, r.effHrs,
      r.hourlyRate, r.gross, r.taxAmt, r.net
    ].map(escape).join(','))
  ];

  // Totals row
  const totGross = rows.reduce((s, r) => s + r.gross, 0);
  const totTax   = rows.reduce((s, r) => s + r.taxAmt, 0);
  const totNet   = rows.reduce((s, r) => s + r.net, 0);
  const totEff   = rows.reduce((s, r) => s + r.effHrs, 0);
  lines.push(['', '', '', '', '', t('exportTotal'), '', '', totEff.toFixed(2), '', totGross, totTax, totNet].map(escape).join(','));

  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `work-tracker-${fromYM}-to-${toYM}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── PDF export — real client-side PDF generation ─────────────────────────────
// This used to render a hidden iframe and call window.print(), relying on the
// browser's "Save as PDF" print destination. That breaks on mobile: printing
// the contents of an off-screen iframe is unreliable on iOS Safari and many
// mobile Chromium browsers, which often end up printing whatever's visible on
// screen instead — i.e. a screenshot of the app rather than the report.
//
// Now we build the report as real off-screen DOM (same document, no iframe),
// rasterize each page with html2canvas, and assemble a genuine multi-page PDF
// binary with jsPDF. That works identically on desktop and mobile because it
// never touches the OS print pipeline at all. Both libraries are lazy-loaded
// from CDN on first use (same pattern app.js already uses for Chart.js).
//
// Multi-language support: rather than embedding per-script fonts into the PDF
// (impractical client-side for CJK/Thai/Devanagari without a build step),
// pages are rasterized images — so any script the browser can render, the
// export can render, including Korean, with zero extra font-embedding work.
// We just make sure the right Google Font is fully loaded before capture.

const JSPDF_CDN       = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
const HTML2CANVAS_CDN = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';

let _pdfLibsPromise = null;
function loadPdfLibs() {
  if (_pdfLibsPromise) return _pdfLibsPromise;
  _pdfLibsPromise = (async () => {
    try {
      const jobs = [];
      if (!window.jspdf)       jobs.push(import(JSPDF_CDN));
      if (!window.html2canvas) jobs.push(import(HTML2CANVAS_CDN));
      await Promise.all(jobs);
      if (!window.jspdf?.jsPDF || !window.html2canvas) throw new Error('PDF libraries unavailable after load');
      return { jsPDF: window.jspdf.jsPDF, html2canvas: window.html2canvas };
    } catch (e) {
      _pdfLibsPromise = null; // allow a retry on the next click (e.g. after reconnecting)
      throw e;
    }
  })();
  return _pdfLibsPromise;
}

// ── Per-language font loading ────────────────────────────────────────────────
// Inter (already loaded by index.html) covers Latin + Cyrillic. Korean, Thai,
// Chinese and Devanagari need their own font or they'll fall back to whatever
// the OS happens to ship — inconsistent, and sometimes ugly. Since html2canvas
// rasterizes exactly what's on screen, the right weights have to be genuinely
// loaded (not just linked) before we capture, so we force it via the Font
// Loading API with a sample of real glyphs from that script.
const PDF_LANG_FONT = {
  ko: { family: 'Noto Sans KR',         sample: '한글 가나다라 09' },
  th: { family: 'Noto Sans Thai',       sample: 'กขคงจฉ ๐๙' },
  zh: { family: 'Noto Sans SC',         sample: '汉字测试 09' },
  ne: { family: 'Noto Sans Devanagari', sample: 'नेपाली परीक्षण ०९' },
};

async function ensurePdfFont(lang) {
  const cfg = PDF_LANG_FONT[lang];
  if (!cfg) return `'Inter', sans-serif`;

  const linkId = `wt4-pdf-font-${cfg.family.replace(/\s+/g, '-')}`;
  if (!document.getElementById(linkId)) {
    await new Promise(resolve => {
      const link = document.createElement('link');
      link.id = linkId;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(cfg.family)}:wght@400;500;600;700;800&display=swap`;
      link.onload = resolve;
      link.onerror = resolve; // don't block the export on a font hiccup — system fallback still renders fine
      document.head.appendChild(link);
    });
  }
  try {
    await Promise.all([400, 500, 600, 700, 800].map(w =>
      document.fonts.load(`${w} 16px "${cfg.family}"`, cfg.sample)
    ));
  } catch {}
  return `'${cfg.family}', 'Inter', sans-serif`;
}

// ── Page geometry ─────────────────────────────────────────────────────────────
// Pages are rendered off-screen at a fixed CSS pixel width, then converted to
// real A4-landscape millimetres. TARGET_H_PX is the budget the paginator tries
// to fill per page — the actual height of any given page is whatever its real
// content measures (so the last page of a section, or an oversized header on
// a very wide date range, never gets clipped or stretched).
const PAGE_W_MM     = 297;                              // A4 landscape width
const MARGIN_MM      = 14;
const CONTENT_W_MM  = PAGE_W_MM - MARGIN_MM * 2;
const TARGET_H_MM   = 210 - MARGIN_MM * 2;               // A4 landscape height minus margins
const CONTENT_PX_W  = 1360;                              // render width, in CSS px
const PX_PER_MM     = CONTENT_PX_W / CONTENT_W_MM;
const TARGET_H_PX   = TARGET_H_MM * PX_PER_MM;
const mmFromPx        = px => px / PX_PER_MM;

// ── Scoped stylesheet ─────────────────────────────────────────────────────────
// Everything lives under .wt4-pdfdoc so it can never leak into (or be affected
// by) the live app's own dark-mode theme variables — the report should always
// render the same clean, light, printable look regardless of app theme.
const PDF_CSS = `
.wt4-pdfdoc{position:fixed;left:-99999px;top:0;line-height:1.5;-webkit-font-smoothing:antialiased;
  --ink:#0d1033;--ink-muted:#6370a0;--ink-hint:#b0b8d8;--primary:#3a5fff;--primary-lt:#eef1ff;
  --success:#18a958;--success-lt:#e8f7ee;--danger:#e8294a;--danger-lt:#fdf0f2;
  --warn:#d4870a;--warn-lt:#fef8ed;--sat-col:#2060e8;--border:#e2e6f4;--bg:#f8f9fe;--card:#fff;--radius:12px;}
.wt4-pdfdoc,.wt4-pdfdoc *{box-sizing:border-box;margin:0;padding:0;}
.wt4-pdfdoc .pdf-page{width:${CONTENT_PX_W}px;background:var(--card);color:var(--ink);overflow:hidden;}

.wt4-pdfdoc .doc-header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:22px;border-bottom:2px solid var(--border);margin-bottom:26px;}
.wt4-pdfdoc .doc-logo{display:flex;align-items:center;gap:12px;}
.wt4-pdfdoc .doc-logo-icon{width:46px;height:46px;background:linear-gradient(135deg,#3a5fff 0%,#6c8eff 100%);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;}
.wt4-pdfdoc .doc-logo-text{font-size:18px;font-weight:700;letter-spacing:-0.03em;}
.wt4-pdfdoc .doc-logo-sub{font-size:12px;color:var(--ink-muted);margin-top:2px;font-weight:500;}
.wt4-pdfdoc .doc-meta{text-align:right;}
.wt4-pdfdoc .doc-title{font-size:24px;font-weight:800;letter-spacing:-0.04em;}
.wt4-pdfdoc .doc-period{font-size:14px;color:var(--primary);font-weight:600;margin-top:5px;}
.wt4-pdfdoc .doc-generated{font-size:11px;color:var(--ink-hint);margin-top:7px;}

.wt4-pdfdoc .cont-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;border-bottom:1px solid var(--border);margin-bottom:18px;font-size:11px;color:var(--ink-muted);}
.wt4-pdfdoc .cont-header b{color:var(--ink);font-weight:700;}

.wt4-pdfdoc .kpi-row{display:flex;gap:14px;margin-bottom:30px;}
.wt4-pdfdoc .kpi{flex:1 1 0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:16px 14px;position:relative;}
.wt4-pdfdoc .kpi-bar{height:3px;background:var(--primary);border-radius:99px 99px 0 0;margin:-16px -14px 14px -14px;}
.wt4-pdfdoc .kpi.kpi--net .kpi-bar{background:var(--success);}
.wt4-pdfdoc .kpi.kpi--hrs .kpi-bar{background:var(--warn);}
.wt4-pdfdoc .kpi-lbl{font-size:9.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:7px;}
.wt4-pdfdoc .kpi-val{font-size:21px;font-weight:800;letter-spacing:-0.04em;line-height:1;}
.wt4-pdfdoc .kpi-val.green{color:var(--success);}
.wt4-pdfdoc .kpi-val.blue{color:var(--primary);}
.wt4-pdfdoc .kpi-val.amber{color:var(--warn);}
.wt4-pdfdoc .kpi-sub{font-size:10.5px;color:var(--ink-hint);margin-top:5px;font-weight:500;}

.wt4-pdfdoc .section-heading{font-size:10.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:13px;padding-bottom:7px;border-bottom:1px solid var(--border);}

.wt4-pdfdoc .month-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:24px;}
.wt4-pdfdoc .month-summary{flex:1 1 220px;max-width:280px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;}
.wt4-pdfdoc .month-name{font-size:13.5px;font-weight:700;margin-bottom:11px;letter-spacing:-0.02em;}
.wt4-pdfdoc .month-stats{display:flex;flex-wrap:wrap;gap:7px;}
.wt4-pdfdoc .ms{flex:1 1 45%;display:flex;flex-direction:column;gap:2px;}
.wt4-pdfdoc .ms--net{flex:1 1 100%;border-top:1px solid var(--border);padding-top:7px;flex-direction:row;justify-content:space-between;align-items:center;}
.wt4-pdfdoc .ms-lbl{font-size:9.5px;color:var(--ink-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;}
.wt4-pdfdoc .ms-val{font-size:13.5px;font-weight:700;}
.wt4-pdfdoc .net-val{color:var(--success)!important;font-size:15.5px!important;}
.wt4-pdfdoc .auto-tag{font-size:9px;background:var(--warn-lt);color:var(--warn);padding:1px 5px;border-radius:4px;font-weight:600;margin-left:4px;}

.wt4-pdfdoc .legend{display:flex;flex-wrap:wrap;gap:10px 20px;margin-bottom:22px;}
.wt4-pdfdoc .legend-item{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--ink-muted);}
.wt4-pdfdoc .legend-swatch{width:10px;height:10px;border-radius:3px;flex-shrink:0;}

.wt4-pdfdoc table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10.5px;}
.wt4-pdfdoc col.c-date{width:9%;} .wt4-pdfdoc col.c-day{width:6%;} .wt4-pdfdoc col.c-type{width:23%;}
.wt4-pdfdoc col.c-shift{width:8%;} .wt4-pdfdoc col.c-reg{width:6%;} .wt4-pdfdoc col.c-ot{width:6%;}
.wt4-pdfdoc col.c-eff{width:7%;} .wt4-pdfdoc col.c-rate{width:9%;} .wt4-pdfdoc col.c-gross{width:9%;}
.wt4-pdfdoc col.c-tax{width:8%;} .wt4-pdfdoc col.c-net{width:9%;}

.wt4-pdfdoc thead tr{background:var(--ink);color:#fff;}
.wt4-pdfdoc thead th{padding:9px 7px;text-align:right;font-size:9px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;white-space:nowrap;overflow:hidden;}
.wt4-pdfdoc thead th:nth-child(1),.wt4-pdfdoc thead th:nth-child(2),.wt4-pdfdoc thead th:nth-child(3),.wt4-pdfdoc thead th:nth-child(4){text-align:left;}

.wt4-pdfdoc tbody tr td{padding:7px 7px;border-bottom:1px solid var(--border);vertical-align:middle;overflow:hidden;}
.wt4-pdfdoc tbody tr.even td{background:#fafbfe;}
.wt4-pdfdoc .td-date{font-weight:600;white-space:nowrap;}
.wt4-pdfdoc .td-day{color:var(--ink-muted);font-size:9px;}
.wt4-pdfdoc .td-type{font-size:9px;}
.wt4-pdfdoc .td-shift{font-size:9px;color:var(--ink-muted);}
.wt4-pdfdoc .td-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.wt4-pdfdoc .td-num.eff{color:var(--primary);font-weight:600;}
.wt4-pdfdoc .td-num.tax{color:var(--danger);}
.wt4-pdfdoc .td-num.net{color:var(--success);font-weight:700;}

.wt4-pdfdoc .hol-row td:first-child{border-left:3px solid var(--danger);}
.wt4-pdfdoc .sun-row td:first-child{border-left:3px solid #e8294a88;}
.wt4-pdfdoc .sat-row td:first-child{border-left:3px solid var(--sat-col);}
.wt4-pdfdoc .auto-row td{background:var(--warn-lt)!important;}
.wt4-pdfdoc .auto-row td:first-child{border-left:3px solid var(--warn);}

.wt4-pdfdoc .hol-badge,.wt4-pdfdoc .auto-badge{display:inline-block;font-size:8px;padding:1px 5px;border-radius:4px;margin-left:5px;font-weight:600;white-space:nowrap;}
.wt4-pdfdoc .hol-badge{background:var(--danger-lt);color:var(--danger);}
.wt4-pdfdoc .auto-badge{background:var(--warn-lt);color:var(--warn);font-weight:700;letter-spacing:0.04em;}

.wt4-pdfdoc .totals-row td{background:var(--primary-lt)!important;font-weight:700;border-top:2px solid var(--primary);border-bottom:none;font-size:10.5px;}
.wt4-pdfdoc .totals-row .td-num.net{font-size:12px;}

.wt4-pdfdoc .doc-footer{padding-top:16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;}
.wt4-pdfdoc .footer-left{font-size:9.5px;color:var(--ink-hint);line-height:1.6;}
.wt4-pdfdoc .footer-right{font-size:9.5px;color:var(--ink-hint);text-align:right;}
.wt4-pdfdoc .footer-note{font-size:9.5px;color:var(--ink-hint);margin-top:18px;line-height:1.7;}
`;

function ensurePdfStylesheet() {
  if (document.getElementById('wt4-pdf-styles')) return;
  const style = document.createElement('style');
  style.id = 'wt4-pdf-styles';
  style.textContent = PDF_CSS;
  document.head.appendChild(style);
}

// ── Small formatting helpers shared by the HTML builders below ──────────────
function fmtKRW(n) { return '₩' + n.toLocaleString('en-US'); }
function fmtYM(ym) {
  const [y, m] = ym.split('-');
  return `${t('mn')[parseInt(m) - 1]} ${y}`;
}

const PDF_COLGROUP = `<colgroup><col class="c-date"><col class="c-day"><col class="c-type"><col class="c-shift"><col class="c-reg"><col class="c-ot"><col class="c-eff"><col class="c-rate"><col class="c-gross"><col class="c-tax"><col class="c-net"></colgroup>`;

// ── HTML block builders ──────────────────────────────────────────────────────
function buildHeaderHTML(periodLabel, generatedDate) {
  return `
    <div class="doc-header">
      <div class="doc-logo">
        <div class="doc-logo-icon">🕐</div>
        <div>
          <div class="doc-logo-text">Work Hour Tracker</div>
          <div class="doc-logo-sub">${t('exportPayStatement')}</div>
        </div>
      </div>
      <div class="doc-meta">
        <div class="doc-title">${t('exportReportTitle')}</div>
        <div class="doc-period">${periodLabel}</div>
        <div class="doc-generated">${t('exportGenerated', generatedDate)}</div>
      </div>
    </div>`;
}

function buildContHeaderHTML(periodLabel, pageNum, totalPages) {
  return `
    <div class="cont-header">
      <span><b>Work Hour Tracker</b> — ${t('exportReportTitle')}</span>
      <span>${periodLabel} · ${pageNum}/${totalPages}</span>
    </div>`;
}

function buildKpiHTML(daysWorked, autoDays, totEff, totGross, totNet, totTax, taxPct) {
  return `
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-bar"></div>
        <div class="kpi-lbl">${t('exportKpiDays')}</div>
        <div class="kpi-val blue">${daysWorked + autoDays}</div>
        <div class="kpi-sub">${t('exportKpiDaysSub', daysWorked, autoDays)}</div>
      </div>
      <div class="kpi kpi--hrs"><div class="kpi-bar"></div>
        <div class="kpi-lbl">${t('exportKpiHours')}</div>
        <div class="kpi-val amber">${totEff.toFixed(1)}h</div>
        <div class="kpi-sub">${t('exportKpiHoursSub')}</div>
      </div>
      <div class="kpi"><div class="kpi-bar"></div>
        <div class="kpi-lbl">${t('exportKpiGross')}</div>
        <div class="kpi-val">${fmtKRW(totGross)}</div>
        <div class="kpi-sub">${t('exportKpiGrossSub', taxPct)}</div>
      </div>
      <div class="kpi kpi--net"><div class="kpi-bar"></div>
        <div class="kpi-lbl">${t('exportKpiNet')}</div>
        <div class="kpi-val green">${fmtKRW(totNet)}</div>
        <div class="kpi-sub">${t('exportKpiNetSub', taxPct, fmtKRW(totTax))}</div>
      </div>
    </div>`;
}

function buildMonthGridHTML(byMonth) {
  const cards = Object.entries(byMonth).map(([ym, mrows]) => {
    const mGross = mrows.reduce((s, r) => s + r.gross, 0);
    const mNet   = mrows.reduce((s, r) => s + r.net, 0);
    const mDays  = mrows.filter(r => !r.autoCredit || r.regHrs > 0 || r.otHrs > 0).length;
    const mAuto  = mrows.filter(r => r.autoCredit && r.regHrs === 0 && r.otHrs === 0).length;
    const mEff   = mrows.reduce((s, r) => s + r.effHrs, 0);
    return `
      <div class="month-summary">
        <div class="month-name">${fmtYM(ym)}</div>
        <div class="month-stats">
          <div class="ms"><span class="ms-lbl">${t('exportDaysWorked')}</span><span class="ms-val">${mDays}${mAuto ? ` <span class="auto-tag">${t('exportAutoTag', mAuto)}</span>` : ''}</span></div>
          <div class="ms"><span class="ms-lbl">${t('exportEffHours')}</span><span class="ms-val">${mEff.toFixed(1)}h</span></div>
          <div class="ms"><span class="ms-lbl">${t('exportGross')}</span><span class="ms-val">${fmtKRW(mGross)}</span></div>
          <div class="ms ms--net"><span class="ms-lbl">${t('exportNetPay')}</span><span class="ms-val net-val">${fmtKRW(mNet)}</span></div>
        </div>
      </div>`;
  }).join('');
  return `<div class="section-heading">${t('exportMonthlyBreakdown')}</div><div class="month-grid">${cards}</div>`;
}

function buildLegendHTML() {
  return `
    <div class="legend">
      <div class="legend-item"><div class="legend-swatch" style="background:#e8294a;"></div>${t('exportLegendHoliday')}</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#e8294a88;"></div>${t('exportLegendSunday')}</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#2060e8;"></div>${t('exportLegendSaturday')}</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#d4870a;"></div>${t('exportLegendAuto')}</div>
    </div>`;
}

function buildTheadHTML(taxPct) {
  return `<thead><tr>
    <th>${t('exportColDate')}</th><th>${t('exportColDay')}</th><th>${t('exportColType')}</th><th>${t('exportColShift')}</th>
    <th>${t('exportColRegH')}</th><th>${t('exportColOTH')}</th><th>${t('exportColEffH')}</th>
    <th>${t('exportColRate')}</th><th>${t('exportColGross')}</th><th>${t('exportColTax', taxPct)}</th><th>${t('exportColNet')}</th>
  </tr></thead>`;
}

function buildRowHTML(r, idx) {
  const dow = dowOf(r.date);
  const isSundayRow = dow === 0, isSaturdayRow = dow === 6;
  const rowClass = r.autoCredit ? 'auto-row' : (r.holiday ? 'hol-row' : (isSundayRow ? 'sun-row' : (isSaturdayRow ? 'sat-row' : '')));
  const holBadge  = r.holiday ? `<span class="hol-badge">${r.holiday}</span>` : '';
  const autoBadge = r.autoCredit ? `<span class="auto-badge">AUTO</span>` : '';
  return `
    <tr class="${rowClass}${idx % 2 === 0 ? ' even' : ''}">
      <td class="td-date">${r.date}</td>
      <td class="td-day">${r.dayOfWeek}</td>
      <td class="td-type">${r.type}${holBadge}${autoBadge}</td>
      <td class="td-shift">${r.shift}</td>
      <td class="td-num">${r.regHrs > 0 ? r.regHrs : (r.autoCredit ? '8*' : '—')}</td>
      <td class="td-num">${r.otHrs > 0 ? r.otHrs : '—'}</td>
      <td class="td-num eff">${r.effHrs.toFixed(2)}</td>
      <td class="td-num">${fmtKRW(r.hourlyRate)}</td>
      <td class="td-num">${fmtKRW(r.gross)}</td>
      <td class="td-num tax">−${fmtKRW(r.taxAmt)}</td>
      <td class="td-num net">${fmtKRW(r.net)}</td>
    </tr>`;
}

function buildTfootHTML(totEff, totGross, totTax, totNet) {
  return `<tfoot><tr class="totals-row">
    <td colspan="4" style="text-align:left;font-size:10px;letter-spacing:0.04em;">${t('exportTotal')}</td>
    <td class="td-num"></td><td class="td-num"></td>
    <td class="td-num eff">${totEff.toFixed(2)}h</td>
    <td class="td-num"></td>
    <td class="td-num">${fmtKRW(totGross)}</td>
    <td class="td-num tax">−${fmtKRW(totTax)}</td>
    <td class="td-num net">${fmtKRW(totNet)}</td>
  </tr></tfoot>`;
}

function buildFooterHTML(periodLabel, taxPct, generatedDate) {
  return `
    <div class="doc-footer">
      <div class="footer-left">Work Hour Tracker · ${t('exportReportTitle')}<br>${t('exportFooterPeriod', periodLabel, taxPct)}</div>
      <div class="footer-right">${t('exportFooterGenBy')}<br>${generatedDate}</div>
    </div>
    <div class="footer-note">${t('exportFootnote', taxPct).replace(/\n/g, '<br>')}</div>`;
}

// ── PDF export entry point ───────────────────────────────────────────────────
async function exportPDF(fromYM, toYM) {
  const rows = buildRows(fromYM, toYM);
  if (!rows.length) { alert(t('exportNoData')); return; }

  const { jsPDF, html2canvas } = await loadPdfLibs();
  const fontStack = await ensurePdfFont(getLang());
  ensurePdfStylesheet();

  const taxPct     = getTaxRate();
  const totGross   = rows.reduce((s, r) => s + r.gross, 0);
  const totTax     = rows.reduce((s, r) => s + r.taxAmt, 0);
  const totNet     = rows.reduce((s, r) => s + r.net, 0);
  const totEff     = rows.reduce((s, r) => s + r.effHrs, 0);
  const daysWorked = rows.filter(r => !r.autoCredit || r.regHrs > 0 || r.otHrs > 0).length;
  const autoDays   = rows.filter(r => r.autoCredit && r.regHrs === 0 && r.otHrs === 0).length;

  const byMonth = {};
  rows.forEach(r => { const ym = r.date.slice(0, 7); (byMonth[ym] ??= []).push(r); });

  const localeMap = { ko: 'ko-KR', th: 'th-TH', ru: 'ru-RU', zh: 'zh-CN', fr: 'fr-FR', id: 'id-ID', ne: 'ne-NP' };
  const generatedDate = new Date().toLocaleDateString(localeMap[getLang()] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const periodLabel = fromYM === toYM ? fmtYM(fromYM) : `${fmtYM(fromYM)} – ${fmtYM(toYM)}`;

  const headerHTML = buildHeaderHTML(periodLabel, generatedDate)
    + buildKpiHTML(daysWorked, autoDays, totEff, totGross, totNet, totTax, taxPct)
    + buildMonthGridHTML(byMonth)
    + buildLegendHTML();
  const footerHTML = buildFooterHTML(periodLabel, taxPct, generatedDate);

  // ── Off-screen scratch root — same document, just positioned off-screen.
  // (Not display:none / visibility:hidden — the browser needs to actually lay
  // this out for html2canvas and our own height measurements to work.)
  const root = document.createElement('div');
  root.className = 'wt4-pdfdoc';
  root.style.fontFamily = fontStack;
  document.body.appendChild(root);

  try {
    // ── Measurement pass — render everything once at full size so we know
    // exactly how tall each block is, including any text-wrapping caused by
    // long translated strings or badges in any language.
    const measHeader = document.createElement('div');
    measHeader.className = 'pdf-page';
    measHeader.innerHTML = headerHTML;
    root.appendChild(measHeader);

    const measCont = document.createElement('div');
    measCont.className = 'pdf-page';
    measCont.innerHTML = buildContHeaderHTML(periodLabel, 1, 1);
    root.appendChild(measCont);

    const measTable = document.createElement('table');
    measTable.style.width = CONTENT_PX_W + 'px';
    measTable.innerHTML = PDF_COLGROUP + buildTheadHTML(taxPct)
      + `<tbody>${rows.map((r, i) => buildRowHTML(r, i)).join('')}</tbody>`
      + buildTfootHTML(totEff, totGross, totTax, totNet);
    root.appendChild(measTable);

    const measFooter = document.createElement('div');
    measFooter.className = 'pdf-page';
    measFooter.innerHTML = footerHTML;
    root.appendChild(measFooter);

    await document.fonts.ready;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); // let layout settle

    const headerH = measHeader.offsetHeight;
    const contH   = measCont.offsetHeight;
    const theadH  = measTable.tHead.offsetHeight;
    const tfootH  = measTable.tFoot.offsetHeight;
    const footerH = measFooter.offsetHeight;
    const rowHs   = Array.from(measTable.tBodies[0].rows).map(tr => tr.offsetHeight);

    root.innerHTML = ''; // clear scratch — real page elements go in next

    // ── Paginate: bucket rows into pages that fit the target page height,
    // always keeping whole rows together (never splitting one mid-row).
    const pages = [];
    let cursor = 0, pageIdx = 0;
    while (cursor < rows.length) {
      const isFirst = pageIdx === 0;
      const avail = TARGET_H_PX - (isFirst ? headerH : contH) - theadH;
      let used = 0, start = cursor;
      while (cursor < rows.length && used + rowHs[cursor] <= avail) { used += rowHs[cursor]; cursor++; }
      if (cursor === start) cursor++; // guarantee forward progress even if a single row overflows the budget
      const isLast = cursor >= rows.length;
      let includeTfoot = false, includeFooter = false;
      if (isLast && (used + tfootH <= avail || pages.length === 0)) {
        includeTfoot = true; used += tfootH;
        if (used + footerH <= avail) includeFooter = true;
      }
      pages.push({ rowStart: start, rowEnd: cursor, isFirst, includeTfoot, includeFooter });
      pageIdx++;
    }
    if (!pages[pages.length - 1].includeFooter) {
      const prev = pages[pages.length - 1];
      pages.push({ rowStart: rows.length, rowEnd: rows.length, isFirst: false, includeTfoot: !prev.includeTfoot, includeFooter: true });
    }

    // ── Render + capture each page, one at a time (keeps memory low on mobile)
    const total = pages.length;
    const images = [];
    for (let i = 0; i < total; i++) {
      const p = pages[i];
      const pageEl = document.createElement('div');
      pageEl.className = 'pdf-page';

      let html = p.isFirst ? headerHTML : buildContHeaderHTML(periodLabel, i + 1, total);
      if (p.rowEnd > p.rowStart || p.includeTfoot) {
        const slice = rows.slice(p.rowStart, p.rowEnd);
        html += `<table>${PDF_COLGROUP}${buildTheadHTML(taxPct)}<tbody>${
          slice.map((r, j) => buildRowHTML(r, p.rowStart + j)).join('')
        }</tbody>${p.includeTfoot ? buildTfootHTML(totEff, totGross, totTax, totNet) : ''}</table>`;
      }
      if (p.includeFooter) html += footerHTML;

      pageEl.innerHTML = html;
      root.appendChild(pageEl);

      const canvas = await html2canvas(pageEl, { scale: 2, backgroundColor: '#ffffff' });
      images.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.92), heightMm: mmFromPx(pageEl.offsetHeight) });
      root.removeChild(pageEl);
    }

    // ── Assemble the real PDF binary ────────────────────────────────────────
    const pdf = new jsPDF({ unit: 'mm', orientation: 'landscape', format: [PAGE_W_MM, images[0].heightMm + MARGIN_MM * 2] });
    images.forEach((img, i) => {
      if (i > 0) pdf.addPage([PAGE_W_MM, img.heightMm + MARGIN_MM * 2], 'landscape');
      pdf.addImage(img.dataUrl, 'JPEG', MARGIN_MM, MARGIN_MM, CONTENT_W_MM, img.heightMm);
    });
    pdf.save(`work-tracker-${fromYM}-to-${toYM}.pdf`);

  } finally {
    document.body.removeChild(root);
  }
}

// ── Export UI card HTML ────────────────────────────────────────────────────────
export function buildExportCard() {
  const months = monthsWithData();
  if (!months.length) return ''; // no data yet — hide the card entirely

  const mnames = t('mn');
  function optLabel(ym) {
    const [y, m] = ym.split('-');
    return `${mnames[parseInt(m) - 1]} ${y}`;
  }

  const opts = months.map(ym => `<option value="${ym}">${optLabel(ym)}</option>`).join('');
  const lastM  = months[months.length - 1];
  const firstM = months[0];

  // Build preset buttons
  const now = new Date();
  const curYM = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const prevYM = now.getMonth() === 0
    ? `${now.getFullYear() - 1}-12`
    : `${now.getFullYear()}-${pad(now.getMonth())}`;

  function clamp(ym) {
    if (ym < firstM) return firstM;
    if (ym > lastM)  return lastM;
    return ym;
  }

  function threeMonthsAgo() {
    let y = now.getFullYear(), m = now.getMonth() - 2;
    if (m < 0) { m += 12; y--; }
    return clamp(`${y}-${pad(m + 1)}`);
  }

  const presets = [
    { label: t('exportPresetThisMonth'), from: clamp(curYM),                      to: lastM },
    { label: t('exportPresetLastMonth'), from: clamp(prevYM),                     to: clamp(prevYM) },
    { label: t('exportPresetLast3'),     from: threeMonthsAgo(),                  to: lastM },
    { label: t('exportPresetThisYear'),  from: clamp(`${now.getFullYear()}-01`),  to: lastM },
    { label: t('exportPresetAllTime'),   from: firstM,                             to: lastM },
  ].filter((p, i, arr) => {
    const key = p.from + p.to;
    return arr.findIndex(x => x.from + x.to === key) === i;
  });

  const presetBtns = presets.map(p =>
    `<button class="exp-preset" data-from="${p.from}" data-to="${p.to}">${p.label}</button>`
  ).join('');

  return `
  <div class="card" id="export-card">
    <div class="card-title">${t('exportTitle')}</div>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
      ${t('exportSub')}
    </p>

    <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">${t('exportQuickRange')}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px;">
      ${presetBtns}
    </div>

    <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">${t('exportCustomRange')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;">
      <div>
        <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:5px;">${t('exportFrom')}</label>
        <select id="exp-from" class="wage-inp" style="width:100%;cursor:pointer;">
          ${opts}
        </select>
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:5px;">${t('exportTo')}</label>
        <select id="exp-to" class="wage-inp" style="width:100%;cursor:pointer;">
          ${opts}
        </select>
      </div>
    </div>
    <div id="exp-range-err" style="display:none;font-size:12px;color:var(--danger);margin-bottom:12px;">
      ${t('exportRangeErr')}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <button class="btn-pri" id="exp-csv" style="display:flex;align-items:center;justify-content:center;gap:7px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        ${t('exportCSV')}
      </button>
      <button class="btn-sec" id="exp-pdf" style="display:flex;align-items:center;justify-content:center;gap:7px;border-color:var(--border-strong);">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M10 12v6"/><path d="M14 12v6"/><path d="M10 15h4"/></svg>
        ${t('exportPDF')}
      </button>
    </div>
    <div style="font-size:11px;color:var(--text-hint);margin-top:10px;">
      ${t('exportPDFHint')}
    </div>
  </div>`;
}

// ── Wire events for the export card ───────────────────────────────────────────
export function wireExportCard() {
  const card = document.getElementById('export-card');
  if (!card) return;

  const fromSel = document.getElementById('exp-from');
  const toSel   = document.getElementById('exp-to');
  const errEl   = document.getElementById('exp-range-err');
  const months  = monthsWithData();

  if (!fromSel || !toSel || !months.length) return;

  // Default: show all time on load
  fromSel.value = months[0];
  toSel.value   = months[months.length - 1];

  function validate() {
    const valid = fromSel.value <= toSel.value;
    errEl.style.display = valid ? 'none' : 'block';
    return valid;
  }

  fromSel.addEventListener('change', () => {
    if (fromSel.value > toSel.value) toSel.value = fromSel.value;
    validate();
  });
  toSel.addEventListener('change', () => {
    if (toSel.value < fromSel.value) fromSel.value = toSel.value;
    validate();
  });

  // Preset buttons — set both selects and clear any error
  card.querySelectorAll('.exp-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      fromSel.value = btn.dataset.from;
      toSel.value   = btn.dataset.to;
      errEl.style.display = 'none';
      // Highlight active preset
      card.querySelectorAll('.exp-preset').forEach(b => b.classList.remove('exp-preset--active'));
      btn.classList.add('exp-preset--active');
    });
  });

  document.getElementById('exp-csv')?.addEventListener('click', () => {
    if (!validate()) return;
    exportCSV(fromSel.value, toSel.value);
  });

  document.getElementById('exp-pdf')?.addEventListener('click', async (e) => {
    if (!validate()) return;
    const btn = e.currentTarget;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<svg class="exp-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-9-9"/></svg>${t('exportPDFGenerating')}`;
    try {
      await exportPDF(fromSel.value, toSel.value);
    } catch (err) {
      console.warn('[export] PDF generation failed:', err);
      alert(t('exportPDFError'));
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });
}
