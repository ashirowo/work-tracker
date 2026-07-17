// ─────────────────────────────────────────────────────────────────────────────
// domain/shift-pattern.js — anchor-based shift inference (Phase 3).
//
// wt4_shifts is a map of week-Monday → 'day'|'night' ANCHORS. The most recent
// anchor at or before a week decides that week's shift; a rotation alternates
// by week-parity from the anchor; a fixed pattern (the two most recent anchors
// sharing one value) stops alternating. Bodies are verbatim from app.js
// (shiftFor / setShiftFromWeek) and export.js — the byte-duplicated inference
// algorithm now has ONE home.
//
// TWO fixed-pattern predicates exist ON PURPOSE (different semantics):
//   recentAnchorsFixedDay — app.js's storedPatternIsFixedDay rule: the two
//     most recent anchors ≤ the given week are BOTH 'day' (drives the
//     day-pattern workplace form).
//   allAnchorsSame — export.js's isFixedShiftPattern rule: ≥2 anchors, all
//     equal (drives the redundant shift-suffix omission in reports).
// Do not merge them.
// ─────────────────────────────────────────────────────────────────────────────

import { pd, getMonday } from '../core/dates.js';

// The shift for date-string s under anchor map sh (verbatim app.js shiftFor).
export function shiftForIn(sh, s){
  const ws=getMonday(s);
  const keys=Object.keys(sh).filter(k=>k<=ws).sort();
  if(!keys.length)return'day';
  const anchor=keys[keys.length-1];
  const anchorShift=sh[anchor];
  // Fixed-shift detection: if the two most recent anchors at or before this week
  // share the same value, the user is on a fixed pattern — skip the alternating formula.
  if(keys.length>=2 && sh[keys[keys.length-2]]===anchorShift) return anchorShift;
  const msPerWeek=7*24*3600*1000;
  const weeks=Math.round((pd(ws)-pd(anchor))/msPerWeek);
  return weeks%2===0?anchorShift:(anchorShift==='day'?'night':'day');
}

// Set the anchor for week ws, deleting superseded (≥ ws) anchors. MUTATES the
// passed map and returns it — the caller owns the object and persists it
// (matches setShiftFromWeek's original in-place behavior).
export function applyAnchor(shifts, ws, shift){
  Object.keys(shifts).filter(k=>k>=ws).forEach(k=>delete shifts[k]);
  shifts[ws]=shift;
  return shifts;
}

export function recentAnchorsFixedDay(shifts, weekMonday){
  const keys=Object.keys(shifts).filter(k=>k<=weekMonday).sort();
  if(keys.length<2) return false;
  return shifts[keys[keys.length-1]]==='day'&&shifts[keys[keys.length-2]]==='day';
}

export function allAnchorsSame(shifts){
  const vals=Object.values(shifts).filter(v=>v==='day'||v==='night');
  if(vals.length<2) return false;
  return vals.every(v=>v===vals[0]);
}
