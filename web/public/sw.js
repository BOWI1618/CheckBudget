/**
 * Service Worker: кеширует оболочку приложения, чтобы оно открывалось
 * без сети. Данные в SW не кешируются — они лежат в IndexedDB и
 * управляются самим приложением, которое умеет их дозагружать по seq.
 *
 * API-запросы принципиально НЕ перехватываются: кешированный ответ на
 * финансовый запрос опаснее, чем честная ошибка сети.
 */
const SHELL_CACHE = 'checkbudget-shell-v1';
const SHELL_ASSETS = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Навигация: сеть первой, кеш — как запасной вариант при офлайне.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((r) => r ?? Response.error())),
    );
    return;
  }

  // Статика собрана с хешем в имени — можно безопасно отдавать из кеша.
  event.respondWith(
    caches.match(request).then((cached) =>
      cached ?? fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }),
    ),
  );
});
