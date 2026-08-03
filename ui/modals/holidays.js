// ─────────────────────────────────────────────────────────────────────────────
// ui/modals/holidays.js — the All-Holidays modal (Phase 7).
//
// Read-only: lists upcoming public holidays from the app-owned holiday map.
// Opened from the Settings holiday card. app.js passes a small ctx of the
// app-bound accessors it can't import (t, holName, the live holiday map, the
// current language, and the pinned "today"); everything else is a real import.
// Body verbatim from app.js.
// ─────────────────────────────────────────────────────────────────────────────

import { pd } from '../../core/dates.js';
import { TR } from '../../translations.js';
import { upcomingHolCutoff } from '../../data/holidays.js';
import { attachSheetGestures } from '../motion.js';
import { animateModalClose } from '../dom.js';

export function buildAllHolidaysModal(ctx) {
  const { t, holName, todayStr, holidays, lang } = ctx;
  const td = todayStr();
  const cutoff = upcomingHolCutoff();
  const upcoming = Object.keys(holidays).filter(ds => ds >= td && ds <= cutoff).sort();

  function rowHTML(ds) {
    const d = pd(ds);
    const tr2 = TR[lang] || TR.en;
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
    <div class="wm-scroll">
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

  // Was a bare ov.remove() — the only sheet that vanished instantly instead of
  // sliding out, which read as a glitch next to the others.
  const close = () => {
    animateModalClose('#all-hol-modal-ov', () => {
      document.body.classList.remove('modal-open');
    });
  };
  attachSheetGestures(ov, close);   // renders as a bottom sheet below 540px
  document.getElementById('all-hol-close').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
}
