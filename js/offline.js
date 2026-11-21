// Registers the service worker that caches the engine, and asks the browser not to evict that storage.
// This is an optimisation only: it must never block or break a review, so the whole thing is time-limited.
const LIMIT_MS = 5000;

async function setup() {
  await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  // On the very first visit the page isn't controlled yet; wait briefly so the first engine download gets cached too.
  if (!navigator.serviceWorker.controller) {
    await new Promise(done => {
      navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
      setTimeout(done, 3000);
    });
  }
  navigator.storage?.persist?.();
}

export async function keepEngineCached() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await Promise.race([setup(), new Promise(done => setTimeout(done, LIMIT_MS))]);
  } catch { /* the engine still works, it just won't be kept on the device */ }
}
