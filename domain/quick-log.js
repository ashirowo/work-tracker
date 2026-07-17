// ─────────────────────────────────────────────────────────────────────────────
// domain/quick-log.js — one-tap default inference (Phase 4).
//
// Works out the user's "usual" hours so a single tap can log a normal shift.
// Strategy (strongest signal first):
//   1. Look at recent logs of the SAME shift type (day/night) as the target.
//   2. Find the modal (most common) regular-hours value among them.
//   3. Only trust it if it's consistent enough (the confidence gate) —
//      otherwise the user is irregular and one-tap is not offered.
// Overtime is never assumed: the default is always OT = 0.
// Bodies verbatim from app.js; env is the same capability record earnings.js
// documents.
// ─────────────────────────────────────────────────────────────────────────────

import { calcWageIn } from './earnings.js';

export const QUICK_LOG_MIN_SAMPLES = 3;     // need at least this many same-type logs
export const QUICK_LOG_MIN_CONFIDENCE = 0.7; // ≥70% must share the modal hours value

// Returns { regHrs, otHrs, shift } or null when there isn't enough confident
// signal to offer a one-tap log.
export function defaultLogForIn(env, dateStr){
  const shift = env.shiftFor(dateStr); // day/night/(double never auto-defaulted)
  if(shift==='double') return null; // doubles are deliberate — never one-tap
  const logs = env.getLogs();
  // Gather regular-hours from recent logs of the same shift type, newest first.
  const sameType = Object.keys(logs)
    .filter(d => d <= env.todayStr())
    .sort().reverse()
    .map(d => ({ d, log: logs[d] }))
    .filter(({d, log}) => {
      if(!log || typeof log.regHrs !== 'number' || log.regHrs <= 0) return false;
      const s = log.shiftOverride || env.shiftFor(d);
      return s === shift;
    })
    .slice(0, 12); // recent window

  if(sameType.length < QUICK_LOG_MIN_SAMPLES) return null;

  // Modal (most frequent) regular-hours value.
  const counts = {};
  sameType.forEach(({log}) => { counts[log.regHrs] = (counts[log.regHrs]||0)+1; });
  let bestHrs = null, bestCount = 0;
  Object.entries(counts).forEach(([hrs, n]) => { if(n > bestCount){ bestCount = n; bestHrs = parseFloat(hrs); } });

  // Confidence gate: the modal value must dominate, else the user is irregular.
  const confidence = bestCount / sameType.length;
  if(confidence < QUICK_LOG_MIN_CONFIDENCE) return null;

  return { regHrs: bestHrs, otHrs: 0, shift };
}

// Build a full log entry (same shape as the modal's save path) for a one-tap log.
export function buildQuickLogEntryIn(env, dateStr){
  const def = defaultLogForIn(env, dateStr);
  if(!def) return null;
  const wage = env.wageFor(dateStr);
  const c = calcWageIn(env, dateStr, def.regHrs, def.otHrs, wage, def.shift, undefined);
  const weekShift = env.shiftFor(dateStr);
  const override = def.shift !== weekShift ? def.shift : undefined;
  return {
    regHrs: def.regHrs, otHrs: def.otHrs, hrs: def.regHrs + def.otHrs,
    gross: c.gross, net: c.net, eff: c.eff,
    ...(override && { shiftOverride: override }),
  };
}
