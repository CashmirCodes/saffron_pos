// Minimal service worker: just enough to make Saffron POS installable as a
// PWA. Data always comes fresh from the API (the app has no offline mode --
// it needs the cloud database), so this only caches the static app shell
// (HTML/CSS/JS/icons) as a network-first-with-cache-fallback, and leaves
// every /api/* request completely untouched.
const CACHE_NAME = 'saffron-pos-shell-v3';
const SHELL_ASSETS = [
  'index.html',
  'login.html',
  'register.html',
  'manifest.json',
  'css/style.css',
  'js/api.js',
  'js/app.js',
  'js/ui.js',
  'js/platform.js',
  'platform.html',
  'js/velaris-bg.js',
  'js/pwa.js',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {}) // don't fail install over one missing/offline asset
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return; // always live, never cached

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request))
  );
});
