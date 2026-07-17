// ─────────────────────────────────────────────────────────────────────────────
// firebase.js — Cloud sync module for Shiftr
//
// ARCHITECTURE OVERVIEW:
// ┌─────────────┐    login/logout     ┌───────────────┐
// │   User UI   │ ──────────────────► │ Firebase Auth │
// └─────────────┘                     └───────┬───────┘
//       │                                     │ uid
//       │ data changes                        ▼
//       │                            ┌───────────────┐
//       ├──────────────────────────► │   Firestore   │  users/{uid}
//       │                            └───────┬───────┘
//       │                                    │ on login / on change
//       ▼                                    ▼
// ┌─────────────────────────────────────────────────────┐
// │               localStorage (primary cache)           │
// │  wt4_logs | wt4_shifts | wt4_wages | wt4_lang | ...  │
// └─────────────────────────────────────────────────────┘
//
// SYNC FLOW:
//  1. App starts → loads from localStorage instantly (no flicker)
//  2. Firebase SDK loads → Auth state resolves
//  3. If signed in → fetch Firestore doc → merge into localStorage → re-render
//  4. On any data change → debounced push to Firestore (if signed in)
//  5. If offline → changes accumulate in localStorage; Firestore SDK
//     queues writes and flushes automatically when connection restores
//
// AUTH FLOW:
//  1. User clicks "Sign in with Google" → Google popup
//  2. On success → onAuthStateChanged fires with user object
//  3. We pull cloud data, merge, render
//  4. On logout → clear auth state, keep localStorage intact
// ─────────────────────────────────────────────────────────────────────────────

// ── Firebase config ───────────────────────────────────────────────────────────
// Replace these values with your own Firebase project config.
// Get them from: Firebase Console → Project Settings → Your apps → Web app
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCRz4dSLxb3QKz6zDEOzW__cF-JgaIrAhA",
  authDomain:        "chugan-yagan.firebaseapp.com",
  projectId:         "chugan-yagan",
  storageBucket:     "chugan-yagan.firebasestorage.app",
  messagingSenderId: "216270497081",
  appId:             "1:216270497081:web:fc30f466986fce2cc2b4e8",
  measurementId: "G-EEMRJWTJKZ"
};

// ── Imports from Firebase CDN (ESM) ──────────────────────────────────────────
import { initializeApp }                              from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
                                                      from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, deleteDoc, serverTimestamp,
         collection, query, where, getDocs, Timestamp }
                                                      from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { generateShareCode } from './share.js';

// ── Init ──────────────────────────────────────────────────────────────────────
const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth        = getAuth(firebaseApp);
const db          = getFirestore(firebaseApp);
const provider    = new GoogleAuthProvider();

// ── Internal state ────────────────────────────────────────────────────────────
let _currentUser  = null;   // Firebase User object, or null
let _syncTimer    = null;   // debounce handle for push
let _syncPending  = false;  // true if a push is queued

// Keys we sync between localStorage and Firestore
// These must match the localStorage keys used in app.js
const SYNC_KEYS = {
  logs:     'wt4_logs',
  shifts:   'wt4_shifts',
  wages:    'wt4_wages',
  lang:     'wt4_lang',
  theme:    'wt4_theme',
  holAuto:  'wt4_hol_auto',
  taxRate:  'wt4_tax_rate',
  dedMode:  'wt4_deduction_mode',
  insurance:'wt4_insurance',
  profile:   'wt4_profile',   // pay profile — joined AFTER merge:true rollout (v46+)
  targetHrs: 'wt4_target_hrs', // monthly target hours
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {
    console.warn('[firebase] localStorage write failed:', e);
  }
}

// Firestore document reference for the signed-in user
function userDoc(uid) {
  return doc(db, 'users', uid);
}

