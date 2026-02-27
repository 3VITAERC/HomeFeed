/**
 * HomeFeed Service Worker
 * Strategy: Cache-first for app shell (HTML/CSS/JS), network-only for images/API.
 */

const CACHE_NAME = 'homefeed-shell-v1';

const SHELL_URLS = [
  '/',
  '/static/style.css',
  '/static/js/app.js',
  '/static/js/state.js',
  '/static/js/api.js',
  '/static/js/viewport.js',
  '/static/js/comments.js',
  '/static/js/utils/path.js',
  '/static/js/utils/video.js',
  '/static/js/utils/gif.js',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

// Install: pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-only for images and API, cache-first for shell
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Always go to network for API calls and served images/videos
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/image/') ||
    url.pathname.startsWith('/thumbnail/') ||
    url.pathname.startsWith('/gif/') ||
    url.pathname.startsWith('/video-poster/')
  ) {
    return; // fall through to browser default (network)
  }

  // Cache-first for everything else (app shell)
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Cache successful GET responses for shell assets
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
