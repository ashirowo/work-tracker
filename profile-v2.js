// ─────────────────────────────────────────────────────────────────────────────
// profile-v2.js — the v2 workplace schema and its lowering to v1 tables.
// Phase 5.1.
//
// DESIGN: the golden-proven v1 engine (calc.js) interprets BRACKET TABLES.
// Rather than rewrite that engine, v2 is an AUTHORING form that expresses night
// premium ADDITIVELY (base multiplier + a night adder on the night hours), and
// `normalizeProfile()` lowers a v2 profile into the exact v1 execution tables
// the engine already runs. So:
//   • the engine never changes — the golden gate stays bit-for-bit;
//   • v2 gains the additive night model + schedule separation you ratified;
//   • a v1 profile passes through untouched (back-compat + grandfathering).
//
// WHY ADDITIVE (근로기준법 §56, researched): Korean premiums stack by ADDITION
// on the ordinary wage — overtime +50%, night +50%, independently — so a night
// bracket is just `base` on all hours plus `prem` on the hours in the night
// window. Verified to reproduce every factory golden value.
//
// ── v2 SCHEMA (only the fields that differ from v1) ──────────────────────────
//   v: 2
//   night: {                      ← NEW, top-level night pricing
//     window: { start:'22:00', end:'06:00' },   // legal night period
//     prem:   0.5,                              // additive adder (+50%)
//     mode:   'threshold' | 'overlap',
//   }
//   schedule: {                   ← NEW, USER config (not preset data)
//     night: { start:'20:30', end:'05:30', breakMin:60, breakNightMin:30 },
//   }                              // required by 'overlap'; ignored by 'threshold'
//   rates[class][shift] = { base, ot, plainHours? }   ← cells hold a BASE
//     multiplier + OT, NOT night brackets. For a night shift:
//       mode:'threshold' → plainHours (per cell) is the negotiated plain cap
//                          (the factory's 5.68). Bracket: [{upTo:plainHours,
//                          mult:base},{mult:base+prem}].
//       mode:'overlap'   → the plain cap is DERIVED from schedule ∩ window
//                          (paid hours outside the window stay at base; hours
//                          inside get base+prem). Needs schedule.night.
//   Day-shift cells and non-night classes: [{mult:base}] as before.
//
// A missing schedule under 'overlap' lowers to base-only night hours (zero
// premium) — never a guess, never a crash; the UI nudges the user to set times.
// ─────────────────────────────────────────────────────────────────────────────

export const PROFILE_SCHEMA_V2 = 2;

const r4 = x => +(+x).toFixed(4);
const r2 = x => +(+x).toFixed(2);

function parseHM(s){
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if(!m) return null;
  const h = +m[1], min = +m[2];
  if(h > 24 || min > 59) return null;
  return h * 60 + min;
}

