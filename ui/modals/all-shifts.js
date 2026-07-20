// ─────────────────────────────────────────────────────────────────────────────
// ui/modals/all-shifts.js — the All-Shifts modal (Phase 7).
//
// Premium glass panel: sorting, shift-type filtering, pagination. Self-contained
// state (module-level) with surgical body patches (no full rebuilds). Opened
// from the Overview "View all" link and re-opened by the day-log modal's return
// trip. app.js passes ctx; a row click sets S.modal (opening the day-log modal
// via app's render) with a _returnToAllShifts snapshot, and closeModal reopens
// this modal via buildAllShiftsModal(ctx, restore). Bodies verbatim; the ctx
// members bind to module lets on each open (one modal at a time).
// ─────────────────────────────────────────────────────────────────────────────

import { animateModalClose } from '../dom.js';
import { entryHours } from '../../domain/log-entries.js';

// Persisted view state (survives the day-log round trip via _returnToAllShifts).
let _allShiftsSort   = 'date-desc';
let _allShiftsFilter = 'all';   // 'all' | 'day' | 'night' | 'double'
let _allShiftsPage   = 1;
let _allShiftsPerPage = 10;
// Bound from ctx on each open:
let t, render, getLogs, shiftFor, liveGross, applyTax, S, today;

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
      const { reg, ot } = entryHours(l);
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

export function buildAllShiftsModal(ctx, restore) {
  ({t,render,getLogs,shiftFor,liveGross,applyTax,S,today}=ctx);
  if(restore){_allShiftsPage=restore.page;_allShiftsSort=restore.sort;_allShiftsFilter=restore.filter;_allShiftsPerPage=restore.perPage;}
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


export function closeAllShiftsModal(){
  animateModalClose('#all-shifts-ov', () => {
    document.body.classList.remove('modal-open');
  });
}
