// Keeps the Stockfish engine files (engine/*.js and engine/*.wasm, ~94 MB for full strength) in Cache Storage, so they
// are downloaded once and then start from the device. Cache Storage lasts far longer than the normal HTTP cache,
// which phones empty aggressively. The deploy copies this file to the site root so its scope covers engine/.
// Bump CACHE to throw old engine files away (for example after moving to a newer Stockfish).
const CACHE = 'engine-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE && k.startsWith('engine-')) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // manifest.json is deliberately not cached: it must always be fresh.
  if (e.request.method !== 'GET' || u.origin !== location.origin || !/\/engine\/[^/]+\.(js|wasm)$/.test(u.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(u.href);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.status === 200) e.waitUntil(cache.put(u.href, res.clone()).catch(() => {})); // e.g. storage full: still serve it
    return res;
  })());
});