// ── Pull: Firestore → localStorage ───────────────────────────────────────────
// Called once after sign-in. Merges cloud data into local storage.
// Cloud wins on conflict (it's the authoritative cross-device record),
// UNLESS the local copy is newer (based on updatedAt timestamps).
async function pullFromCloud(uid) {
  try {
    const snap = await getDoc(userDoc(uid));

    if (!snap.exists()) {
      // First-time user — no cloud data yet. Push local data up.
      console.log('[firebase] First-time user — pushing local data to cloud.');
      await pushToCloud(uid);
      return;
    }

    const cloud = snap.data();

    // Compare timestamps: if cloud is newer, merge it in
    const cloudTs = cloud.updatedAt?.toMillis?.() ?? 0;
    const localTs = lsGet('wt4_syncedAt', 0);

    if (cloudTs > localTs) {
      // Cloud is newer — overwrite local data
      console.log('[firebase] Cloud data is newer — loading from cloud.');
      if (cloud.logs    !== undefined) lsSet(SYNC_KEYS.logs,    cloud.logs);
      if (cloud.shifts  !== undefined) lsSet(SYNC_KEYS.shifts,  cloud.shifts);
      if (cloud.wages   !== undefined) lsSet(SYNC_KEYS.wages,   cloud.wages);
      if (cloud.lang    !== undefined) lsSet(SYNC_KEYS.lang,    cloud.lang);
      if (cloud.theme   !== undefined) lsSet(SYNC_KEYS.theme,   cloud.theme);
      if (cloud.holAuto !== undefined) lsSet(SYNC_KEYS.holAuto, cloud.holAuto);
      if (cloud.taxRate !== undefined) lsSet(SYNC_KEYS.taxRate, cloud.taxRate);
      if (cloud.dedMode !== undefined) lsSet(SYNC_KEYS.dedMode, cloud.dedMode);
      if (cloud.insurance !== undefined) lsSet(SYNC_KEYS.insurance, cloud.insurance);
      if (cloud.profile !== undefined && cloud.profile !== null) lsSet(SYNC_KEYS.profile, cloud.profile);
      if (cloud.targetHrs !== undefined) lsSet(SYNC_KEYS.targetHrs, cloud.targetHrs);
      lsSet('wt4_syncedAt', cloudTs);
      // Signal to completeOnboarding() that cloud data is now in localStorage,
      // so it should not overwrite wages/shifts with fresh onboarding defaults.
      lsSet('wt4_cloud_pulled', true);
      _setSyncStatus('synced');
    } else if (_syncPending) {
      // We have a genuine local change queued (from scheduleSync()) that
      // hasn't been pushed yet — e.g. an edit made just before this reload.
      // Push it now rather than losing it.
      console.log('[firebase] Pending local change — pushing to cloud.');
      await pushToCloud(uid);
    } else {
      // Nothing changed on either side — this is the common "just reopened
      // the app" case. Do NOT push: a push here would be a no-op write that
      // only serves to bump updatedAt/wt4_syncedAt on every single reload.
      console.log('[firebase] Already in sync — nothing to push.');
      _setSyncStatus('synced');
    }

    // Re-render app with newly merged data — go through setCURRENT_USER
    // so CURRENT_USER stays in sync; render() will be called inside it.
    window._appBridge?.render?.();

  } catch(e) {
    // Offline or Firestore error — silently continue with localStorage
    console.warn('[firebase] Pull failed (offline?):', e.message);
  }
}

// ── Push: localStorage → Firestore ───────────────────────────────────────────
// Writes current localStorage state to Firestore.
// Safe to call at any time; does nothing if not signed in.
async function pushToCloud(uid) {
  const targetUid = uid ?? _currentUser?.uid;
  if (!targetUid) return; // not signed in

  const payload = {
    logs:      lsGet(SYNC_KEYS.logs,    {}),
    shifts:    lsGet(SYNC_KEYS.shifts,  {}),
    wages:     lsGet(SYNC_KEYS.wages,   [{date:'2000-01-01',amount:10320}]),
    lang:      lsGet(SYNC_KEYS.lang,    'en'),
    theme:     lsGet(SYNC_KEYS.theme,   'dark'),
    holAuto:   lsGet(SYNC_KEYS.holAuto, true),
    taxRate:   lsGet(SYNC_KEYS.taxRate, 3.3),
    dedMode:   lsGet(SYNC_KEYS.dedMode, 'tax'),
    insurance: lsGet(SYNC_KEYS.insurance, {}),
    profile:   lsGet(SYNC_KEYS.profile, null),
    targetHrs: lsGet(SYNC_KEYS.targetHrs, 250),
    updatedAt: serverTimestamp(),
  };

  try {
    // ⚠ DO NOT ADD { merge: true } HERE. This has now been regressed twice
    // (added in "added google auth", removed in "Fix deleted logs reappearing
    // after Firestore sync", re-added by the "custom presets" refactor).
    //
    // WHY: Firestore's merge DEEP-MERGES nested map fields instead of
    // replacing them. logs/shifts/profile are maps, so a DELETED key (a
    // removed day, a cleared shift anchor, a dropped rate cell) has nothing to
    // merge and silently survives in the cloud forever — the next pull
    // resurrects it locally. It is NOT "behavior-identical": that only holds
    // for scalars and for `wages` (an array, which merge replaces wholesale).
    // For `profile` it is actively dangerous — a merged rates cell can carry
    // BOTH `workedAs` and day/night cells, and normalizeProfile() takes the
    // `workedAs` branch first, silently dropping a premium the user configured.
    //
    // THE TRADEOFF (deliberate): a full overwrite means a client that doesn't
    // know a field erases it. That is safe here BECAUSE the payload above
    // writes every field pullFromCloud reads — the doc we write is exactly the
    // doc we read. If you ever ADD a synced field, add it to SYNC_KEYS, this
    // payload, AND pullFromCloud together; do not reach for merge to paper
    // over a partial rollout (use { mergeFields: [...] }, which replaces the
    // named fields wholesale, if you truly need a staged one).
    await setDoc(userDoc(targetUid), payload);
    lsSet('wt4_syncedAt', Date.now());
    console.log('[firebase] Pushed to cloud.');
    _setSyncStatus('synced');
  } catch(e) {
    // Offline — Firestore SDK will retry automatically when back online
    console.warn('[firebase] Push failed (queued for retry):', e.message);
    _setSyncStatus('pending');
  }
}

