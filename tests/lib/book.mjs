// The mock engine's "book": finished root searches for every position of the kit's test games, so tests do not wait for a fake
// engine to think. It is only ever USED when it was made from exactly the current chess-core.js + mock-engine.js (hash check),
// so it cannot hide a change in either; `kit.mjs book` rebuilds it (about a minute), and the `static` suite spot-checks it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { kitRoot } from './env.mjs';
import { chessModule } from './chess.mjs';
import { BOOK_GAMES, GAMES } from './games.mjs';

export const BOOK_FILE = path.join(kitRoot, 'data/mock-book.json');
const read = f => fs.readFileSync(path.join(kitRoot, f), 'utf8');
// What a book depends on: the move generator and the search. The CONFIG line is part of the key via the configs below.
export const sourceHash = () => crypto.createHash('sha1').update(read('src/chess-core.js')).update(read('src/mock-engine.js')).digest('hex').slice(0, 16);
export const configKey = c => `c${c.cap}q${c.qdepth}`;
export const CONFIGS = [{ cap: 3, qdepth: 4 }, { cap: 2, qdepth: 2 }];

export function loadBook() {
  if (process.env.KIT_NO_BOOK === '1') return { books: null, why: 'disabled by KIT_NO_BOOK=1' };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(BOOK_FILE, 'utf8')); } catch { return { books: null, why: 'no data/mock-book.json (run `node kit.mjs book`)' }; }
  if (doc.hash !== sourceHash()) return { books: null, why: 'stale: chess-core.js or mock-engine.js changed since it was made (run `node kit.mjs book`)' };
  return { books: doc.books, positions: doc.positions, why: 'ok' };
}

export async function positionsOfGames() {
  const { Chess } = await chessModule();
  const fens = new Set();
  for (const id of BOOK_GAMES) {
    const c = new Chess(); c.loadPgn(GAMES[id].pgn);
    const h = c.history({ verbose: true });
    if (h.length) fens.add(h[0].before);
    for (const m of h) fens.add(m.after);
  }
  return [...fens];
}

// The mock's own search, loaded into a vm so Node can call it exactly as the browser worker would.
export async function searcher(cfg) {
  const core = read('src/chess-core.js'), engine = read('src/mock-engine.js');
  const sb = { postMessage() {}, self: { location: { href: 'file:///book/x.js' } }, fetch: () => new Promise(() => {}), setTimeout, clearTimeout, Date, Math, console };
  vm.createContext(sb);
  vm.runInContext(`const CONFIG = ${JSON.stringify({ ...cfg, name: 'book', loadDelay: 0, options: 'modern', behavior: 'normal' })};\n${core}\n${engine}`, sb);
  return sb.rootSearch;
}

// Runs the mock's own search (inside a vm, like mock-cli.mjs) for every position at every depth the mock iterates through.
export async function buildBook(onProgress = () => {}) {
  const { ChessCore: C } = await chessModule();
  const core = read('src/chess-core.js'), engine = read('src/mock-engine.js');
  const fens = await positionsOfGames();
  const books = {};
  for (const cfg of CONFIGS) {
    const sb = { postMessage() {}, self: { location: { href: 'file:///book/x.js' } }, fetch: () => new Promise(() => {}), setTimeout, clearTimeout, Date, Math, console };
    vm.createContext(sb);
    vm.runInContext(`const CONFIG = ${JSON.stringify({ ...cfg, name: 'book', loadDelay: 0, options: 'modern', behavior: 'normal' })};\n${core}\n${engine}`, sb);
    const book = (books[configKey(cfg)] = {});
    let n = 0;
    for (const fen of fens) {
      const s = C.parseFen(fen);
      if (!C.legal(s).length) continue;
      for (let d = 1; d <= cfg.cap; d++) {
        const res = sb.rootSearch(s, d);
        book[C.toFen({ ...s, full: 1 }) + '|' + d] = res.map(r => [r.m.from, r.m.to, r.m.promo || '', r.sc]);
      }
      onProgress(configKey(cfg), ++n, fens.length);
    }
  }
  fs.mkdirSync(path.dirname(BOOK_FILE), { recursive: true });
  fs.writeFileSync(BOOK_FILE, JSON.stringify({ hash: sourceHash(), made: new Date().toISOString(), positions: fens.length, books }));
  return { positions: fens.length };
}