// Paid night minutes for a shift schedule intersected with the night window.
// Mirrors compile.js window math: cross-midnight handled; the window is
// projected onto the shift timeline at ±24h.
//
// BREAKS — three forms, anchored wins:
//  • schedule.break = { start, end }  (HH:MM) — an ANCHORED unpaid break. It is
//    projected onto the shift timeline like the window and subtracted from the
//    runs it actually overlaps: a 02:00–03:00 break inside a 22:00–06:00
//    premium window removes 60 PREMIUM minutes, exactly as worked reality.
//    (Legacy stored form — the UI now authors the duration pair below.)
//  • schedule.breakMin = N + schedule.breakNightMin = M — the DURATION pair the
//    UI collects: N total unpaid minutes, of which M fall inside the premium
//    window. M is taken from premium runs, N−M from plain runs (tail-most);
//    if either side runs short the remainder spills to the other, so the total
//    deduction is always N (clamped to the shift).
//  • schedule.breakMin = N alone — oldest count-only fallback, deducted from
//    PLAIN runs first (tail-most), then premium — the original documented
//    rule, kept for stored profiles that predate the forms above.
export function nightHoursOf(schedule, window){
  const s = parseHM(schedule && schedule.start), e0 = parseHM(schedule && schedule.end);
  const ws = parseHM(window && window.start), we0 = parseHM(window && window.end);
  if(s == null || e0 == null || ws == null || we0 == null) return null;
  let e = e0; if(e <= s) e += 1440;
  let we = we0; if(we <= ws) we += 1440;

  const spans = [];
  for(const off of [-1440, 0, 1440]){
    const a = Math.max(s, ws + off), b = Math.min(e, we + off);
    if(b > a) spans.push([a, b]);
  }
  spans.sort((a, b) => a[0] - b[0]);

  // Runs as INTERVALS over the shift's absolute timeline (not just minute
  // counts) so an anchored break can be subtracted where it actually falls.
  const runs = [];
  let cur = s;
  for(const [a, b] of spans){
    if(a > cur) runs.push({ premium: false, a: cur, b: a });
    runs.push({ premium: true, a, b });
    cur = b;
  }
  if(cur < e) runs.push({ premium: false, a: cur, b: e });
  for(const rn of runs) rn.min = rn.b - rn.a;

  const brkT = schedule.break;
  const bs = parseHM(brkT && brkT.start), be0 = parseHM(brkT && brkT.end);
  if(bs != null && be0 != null && bs !== be0){
    // Anchored break: project onto the timeline (±24h, cross-midnight) and
    // remove the overlap from each run it intersects.
    let be = be0; if(be <= bs) be += 1440;
    for(const off of [-1440, 0, 1440]){
      const a = Math.max(s, bs + off), b = Math.min(e, be + off);
      if(b <= a) continue;
      for(const rn of runs){
        const cut = Math.min(rn.b, b) - Math.max(rn.a, a);
        if(cut > 0) rn.min -= cut;
      }
    }
  }else{
    // eat() removes `amt` minutes from runs of one kind (tail-most first) and
    // returns whatever it couldn't take.
    const eat = (wantPrem, amt) => {
      for(let i = runs.length - 1; i >= 0 && amt > 0; i--){
        if(runs[i].premium !== wantPrem) continue;
        const take = Math.min(runs[i].min, amt);
        runs[i].min -= take; amt -= take;
      }
      return amt;
    };
    const tot = (schedule.breakMin || 0);
    if(schedule.breakNightMin != null){
      // Duration pair: the stated night portion comes out of premium runs, the
      // rest out of plain runs; shortfalls spill to the other side so the
      // total deduction stays `tot` (clamped to the shift's paid minutes).
      const nMin = Math.max(0, Math.min(schedule.breakNightMin, tot));
      let rem = eat(true, nMin) + eat(false, tot - nMin);
      if(rem > 0) eat(true, eat(false, rem));
    }else{
      // Legacy count-only break: plain runs first (tail-most), then premium.
      eat(true, eat(false, tot));
    }
  }

  let plain = 0, night = 0;
  for(const rn of runs){ if(rn.premium) night += rn.min; else plain += rn.min; }
  return { plainHours: r2(plain / 60), nightHours: r2(night / 60) };
}

// True if the shift's scheduled END falls inside the night window — i.e. OT
// worked immediately after the shift begins in-window (for the night-OT adder).
function scheduledEndInWindow(sched, window){
  const s = parseHM(sched && sched.start), e0 = parseHM(sched && sched.end);
  const ws = parseHM(window && window.start), we0 = parseHM(window && window.end);
  if(s == null || e0 == null || ws == null || we0 == null) return false;
  let e = e0; if(e <= s) e += 1440;
  const endMod = ((e % 1440) + 1440) % 1440;
  // window as a same-day interval, possibly wrapping midnight
  let a = ws, b = we0;
  if(b <= a){ // wraps midnight: in-window if >= start OR < end
    return endMod >= a || endMod < b;
  }
  return endMod >= a && endMod < b;
}

