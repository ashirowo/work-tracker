// ─────────────────────────────────────────────────────────────────────────────
// share.js — Phase 6.1: the workplace-sharing pipeline (pure module).
//
// Sharing turns a workplace profile into a small ENVELOPE that travels through
// an untrusted channel (a Firestore share doc, a pasted link, a backup file)
// and back into a profile another device can store. This module is the single
// choke point for BOTH directions:
//
//   packShare(profile)   → envelope    (strip personal data, whitelist-copy)
//   unpackShare(envelope) → { ok, profile } | { ok:false, error }
//
// Everything here happens UPSTREAM of the frozen engine: the output of a
// successful unpack is written to wt4_profile exactly like a wizard-authored
// profile, and getProfile()/normalizeProfile()/calc.js are untouched.
//
// TRUST MODEL — unpack input is HOSTILE. Firestore rules validate coarsely at
// write time, but the client never relies on that: the profile is rebuilt
// field-by-field from a whitelist (never stored by reference), every leaf is
// type- and range-checked, dynamic keys are token-validated (and __proto__/
// constructor/prototype are banned), and the result must survive an engine
// probe before it is offered for preview. Any violation rejects the WHOLE
// import — mirroring getProfile()'s wholesale-fallback rule: never half-run.
//
// WHAT IS NEVER SHARED (ratified: a schedule is one user's shift times, not
// workplace pay rules — and wages/logs are personal):
//   • profile.schedule           — stripped on pack AND on unpack
//   • profile.source.answers.schedule — same (the wizard state carries a copy)
//   • wages, logs, settings, identity — never enter the payload at all
//
// PIPELINE ORDER (unpack): envelope check → sanitize → migrate → engine probe.
// Sanitize runs BEFORE migrate so migration logic never touches hostile data.
//
// MIGRATION — migrateToLatest() raises v1 → v2 only when the raise is
// SELF-VERIFYING: the candidate v2 is lowered back through normalizeProfile()
// and must reproduce the v1 tables byte-for-byte, else the profile stays v1
// (which the engine runs natively — v1 is valid forever). Future schema bumps
// (v2 → v3) append to this chain; old envelopes stay importable.
//
// ERROR CODES (unpackShare): 'format'  — not a share envelope at all
//                            'version' — minted by a NEWER app; update to use
//                            'invalid' — structurally broken or tampered
//                            'engine'  — well-formed but the engine can't run it
// The UI maps these to translated messages; codes are stable API.
//
// SHARE CODES (Phase 6.2) — 8 chars of Crockford Base32 (no I/L/O/U), 40 bits
// from crypto.getRandomValues. The code IS the Firestore doc id in shares/.
// normalizeShareCode() is forgiving on entry (case, hyphens, the classic
// O↔0 / I,L↔1 transcription typos) — codes get handwritten on noticeboards.
// ─────────────────────────────────────────────────────────────────────────────

import { isUsableProfile } from './profile.js';
import { normalizeProfile } from './profile-v2.js';
import { calcDay } from './calc.js';

export const SHARE_FMT_V = 1;          // envelope format version (transport)
export const PROFILE_SCHEMA_LATEST = 2; // newest profile schema this app writes

const CLASSES = ['weekday', 'saturday', 'restday', 'holiday'];
const ALIAS_TARGETS = ['weekday', 'saturday'];
const CREDIT_WHENS = ['always', 'holAuto', 'never'];
const NAME_MAX = 60;

// ── Leaf validators ───────────────────────────────────────────────────────────
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
// Finite number in [min,max] (exclMin: strictly greater than min).
function num(x, min, max, exclMin){
  return typeof x === 'number' && Number.isFinite(x)
      && (exclMin ? x > min : x >= min) && x <= max;
}
// Identifier-ish string key: short, ASCII, and never a prototype-chain key.
function token(s, max){
  return typeof s === 'string' && s.length >= 1 && s.length <= max
      && /^[a-z0-9_-]+$/i.test(s) && !BAD_KEYS.has(s);
}
// HH:MM clock string — same acceptance as profile-v2.js's parseHM.
function isHM(s){
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof s === 'string' ? s : '');
  return !!m && +m[1] <= 24 && +m[2] <= 59;
}
function cleanName(s){
  if(typeof s !== 'string') return undefined;
  const nm = s.trim().slice(0, NAME_MAX);
  return nm || undefined;
}

