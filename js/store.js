// Keeps finished position analyses on this device (IndexedDB), so a position the engine has already searched at a given
// depth is never searched again: not after a reload, and not in another game that reaches the same position (openings!).
// An optimisation only. Private mode, a full disk or a browser without IndexedDB must never slow down or break a review,
// so every failure is swallowed and the engine simply does the work.
const NAME = 'game-review', STORE = 'analysis';
const MAX = 20000, KEEP = 16000; // above MAX entries the oldest are dropped down to KEEP (about 1 KB each)
const OPEN_MS = 3000;            // some browsers never answer indexedDB.open(); don't wait on them for long
let db = null;

// When a store grows too big, forget the oldest entries.
function prune(d) {
  try {
    const s = d.transaction(STORE, 'readwrite').objectStore(STORE), c = s.count();
    c.onsuccess = () => {
      let extra = c.result - KEEP;
      if (c.result <= MAX) return;
      s.index('t').openCursor().onsuccess = e => { // oldest first
        const cur = e.target.result;
        if (cur && extra-- > 0) { cur.delete(); cur.continue(); }
      };
    };
  } catch { /* ignore */ }
}

function open() {
  if (!db) {
    db = new Promise(resolve => {
      try {
        setTimeout(() => resolve(null), OPEN_MS);
        const req = indexedDB.open(NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE).createIndex('t', 't');
        req.onsuccess = () => { prune(req.result); resolve(req.result); };
        req.onerror = req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return db;
}

// Resolves with what was stored under `key`, or undefined. Never rejects.
export async function recall(key) {
  try {
    const d = await open();
    if (!d) return undefined;
    return await new Promise(resolve => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result?.v);
      r.onerror = () => resolve(undefined);
    });
  } catch { return undefined; }
}

// Fire and forget. Never throws.
export function remember(key, value) {
  open().then(d => {
    if (!d) return;
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.onerror = tx.onabort = e => e.preventDefault?.(); // e.g. storage full
      tx.objectStore(STORE).put({ t: Date.now(), v: value }, key);
    } catch { /* ignore */ }
  });
}
