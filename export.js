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
// DEPENDENCIES: none — uses only browser APIs already available in the app.
//   PDF is generated via a hidden iframe + window.print() with @media print CSS.
//   CSV is a plain Blob download. No external libraries needed.
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

  // From logs
  Object.keys(logs).forEach(ds => {
    if (ds <= today) set.add(ds.slice(0, 7));
  });

  // Auto-credited days (sundays/holidays) also produce data for a month
  const hols = getHolidays();
  Object.keys(hols).forEach(ds => {
    if (ds <= today && isHolAuto()) set.add(ds.slice(0, 7));
  });

  return [...set].sort();
}

// ── Build rows for a date range ───────────────────────────────────────────────
function buildRows(fromYM, toYM) {
  const logs = getLogs();
  const holidays = getHolidays();
  const today = todayStr();
  const rows = [];

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
      } else if (isHol && holCredit) {
        gross = Math.round(8 * wage); net = applyTax(gross); eff = 8; autoCredit = true;
      } else if (sun) {
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
        holiday: isHol ? (holidays[ds] || '') : '',
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

// ── PDF export ────────────────────────────────────────────────────────────────
function exportPDF(fromYM, toYM) {
  const rows = buildRows(fromYM, toYM);
  if (!rows.length) { alert(t('exportNoData')); return; }

  const taxPct = getTaxRate();
  const totGross = rows.reduce((s, r) => s + r.gross, 0);
  const totTax   = rows.reduce((s, r) => s + r.taxAmt, 0);
  const totNet   = rows.reduce((s, r) => s + r.net, 0);
  const totEff   = rows.reduce((s, r) => s + r.effHrs, 0);
  const daysWorked = rows.filter(r => !r.autoCredit || r.regHrs > 0 || r.otHrs > 0).length;
  const autoDays   = rows.filter(r => r.autoCredit && r.regHrs === 0 && r.otHrs === 0).length;

  // Group by month for section headers
  const byMonth = {};
  rows.forEach(r => {
    const ym = r.date.slice(0, 7);
    if (!byMonth[ym]) byMonth[ym] = [];
    byMonth[ym].push(r);
  });

  const mnames = t('mn');
  function fmtYM(ym) {
    const [y, m] = ym.split('-');
    return `${mnames[parseInt(m) - 1]} ${y}`;
  }
  function fmtKRW(n) { return '₩' + n.toLocaleString('en-US'); }

  // Build month summary cards HTML
  const monthCards = Object.entries(byMonth).map(([ym, mrows]) => {
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

  // Build detailed table rows HTML
  const tableRows = rows.map((r, i) => {
    const isHoliday = !!r.holiday;
    const isSundayRow = dowOf(r.date) === 0;
    const isSaturdayRow = dowOf(r.date) === 6;
    const rowClass  = r.autoCredit ? 'auto-row' : (isHoliday ? 'hol-row' : (isSundayRow ? 'sun-row' : (isSaturdayRow ? 'sat-row' : '')));
    const holBadge  = r.holiday ? `<span class="hol-badge">${r.holiday}</span>` : '';
    const autoBadge = r.autoCredit ? `<span class="auto-badge">AUTO</span>` : '';
    return `
      <tr class="${rowClass}${i % 2 === 0 ? ' even' : ''}">
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
  }).join('');

  const generatedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const periodLabel = fromYM === toYM ? fmtYM(fromYM) : `${fmtYM(fromYM)} – ${fmtYM(toYM)}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Work Hour Tracker — ${periodLabel}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --ink:       #0d1033;
    --ink-muted: #6370a0;
    --ink-hint:  #b0b8d8;
    --primary:   #3a5fff;
    --primary-lt:#eef1ff;
    --success:   #18a958;
    --success-lt:#e8f7ee;
    --danger:    #e8294a;
    --danger-lt: #fdf0f2;
    --warn:      #d4870a;
    --warn-lt:   #fef8ed;
    --sat-col:   #2060e8;
    --border:    #e2e6f4;
    --bg:        #f8f9fe;
    --card:      #ffffff;
    --radius:    12px;
  }

  html { font-size: 10pt; }

  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
    line-height: 1.5;
  }

  /* ── Page shell ── */
  .page {
    max-width: 860px;
    margin: 0 auto;
    padding: 40px 32px 60px;
    background: var(--card);
    min-height: 100vh;
  }

  /* ── Header ── */
  .doc-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 24px;
    border-bottom: 2px solid var(--border);
    margin-bottom: 32px;
  }
  .doc-logo {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .doc-logo-icon {
    width: 40px; height: 40px;
    background: linear-gradient(135deg, #3a5fff 0%, #6c8eff 100%);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
  .doc-logo-text { font-size: 16px; font-weight: 700; letter-spacing: -0.03em; color: var(--ink); }
  .doc-logo-sub  { font-size: 11px; color: var(--ink-muted); margin-top: 1px; font-weight: 500; }
  .doc-meta { text-align: right; }
  .doc-title  { font-size: 22px; font-weight: 800; letter-spacing: -0.04em; color: var(--ink); }
  .doc-period { font-size: 13px; color: var(--primary); font-weight: 600; margin-top: 4px; }
  .doc-generated { font-size: 10px; color: var(--ink-hint); margin-top: 6px; }

  /* ── KPI strip ── */
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 28px;
  }
  .kpi {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 14px;
    position: relative;
    overflow: hidden;
  }
  .kpi::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: var(--primary);
    border-radius: 99px 99px 0 0;
  }
  .kpi.kpi--net::before  { background: var(--success); }
  .kpi.kpi--tax::before  { background: var(--danger); }
  .kpi.kpi--hrs::before  { background: var(--warn); }
  .kpi-lbl { font-size: 9px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-muted); margin-bottom: 6px; }
  .kpi-val { font-size: 20px; font-weight: 800; letter-spacing: -0.04em; color: var(--ink); line-height: 1; }
  .kpi-val.green { color: var(--success); }
  .kpi-val.red   { color: var(--danger); }
  .kpi-val.blue  { color: var(--primary); }
  .kpi-val.amber { color: var(--warn); }
  .kpi-sub { font-size: 10px; color: var(--ink-hint); margin-top: 4px; font-weight: 500; }

  /* ── Section heading ── */
  .section-heading {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
    margin-bottom: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }

  /* ── Month summary cards ── */
  .month-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
    margin-bottom: 36px;
  }
  .month-summary {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .month-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--ink);
    margin-bottom: 10px;
    letter-spacing: -0.02em;
  }
  .month-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .ms { display: flex; flex-direction: column; gap: 2px; }
  .ms--net { border-top: 1px solid var(--border); padding-top: 6px; grid-column: span 2; flex-direction: row; justify-content: space-between; align-items: center; }
  .ms-lbl { font-size: 9px; color: var(--ink-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .ms-val { font-size: 13px; font-weight: 700; color: var(--ink); }
  .net-val { color: var(--success) !important; font-size: 15px !important; }
  .auto-tag { font-size: 9px; background: var(--warn-lt); color: var(--warn); padding: 1px 5px; border-radius: 4px; font-weight: 600; margin-left: 4px; }

  /* ── Detail table ── */
  .table-wrap { overflow-x: auto; margin-bottom: 24px; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9.5pt;
  }
  thead tr {
    background: var(--ink);
    color: #fff;
  }
  thead th {
    padding: 9px 8px;
    text-align: right;
    font-size: 8.5pt;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  thead th:first-child,
  thead th:nth-child(2),
  thead th:nth-child(3),
  thead th:nth-child(4) { text-align: left; }

  tbody tr td {
    padding: 7px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  tbody tr.even td { background: #fafbfe; }

  .td-date { font-weight: 600; color: var(--ink); white-space: nowrap; }
  .td-day  { color: var(--ink-muted); font-size: 8.5pt; }
  .td-type { color: var(--ink); font-size: 8.5pt; }
  .td-shift { font-size: 8.5pt; color: var(--ink-muted); }
  .td-num  { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .td-num.eff   { color: var(--primary); font-weight: 600; }
  .td-num.tax   { color: var(--danger); }
  .td-num.net   { color: var(--success); font-weight: 700; }

  /* Row type tints */
  .hol-row  td:first-child { border-left: 3px solid var(--danger); }
  .sun-row  td:first-child { border-left: 3px solid #e8294a88; }
  .sat-row  td:first-child { border-left: 3px solid var(--sat-col); }
  .auto-row td { background: var(--warn-lt) !important; }
  .auto-row td:first-child { border-left: 3px solid var(--warn); }

  /* Badges */
  .hol-badge {
    display: inline-block;
    font-size: 7.5pt;
    background: var(--danger-lt);
    color: var(--danger);
    padding: 1px 5px;
    border-radius: 4px;
    margin-left: 5px;
    font-weight: 600;
    white-space: nowrap;
  }
  .auto-badge {
    display: inline-block;
    font-size: 7.5pt;
    background: var(--warn-lt);
    color: var(--warn);
    padding: 1px 5px;
    border-radius: 4px;
    margin-left: 5px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  /* Totals row */
  .totals-row td {
    background: var(--primary-lt) !important;
    font-weight: 700;
    border-top: 2px solid var(--primary);
    border-bottom: none;
    font-size: 9.5pt;
  }
  .totals-row .td-num.net { font-size: 11pt; }

  /* ── Footer ── */
  .doc-footer {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .footer-left  { font-size: 9px; color: var(--ink-hint); line-height: 1.6; }
  .footer-right { font-size: 9px; color: var(--ink-hint); text-align: right; }
  .footer-note  { font-size: 8.5pt; color: var(--ink-hint); margin-top: 20px; line-height: 1.7; }

  /* ── Legend ── */
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
    margin-top: 12px;
    margin-bottom: 32px;
  }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 9pt; color: var(--ink-muted); }
  .legend-swatch { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }

  /* ── Print ── */
  @media print {
    body { background: #fff; }
    .page { padding: 20px 24px; min-height: auto; }
    .doc-header { margin-bottom: 20px; padding-bottom: 16px; }
    .kpi-row { gap: 8px; margin-bottom: 20px; }
    .month-grid { margin-bottom: 24px; }
    table { font-size: 8.5pt; }
    thead th { font-size: 7.5pt; padding: 7px 6px; }
    tbody tr td { padding: 5px 6px; }
    .td-num { font-size: 8pt; }
    .doc-footer { margin-top: 24px; }
    /* Keep table header on each page */
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    /* Avoid row breaks inside a single row */
    tbody tr { page-break-inside: avoid; }
    /* Month summaries: try to keep on same page */
    .month-summary { page-break-inside: avoid; }
    /* Force page break before detail table if needed */
    .detail-section { page-break-before: auto; }
    @page {
      size: A4 landscape;
      margin: 16mm 14mm;
    }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
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
  </div>

  <!-- KPI strip -->
  <div class="kpi-row">
    <div class="kpi">
      <div class="kpi-lbl">${t('exportKpiDays')}</div>
      <div class="kpi-val blue">${daysWorked + autoDays}</div>
      <div class="kpi-sub">${t('exportKpiDaysSub', daysWorked, autoDays)}</div>
    </div>
    <div class="kpi kpi--hrs">
      <div class="kpi-lbl">${t('exportKpiHours')}</div>
      <div class="kpi-val amber">${totEff.toFixed(1)}h</div>
      <div class="kpi-sub">${t('exportKpiHoursSub')}</div>
    </div>
    <div class="kpi">
      <div class="kpi-lbl">${t('exportKpiGross')}</div>
      <div class="kpi-val">${fmtKRW(totGross)}</div>
      <div class="kpi-sub">${t('exportKpiGrossSub', taxPct)}</div>
    </div>
    <div class="kpi kpi--net">
      <div class="kpi-lbl">${t('exportKpiNet')}</div>
      <div class="kpi-val green">${fmtKRW(totNet)}</div>
      <div class="kpi-sub">${t('exportKpiNetSub', taxPct, fmtKRW(totTax))}</div>
    </div>
  </div>

  <!-- Monthly breakdown -->
  <div class="section-heading">${t('exportMonthlyBreakdown')}</div>
  <div class="month-grid">
    ${monthCards}
  </div>

  <!-- Legend -->
  <div class="legend">
    <div class="legend-item"><div class="legend-swatch" style="background:#e8294a;"></div> ${t('exportLegendHoliday')}</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#e8294a88;"></div> ${t('exportLegendSunday')}</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#2060e8;"></div> ${t('exportLegendSaturday')}</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#d4870a;"></div> ${t('exportLegendAuto')}</div>
  </div>

  <!-- Detail table -->
  <div class="detail-section">
    <div class="section-heading">${t('exportDailyDetail')}</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>${t('exportColDate')}</th>
            <th>${t('exportColDay')}</th>
            <th>${t('exportColType')}</th>
            <th>${t('exportColShift')}</th>
            <th>${t('exportColRegH')}</th>
            <th>${t('exportColOTH')}</th>
            <th>${t('exportColEffH')}</th>
            <th>${t('exportColRate')}</th>
            <th>${t('exportColGross')}</th>
            <th>${t('exportColTax', taxPct)}</th>
            <th>${t('exportColNet')}</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
        <tfoot>
          <tr class="totals-row">
            <td colspan="4" style="text-align:left;font-size:9pt;letter-spacing:0.04em;">${t('exportTotal')}</td>
            <td class="td-num"></td>
            <td class="td-num"></td>
            <td class="td-num eff">${totEff.toFixed(2)}h</td>
            <td class="td-num"></td>
            <td class="td-num">${fmtKRW(totGross)}</td>
            <td class="td-num tax">−${fmtKRW(totTax)}</td>
            <td class="td-num net">${fmtKRW(totNet)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>

  <!-- Footer -->
  <div class="doc-footer">
    <div class="footer-left">
      Work Hour Tracker · ${t('exportReportTitle')}<br>
      ${t('exportFooterPeriod', periodLabel, taxPct)}
    </div>
    <div class="footer-right">
      ${t('exportFooterGenBy')}<br>
      ${generatedDate}
    </div>
  </div>

  <div class="footer-note">
    ${t('exportFootnote', taxPct).replace(/\n/g, '<br>')}
  </div>

</div>
</body>
</html>`;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();

  // Give fonts and styles time to load, then print
  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      // Fallback: open in new tab
      const blob = new Blob([html], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank');
    }
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }, 800);
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

  document.getElementById('exp-pdf')?.addEventListener('click', () => {
    if (!validate()) return;
    exportPDF(fromSel.value, toSel.value);
  });
}