// ── Sanitizers — whitelist REBUILD, never reference-copy ─────────────────────
// Each returns a fresh clean object, or null on any violation.

// One rate cell. Two accepted forms, exactly the two normalizeProfile takes:
//   v1 bracket cell  { reg:[{upTo?,mult}…], ot }   (also legal inside v2)
//   v2 additive cell { base, ot, plainHours? }
function sanitizeCell(c, v2){
  if(!isObj(c)) return null;
  if(c.reg !== undefined || !v2){
    if(!Array.isArray(c.reg) || c.reg.length < 1 || c.reg.length > 6) return null;
    if(!num(c.ot, 0, 10, true)) return null;
    const reg = []; let prev = 0;
    for(let i = 0; i < c.reg.length; i++){
      const b = c.reg[i], last = i === c.reg.length - 1;
      if(!isObj(b) || !num(b.mult, 0, 10, true)) return null;
      if(last){                                   // final bracket: open-ended
        if(b.upTo !== undefined && b.upTo !== null) return null;
        reg.push({ mult: b.mult });
      }else{                                      // thresholds strictly ascending
        if(!num(b.upTo, 0, 24, true) || b.upTo <= prev) return null;
        prev = b.upTo;
        reg.push({ upTo: b.upTo, mult: b.mult });
      }
    }
    return { reg, ot: c.ot };
  }
  if(!num(c.base, 0, 10, true) || !num(c.ot, 0, 10, true)) return null;
  const cell = { base: c.base, ot: c.ot };
  if(c.plainHours !== undefined){
    if(!num(c.plainHours, 0, 24)) return null;
    cell.plainHours = c.plainHours;
  }
  return cell;
}

function sanitizeRates(r, shifts, v2){
  if(!isObj(r)) return null;
  const out = {};
  for(const cls of CLASSES){
    const e = r[cls];
    if(!isObj(e)) return null;                    // all four classes required:
    if(e.workedAs !== undefined){                 // the engine indexes them all
      if(cls === 'weekday') return null;          // weekday anchors everything
      if(!ALIAS_TARGETS.includes(e.workedAs) || e.workedAs === cls) return null;
      out[cls] = { workedAs: e.workedAs };
      continue;
    }
    const entry = {};
    for(const sh of shifts){                      // a real class needs a cell
      const cell = sanitizeCell(e[sh], v2);       // for every declared shift;
      if(!cell) return null;                      // unknown cell keys are dropped
      entry[sh] = cell;
    }
    out[cls] = entry;
  }
  // Single-hop aliases only: mathClassOf follows ONE workedAs, and a pinned
  // composite table indexes its class directly — an alias chain would crash.
  for(const cls of CLASSES){
    const t = out[cls].workedAs;
    if(t && out[t].workedAs) return null;
  }
  return out;
}

function sanitizeCredits(c){
  if(!isObj(c)) return null;
  const out = {};
  for(const k of ['restday', 'holiday']){         // calcDay reads both unconditionally
    const e = c[k];
    if(!isObj(e) || !num(e.hours, 0, 24) || !CREDIT_WHENS.includes(e.when)) return null;
    out[k] = { hours: e.hours, when: e.when };
  }
  return out;
}

function sanitizeComposites(c, rates){
  // composites.double is REQUIRED: buildRulesRows (the import preview) reads
  // comp.parts unconditionally — every compiler-authored profile has it.
  if(!isObj(c) || !isObj(c.double)) return null;
  const out = {};
  for(const key of Object.keys(c)){
    if(!token(key, 24)) return null;
    const comp = c[key];
    if(!isObj(comp) || !Array.isArray(comp.parts)
       || comp.parts.length < 1 || comp.parts.length > 4) return null;
    if(!num(comp.ot, 0, 10, true)) return null;
    const parts = [];
    for(const pt of comp.parts){
      if(!isObj(pt) || !token(pt.shift, 24) || !num(pt.hours, 0, 24)) return null;
      if(pt.table !== 'inherit'){
        // A pinned table is indexed WITHOUT an alias hop (calc.js cellFor) —
        // it must name a class that holds real tables.
        if(!CLASSES.includes(pt.table) || rates[pt.table].workedAs) return null;
      }
      parts.push({ shift: pt.shift, hours: pt.hours, table: pt.table });
    }
    out[key] = { parts, ot: comp.ot };
  }
  return out;
}

