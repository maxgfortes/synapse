const VERSION = 'synapse-v11';
const THUMBS = 'synapse-thumbs-v1';

const SHELL = [
  './', 'index.html', 'sobre.html', 'termos.html', 'contato.html', '404.html', 'manifest.webmanifest',
  'css/fonts.css', 'css/base.css', 'css/desktop.css', 'css/mobile.css', 'css/pages.css',
  'assets/fonts/SFPro-Regular.woff2', 'assets/fonts/SFPro-Medium.woff2', 'assets/fonts/SFPro-Bold.woff2',
  'js/app.js', 'js/config.js', 'js/no-zoom.js',
  'js/core/analysis-worker.js', 'js/core/bus.js', 'js/core/cover.js', 'js/core/spotify.js', 'js/core/context.js', 'js/core/db.js', 'js/core/engines.js',
  'js/core/enrich.js', 'js/core/player.js', 'js/core/store.js', 'js/core/tags.js', 'js/core/youtube.js',
  'js/metis/context.js', 'js/metis/dsp.js', 'js/metis/engine.js', 'js/metis/features.js', 'js/metis/genres.js',
  'js/metis/math.js', 'js/metis/nn.js',
  'js/ui/desktop.js', 'js/ui/icons.js', 'js/ui/mobile.js', 'js/ui/shared.js',
  'assets/icons/icon.svg', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/favicon-32.png',
  'assets/icons/apple-touch-icon.png', 'assets/icons/loading.gif',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== VERSION && n !== THUMBS).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) || cache.match('index.html');
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request, { ignoreSearch: true });
  const update = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => hit);
  return hit || update;
}

async function cacheThumb(request) {
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname === 'i.ytimg.com') {
    event.respondWith(cacheThumb(request));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : staleWhileRevalidate(request));
});
