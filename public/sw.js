// Minimal offline cache: no build-time asset manifest (Vite's JS/CSS filenames
// are content-hashed and change every build), so instead of precaching a fixed
// list, same-origin GET requests are cached as they're made. Cross-origin
// requests (Google Fonts) are left to the browser/network as-is.
const CACHE_NAME = 'checklist-collection-v2';

self.addEventListener('install', () => {
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
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // The page navigation itself (index.html) is the one request whose URL never
  // changes between deploys — unlike the content-hashed JS/CSS it references —
  // so it must go network-first: cache-first here would keep serving a stale
  // shell pointing at old, no-longer-deployed asset URLs after every new deploy,
  // with no way to notice a new version had shipped. It still falls back to
  // cache so a previously-visited page keeps working offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          var copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Everything else (content-hashed JS/CSS, images, icons) is safe to serve
  // cache-first, since a given URL's content never changes — a cache hit is
  // never stale — with the network response refreshing the cache regardless.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            var copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
