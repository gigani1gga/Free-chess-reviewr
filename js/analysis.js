// Parsing a PGN, running the engine over every position, and turning the results into a review.
import { Chess } from '../vendor/chess.js';
import { winPct, accuracy, classify, sacrifice, tags, explain } from './review.js';
import { BAD } from './meta.js';
import { coach, replay, mkLine } from './coach.js';
import { recall, remember } from './store.js';

const cache = new Map(); // fen+depth -> Promise<position result>, so repeated positions/games are free

export function parseGame(pgn) {
  const g = new Chess();
  try { g.loadPgn(pgn); } catch { throw new Error('Could not read that PGN.'); }
  const moves = g.history({ verbose: true });
  if (!moves.length) throw new Error('That game has no moves.');
  return { headers: g.header(), moves, fens: [moves[0].before, ...moves.map(m => m.after)] };
}

async function compute(eng, fen, depth) {
  const c = new Chess(fen), turn = c.turn();
  if (c.isCheckmate()) return { fen, turn, over: 'mate', win: turn === 'w' ? 0 : 100, lines: [] };
  if (c.isGameOver()) return { fen, turn, over: 'draw', win: 50, lines: [] };
  const s = turn === 'w' ? 1 : -1; // engine scores are from the side to move; convert to White's view
  const lines = (await eng.analyze(fen, depth)).map(l => {
    const mate = l.mate != null ? l.mate * s : null, cp = l.cp != null ? l.cp * s : null;
    return { mate, cp, pv: l.pv, win: mate != null ? (mate > 0 ? 100 : 0) : winPct(cp) };
  });
  const top = lines[0] || { win: 50, pv: [] };
  return { fen, turn, lines, win: top.win, mate: top.mate, cp: top.cp, best: top.pv[0] };
}

// Same engine setup + same depth + same position = same answer, so finished positions are also kept on this device
// (store.js). The move number changes nothing about what an engine finds (the half-move clock can, so it stays in the key),
// which lets opening positions reached in other games match. Engines without an `id` (test fakes) are never stored.
export const storeKey = (eng, depth, fen) => eng.id && `${eng.id}|${depth}|${fen.split(' ').slice(0, 5).join(' ')}`;

async function solve(eng, fen, depth) {
  const k = storeKey(eng, depth, fen);
  const hit = k && await recall(k);
  if (hit && Array.isArray(hit.lines) && hit.lines.length) return { ...hit, fen }; // `fen` keeps this game's move number
  const r = await compute(eng, fen, depth);
  if (k && r.lines.length) remember(k, r); // game-over positions never reach the engine, so there is nothing to keep
  return r;
}

function analyse(eng, fen, depth) {
  const key = `${eng.kind}|${depth}|${fen}`;
  if (!cache.has(key)) {
    cache.set(key, solve(eng, fen, depth).catch(e => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

// Each engine takes a run of consecutive positions at a time instead of every n-th one. Position i+1 is reached by a move
// from position i, so the engine's hash table (which is kept between positions) already holds much of the search it needs
// when it moves on to i+1. Same depth, but usually less work than starting cold. Runs are claimed on demand, so a faster
// engine simply takes more of them. Runs shrink towards the end of the game (guided scheduling), so that no engine is left
// finishing a long run while the others sit idle.
const MIN_RUN = 2, MAX_RUN = 8;
export const runSize = (left, engines) => Math.min(left, Math.max(MIN_RUN, Math.min(MAX_RUN, Math.ceil(left / (engines * 2)))));

// Spreads positions over all engines; resolves with results in the same order as `fens`.
export async function analyseAll(engines, fens, depth, onProgress) {
  const out = new Array(fens.length);
  let next = 0, done = 0;
  await Promise.all(engines.map(async eng => {
    while (next < fens.length) {
      const from = next, to = from + runSize(fens.length - from, engines.length);
      next = to;
      for (let i = from; i < to; i++) {
        out[i] = await analyse(eng, fens[i], depth);
        onProgress(++done, fens.length);
      }
    }
  }));
  return out;
}

const uci = m => m.from + m.to + (m.promotion || '');

export function buildReview({ headers, moves, fens }, pos) {
  const acc = { w: [], b: [] }, cnt = { w: {}, b: {} };
  let prev = 0;
  const items = moves.map((m, i) => {
    const b = pos[i], a = pos[i + 1], me = m.color;
    const pov = w => (me === 'w' ? w : 100 - w);
    const played = uci(m);
    const isBest = played === b.best;
    // If the move is one of the engine's top lines, use that line's own score: it comes from the same search
    // as the "before" score, so depth noise can't make a best/second-best move look like a loss.
    const line = b.lines.find(l => l.pv[0] === played);
    const wb = pov(b.win), wa = pov(line ? line.win : a.win), drop = isBest ? 0 : Math.max(0, wb - wa);
    const gap = b.lines[1] ? wb - pov(b.lines[1].win) : null;
    const cls = classify({ drop, isBest, wb, wa, gap, sac: sacrifice(m, a.fen), prev });
    prev = drop;
    acc[me].push(accuracy(drop));
    cnt[me][cls] = (cnt[me][cls] || 0) + 1;

    let bestSan = null;
    if (b.best && !isBest && BAD.includes(cls)) {
      try { bestSan = new Chess(b.fen).move({ from: b.best.slice(0, 2), to: b.best.slice(2, 4), promotion: b.best[4] }).san; } catch { /* ignore */ }
    }
    const tg = tags({ m, b, a, drop, wb, wa, cls });
    // What Stockfish says about this move: its answer, its own choice, and reasons checked against those lines.
    let extra = { why: [], lines: [], ev: [] };
    try { extra = coach({ m, b, a, cls, isBest, tg }); } catch { /* the review still works without the extra reasons */ }
    return { m, cls, tags: tg.map(t => t[0]), best: isBest ? null : b.best, lines: extra.lines, ev: extra.ev, text: explain({ m, cls, tg, bestSan, wa, i, extra }) };
  });
  const avg = xs => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
  return { headers, items, pos, acc: { w: avg(acc.w), b: avg(acc.b) }, cnt };
}

// "Ask Stockfish": a deeper look at one position with a few candidate moves, each with the line the engine expects.
// Scores come back from the side to move's view; like everything else here they are converted to White's.
export async function explore(eng, fen, depth, n = 3) {
  const c = new Chess(fen), s = c.turn() === 'w' ? 1 : -1;
  if (c.isGameOver()) return [];
  const raw = await eng.explore(fen, depth, n);
  return raw.map(l => {
    const mate = l.mate != null ? l.mate * s : null, cp = l.cp != null ? l.cp * s : null;
    const win = mate != null ? (mate > 0 ? 100 : 0) : winPct(cp);
    const steps = replay(fen, l.pv, 10);
    return { ...mkLine(steps[0]?.san || '?', fen, steps, { mate, cp, win }), win };
  }).filter(l => l.steps.length);
}