// Lower one v2 night cell → v1 bracket table. `plainCap` is the hours at base
// before the adder kicks in (from plainHours in threshold mode, or derived in
// overlap mode). prem 0 or no cap → flat base.
function nightCellToBrackets(base, prem, plainCap){
  if(!prem) return [{ mult: r4(base) }];
  if(plainCap == null) return [{ mult: r4(base) }];            // no schedule → base only
  if(plainCap <= 0)    return [{ mult: r4(base + prem) }];     // whole shift premium
  return [{ upTo: r2(plainCap), mult: r4(base) }, { mult: r4(base + prem) }];
}

function lowerCell(cell, isNight, night, schedule){
  if(!cell || cell.reg) return cell;                 // already a v1 cell — pass through
  const base = cell.base != null ? cell.base : 1;
  const ot   = cell.ot   != null ? cell.ot   : 1.5;
  if(!isNight) return { reg: [{ mult: r4(base) }], ot: r4(ot) };
  const prem = (night && night.prem) || 0;
  let plainCap = null;
  let otMult = ot;                                    // authored OT multiplier
  if(prem){
    if(night.mode === 'overlap'){
      const nh = schedule && schedule.night ? nightHoursOf(schedule.night, night.window) : null;
      // A shift with ZERO night hours has no premium tier — flat base cell.
      // (plainCap null → base-only bracket.) Only when night hours exist does
      // the plain cap = the pre-window paid hours.
      plainCap = (nh && nh.nightHours > 0) ? nh.plainHours : null;
      // §56: OT hours that fall in the night window stack the night adder on
      // top of the OT premium (연장 + 야간 = 각각 가산). In overlap mode, OT
      // hours immediately follow the scheduled shift end; if that end is inside
      // the night window, those OT hours are in-window → add the night adder.
      // If there is no schedule yet, we cannot classify → leave OT at base
      // (matches the base-only degradation of the regular hours).
      if(nh && nh.nightHours > 0 && scheduledEndInWindow(schedule.night, night.window)){
        otMult = ot + prem;
      }
    }else{                                            // 'threshold' (default)
      plainCap = cell.plainHours != null ? cell.plainHours : 0;
      // Threshold workplaces author night OT explicitly (the factory's 2.0×);
      // leave as-is — the golden suite pins it.
    }
  }
  return { reg: nightCellToBrackets(base, prem, plainCap), ot: r4(otMult) };
}

// Lower a whole v2 profile to a v1-shaped execution profile the engine runs.
// Idempotent on v1 input. Preserves source/schedule/night for round-tripping
// and UI, but the engine only ever reads rates/credits/composites.
export function normalizeProfile(profile){
  if(!profile || profile.v !== PROFILE_SCHEMA_V2) return profile;   // v1 or unknown: untouched
  const { night, schedule } = profile;
  const rates = {};
  for(const cls of Object.keys(profile.rates)){
    const entry = profile.rates[cls];
    if(entry.workedAs){ rates[cls] = { workedAs: entry.workedAs }; continue; }
    rates[cls] = {};
    for(const shift of Object.keys(entry)){
      rates[cls][shift] = lowerCell(entry[shift], shift === 'night', night, schedule);
    }
  }
  return {
    v: 1,                       // execution form
    id: profile.id,
    _v2: true,                  // provenance marker (harmless to the engine)
    shifts: (profile.shifts || []).map(s => typeof s === 'string' ? s : s.id),
    restDow: profile.restDow ?? 0,
    rates,
    credits: profile.credits,
    composites: profile.composites,
  };
}

// True if a v2 profile needs a night schedule it doesn't yet have — the UI uses
// this to prompt "set your shift times" (and to decide whether onboarding asks).
export function needsNightSchedule(profile){
  if(!profile || profile.v !== PROFILE_SCHEMA_V2) return false;
  const n = profile.night;
  if(!n || !n.prem || n.mode !== 'overlap') return false;
  const anyNight = profile.rates && Object.values(profile.rates)
    .some(e => e && e.night && !e.workedAs);
  return anyNight && !(profile.schedule && profile.schedule.night);
}
