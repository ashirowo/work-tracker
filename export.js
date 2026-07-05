// ─────────────────────────────────────────────────────────────────────────────
// export.js — CSV + PDF export for Shiftr
//
// INTEGRATION (current):
//   • Shared logic (date math, storage, and the wage-calc engine) is imported
//     from ./core/* — the SAME modules app.js uses, so an exported report and
//     the on-screen numbers are computed by one engine, never two.
//   • The export-card MARKUP is rendered by app.js (buildExportCardInline);
//     this module exposes wireExportCard() to bind that card's behavior, plus
//     buildRows / exportCSV / exportPDF / monthsWithData / showExportToast.
//
// DEPENDENCIES: no up-front third-party libs — CSV is a plain Blob download.
//   PDF is generated client-side; on first use, jsPDF + html2canvas are
//   lazy-loaded from CDN (same pattern app.js uses for Chart.js) and cached by
//   the service worker afterward, so PDF export keeps working offline too.
// ─────────────────────────────────────────────────────────────────────────────

import { TR } from './translations.js';
import { LS } from './core/constants.js';
import { pad, mkds, pd, today as todayStr, dowOf, isSun, isSat, getMonday } from './core/datetime.js';
import { ld, getLogs, getShifts, getWages, wageFor, getInsurance, isHolAuto, getDeductionMode } from './core/storage.js';
import {
  calcWage as _calcWage, shiftFor, isFixedShiftPattern, applyTax,
  deductionPct, careRateOfGross, insuranceRatePct,
} from './core/payroll.js';
import { translateHolidayName } from './core/holidays.js';

// ── Export-specific helpers ──────────────────────────────────────────────────
// Pure date/storage/payroll helpers now come from ./core (single source of truth
// shared with app.js). Only the export-only concerns live here: language
// resolution, the report-scoped holiday snapshot, and the deduction-noun/label
// formatting used by the CSV columns and PDF headers.

function getLang() { return ld(LS.lang, 'en'); }
function t(k, ...a) {
  const lang = getLang();
  const fn = TR[lang]?.[k] ?? TR.en?.[k];
  return typeof fn === 'function' ? fn(...a) : (fn || k);
}
// Same as t(), but for an explicitly chosen language — used by the PDF generator
// so a report can be produced in a language other than the app's current UI.
function tFor(lang, k, ...a) {
  const fn = TR[lang]?.[k] ?? TR.en?.[k];
  return typeof fn === 'function' ? fn(...a) : (fn || k);
}

// A snapshot of all holidays across the relevant year range, read from the gov
// cache. Reports take this snapshot once and pass it into calcWage so a single
// export is internally consistent even if the live cache changes mid-run.
function getHolidays() {
  const hols = {};
  const curY = new Date().getFullYear();
  for (let yr = curY - 3; yr <= curY + 2; yr++) {
    try {
      const raw = localStorage.getItem(LS.govPrefix + yr);
      if (raw) {
        const { ko } = JSON.parse(raw);
        if (ko) Object.assign(hols, ko);
      }
    } catch (e) {}
    hols[`${yr}-05-01`] = '근로자의 날'; // Labour Day
  }
  return hols;
}

// calcWage for exports: same engine as app.js, but the holiday-presence check
// comes from the report's `holidays` snapshot rather than the live module state,
// and note labels aren't needed. `holAuto` is read from storage here (exports
// have no live session S). The trailing `holidays` param keeps the original
// export call signature intact.
function calcWage(dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride, holidays) {
  return _calcWage(dateStr, regHrs, otHrs, wage, shiftOverride, holCreditOverride, {
    isHol: ds => !!holidays[ds],
    holAuto: ld(LS.holAuto, true) !== false,
    tr: TR[getLang()] || TR.en,
  });
}

// Mode-aware column/label noun, e.g. "Tax" or "4대 보험", in the given language.
function dedNoun(lang) {
  const m = getDeductionMode();
  return (TR[lang] && TR[lang].exportDedNoun && TR[lang].exportDedNoun[m])
    || (m === 'insurance' ? '4 Insurances' : 'Tax');
}
// Compact column-header variant (e.g. "Insurance") for the narrow table column.
function dedCol(lang) {
  const m = getDeductionMode();
  return (TR[lang] && TR[lang].exportDedCol && TR[lang].exportDedCol[m])
    || dedNoun(lang);
}
// Full deduction label with the active percentage, e.g. "Tax (3.3%)".
function dedLabel(lang, pct) {
  return `${dedNoun(lang)} (${Math.round(pct * 100) / 100}%)`;
}