// Wizard answers riding in source — round-trip sugar for "Edit workplace",
// NOT execution data. Malformed source is DROPPED (import continues); the
// editor falls back to default chips exactly as for a grandfathered profile.
function sanitizeAnswers(a){
  if(!isObj(a) || a.v !== 2) return null;
  const out = { v: 2 };
  if(a.pattern !== undefined){
    if(!['rotation', 'fixedDay', 'fixedNight'].includes(a.pattern)) return null;
    out.pattern = a.pattern;
  }
  if(a.shiftHours !== undefined){
    if(!num(a.shiftHours, 0, 24, true)) return null;
    out.shiftHours = a.shiftHours;
  }
  if(a.nightModel !== undefined){
    if(!['none', 'threshold', 'overlap'].includes(a.nightModel)) return null;
    out.nightModel = a.nightModel;
  }
  if(a.nightPrem !== undefined){
    if(!num(a.nightPrem, 0, 9)) return null;
    out.nightPrem = a.nightPrem;
  }
  if(a.plainHours !== undefined){
    if(!num(a.plainHours, 0, 24)) return null;
    out.plainHours = a.plainHours;
  }
  if(a.nightWindow !== undefined){
    if(!isObj(a.nightWindow) || !isHM(a.nightWindow.start) || !isHM(a.nightWindow.end)) return null;
    out.nightWindow = { start: a.nightWindow.start, end: a.nightWindow.end };
  }
  if(a.saturday !== undefined){
    const s = a.saturday;
    if(!isObj(s) || typeof s.extra !== 'boolean') return null;
    out.saturday = { extra: s.extra };
    if(s.mult !== undefined){
      if(!num(s.mult, 0, 10, true)) return null;
      out.saturday.mult = s.mult;
    }
  }
  if(a.holiday !== undefined){
    const h = a.holiday;
    if(!isObj(h) || typeof h.paidCredit !== 'boolean') return null;
    out.holiday = { paidCredit: h.paidCredit };
    if(h.creditHours !== undefined){
      if(!num(h.creditHours, 0, 24)) return null;
      out.holiday.creditHours = h.creditHours;
    }
    if(h.workedMult !== undefined){
      if(!num(h.workedMult, 0, 10, true)) return null;
      out.holiday.workedMult = h.workedMult;
    }
  }
  if(a.otDay !== undefined){
    if(!num(a.otDay, 0, 10, true)) return null;
    out.otDay = a.otDay;
  }
  if(a.otNight !== undefined){
    if(!num(a.otNight, 0, 10, true)) return null;
    out.otNight = a.otNight;
  }
  if(a.restDay !== undefined){
    const r = a.restDay;
    if(!isObj(r) || typeof r.paidCredit !== 'boolean') return null;
    out.restDay = {};
    if(r.dow !== undefined){
      if(!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) return null;
      out.restDay.dow = r.dow;
    }
    out.restDay.paidCredit = r.paidCredit;
    if(r.hours !== undefined){
      if(!num(r.hours, 0, 24)) return null;
      out.restDay.hours = r.hours;
    }
  }
  // a.schedule deliberately never copied — the sharer's shift times.
  return out;
}

function sanitizeSource(s){
  if(!isObj(s)) return null;
  if(s.kind !== 'preset' && s.kind !== 'wizard') return null;
  const out = { kind: s.kind };
  if(s.kind === 'preset'){
    if(!token(s.presetId, 40)) return null;
    out.presetId = s.presetId;
  }
  if(s.answers !== undefined){
    const a = sanitizeAnswers(s.answers);
    if(!a) return null;
    out.answers = a;
  }
  return out;
}

