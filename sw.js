// Stay Cool London — minimal service worker.
// Strategy: network-first for same-origin GETs (so the app is always fresh when
// online), falling back to cache when offline. This enables "install to home
// screen" and offline use without ever serving stale app code or data.

const CACHE = 'staycool-v1';
const SHELL = ['/', '/index.html', '/css/styles.css', '/js/app.js', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Only handle same-origin GETs; let tiles, Supabase, CDNs pass straight through.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // refresh the cache copy for offline use
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
