// Offline-first service worker: app shell is cached; bump VERSION on every release.
const VERSION = 'v52';
const SHELL = [
  './', 'index.html', 'app.css', 'glass.css', 'manifest.webmanifest',
  'js/app.js', 'js/market.js', 'js/sync.js', 'js/config.js', 'js/db.js', 'js/model.js', 'js/suggest.js', 'js/bank.js', 'js/stats.js', 'js/jalali.js', 'js/format.js', 'js/analysis.js',
  'vendor/xlsx.mini.min.js', 'vendor/lightweight-charts.mjs', 'fonts/Vazirmatn.woff2', 'fonts/Estedad-arabic.woff2', 'fonts/Estedad-latin.woff2',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'data/hesab.enc.json',
];

self.addEventListener('install', e => {
  // Bypass the browser HTTP cache so a new version never installs stale files.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // Live prices: network first, the cached copy only when offline.
  if (new URL(e.request.url).pathname.endsWith('/data/prices.json')) {
    e.respondWith(caches.open(VERSION).then(cache => fetch(e.request, { cache: 'no-store' })
      .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
      .catch(() => cache.match(e.request, { ignoreSearch: true }))));
    return;
  }
  // Serve from cache instantly; refresh the cache in the background when online.
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
