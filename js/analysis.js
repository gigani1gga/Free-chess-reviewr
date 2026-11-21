// Parsing a PGN, running the engine over every position, and turning the results into a review.
import { Chess } from '../vendor/chess.js';
import { winPct, accuracy, classify, sacrifice, tags, explain } from './review.js';
import { BAD } from './meta.js';

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

function analyse(eng, fen, depth) {
  const key = fen + '|' + depth;
  if (!cache.has(key)) {
    cache.set(key, compute(eng, fen, depth).catch(e => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

// Spreads positions over all engines; resolves with results in the same order as `fens`.
export async function analyseAll(engines, fens, depth, onProgress) {
  const out = new Array(fens.length);
  let next = 0, done = 0;
  await Promise.all(engines.map(async eng => {
    while (next < fens.length) {
      const i = next++;
      out[i] = await analyse(eng, fens[i], depth);
      onProgress(++done, fens.length);
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
    const wb = pov(b.win), wa = pov(a.win), drop = Math.max(0, wb - wa);
    const isBest = uci(m) === b.best;
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
    return { m, cls, best: isBest ? null : b.best, text: explain({ m, cls, tg, bestSan, wa, i }) };
  });
  const avg = xs => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
  return { headers, items, pos, acc: { w: avg(acc.w), b: avg(acc.b) }, cnt };
}