// The whole profile. Returns a clean rebuild or null. profile.schedule is
// NEVER copied — that is the strip, structural rather than an explicit delete.
function sanitizeProfile(p){
  if(!isObj(p)) return null;
  if(p.v !== 1 && p.v !== PROFILE_SCHEMA_LATEST) return null;
  const v2 = p.v === PROFILE_SCHEMA_LATEST;

  // id is provenance/debugging only — coerce rather than reject.
  const id = token(p.id, 40) ? p.id : 'shared';

  if(!Array.isArray(p.shifts) || p.shifts.length < 1 || p.shifts.length > 4) return null;
  const shifts = [];
  for(const s of p.shifts){
    const sid = typeof s === 'string' ? s : (isObj(s) ? s.id : null);
    if(!token(sid, 24)) return null;
    shifts.push(sid);
  }

  if(!Number.isInteger(p.restDow) || p.restDow < 0 || p.restDow > 6) return null;

  let night;
  if(v2){
    const n = p.night;
    if(!isObj(n) || !isObj(n.window) || !isHM(n.window.start) || !isHM(n.window.end)) return null;
    if(!num(n.prem, 0, 9)) return null;
    if(n.mode !== 'threshold' && n.mode !== 'overlap') return null;
    night = { window: { start: n.window.start, end: n.window.end }, prem: n.prem, mode: n.mode };
  }

  const rates = sanitizeRates(p.rates, shifts, v2);
  if(!rates) return null;
  const credits = sanitizeCredits(p.credits);
  if(!credits) return null;
  const composites = sanitizeComposites(p.composites, rates);
  if(!composites) return null;

  const out = { v: p.v, id, shifts, restDow: p.restDow };
  if(night) out.night = night;
  out.rates = rates;
  out.credits = credits;
  out.composites = composites;
  const source = sanitizeSource(p.source);      // malformed → dropped, not fatal
  if(source) out.source = source;
  return out;
}

// ── Migration — the schema-version chain ─────────────────────────────────────
// v1 → v2: RECOGNIZE the cell shapes the compilers emit (flat cell → base;
// two-bracket night cell → base + plainHours, with one consistent additive
// adder across all night cells), then SELF-VERIFY: lowering the candidate
// through normalizeProfile must reproduce the v1 tables byte-for-byte. Any
// mismatch — ambiguous shapes, exotic brackets, float dust — keeps the
// profile v1, which the engine runs natively. Never a guess.
function raiseV1(p){
  const rates = {};
  let prem = null;                                // adder inferred from night cells
  for(const cls of Object.keys(p.rates)){
    const e = p.rates[cls];
    if(e.workedAs){ rates[cls] = { workedAs: e.workedAs }; continue; }
    const entry = {};
    for(const sh of Object.keys(e)){
      const cell = e[sh], reg = cell.reg;
      if(reg.length === 1 && reg[0].upTo === undefined){
        entry[sh] = { base: reg[0].mult, ot: cell.ot };
      }else if(sh === 'night' && reg.length === 2
               && reg[0].upTo !== undefined && reg[1].upTo === undefined){
        const d = +(reg[1].mult - reg[0].mult).toFixed(4);
        if(d <= 0 || d > 9) return null;
        if(prem === null) prem = d;
        else if(prem !== d) return null;          // adders disagree → not additive
        entry[sh] = { base: reg[0].mult, ot: cell.ot, plainHours: reg[0].upTo };
      }else return null;                          // exotic shape → stays v1
    }
    rates[cls] = entry;
  }

  const candidate = {
    v: PROFILE_SCHEMA_LATEST,
    id: p.id,
    shifts: p.shifts,
    restDow: p.restDow,
    // Window is display metadata in threshold mode (plainHours drives the math).
    night: { window: { start: '22:00', end: '06:00' }, prem: prem || 0, mode: 'threshold' },
    rates,
    credits: p.credits,
    composites: p.composites,
  };
  if(p.source) candidate.source = p.source;

  const low = normalizeProfile(candidate);
  if(JSON.stringify(low.rates)      !== JSON.stringify(p.rates))      return null;
  if(JSON.stringify(low.credits)    !== JSON.stringify(p.credits))    return null;
  if(JSON.stringify(low.composites) !== JSON.stringify(p.composites)) return null;
  return candidate;
}

// Public: upgrade a (sanitized) profile to the newest schema this app writes.
// Unraisable profiles come back unchanged — older schemas stay valid forever.
export function migrateToLatest(profile){
  if(!isObj(profile) || profile.v !== 1) return profile;
  try{ return raiseV1(profile) || profile; }
  catch(e){ return profile; }
}

