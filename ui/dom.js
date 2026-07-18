// ─────────────────────────────────────────────────────────────────────────────
// ui/dom.js — small DOM utilities shared across the UI layer (Phase 6).
// escHTML: HTML-escape untrusted text for interpolation. animateModalClose:
// play the .closing exit animation, then remove overlays and run a callback.
// No app state, no imports. More utilities land here as their consumers move.
// ─────────────────────────────────────────────────────────────────────────────

export function animateModalClose(selector, callback) {
  const overlays = document.querySelectorAll(selector);
  if (!overlays.length) { callback(); return; }
  overlays.forEach(el => el.classList.add('closing'));
  // Use the animation duration from CSS (180ms). A small buffer ensures it's done.
  setTimeout(() => {
    overlays.forEach(el => el.remove());
    callback();
  }, 190);
}

export const escHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