// ── Debounced sync trigger ────────────────────────────────────────────────────
// Call this after any data change. Waits 1.5s of silence before pushing,
// so rapid edits (e.g. typing a wage) don't spam Firestore.
function scheduleSync() {
  if (!_currentUser) return; // not signed in — nothing to sync
  _syncPending = true;
  _setSyncStatus('pending');
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    pushToCloud(_currentUser.uid);
    _syncPending = false;
  }, 1500);
}

// ── Auth: Sign in with Google ─────────────────────────────────────────────────
async function signInWithGoogle() {
  // Guard: Google auth requires a live network connection.
  if (!navigator.onLine) {
    alert('You\'re offline. Please reconnect to the internet and try signing in again.');
    return;
  }
  try {
    await signInWithPopup(auth, provider);
    // onAuthStateChanged will handle the rest
  } catch(e) {
    if (e.code === 'auth/popup-blocked') {
      alert('Popup was blocked. Please allow popups for this site and try again.');
    } else if (e.code !== 'auth/popup-closed-by-user') {
      console.error('[firebase] Sign-in error:', e);
    }
  }
}

// ── Auth: Sign out ────────────────────────────────────────────────────────────
async function signOutUser() {
  clearTimeout(_syncTimer);
  // Push any pending changes before signing out
  if (_syncPending && _currentUser) {
    await pushToCloud(_currentUser.uid);
  }
  await signOut(auth);
  // _currentUser is cleared by onAuthStateChanged
}

// ── Sync status ───────────────────────────────────────────────────────────────
// Stored as a simple string so app.js can read it during render.
// 'idle' | 'pending' | 'synced' | 'offline'
let _syncStatus = 'idle';

function _setSyncStatus(status) {
  _syncStatus = status;
  // Re-render header in-place without rebuilding the whole app
  // app.js exports updateSyncUI() for this lightweight update
  window._appBridge?.updateSyncUI?.();
}

// ── Auth state observer ───────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for auth state.
// Stores the user globally, then calls render() so the header always
// derives its UI from CURRENT_USER — not from transient DOM state.
onAuthStateChanged(auth, async (user) => {
  _currentUser = user;

  // Tell app.js about the new auth state — it reads CURRENT_USER on every render
  window._appBridge?.setCURRENT_USER?.(user);

  if (user) {
    console.log('[firebase] Signed in as:', user.email);
    _setSyncStatus('pending');
    // Pull cloud data; render() is called inside pullFromCloud after merge
    await pullFromCloud(user.uid);
  } else {
    console.log('[firebase] Signed out.');
    // Re-render so header switches back to Sign In button
    window._appBridge?.setCURRENT_USER?.(null);
  }
});

// ── Offline/online detection ──────────────────────────────────────────────────
// The SW registration script in index.html already toggles the banner DOM;
// here we handle the cloud-sync side: flush queued writes when back online
// and update the sync badge in both directions.
window.addEventListener('online', () => {
  console.log('[firebase] Back online — flushing any pending sync.');
  _setSyncStatus('pending');
  if (_currentUser) pushToCloud(_currentUser.uid);
  else _setSyncStatus('idle');
});
window.addEventListener('offline', () => {
  _setSyncStatus('offline');
  console.log('[firebase] Offline — changes will sync when connection restores.');
});