// ── Engine probe ──────────────────────────────────────────────────────────────
// A profile can be well-formed and still not runnable (e.g. a composite part
// naming a shift no class prices). Prove the engine executes every day-class ×
// shift × worked/unworked combination BEFORE the profile reaches preview —
// broken imports fail here, not in the user's daily view.
function probeProfile(p){
  try{
    if(!isUsableProfile(normalizeProfile(p))) return false;
    const shifts = [...p.shifts, ...Object.keys(p.composites)];
    for(const dayClass of CLASSES)
      for(const shift of shifts)
        for(const [regHrs, otHrs] of [[8, 2], [0, 0]])
          for(const holCredit of [true, false]){
            const r = calcDay(p, { dayClass, shift, regHrs, otHrs, holCredit });
            if(!r || typeof r.eff !== 'number' || !Number.isFinite(r.eff) || r.eff < 0)
              return false;
          }
    return true;
  }catch(e){ return false; }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Local profile → share envelope. The input is the app's OWN stored profile,
// so a failure here is a caller bug — it throws rather than returning codes.
// Output is sanitized (schedule + personal data stripped) and migrated, so
// every minted envelope carries the newest schema this app can express.
export function packShare(profile, opts = {}){
  const clean = sanitizeProfile(profile);
  if(!clean) throw new Error('packShare: profile is not shareable');
  const final = migrateToLatest(clean);
  const env = { fmt: SHARE_FMT_V, schemaV: final.v, profile: final };
  const nm = cleanName(opts.name);
  if(nm) env.name = nm;
  return env;
}

// Untrusted envelope → { ok:true, profile, name? } or { ok:false, error }.
// The returned profile is ready for preview (buildRulesRows) and — after the
// user confirms — for storage, exactly like a wizard-authored profile.
// Unknown envelope fields (createdAt, ownerUid, …) are transport metadata and
// are ignored. Never throws.
export function unpackShare(envelope){
  const ERR = e => ({ ok: false, error: e });
  try{
    if(!isObj(envelope)) return ERR('format');
    const { fmt, schemaV, profile } = envelope;
    if(!Number.isInteger(fmt) || fmt < 1) return ERR('format');
    if(fmt > SHARE_FMT_V) return ERR('version');
    if(!Number.isInteger(schemaV) || schemaV < 1) return ERR('format');
    if(schemaV > PROFILE_SCHEMA_LATEST) return ERR('version');
    if(!isObj(profile) || profile.v !== schemaV) return ERR('format');

    const clean = sanitizeProfile(profile);
    if(!clean) return ERR('invalid');
    const final = migrateToLatest(clean);
    if(!probeProfile(final)) return ERR('engine');

    const out = { ok: true, profile: final };
    const nm = cleanName(envelope.name);
    if(nm) out.name = nm;
    return out;
  }catch(e){ return { ok: false, error: 'invalid' }; }
}

// ── Share codes (Phase 6.2) ───────────────────────────────────────────────────
// Crockford Base32: digits + uppercase letters minus I, L, O, U — nothing a
// handwritten note can corrupt ambiguously. 8 symbols = 40 bits of entropy;
// the code is the exact Firestore doc id, so this regex must stay byte-equal
// to the one in firestore.rules' create clause.
export const SHARE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;

// Cryptographically random code. 256 % 32 === 0, so the byte→symbol map has
// no modulo bias.
export function generateShareCode(){
  const bytes = new Uint8Array(CODE_LEN);
  globalThis.crypto.getRandomValues(bytes);
  let code = '';
  for(const b of bytes) code += CODE_ALPHABET[b % 32];
  return code;
}

// User input → canonical code, or null. Forgiving: case-insensitive, ignores
// hyphens/spaces/punctuation, and applies Crockford's decode aliases
// (O → 0, I/L → 1). U stays invalid — it is not in the alphabet.
export function normalizeShareCode(input){
  if(typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[^0-9A-Z]/g, '')
                 .replace(/O/g, '0').replace(/[IL]/g, '1');
  return SHARE_CODE_RE.test(s) ? s : null;
}

// Display form: XXXX-XXXX (what share sheets and the entry field show).
export function formatShareCode(code){
  return code.slice(0, 4) + '-' + code.slice(4);
}
