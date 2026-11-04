// App-shell cache so Loop Road opens offline (tracks themselves are cached
// in IndexedDB by the app). Bump VERSION when you change files.
const VERSION = 'loop-road-v1';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/main.js',
  'js/config.js',
  'js/drive.js',
  'js/cache.js',
  'js/engine.js',
  'js/pitch.js',
  'js/pitch-worker.js',
  'js/dsp/pitchshift.js',
  'js/render.js',
  'js/state.js',
  'js/timeline.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first for the app's own files (so updates show up), cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
