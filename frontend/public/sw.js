const CACHE_NAME = 'seas-cache-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept:
  // 1. Non-GET requests
  // 2. API requests (/api/ or /auth, /alerts, /contacts, /admin, /webhooks)
  // 3. Socket.io websockets
  // 4. Vite development endpoints (/@vite, /@fs, /src/, node_modules)
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/alerts') ||
    url.pathname.startsWith('/contacts') ||
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/webhooks') ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.includes('/@vite') ||
    url.pathname.includes('/@fs') ||
    url.pathname.includes('/src/') ||
    url.pathname.includes('node_modules')
  ) {
    return;
  }

  // App shell: network-first so a new deploy is picked up immediately (cache-first would keep serving
  // an old index.html that points at deleted hashed assets). The cached copy is the offline fallback.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          }
          return networkResponse;
        })
        .catch(() =>
          caches.match('/index.html').then(
            (navResponse) =>
              navResponse ||
              new Response('Offline - SEAS Emergency System', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              })
          )
        )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
          return networkResponse;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html').then((navResponse) => {
              return navResponse || new Response('Offline - SEAS Emergency System', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
            });
          }
          return new Response('Network unavailable', { status: 503, statusText: 'Service Unavailable' });
        });
    })
  );
});
