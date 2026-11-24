// The kit testing itself. Every fake in the kit (chess stand-in, mock engine, mock "book", fake engine, strict chess.js wrapper)
// is a place where a bug would look like an app bug. These checks make them prove themselves against the independent oracle.
import fs from 'node:fs';
import path from 'node:path';
import { siteDir, importFile } from '../lib/env.mjs';
import { BOOK_FILE, CONFIGS, configKey, loadBook, searcher } from '../lib/book.mjs';
import { chessModule } from '../lib/chess.mjs';
import { fakeEngine } from '../lib/fake-engine.mjs';
import { mirrorFen, mirrorUci, randomGame, STARTS } from '../lib/gen.mjs';
import * as O from '../lib/oracle.mjs';
import { newSeed, rng } from '../lib/prng.mjs';
import { createSuite } from '../lib/suite.mjs';

const S = createSuite('kit', { timeout: 120000 });
const seed = S.opts.seed ?? newSeed();
const { Chess, ChessCore: C } = await chessModule();
const m = { tags: ['kit'], covers: ['src/mock-engine.js', 'src/chess-core.js'] };
const uci = x => C.sqName(x.from) + C.sqName(x.to) + (x.promo || '');
const positions = async (r, n) => { const out = []; while (out.length < n) { const g = await randomGame(r, { fen: r.pick(STARTS), maxPlies: 30, greed: 0.5 }); out.push(...g.fens.filter(() => r.chance(0.3)).slice(0, 6)); } return out.slice(0, n); };

S.test('mock engine: its search returns exactly the legal moves, best first (checked against the oracle)', async () => {
  const search = await searcher({ cap: 1, qdepth: 0 }), r = rng(seed);
  for (const fen of await positions(r, 120)) {
    const s = C.parseFen(fen);
    if (!C.legal(s).length) continue;
    const res = search(s, 1), got = res.map(x => uci(x.m)).sort(), want = O.legalUci(fen);
    if (got.join() !== want.join()) throw new Error(`mock search lists ${got.length} moves, oracle has ${want.length} in ${fen} [seed ${seed}]`);
    for (let i = 1; i < res.length; i++) if (res[i - 1].sc < res[i].sc) throw new Error(`mock results not sorted best-first in ${fen}`);
  }
}, m);

S.test('mock engine: always finds a mate in one, and its mate score has the right sign', async () => {
  const search = await searcher({ cap: 2, qdepth: 2 });
  for (const [fen, mv] of [['r5k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8'], ['r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'h5f7']]) {
    const res = search(C.parseFen(fen), 2);
    if (uci(res[0].m) !== mv) throw new Error(`mock missed the mate ${mv} in ${fen}; chose ${uci(res[0].m)}`);
    if (!(res[0].sc > 20000)) throw new Error(`a mating move scored only ${res[0].sc}`);
  }
}, m);

S.test('mock book: finished searches in data/mock-book.json equal a fresh search (spot check of 40 entries)', async () => {
  const { books, why } = loadBook();
  if (!books) { console.log(`   (book not in use: ${why}; nothing to verify)`); return; }
  const r = rng(seed + 1);
  for (const cfg of CONFIGS) {
    const search = await searcher(cfg), book = books[configKey(cfg)], keys = Object.keys(book);
    for (let i = 0; i < 20; i++) {
      const key = r.pick(keys), [fen, d] = key.split('|'), fresh = search(C.parseFen(fen), +d).map(x => [x.m.from, x.m.to, x.m.promo || '', x.sc]);
      if (JSON.stringify(fresh) !== JSON.stringify(book[key])) throw new Error(`book entry ${key} (${configKey(cfg)}) differs from a fresh search: the book is wrong. Run: node kit.mjs book`);
    }
  }
}, { ...m, tags: ['kit'], covers: ['data/mock-book.json'] });

S.test('strict chess.js wrapper: using a method the stand-in lacks throws a clear error and is recorded', async () => {
  const mod = await importFile(path.join(siteDir(), 'vendor/chess.js'), true);
  const c = new mod.Chess();
  if (typeof c.moves !== 'function' || c.fen().split(' ')[0] !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR') throw new Error('the wrapped Chess no longer behaves normally');
  let msg = '';
  const quiet = console.error; console.error = () => {}; // the wrapper also logs, so the browser tests notice
  try { c.board(); } catch (e) { msg = e.message; } finally { console.error = quiet; }
  if (!/STAND-IN LACKS Chess\.board/.test(msg)) throw new Error(`no clear error: "${msg}" (is KIT_STRICT_CHESS=0 set?)`);
  if (!globalThis.__chessMisses?.has('board')) throw new Error('the miss was not recorded in globalThis.__chessMisses');
  globalThis.__chessMisses.delete('board');
}, { tags: ['kit'], covers: ['build-site.mjs'] });

S.test('fake engine: mirror-symmetric, lines are legal, finds mate in one (so fuzz results mean something)', async () => {
  const eng = await fakeEngine({ seed: 5, glitch: 0 }), r = rng(seed + 2);
  let mates = 0;
  for (const fen of await positions(r, 80)) {
    const ls = await eng.analyze(fen, 12);
    const legal = O.legalUci(fen);
    if (!legal.length) { if (ls.length) throw new Error(`lines for a finished game: ${fen}`); continue; }
    if (!ls.length || !legal.includes(ls[0].pv[0])) throw new Error(`first move of the best line is not legal in ${fen}`);
    const twin = await eng.analyze(mirrorFen(fen), 12);
    if (JSON.stringify(ls.map(l => ({ ...l, pv: l.pv.map(mirrorUci) }))) !== JSON.stringify(twin)) throw new Error(`not mirror-symmetric in ${fen}`);
    const o = O.parse(fen), mate = O.legal(o).some(x => { const n = O.make(o, x); return O.inCheck(n) && !O.legal(n).length; });
    if (mate) { mates++; if (ls[0].mate !== 1) throw new Error(`missed a mate in one in ${fen}`); }
  }
}, { tags: ['kit'], covers: ['lib/fake-engine.mjs'] });

S.test('generators: random games are legal, mirrorFen is an involution and keeps the position legal', async () => {
  const r = rng(seed + 3);
  for (let i = 0; i < 25; i++) {
    const g = await randomGame(r, { fen: r.pick(STARTS), maxPlies: 50 });
    g.ucis.forEach((u, k) => { if (!O.legalUci(g.fens[k]).includes(u)) throw new Error(`generated an illegal move ${u} in ${g.fens[k]}`); });
    for (const f of g.fens) {
      if (mirrorFen(mirrorFen(f)) !== f) throw new Error(`mirrorFen not an involution: ${f}`);
      if (O.legalUci(f).length !== O.legalUci(mirrorFen(f)).length) throw new Error(`mirrored position has a different number of legal moves: ${f}`);
    }
  }
}, { tags: ['kit'], covers: ['lib/gen.mjs'] });

await S.run();
S.finish();
