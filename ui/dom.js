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
  // Wait for the exit animation that is ACTUALLY in effect instead of a fixed
  // 190ms. Below 540px the panel now slides out over --dur-slow (320ms, to
  // match the date-range sheet); above it the centered dialog still uses
  // --dur-base. The old constant removed the node partway through the longer
  // slide, so the sheet vanished mid-flight instead of finishing.
  // Reduced motion sets animation:none, which reads as 0 and closes at once.
  let ms = 0;
  overlays.forEach(el => {
    [el, el.querySelector('.modal')].forEach(n => {
      if(!n) return;
      const cs = getComputedStyle(n);
      const dur = parseFloat(cs.animationDuration) || 0;
      const delay = parseFloat(cs.animationDelay) || 0;
      ms = Math.max(ms, (dur + delay) * 1000);
    });
  });
  setTimeout(() => {
    overlays.forEach(el => el.remove());
    callback();
  }, Math.round(ms) + 30);
}

export const escHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
