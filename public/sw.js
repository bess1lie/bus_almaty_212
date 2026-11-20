/* Service worker для bus_almaty_212 — кэш оболчки и тайлов. */
const CACHE = 'bus212-v1';
const SHELL = [
  '/bus_almaty_212/',
  '/bus_almaty_212/index.html',
  '/bus_almaty_212/ui/bus-ui.css',
  '/bus_almaty_212/manifest.webmanifest',
  '/bus_almaty_212/models/variants/bus_almaty_212_golden_hour.glb',
  '/bus_almaty_212/models/variants/bus_almaty_212_turquoise.glb',
  '/bus_almaty_212/models/variants/bus_almaty_212_sand.glb',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Тайлы и модель — cache-first, чтобы повторные загрузки были быстрыми
  if (url.pathname.includes('/map/v1/tiles/') || url.pathname.includes('/models/')) {
    e.respondWith(
      caches.match(e.request).then((cached) =>
        cached || fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
      )
    );
    return;
  }

  // Остальное — network-first с fallback на кэш
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