// ── Determine which months have any data ──────────────────────────────────────
export function monthsWithData() {
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
// `lang` defaults to the app's current UI language (used by CSV export); the
// PDF generator passes an explicitly-chosen report language instead.
export function buildRows(fromYM, toYM, lang = getLang()) {
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

      if (net === 0 && !log) continue; // skip days with no earnings and no log entry

      // Full shift name ("Day Shift" / "Night Shift" / "Double Shift").
      // Omitted for day/night when the user works a single fixed shift (it would
      // repeat on every row) and on auto-credited days (no real worked shift).
      // Double always shows (distinct day type).
      const fixed = isFixedShiftPattern();
      const shiftSuffix = (shift === 'day' || shift === 'night') && !fixed && !autoCredit
        ? ` (${tFor(lang, 'shiftFull')[shift]})` : '';
      if (shift === 'double') type = tFor(lang, 'shiftFull').double;
      else if (isHol) type = tFor(lang, 'exportLegendHoliday');
      else if (sun)   type = tFor(lang, 'exportLegendSunday') + shiftSuffix;
      else if (sat)   type = tFor(lang, 'exportLegendSaturday') + shiftSuffix;
      else            type = tFor(lang, 'exportTypeWeekday') + shiftSuffix;

      rows.push({
        date: ds,
        dayOfWeek: tFor(lang, 'dh')[dowOf(ds)],
        type,
        shift: shift === 'double' ? tFor(lang, 'doubleShift') : shift === 'day' ? tFor(lang, 'dayShift') : tFor(lang, 'nightShift'),
        shiftKey: shift, // raw 'day'|'night'|'double' for color-coding in the PDF
        holiday: isHol ? translateHolidayName(holidays[ds] || '', lang) : '',
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

// ── Export confirmation toast ────────────────────────────────────────────────
// Mobile browsers are inconsistent about confirming a download happened:
// Android Chrome shows its own "Download complete" notification, but iOS
// Safari often just opens the file inline with no visible save cue, and an
// installed PWA has no browser chrome at all to show a download bar. So we
// show our own lightweight, self-dismissing confirmation rather than relying
// on the OS/browser to tell the user anything.
let _toastHideTimer = null;
export function showExportToast(message) {
  document.getElementById('exp-toast')?.remove();
  clearTimeout(_toastHideTimer);

  const el = document.createElement('div');
  el.id = 'exp-toast';
  el.className = 'exp-toast';
  el.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><span>${message}</span>`;
  document.body.appendChild(el);

  // Add the visible class on the next frame so the fade-in actually animates
  // instead of snapping straight to its end state.
  requestAnimationFrame(() => el.classList.add('exp-toast--visible'));

  _toastHideTimer = setTimeout(() => {
    el.classList.remove('exp-toast--visible');
    setTimeout(() => el.remove(), 220);
  }, 2800);
}

// ── Apply export filter options to a rows array ───────────────────────────────
// Returns a new rows array with OT stripped/recalculated and holiday rows
// handled correctly. Called by both exportCSV and exportPDF so the logic
// is identical regardless of output format.
//
// OT (includeOT=false):
//   Keep the row but re-run calcWage with otHrs=0 so effHrs/gross/net
//   reflect only the base shift pay. The row is never dropped — the user
//   still worked that day, they just want to see it without the OT component.
//
// Holidays (includeHol=false):
//   • Pure auto-credited day (no log entry): drop entirely.
//   • Worked holiday (log entry exists): re-run calcWage with holCreditOverride=false
//     so the 8-hour attendance base is removed, but the work multipliers (1.5×)
//     still apply. Row is kept.
function applyExportOpts(rows, opts) {
  const holidays = getHolidays();
  const wage = (ds) => wageFor(ds); // closure over existing helper

  return rows.reduce((out, r) => {
    let row = r;

    // ── Holiday filter ──────────────────────────────────────────────────────
    if (opts.includeHol === false && r.holiday) {
      if (r.autoCredit && r.regHrs === 0 && r.otHrs === 0) {
        // Pure auto-credited holiday with no logged work — drop it
        return out;
      }
      // Worked holiday — recalculate without the auto 8hr credit base
      const w = wage(r.date);
      const otH = (opts.includeOT === false) ? 0 : r.otHrs;
      const c = calcWage(r.date, r.regHrs, otH, w, undefined, false /* holCreditOverride=off */, holidays);
      row = { ...r, otHrs: otH, effHrs: c.eff, gross: c.gross, taxAmt: c.gross - c.net, net: c.net };
      out.push(row);
      return out;
    }

    // ── OT filter (holiday already handled above) ───────────────────────────
    if (opts.includeOT === false && r.otHrs > 0) {
      const w = wage(r.date);
      const c = calcWage(r.date, r.regHrs, 0 /* strip OT */, w, undefined,
        r.autoCredit ? true : undefined, holidays);
      row = { ...r, otHrs: 0, effHrs: c.eff, gross: c.gross, taxAmt: c.gross - c.net, net: c.net };
    }

    out.push(row);
    return out;
  }, []).filter(r => r.net > 0);
}

// ── CSV export ────────────────────────────────────────────────────────────────
export function exportCSV(fromYM, toYM, opts = {}) {
  let rows = buildRows(fromYM, toYM);
  if (!rows.length) { alert(t('exportNoData')); return; }
  rows = applyExportOpts(rows, opts);
  if (!rows.length) { alert(t('exportNoData')); return; }

  const taxPct = Math.round(deductionPct() * 10000) / 10000;
  const includeEarnings = opts.includeEarnings !== false;
  const includeNotes    = opts.includeNotes === true;
  const includeOTCol    = opts.includeOT !== false;

  const headers = [
    t('exportColDate'), t('exportColDay'), t('exportColType'), t('exportColShift'),
    t('exportLegendHoliday'), 'Auto',
    t('exportColRegH'),
    ...(includeOTCol ? [t('exportColOTH')] : []),
    t('exportColEffH'),
    `${t('exportColRate')} (₩)`,
    ...(includeEarnings ? [
      `${t('exportColGross')} (₩)`,
      `${dedLabel(getLang(), taxPct)} (₩)`,
      `${t('exportColNet')} (₩)`
    ] : []),
    ...(includeNotes ? ['Notes'] : []),
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
      r.regHrs,
      ...(includeOTCol ? [r.otHrs] : []),
      r.effHrs,
      r.hourlyRate,
      ...(includeEarnings ? [r.gross, r.taxAmt, r.net] : []),
      ...(includeNotes ? [r.note || ''] : []),
    ].map(escape).join(','))
  ];

  // Totals row
  const totGross = rows.reduce((s, r) => s + r.gross, 0);
  const totTax   = rows.reduce((s, r) => s + r.taxAmt, 0);
  const totNet   = rows.reduce((s, r) => s + r.net, 0);
  const totEff   = rows.reduce((s, r) => s + r.effHrs, 0);
  lines.push([
    '', '', '', '', '', t('exportTotal'),
    '',
    ...(includeOTCol ? [''] : []),
    totEff.toFixed(2),
    '',
    ...(includeEarnings ? [totGross, totTax, totNet] : []),
    ...(includeNotes ? [''] : []),
  ].map(escape).join(','));

  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shiftr-${fromYM}-to-${toYM}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showExportToast(t('exportSavedToast', a.download));
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

// Selectable report languages — labelled in their own native script so they're
// recognizable regardless of which language the app's UI currently is in.
// (Used for font lookups; the Korean entry's display label gets overridden
// per-UI-language below, since it should read as the current language's own
// word for "Korean" rather than always the Korean script itself.)
const PDF_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'th', label: 'ไทย' },
  { code: 'ru', label: 'Русский' },
  { code: 'zh', label: '中文' },
  { code: 'fr', label: 'Français' },
  { code: 'ne', label: 'नेपाली' },
];

// The report-language picker only ever offers two choices: whatever the
// app's current UI language is, plus Korean (since payslips/labor offices
// in Korea are the most common reason to want a language other than the
// app's own). When the app's UI language already IS Korean, there's no
// second option to offer, so the picker isn't rendered at all (see
// buildExportCard) — this function is only called in the other case, but
// still guards against being called with lang === 'ko' just in case.
//
// Labels are shown in the CURRENT UI language, not the report's own
// language: the current-language entry's native name already doubles as
// its own translation (e.g. "Français" is correct in a French UI too), but
// "Korean" needs an actual translated word (e.g. "Korean" / "Coréen" /
// "한국어") rather than always showing the Korean script.
function getReportLanguageOptions() {
  const current = getLang();
  const currentEntry = PDF_LANGUAGES.find(l => l.code === current) ?? PDF_LANGUAGES[0];
  if (current === 'ko') return [currentEntry];
  return [currentEntry, { code: 'ko', label: t('langKorean') }];
}

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
  /* Palette mirrors the app's LIGHT theme (see :root[data-theme="light"] in style.css)
     so the exported report reads as the same product, not a generic blue template. */
  --ink:#0d1033;--ink-muted:#6370a0;--ink-hint:#b0b8d8;--primary:#4977fd;--primary-lt:#eaf0ff;
  --success:#18a958;--success-lt:#e8f7ee;--danger:#e8294a;--danger-lt:#fdf0f2;
  --warn:#c8860a;--warn-lt:#fdf6e8;--sat-col:#7c93ff;
  --night:#6040c8;--night-lt:#efeafb;--day:#c8860a;--day-lt:#fdf6e8;
  --border:#e2e6f4;--bg:#fcfdff;--card:#fff;--radius:12px;}
.wt4-pdfdoc,.wt4-pdfdoc *{box-sizing:border-box;margin:0;padding:0;}
.wt4-pdfdoc .pdf-page{width:${CONTENT_PX_W}px;background:var(--card);color:var(--ink);overflow:hidden;}

.wt4-pdfdoc .doc-header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:22px;border-bottom:2px solid var(--border);margin-bottom:26px;}
.wt4-pdfdoc .doc-logo{display:flex;align-items:center;gap:12px;}
.wt4-pdfdoc .doc-logo-icon{width:46px;height:46px;flex-shrink:0;display:flex;align-items:center;justify-content:center;}
.wt4-pdfdoc .doc-logo-text{font-size:18px;font-weight:700;letter-spacing:-0.03em;}
.wt4-pdfdoc .doc-logo-r{color:#8b5cf6;}
.wt4-pdfdoc .doc-logo-sub{font-size:12px;color:var(--ink-muted);margin-top:2px;font-weight:500;}
.wt4-pdfdoc .doc-meta{text-align:right;}
.wt4-pdfdoc .doc-title{font-size:24px;font-weight:800;letter-spacing:-0.04em;}
.wt4-pdfdoc .doc-period{font-size:14px;color:var(--primary);font-weight:600;margin-top:5px;}
.wt4-pdfdoc .doc-generated{font-size:11px;color:var(--ink-hint);margin-top:7px;}

.wt4-pdfdoc .cont-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;border-bottom:1px solid var(--border);margin-bottom:18px;font-size:11px;color:var(--ink-muted);}
.wt4-pdfdoc .cont-header b{color:var(--ink);font-weight:700;}

.wt4-pdfdoc .kpi-row{display:flex;gap:14px;margin-bottom:30px;}
.wt4-pdfdoc .kpi{flex:1 1 0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:15px 14px;position:relative;overflow:hidden;}
.wt4-pdfdoc .kpi::after{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:#7c93ff;border-radius:3px 3px 0 0;}
.wt4-pdfdoc .kpi.kpi--hrs::after{background:#8f9bf7;}
.wt4-pdfdoc .kpi.kpi--gross::after{background:#a78bfa;}
.wt4-pdfdoc .kpi.kpi--net::after{background:var(--success);}
.wt4-pdfdoc .kpi-lbl{font-size:9.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:7px;padding-right:36px;}
.wt4-pdfdoc .kpi-val{font-size:21px;font-weight:800;letter-spacing:-0.04em;line-height:1;color:var(--ink);}
.wt4-pdfdoc .kpi-val.green{color:var(--success);}
.wt4-pdfdoc .kpi-val.purple{color:#a78bfa;}
.wt4-pdfdoc .kpi-val.blue{color:#7c93ff;}
.wt4-pdfdoc .kpi-val.grad{color:#8f7bf0;}
.wt4-pdfdoc .kpi-sub{font-size:10.5px;color:var(--ink-hint);margin-top:5px;font-weight:500;}
/* Icon badge, top-right of each KPI card — soft tinted square, accent glyph */
.wt4-pdfdoc .kpi-icon{position:absolute;top:14px;right:13px;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;}
.wt4-pdfdoc .kpi-icon--purple{background:#f1ecfe;color:#a78bfa;}
.wt4-pdfdoc .kpi-icon--blue{background:#eaf0ff;color:#7c93ff;}
.wt4-pdfdoc .kpi-icon--grad{background:#eef0ff;}
.wt4-pdfdoc .kpi-icon--green{background:var(--success-lt);color:var(--success);}

/* 4대 보험 breakdown — full-width card below the KPI row.
   Header (icon + title + summary, rate pill) over a nested row of the four
   insurances plus a highlighted TOTAL DEDUCTION cell. */
.wt4-pdfdoc .insb{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:30px;}
.wt4-pdfdoc .insb-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px;}
.wt4-pdfdoc .insb-head-left{display:flex;align-items:center;gap:11px;}
.wt4-pdfdoc .insb-icon{width:34px;height:34px;border-radius:9px;background:var(--danger-lt);color:var(--danger);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.wt4-pdfdoc .insb-title{font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink);}
.wt4-pdfdoc .insb-subtitle{font-size:10.5px;color:var(--ink-muted);margin-top:3px;}
.wt4-pdfdoc .insb-rate-pill{background:var(--danger-lt);border-radius:10px;padding:8px 16px;text-align:center;flex-shrink:0;}
.wt4-pdfdoc .insb-rate-pct{font-size:15px;font-weight:800;color:var(--danger);letter-spacing:-0.02em;line-height:1;}
.wt4-pdfdoc .insb-rate-lbl{font-size:8px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--danger);opacity:0.85;margin-top:3px;}
.wt4-pdfdoc .insb-grid{display:flex;gap:0;background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
.wt4-pdfdoc .insb-cell{flex:1 1 0;padding:13px 15px;border-right:1px solid var(--border);min-width:0;}
.wt4-pdfdoc .insb-cell:last-child{border-right:none;}
.wt4-pdfdoc .insb-cell-name{font-size:10.5px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.wt4-pdfdoc .insb-cell-pct{font-size:10px;color:var(--ink-muted);margin-top:6px;}
.wt4-pdfdoc .insb-cell-amt{font-size:12.5px;font-weight:700;color:var(--danger);margin-top:6px;white-space:nowrap;}
.wt4-pdfdoc .insb-cell--total{flex:1.15 1 0;background:#fafbfe;display:flex;flex-direction:column;justify-content:center;}
.wt4-pdfdoc .insb-total-lbl{font-size:9.5px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--ink-muted);}
.wt4-pdfdoc .insb-total-amt{font-size:15px;font-weight:800;margin-top:5px;letter-spacing:-0.02em;color:var(--danger);}

.wt4-pdfdoc .section-heading{font-size:10.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:13px;padding-bottom:7px;border-bottom:1px solid var(--border);}

.wt4-pdfdoc .month-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:24px;}
.wt4-pdfdoc .month-summary{flex:1 1 220px;max-width:280px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;}
.wt4-pdfdoc .month-name{font-size:13.5px;font-weight:700;margin-bottom:11px;letter-spacing:-0.02em;}
.wt4-pdfdoc .month-stats{display:flex;flex-wrap:wrap;gap:7px;}
.wt4-pdfdoc .ms{flex:1 1 45%;display:flex;flex-direction:column;gap:2px;}
.wt4-pdfdoc .ms--net{flex:1 1 100%;border-top:1px solid var(--border);padding-top:7px;flex-direction:row;justify-content:space-between;align-items:center;}
.wt4-pdfdoc .ms--ded{flex:1 1 100%;flex-direction:row;justify-content:space-between;align-items:center;}
.wt4-pdfdoc .ded-val{color:var(--danger)!important;font-size:13px!important;font-weight:600;}
.wt4-pdfdoc .ms-lbl{font-size:9.5px;color:var(--ink-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;}
.wt4-pdfdoc .ms-val{font-size:13.5px;font-weight:700;}
.wt4-pdfdoc .net-val{color:var(--success)!important;font-size:15.5px!important;}
.wt4-pdfdoc .auto-tag{font-size:9px;background:#eaf0ff;color:#6c86ff;padding:1px 5px;border-radius:4px;font-weight:600;margin-left:4px;}

.wt4-pdfdoc .legend{display:flex;flex-wrap:wrap;gap:10px 20px;margin-bottom:22px;}
.wt4-pdfdoc .legend-item{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--ink-muted);}
.wt4-pdfdoc .legend-swatch{width:10px;height:10px;border-radius:3px;flex-shrink:0;}

.wt4-pdfdoc table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10.5px;}
.wt4-pdfdoc col.c-date{width:9%;} .wt4-pdfdoc col.c-day{width:6%;} .wt4-pdfdoc col.c-type{width:31%;}
.wt4-pdfdoc col.c-reg{width:6%;} .wt4-pdfdoc col.c-ot{width:6%;}
.wt4-pdfdoc col.c-eff{width:7%;} .wt4-pdfdoc col.c-rate{width:9%;} .wt4-pdfdoc col.c-gross{width:9%;}
.wt4-pdfdoc col.c-tax{width:8%;} .wt4-pdfdoc col.c-net{width:9%;}

.wt4-pdfdoc thead tr{background:var(--ink);color:#fff;}
.wt4-pdfdoc thead th{padding:9px 7px;text-align:right;font-size:9px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;white-space:nowrap;overflow:hidden;}
.wt4-pdfdoc thead th:nth-child(1),.wt4-pdfdoc thead th:nth-child(2),.wt4-pdfdoc thead th:nth-child(3){text-align:left;}

.wt4-pdfdoc tbody tr td{padding:7px 7px;border-bottom:1px solid var(--border);vertical-align:middle;overflow:hidden;}
.wt4-pdfdoc tbody tr.even td{background:#fafbfe;}
.wt4-pdfdoc .td-date{font-weight:600;white-space:nowrap;}
.wt4-pdfdoc .td-day{color:var(--ink-muted);font-size:9px;}
.wt4-pdfdoc .td-type{font-size:9px;}
.wt4-pdfdoc .td-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.wt4-pdfdoc .td-num.eff{color:var(--primary);font-weight:600;}
.wt4-pdfdoc .td-num.tax{color:var(--danger);}
.wt4-pdfdoc .td-num.net{color:var(--success);font-weight:700;}

/* Row highlights by day type. Holidays = red, Saturdays = purple (our gradient
   purple), Sundays = gradient blue. Auto-credited days keep their day-type
   colour (auto is a reason, not a type) — no separate amber row anymore. */
.wt4-pdfdoc .hol-row td{background:rgba(232,41,74,0.06)!important;}
.wt4-pdfdoc .hol-row td:first-child{border-left:3px solid var(--danger);}
.wt4-pdfdoc .sat-row td{background:rgba(167,139,250,0.10)!important;}
.wt4-pdfdoc .sat-row td:first-child{border-left:3px solid #a78bfa;}
.wt4-pdfdoc .sun-row td:first-child{border-left:3px solid #7c93ff;}

.wt4-pdfdoc .hol-badge,.wt4-pdfdoc .auto-badge{display:inline;font-size:8.5px;margin-left:6px;font-weight:700;white-space:nowrap;}
.wt4-pdfdoc .hol-badge{color:var(--danger);}
.wt4-pdfdoc .auto-badge{letter-spacing:0.04em;}
.wt4-pdfdoc .auto-badge--hol{color:var(--danger);}
.wt4-pdfdoc .auto-badge--sun{color:#6c86ff;}

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
function fmtYM(ym, lang = getLang()) {
  const [y, m] = ym.split('-');
  return `${tFor(lang, 'mn')[parseInt(m) - 1]} ${y}`;
}

function buildColgroup(includeEarnings = true) {
  return `<colgroup><col class="c-date"><col class="c-day"><col class="c-type"><col class="c-reg"><col class="c-ot"><col class="c-eff"><col class="c-rate">${includeEarnings ? '<col class="c-gross"><col class="c-tax"><col class="c-net">' : ''}</colgroup>`;
}

// ── HTML block builders ──────────────────────────────────────────────────────
// Every builder takes `lang` as its first argument — the chosen report
// language, which may differ from the app's current UI language.
function buildHeaderHTML(lang, periodLabel, generatedDate) {
  return `
    <div class="doc-header">
      <div class="doc-logo">
        <div class="doc-logo-icon">
          <svg width="46" height="46" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Shiftr" style="display:block;">
            <defs>
              <linearGradient id="docmk-tileBg" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
                <stop offset="0" stop-color="#dfe4ff"/>
                <stop offset="1" stop-color="#eceffe"/>
              </linearGradient>
              <radialGradient id="docmk-tileGlow" cx="0.5" cy="0" r="0.92" gradientUnits="objectBoundingBox">
                <stop offset="0" stop-color="#4977fd" stop-opacity="0.20"/>
                <stop offset="0.62" stop-color="#4977fd" stop-opacity="0"/>
              </radialGradient>
              <linearGradient id="docmk-g" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
                <stop offset="0" stop-color="#4977fd"/>
                <stop offset="1" stop-color="#8b5cf6"/>
              </linearGradient>
              <filter id="docmk-sShadow" x="-40%" y="-40%" width="180%" height="180%">
                <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="rgba(73,119,253,0.35)"/>
              </filter>
              <clipPath id="docmk-tileClip"><rect width="96" height="96" rx="26"/></clipPath>
            </defs>
            <g clip-path="url(#docmk-tileClip)">
              <rect width="96" height="96" fill="#eef1ff"/>
              <rect width="96" height="96" fill="url(#docmk-tileBg)"/>
              <rect width="96" height="96" fill="url(#docmk-tileGlow)"/>
              <rect x="0" y="0" width="96" height="1.4" fill="rgba(255,255,255,0.7)"/>
              <path d="M8.034 21.684Q5.928 21.684 4.316 20.93Q2.704 20.176 1.794 18.772Q0.884 17.368 0.884 15.392V14.664H4.264V15.392Q4.264 17.03 5.278 17.849Q6.292 18.668 8.034 18.668Q9.802 18.668 10.673 17.966Q11.544 17.264 11.544 16.172Q11.544 15.418 11.115 14.95Q10.686 14.482 9.867 14.183Q9.048 13.884 7.878 13.624L7.28 13.494Q5.408 13.078 4.069 12.441Q2.73 11.804 2.015 10.764Q1.3 9.724 1.3 8.06Q1.3 6.396 2.093 5.213Q2.886 4.03 4.329 3.393Q5.772 2.756 7.722 2.756Q9.672 2.756 11.193 3.419Q12.714 4.082 13.585 5.395Q14.456 6.708 14.456 8.684V9.464H11.076V8.684Q11.076 7.644 10.673 7.007Q10.27 6.37 9.516 6.071Q8.762 5.772 7.722 5.772Q6.162 5.772 5.421 6.357Q4.68 6.942 4.68 7.956Q4.68 8.632 5.031 9.1Q5.382 9.568 6.084 9.88Q6.786 10.192 7.878 10.426L8.476 10.556Q10.426 10.972 11.869 11.622Q13.312 12.272 14.118 13.338Q14.924 14.404 14.924 16.068Q14.924 17.732 14.079 18.993Q13.234 20.254 11.687 20.969Q10.14 21.684 8.034 21.684Z" fill="url(#docmk-g)" filter="url(#docmk-sShadow)" transform="translate(25.867 14.333) scale(2.7333)"/>
            </g>
            <rect x="0.5" y="0.5" width="95" height="95" rx="25.5" fill="none" stroke="rgba(73,119,253,0.18)"/>
          </svg>
        </div>
        <div>
          <div class="doc-logo-text">Shift<span class="doc-logo-r">r</span></div>
          <div class="doc-logo-sub">${tFor(lang, 'exportPayStatement')}</div>
        </div>
      </div>
      <div class="doc-meta">
        <div class="doc-title">${tFor(lang, 'exportReportTitle')}</div>
        <div class="doc-period">${periodLabel}</div>
        <div class="doc-generated">${tFor(lang, 'exportGenerated', generatedDate)}</div>
      </div>
    </div>`;
}

function buildContHeaderHTML(lang, periodLabel, pageNum, totalPages) {
  return `
    <div class="cont-header">
      <span><b>Shiftr</b> — ${tFor(lang, 'exportReportTitle')}</span>
      <span>${periodLabel} · ${pageNum}/${totalPages}</span>
    </div>`;
}

function buildKpiHTML(lang, daysWorked, autoDays, totEff, totGross, totNet, totTax, taxPct, includeEarnings = true) {
  const icoDays  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
  // Eff. Hours icon uses a purple→blue GRADIENT stroke (rendered reliably via
  // an in-SVG linearGradient, unlike gradient text which html2canvas breaks).
  const icoHrs   = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="url(#kpiGrad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="kpiGrad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7c93ff"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;
  const icoGross = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>`;
  const icoNet   = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
  return `
    <div class="kpi-row">
      <div class="kpi">
        <div class="kpi-icon kpi-icon--blue">${icoDays}</div>
        <div class="kpi-lbl">${tFor(lang, 'exportKpiDays')}</div>
        <div class="kpi-val blue">${daysWorked + autoDays}</div>
        <div class="kpi-sub">${tFor(lang, 'exportKpiDaysSub', daysWorked, autoDays)}</div>
      </div>
      <div class="kpi kpi--hrs">
        <div class="kpi-icon kpi-icon--grad">${icoHrs}</div>
        <div class="kpi-lbl">${tFor(lang, 'exportKpiHours')}</div>
        <div class="kpi-val grad">${totEff.toFixed(1)}${tFor(lang, 'hoursUnit')}</div>
        <div class="kpi-sub">${tFor(lang, 'exportKpiHoursSub')}</div>
      </div>
      ${includeEarnings ? `
      <div class="kpi kpi--gross">
        <div class="kpi-icon kpi-icon--purple">${icoGross}</div>
        <div class="kpi-lbl">${tFor(lang, 'exportKpiGross')}</div>
        <div class="kpi-val purple">${fmtKRW(totGross)}</div>
        <div class="kpi-sub">${getDeductionMode() === 'insurance'
          ? `${tFor(lang, 'exportKpiBefore') || 'Before'} ${dedNoun(lang)}`
          : tFor(lang, 'exportKpiGrossSub', taxPct)}</div>
      </div>
      <div class="kpi kpi--net">
        <div class="kpi-icon kpi-icon--green">${icoNet}</div>
        <div class="kpi-lbl">${tFor(lang, 'exportKpiNet')}</div>
        <div class="kpi-val green">${fmtKRW(totNet)}</div>
        <div class="kpi-sub">${tFor(lang, 'exportKpiNetSub', taxPct, fmtKRW(totTax))}</div>
      </div>` : ''}
    </div>
    ${includeEarnings && getDeductionMode() === 'insurance' ? buildInsuranceBreakdownHTML(lang, totGross) : ''}`;
}

// Insurance breakdown card (full width, below the KPI row). Header with icon +
// title + summary and a deduction-rate pill; a nested row of the four insurances
// followed by a highlighted TOTAL DEDUCTION cell.
function buildInsuranceBreakdownHTML(lang, totGross) {
  const ins = getInsurance();
  const carePct = careRateOfGross(ins);
  const parts = [
    [tFor(lang, 'insPension')    || 'National Pension',     ins.pension],
    [tFor(lang, 'insHealth')     || 'Health Insurance',     ins.health],
    [tFor(lang, 'insCare')       || 'Long-term Care',       carePct],
    [tFor(lang, 'insEmployment') || 'Employment Insurance', ins.employment],
  ];
  const cells = parts.map(([name, pct]) => {
    const amt = Math.round(totGross * (pct / 100));
    return `<div class="insb-cell">
      <div class="insb-cell-name">${name}</div>
      <div class="insb-cell-pct">${Math.round(pct * 1000) / 1000}%</div>
      <div class="insb-cell-amt">−${fmtKRW(amt)}</div>
    </div>`;
  }).join('');
  const totalPct = Math.round(insuranceRatePct(ins) * 100) / 100;
  const totalAmt = Math.round(totGross * (insuranceRatePct(ins) / 100));
  const shield = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
  return `<div class="insb">
    <div class="insb-head">
      <div class="insb-head-left">
        <div class="insb-icon">${shield}</div>
        <div>
          <div class="insb-title">${tFor(lang, 'insBreakdownTitle') || 'Insurance Breakdown'}</div>
          <div class="insb-subtitle">${tFor(lang, 'insBreakdownSummary')
            ? tFor(lang, 'insBreakdownSummary', 4, fmtKRW(totalAmt), totalPct)
            : `4 insurances · Total deduction ${fmtKRW(totalAmt)} (${totalPct}%)`}</div>
        </div>
      </div>
      <div class="insb-rate-pill">
        <div class="insb-rate-pct">${totalPct}%</div>
        <div class="insb-rate-lbl">${tFor(lang, 'insDeductionRate') || 'Total Deduction Rate'}</div>
      </div>
    </div>
    <div class="insb-grid">
      ${cells}
      <div class="insb-cell insb-cell--total">
        <div class="insb-cell-name insb-total-lbl">${tFor(lang, 'insTotalDeduction') || 'Total Deduction'}</div>
        <div class="insb-cell-amt insb-total-amt">−${fmtKRW(totalAmt)}</div>
      </div>
    </div>
  </div>`;
}

function buildMonthGridHTML(lang, byMonth, includeEarnings = true) {
  const cards = Object.entries(byMonth).map(([ym, mrows]) => {
    const mGross = mrows.reduce((s, r) => s + r.gross, 0);
    const mNet   = mrows.reduce((s, r) => s + r.net, 0);
    const mDays  = mrows.filter(r => !r.autoCredit || r.regHrs > 0 || r.otHrs > 0).length;
    const mAuto  = mrows.filter(r => r.autoCredit && r.regHrs === 0 && r.otHrs === 0).length;
    const mEff   = mrows.reduce((s, r) => s + r.effHrs, 0);
    return `
      <div class="month-summary">
        <div class="month-name">${fmtYM(ym, lang)}</div>
        <div class="month-stats">
          <div class="ms"><span class="ms-lbl">${tFor(lang, 'exportDaysWorked')}</span><span class="ms-val">${mDays}${mAuto ? ` <span class="auto-tag">${tFor(lang, 'exportAutoTag', mAuto)}</span>` : ''}</span></div>
          <div class="ms"><span class="ms-lbl">${tFor(lang, 'exportEffHours')}</span><span class="ms-val">${mEff.toFixed(1)}${tFor(lang, 'hoursUnit')}</span></div>
          ${includeEarnings ? `
          <div class="ms"><span class="ms-lbl">${tFor(lang, 'exportGross')}</span><span class="ms-val">${fmtKRW(mGross)}</span></div>
          <div class="ms ms--ded"><span class="ms-lbl">${dedNoun(lang)}</span><span class="ms-val ded-val">−${fmtKRW(mGross - mNet)}</span></div>
          <div class="ms ms--net"><span class="ms-lbl">${tFor(lang, 'exportNetPay')}</span><span class="ms-val net-val">${fmtKRW(mNet)}</span></div>` : ''}
        </div>
      </div>`;
  }).join('');
  return `<div class="section-heading">${tFor(lang, 'exportMonthlyBreakdown')}</div><div class="month-grid">${cards}</div>`;
}

function buildLegendHTML(lang) {
  return `
    <div class="legend">
      <div class="legend-item"><div class="legend-swatch" style="background:var(--danger);"></div>${tFor(lang, 'exportLegendHoliday')}</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#a78bfa;"></div>${tFor(lang, 'exportLegendSaturday')}</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#7c93ff;"></div>${tFor(lang, 'exportLegendSunday')}</div>
    </div>`;
}

function buildTheadHTML(lang, taxPct, includeEarnings = true) {
  return `<thead><tr>
    <th>${tFor(lang, 'exportColDate')}</th><th>${tFor(lang, 'exportColDay')}</th><th>${tFor(lang, 'exportColType')}</th>
    <th>${tFor(lang, 'exportColRegH')}</th><th>${tFor(lang, 'exportColOTH')}</th><th>${tFor(lang, 'exportColEffH')}</th>
    <th>${tFor(lang, 'exportColRate')}</th>
    ${includeEarnings ? `<th>${tFor(lang, 'exportColGross')}</th><th>${dedCol(lang)}</th><th>${tFor(lang, 'exportColNet')}</th>` : ''}
  </tr></thead>`;
}

function buildRowHTML(lang, r, idx, includeEarnings = true) {
  const dow = dowOf(r.date);
  const isSundayRow = dow === 0, isSaturdayRow = dow === 6;
  // Day type drives the row styling — a holiday or Sunday keeps its own colour
  // even when it was auto-credited (auto is a reason, not a day type).
  const rowClass = r.holiday ? 'hol-row' : (isSundayRow ? 'sun-row' : (isSaturdayRow ? 'sat-row' : ''));
  const holBadge  = r.holiday ? `<span class="hol-badge">${r.holiday}</span>` : '';
  // AUTO badge takes the colour of its day type: red on holidays, purple on Sundays.
  const autoClass = r.holiday ? 'auto-badge--hol' : (isSundayRow ? 'auto-badge--sun' : '');
  const autoBadge = r.autoCredit ? `<span class="auto-badge ${autoClass}">${tFor(lang, 'exportAutoBadge')}</span>` : '';
  return `
    <tr class="${rowClass}${idx % 2 === 0 ? ' even' : ''}">
      <td class="td-date">${r.date}</td>
      <td class="td-day">${r.dayOfWeek}</td>
      <td class="td-type">${r.type}${holBadge}${autoBadge}</td>
      <td class="td-num">${r.regHrs > 0 ? r.regHrs : (r.autoCredit ? '8*' : '—')}</td>
      <td class="td-num">${r.otHrs > 0 ? r.otHrs : '—'}</td>
      <td class="td-num eff">${r.effHrs.toFixed(2)}</td>
      <td class="td-num">${fmtKRW(r.hourlyRate)}</td>
      ${includeEarnings ? `
      <td class="td-num">${fmtKRW(r.gross)}</td>
      <td class="td-num tax">−${fmtKRW(r.taxAmt)}</td>
      <td class="td-num net">${fmtKRW(r.net)}</td>` : ''}
    </tr>`;
}

function buildTfootHTML(lang, totEff, totGross, totTax, totNet, includeEarnings = true) {
  return `<tfoot><tr class="totals-row">
    <td colspan="3" style="text-align:left;font-size:10px;letter-spacing:0.04em;">${tFor(lang, 'exportTotal')}</td>
    <td class="td-num"></td><td class="td-num"></td>
    <td class="td-num eff">${totEff.toFixed(2)}${tFor(lang, 'hoursUnit')}</td>
    <td class="td-num"></td>
    ${includeEarnings ? `
    <td class="td-num">${fmtKRW(totGross)}</td>
    <td class="td-num tax">−${fmtKRW(totTax)}</td>
    <td class="td-num net">${fmtKRW(totNet)}</td>` : ''}
  </tr></tfoot>`;
}

function buildFooterHTML(lang, periodLabel, taxPct, generatedDate) {
  const dedClauseKey = getDeductionMode() === 'insurance' ? 'exportFootnoteInsClause' : 'exportFootnoteTaxClause';
  const dedClause = tFor(lang, dedClauseKey, taxPct);
  return `
    <div class="doc-footer">
      <div class="footer-left">Shiftr · ${tFor(lang, 'exportReportTitle')}<br>${periodLabel} · ${dedNoun(lang)}: ${Math.round(taxPct * 100) / 100}%</div>
      <div class="footer-right">${tFor(lang, 'exportFooterGenBy')}<br>${generatedDate}</div>
    </div>
    <div class="footer-note">${tFor(lang, 'exportFootnote', taxPct, dedClause).replace(/\n/g, '<br>')}</div>`;
}

// ── PDF export entry point ───────────────────────────────────────────────────
// `lang` is the report's chosen language — independent of the app's current
// UI language, so a report can be generated in a different language than
// whatever the app happens to be displaying right now.
export async function exportPDF(fromYM, toYM, lang = getLang(), opts = {}) {
  let rows = buildRows(fromYM, toYM, lang);
  if (!rows.length) { alert(t('exportNoData')); return; }
  rows = applyExportOpts(rows, opts);
  if (!rows.length) { alert(t('exportNoData')); return; }

  const { jsPDF, html2canvas } = await loadPdfLibs();
  const fontStack = await ensurePdfFont(lang);
  ensurePdfStylesheet();

  const taxPct     = Math.round(deductionPct() * 10000) / 10000;
  const totGross   = rows.reduce((s, r) => s + r.gross, 0);
  const totTax     = rows.reduce((s, r) => s + r.taxAmt, 0);
  const totNet     = rows.reduce((s, r) => s + r.net, 0);
  const totEff     = rows.reduce((s, r) => s + r.effHrs, 0);
  const daysWorked = rows.filter(r => !r.autoCredit || r.regHrs > 0 || r.otHrs > 0).length;
  const autoDays   = rows.filter(r => r.autoCredit && r.regHrs === 0 && r.otHrs === 0).length;

  const byMonth = {};
  rows.forEach(r => { const ym = r.date.slice(0, 7); (byMonth[ym] ??= []).push(r); });

  const localeMap = { ko: 'ko-KR', th: 'th-TH', ru: 'ru-RU', zh: 'zh-CN', fr: 'fr-FR', id: 'id-ID', ne: 'ne-NP' };
  const generatedDate = new Date().toLocaleDateString(localeMap[lang] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const periodLabel = fromYM === toYM ? fmtYM(fromYM, lang) : `${fmtYM(fromYM, lang)} – ${fmtYM(toYM, lang)}`;

  const includeEarnings = opts.includeEarnings !== false;
  const includeMonthly  = opts.includeMonthly !== false;

  const headerHTML = buildHeaderHTML(lang, periodLabel, generatedDate)
    + buildKpiHTML(lang, daysWorked, autoDays, totEff, totGross, totNet, totTax, taxPct, includeEarnings)
    + (includeMonthly ? buildMonthGridHTML(lang, byMonth, includeEarnings) : '')
    + buildLegendHTML(lang);
  const footerHTML = buildFooterHTML(lang, periodLabel, taxPct, generatedDate);

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
    measCont.innerHTML = buildContHeaderHTML(lang, periodLabel, 1, 1);
    root.appendChild(measCont);

    const measTable = document.createElement('table');
    measTable.style.width = CONTENT_PX_W + 'px';
    measTable.innerHTML = buildColgroup(includeEarnings) + buildTheadHTML(lang, taxPct, includeEarnings)
      + `<tbody>${rows.map((r, i) => buildRowHTML(lang, r, i, includeEarnings)).join('')}</tbody>`
      + buildTfootHTML(lang, totEff, totGross, totTax, totNet, includeEarnings);
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

      let html = p.isFirst ? headerHTML : buildContHeaderHTML(lang, periodLabel, i + 1, total);
      if (p.rowEnd > p.rowStart || p.includeTfoot) {
        const slice = rows.slice(p.rowStart, p.rowEnd);
        html += `<table>${buildColgroup(includeEarnings)}${buildTheadHTML(lang, taxPct, includeEarnings)}<tbody>${
          slice.map((r, j) => buildRowHTML(lang, r, p.rowStart + j, includeEarnings)).join('')
        }</tbody>${p.includeTfoot ? buildTfootHTML(lang, totEff, totGross, totTax, totNet, includeEarnings) : ''}</table>`;
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
    const pdfFilename = `shiftr-${fromYM}-to-${toYM}.pdf`;
    pdf.save(pdfFilename);
    showExportToast(t('exportSavedToast', pdfFilename));

  } finally {
    document.body.removeChild(root);
  }
}

// NOTE: the export-card MARKUP is built by app.js (buildExportCardInline);
// this module only wires its behavior (wireExportCard below). The former
// buildExportCard() HTML builder was removed as dead code — app.js diverged
// to its own inline version and never imported this one.

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
    const langSel = document.getElementById('exp-pdf-lang');
    btn.disabled = true;
    btn.innerHTML = `<svg class="exp-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-9-9"/></svg>${t('exportPDFGenerating')}`;
    try {
      await exportPDF(fromSel.value, toSel.value, langSel?.value || getLang());
    } catch (err) {
      console.warn('[export] PDF generation failed:', err);
      alert(t('exportPDFError'));
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });
}
