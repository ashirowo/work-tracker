// ─────────────────────────────────────────────────────────────────────────────
// sw.js — Service Worker for Shiftr
//
// CACHING STRATEGY OVERVIEW:
//
//  ┌─────────────────────┬──────────────────────────────────────────────────┐
//  │ Resource            │ Strategy                                         │
//  ├─────────────────────┼──────────────────────────────────────────────────┤
//  │ App shell           │ Cache-first (updated on SW install)              │
//  │ (HTML/CSS/JS/icons) │                                                  │
//  ├─────────────────────┼──────────────────────────────────────────────────┤
//  │ Google Fonts CSS    │ Stale-while-revalidate (1 week TTL)              │
//  ├─────────────────────┼──────────────────────────────────────────────────┤
//  │ Google Fonts files  │ Cache-first (immutable, long TTL)                │
//  ├─────────────────────┼──────────────────────────────────────────────────┤
//  │ Chart.js CDN        │ Cache-first (immutable versioned URL)            │
//  ├─────────────────────┼──────────────────────────────────────────────────┤
//  │ Firebase SDK        │ Cache-first (immutable versioned URL)            │
//  ├─────────────────────┼──────────────────────────────────────────────────┤
//  │ jsPDF / html2canvas │ Cache-first (immutable versioned URL)            │
//  ├─────────────────────┼──────────────────────────────────────────────────┤
//  │ Korean holiday API  │ Network-first, fall back to cache; no cache=fail │
//  ├─────────────────────┼──────────────────────────────────────────────────┤
//  │ Firebase Auth/DB    │ Network-only (auth cannot be faked offline)      │
//  └─────────────────────┴──────────────────────────────────────────────────┘
//
// VERSIONING:
//  Bump CACHE_VERSION whenever you deploy new static assets.
//  The old cache is deleted in the `activate` handler so stale files are purged.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION   = 'wt4-v64';
const SHELL_CACHE     = `${CACHE_VERSION}-shell`;
const FONT_CACHE      = `${CACHE_VERSION}-fonts`;
const CDN_CACHE       = `${CACHE_VERSION}-cdn`;
const API_CACHE       = `${CACHE_VERSION}-api`;

const ALL_CACHES = [SHELL_CACHE, FONT_CACHE, CDN_CACHE, API_CACHE];

// ── App shell — everything needed to boot the app offline ────────────────────
// Versioned query strings are stripped on lookup so ?v=x.y.z always matches.
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './calc.js',
  './profile.js',
  './profile-v2.js',
  './compile.js',
  './firebase.js',
  './translations.js',
  './export.js',
  './manifest.json',
  './logo-dark.svg',
  './logo-light.svg',
  './ico/favicon.ico',
  './ico/favicon-16x16.png',
  './ico/favicon-32x32.png',
  './ico/apple-touch-icon.png',
  './ico/android-chrome-192x192.png',
  './ico/android-chrome-512x512.png',
];

// ── CDN assets (versioned — safe to cache indefinitely) ───────────────────────
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js',
  // PDF export — lazy-loaded on first use, cached here so it keeps working offline after that
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
];