// ── Delete: remove the user's Firestore document entirely ───────────────────
// Used by the "Reset all data" flow when the user opts to also wipe their
// cloud copy. Safe to call when not signed in (no-op).
async function deleteCloudData(explicitUid) {
  const targetUid = explicitUid ?? _currentUser?.uid;
  if (!targetUid) return;
  try {
    clearTimeout(_syncTimer);
    _syncPending = false;
    await deleteDoc(userDoc(targetUid));
    console.log('[firebase] Cloud document deleted.');
  } catch(e) {
    console.warn('[firebase] Cloud delete failed:', e.message);
    throw e; // let the caller decide how to surface this
  }
}

// ── Workplace sharing — transport for share.js envelopes (Phase 6.2) ─────────
// This layer is DUMB on purpose: it moves envelopes between the client and
// shares/{code}, nothing more. All packing, stripping, validation, and
// migration lives in share.js — anything read from shares/ is UNTRUSTED and
// must go through unpackShare() before it is shown or stored. Access control
// lives in firestore.rules (get-only, no enumeration, immutable after create,
// owner-only list/delete).
const SHARE_TTL_DAYS = 180;   // shares are snapshots; stale pay rules expire

// Publish an envelope (from packShare) under a fresh random code.
// Returns { code, expiresAtMs }. Throws 'auth-required' when signed out —
// creating shares needs an accountable owner (rules enforce it server-side).
async function createShare(envelope){
  if(!_currentUser) throw new Error('auth-required');
  let lastErr = null;
  for(let attempt = 0; attempt < 3; attempt++){
    const code = generateShareCode();
    const expiresAt = Timestamp.fromMillis(Date.now() + SHARE_TTL_DAYS * 86400000);
    try{
      await setDoc(doc(db, 'shares', code), {
        ...envelope,                       // fmt, schemaV, profile, name?
        ownerUid: _currentUser.uid,
        createdAt: serverTimestamp(),
        expiresAt,
      });
      return { code, expiresAtMs: expiresAt.toMillis() };
    }catch(e){
      // permission-denied here is either the 1-in-2⁴⁰ code collision (the
      // create-only rule refuses to overwrite) or a rules/payload mismatch;
      // a fresh code retries the former and can't worsen the latter.
      if(e.code === 'permission-denied'){ lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr;
}

// Fetch one share by CANONICAL code (callers normalize via normalizeShareCode).
// Returns the raw envelope doc or null (missing/expired). No auth required —
// importers are typically brand-new users. Result is UNTRUSTED by contract.
async function fetchShare(code){
  const snap = await getDoc(doc(db, 'shares', code));
  if(!snap.exists()) return null;
  const data = snap.data();
  // Client-side expiry guard — Firestore TTL deletion can lag by hours/days.
  const exp = data.expiresAt?.toMillis?.() ?? 0;
  if(exp && exp < Date.now()) return null;
  return data;
}

// Revoke one of the caller's own shares (rules verify ownership).
async function deleteShare(code){
  if(!_currentUser) throw new Error('auth-required');
  await deleteDoc(doc(db, 'shares', code));
}

// The caller's live shares, for the Settings share list. The ownerUid filter
// is REQUIRED — it is the exact condition firestore.rules' list clause proves,
// so an unfiltered query would be denied, not merely slow.
async function listMyShares(){
  if(!_currentUser) return [];
  const q = query(collection(db, 'shares'), where('ownerUid', '==', _currentUser.uid));
  const snaps = await getDocs(q);
  const now = Date.now();
  return snaps.docs.map(d => {
    const v = d.data();
    return {
      code: d.id,
      name: typeof v.name === 'string' ? v.name : null,
      createdAtMs: v.createdAt?.toMillis?.() ?? 0,
      expiresAtMs: v.expiresAt?.toMillis?.() ?? 0,
    };
  }).filter(s => !s.expiresAtMs || s.expiresAtMs > now);
}

// ── Public API ────────────────────────────────────────────────────────────────
// Exported so app.js can call these without knowing Firebase internals.
// getSyncStatus() — read by app.js during render to show sync badge
function getSyncStatus() { return _syncStatus; }

export {
  signInWithGoogle,
  signOutUser,
  scheduleSync,      // call after any data mutation
  pushToCloud,       // call for immediate push (e.g. before page unload)
  getSyncStatus,     // read current sync status for header badge
  deleteCloudData,   // call to permanently delete the user's Firestore document
  createShare,       // publish a share envelope → { code, expiresAtMs }
  fetchShare,        // code → raw envelope (UNTRUSTED — run unpackShare)
  deleteShare,       // revoke one of the caller's shares
  listMyShares,      // the caller's live shares for the Settings list
};