// ── Domain matchers ───────────────────────────────────────────────────────────
const FONT_CSS_ORIGIN    = 'https://fonts.googleapis.com';
const FONT_FILE_ORIGIN   = 'https://fonts.gstatic.com';
const HOL_API_ORIGIN     = 'https://apis.data.go.kr';
const FIREBASE_ORIGINS   = [
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://firestore.googleapis.com',
  'https://firebase.googleapis.com',
  'https://www.googleapis.com',
];

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL — pre-cache the app shell and CDN assets
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      // Cache app shell
      caches.open(SHELL_CACHE).then(cache =>
        cache.addAll(SHELL_ASSETS).catch(err =>
          console.warn('[SW] Shell pre-cache partial failure:', err)
        )
      ),
      // Cache CDN assets — fail individually so one bad URL doesn't block install
      caches.open(CDN_CACHE).then(async cache => {
        for (const url of CDN_ASSETS) {
          try {
            const res = await fetch(url, { mode: 'cors' });
            if (res.ok) await cache.put(url, res);
          } catch (e) {
            console.warn('[SW] CDN pre-cache skipped (offline?):', url);
          }
        }
      }),
    ]).then(() => self.skipWaiting())
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE — delete old caches, take control of all clients immediately
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !ALL_CACHES.includes(k))
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// FETCH — route every request to the appropriate strategy
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Skip non-GET and chrome-extension requests ───────────────────────────
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // ── Firebase Auth / Firestore — network only ─────────────────────────────
  // These MUST reach the server; we never serve stale auth responses.
  if (FIREBASE_ORIGINS.some(o => request.url.startsWith(o))) {
    event.respondWith(fetchOrOffline(request, /*fallback=*/null));
    return;
  }

  // ── Korean Holiday API — network-first, cache fallback ───────────────────
  // App.js caches results in localStorage anyway; SW cache is a second layer.
  if (url.origin === HOL_API_ORIGIN) {
    event.respondWith(networkFirstWithCache(request, API_CACHE));
    return;
  }

  // ── Google Fonts CSS — stale-while-revalidate ─────────────────────────────
  if (url.origin === FONT_CSS_ORIGIN) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  // ── Google Fonts files — cache-first (immutable) ──────────────────────────
  if (url.origin === FONT_FILE_ORIGIN) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // ── CDN assets (Chart.js, Firebase SDK) — cache-first ────────────────────
  if (
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'www.gstatic.com'
  ) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // ── App shell (same-origin) — cache-first, network fallback ──────────────
  if (url.origin === self.location.origin) {
    event.respondWith(shellCacheFirst(request));
    return;
  }

  // ── Everything else — try network, silently fail ──────────────────────────
  event.respondWith(fetchOrOffline(request, null));
});

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache-first: serve from cache immediately; fetch & update cache in background.
 * Best for truly immutable assets (versioned CDN URLs, font files).
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return offlineResponse();
  }
}

/**
 * Shell cache-first: same as cacheFirst but strips query strings for matching
 * (so style.css?v=1.0.3 hits the cached ./style.css entry) and falls back
 * to the root index.html for navigation requests (SPA offline support).
 */
async function shellCacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);

  // Try exact match first
  let cached = await cache.match(request);
  if (cached) return cached;

  // Try stripping query string (handles ?v=x.y.z versioning)
  const stripped = new Request(new URL(request.url).pathname, { headers: request.headers });
  cached = await cache.match(stripped);
  if (cached) return cached;

  // Try network
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    // For navigation requests fall back to the cached app shell
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html') || await cache.match('./');
      if (shell) return shell;
    }
    return offlineResponse();
  }
}

/**
 * Stale-while-revalidate: respond from cache instantly, then update cache
 * from network in the background. Good for Google Fonts CSS.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then(fresh => {
      if (fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => null);

  return cached || await fetchPromise || offlineResponse();
}

/**
 * Network-first: try the network; on failure serve from cache.
 * Good for API responses where freshness is preferred but offline access matters.
 */
async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    return cached || offlineResponse(503);
  }
}

/**
 * Try network; if offline return a minimal 503 or a null body response
 * rather than throwing, so the app can handle it gracefully.
 */
async function fetchOrOffline(request, _fallback) {
  try {
    return await fetch(request);
  } catch {
    return offlineResponse(503);
  }
}

/** Minimal offline placeholder response */
function offlineResponse(status = 503) {
  return new Response(
    JSON.stringify({ offline: true }),
    {
      status,
      headers: { 'Content-Type': 'application/json', 'X-SW-Offline': '1' }
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE — allow the app to communicate with the SW
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // App can send 'GET_VERSION' to confirm which SW is active
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_VERSION });
  }
});
