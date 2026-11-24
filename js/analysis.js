// Parsing a PGN, running the engine over every position, and turning the results into a review.
import { Chess } from '../vendor/chess.js';
import { classify, sacrifice, tags, explain } from './review.js';
import { winFor, toWhite, cpOf, volatility, gameAccuracy, accuracy, phaseOf, estimateRating, generosity } from './rating.js';
import { sacrificeInLine, interview, holdsUp, interviewText } from './brilliant.js';
import { inBook } from './openings.js';
import { BAD } from './meta.js';
import { coach, replay, mkLine } from './coach.js';
import { recall, remember } from './store.js';

const cache = new Map(); // fen+depth -> Promise<position result>, so repeated positions/games are free

// Only standard chess can be reviewed: the engine and the board know no other rules.
export function parseGame(pgn) {
  const variant = /\[Variant\s+"([^"]*)"\s*\]/i.exec(pgn)?.[1]?.trim();
  if (variant && !/^(standard|from position)$/i.test(variant)) throw new Error(`This game is ${variant}. The reviewer only supports standard chess.`);
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
  const lines = (await eng.analyze(fen, depth)).map(l => toWhite(l, turn)); // engine scores are from the side to move; convert to White's view
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

const eloOf = h => ({ w: parseInt(h?.WhiteElo, 10) || 0, b: parseInt(h?.BlackElo, 10) || 0 });
// The mover's expected points in a position (0-100). Finished games carry their own result.
const topWin = (p, me, e) => (p.lines && p.lines[0] ? winFor(p.lines[0], me, e) : me === 'w' ? p.win : 100 - p.win);
const legalCount = fen => { try { return new Chess(fen).moves().length; } catch { return 99; } };

// Everything we know about move `i`: the facts the grade is made from (and which questions are still worth asking Stockfish).
// `probe` is what Stockfish answered to those questions (see brilliant.js), or null before they were asked.
function judgeMove(i, { moves }, pos, probe, elo, useBook = true) {
  const m = moves[i], b = pos[i], a = pos[i + 1], me = m.color, e = elo[me] || 0;
  const played = uci(m), isBest = played === b.best;
  // The move's own line comes from the same search as the "before" score, so depth noise can't make a best or second-best move
  // look like a loss. A move outside the top lines gets its own line by asking Stockfish about exactly that move.
  const inLine = b.lines.find(l => l.pv[0] === played) || null;
  // (a one-move line is continued with the engine's reply from the position after the move, so the card can still show it)
  let own = inLine || probe?.own || null;
  if (own && !inLine && own.pv.length < 2 && a.lines?.[0]) own = { ...own, pv: [own.pv[0], ...a.lines[0].pv] };
  const wb = topWin(b, me, e), wa = own ? winFor(own, me, e) : topWin(a, me, e);
  const drop = isBest ? 0 : Math.max(0, wb - wa);
  const altLine = b.lines.find(l => l.pv[0] !== played) || null;
  const alt = altLine ? winFor(altLine, me, e) : null;
  const gap = b.lines[1] ? wb - winFor(b.lines[1], me, e) : null;
  const prevM = moves[i - 1];
  const recapture = !!(m.captured && prevM && prevM.captured && prevM.to === m.to);
  const forced = legalCount(b.fen) === 1;
  const book = useBook && !forced && i < 24 && inBook(a.fen);

  const steps = own ? replay(b.fen, own.pv, 8) : [];
  const sacInfo = steps.length >= 2 ? sacrificeInLine(steps, me) : null; // the engine's own line decides, when there is one
  const sac = sacInfo ? sacInfo.sac : sacrifice(m, a.fen);
  const g = generosity(e), tol = 2 + 5 * g, floor = 50 - 12 * g;
  // A real sacrifice of a move that is at least close to the best one is worth explaining (why it is, or is not, brilliant);
  // only one that could actually earn the grade is worth asking Stockfish more about.
  const noteworthy = sac && !recapture && !book && !forced && drop <= 8;
  const worth = noteworthy && wb < 92 && (alt == null || alt < 90);
  const deepOk = holdsUp(probe, me, e, tol, floor);
  let altSan = null;
  if (altLine) altSan = replay(b.fen, altLine.pv, 1)[0]?.san || null;
  const need = { own: !inLine && !probe?.own && (drop >= 5 || worth), deep: worth && !probe?.deep };
  return { m, b, a, me, e, played, isBest, inLine, own, wb, wa, drop, alt, altLine, altSan, gap, recapture, forced, book, sac, sacInfo, sacCand: noteworthy, deepOk, tol, floor, probe, need };
}

// Why a sacrifice that looked promising did not earn a brilliant, in words (only for the card's conversation).
function blockedReason(g) {
  if (g.recapture) return 'It only takes back what the opponent just took.';
  if (g.wb >= 92) return `${g.me === 'w' ? 'White' : 'Black'} was already completely winning, so the sacrifice was not needed.`;
  if (g.alt != null && g.alt >= 90) return 'Another move was just as completely winning, so the sacrifice was not needed.';
  if (g.drop > g.tol) return 'It is not the best or nearly the best move.';
  if (g.wa < g.floor) return 'It leaves the position worse than equal.';
  if (!g.deepOk) return 'A deeper look by Stockfish does not back it up.';
  if (!g.sac) return 'The material comes back, so it is a trade, not a sacrifice.';
  return null;
}

// Asks Stockfish the follow-up questions that the first pass left open: how good exactly is a move that was not among its top
// lines, and does a candidate brilliant survive a deeper look? Only a handful of moves per game need it. Never fails the review:
// an engine that can't answer just leaves those moves graded from what the first pass found.
const probeCache = new Map();
async function askProbe(eng, g, depth) {
  const need = g.need, played = g.played, fen = g.b.fen;
  const key = `${eng.kind}|${depth}|${fen}|${played}|${need.own ? 1 : 0}${need.deep ? 1 : 0}`;
  if (!probeCache.has(key)) {
    probeCache.set(key, (async () => {
      const sk = eng.id && `${eng.id}|probe|${depth}|${fen.split(' ').slice(0, 5).join(' ')}|${played}|${need.own ? 1 : 0}${need.deep ? 1 : 0}`;
      const hit = sk && await recall(sk);
      if (hit && typeof hit === 'object') return hit;
      const r = await interview(eng, { fen, played, depth, need });
      if (sk && (r.own || r.deep)) remember(sk, r);
      return r;
    })().catch(e => { probeCache.delete(key); throw e; }));
  }
  return probeCache.get(key);
}

export async function interrogate(engines, game, pos, depth, onProgress = () => {}, opts = {}) {
  const elo = eloOf(game.headers), out = new Array(game.moves.length), book = opts.book !== false;
  const jobs = [];
  game.moves.forEach((_, i) => { const g = judgeMove(i, game, pos, null, elo, book); if (g.need.own || g.need.deep) jobs.push([i, g]); });
  let next = 0, done = 0;
  await Promise.all(engines.map(async eng => {
    if (typeof eng.probe !== 'function') return;
    while (next < jobs.length) {
      const [i, g] = jobs[next++];
      try {
        let rec = await askProbe(eng, g, depth);
        // Stage two: the move's own score may have just shown that it is nearly the best move after all. Then it is worth the deeper look too.
        if (!g.need.deep) {
          const g2 = judgeMove(i, game, pos, rec, elo, book);
          if (g2.need.deep) rec = { ...rec, ...(await askProbe(eng, { ...g2, need: { own: false, deep: true } }, depth)) };
        }
        out[i] = rec;
      } catch { return; } // this engine is in trouble: leave the rest to the others
      onProgress(++done, jobs.length);
    }
  }));
  return out;
}

const mean = xs => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);

// `opts.book: false` switches the opening book off (book moves are recognised by position, which only means something for a game
// that starts from the normal starting position).
export function buildReview({ headers, moves }, pos, probes = [], opts = {}) {
  const elo = eloOf(headers), wins = pos.map(p => p.win);
  const acc = { w: [], b: [] }, wts = { w: [], b: [] }, cpl = { w: [], b: [] }, cnt = { w: {}, b: {} };
  const phase = { w: { open: [[], []], mid: [[], []], end: [[], []] }, b: { open: [[], []], mid: [[], []], end: [[], []] } };
  let prev = 0;
  const items = moves.map((m, i) => {
    const g = judgeMove(i, { moves }, pos, probes[i] || null, elo, opts.book !== false);
    const { b, a, me, own, wb, wa, drop, gap, isBest } = g;
    const cls = classify({ drop, isBest, wb, wa, gap, sac: g.sac, prev, alt: g.alt, recapture: g.recapture, book: g.book, forced: g.forced, deepOk: g.deepOk, elo: g.e });
    const free = g.book || g.forced;           // moves nobody can be blamed for
    prev = free ? 0 : drop;
    const ma = free ? 100 : accuracy(drop), w = volatility(wins, i);
    acc[me].push(ma); wts[me].push(w);
    const ph = phase[me][phaseOf(b.fen, i)];
    ph[0].push(ma); ph[1].push(w);
    // centipawn loss, from the mover's view (a mate counts as 1000)
    const sgn = me === 'w' ? 1 : -1;
    const after = own ? cpOf(own) : a.over === 'mate' ? sgn * 1000 : a.over ? 0 : cpOf(a.lines[0]);
    cpl[me].push(isBest || free ? 0 : Math.max(0, Math.min(1000, sgn * (cpOf(b.lines[0]) - after))));
    cnt[me][cls] = (cnt[me][cls] || 0) + 1;

    let bestSan = null;
    if (b.best && !isBest && BAD.includes(cls)) {
      try { bestSan = new Chess(b.fen).move({ from: b.best.slice(0, 2), to: b.best.slice(2, 4), promotion: b.best[4] }).san; } catch { /* ignore */ }
    }
    const tg = tags({ m, b, a, drop, wb, wa, cls });
    // What Stockfish says about this move: its answer, its own choice, and reasons checked against those lines. A move that Stockfish
    // was asked about directly shows that answer as its line too.
    const cb = g.probe?.own && !g.inLine ? { ...b, lines: [...b.lines, g.probe.own] } : b;
    let extra = { why: [], lines: [], ev: [] };
    try { extra = coach({ m, b: cb, a, cls, isBest, tg }); } catch { /* the review still works without the extra reasons */ }
    let text = explain({ m, cls, tg, bestSan, wa, i, extra });
    if (cls === 'brilliant' && g.probe?.deep) text += ` Stockfish double-checked it at depth ${g.probe.depth}: it still holds.`;
    g.blocked = cls !== 'brilliant' && g.sacCand ? blockedReason(g) : null;
    const talk = ['brilliant', 'great'].includes(cls) || g.sacCand ? interviewText(g, cls) : [];
    return { m, cls, tags: tg.map(t => t[0]), best: isBest ? null : b.best, lines: extra.lines, ev: extra.ev, text, talk, ep: [Math.round(wb * 10) / 10, Math.round(wa * 10) / 10], cpl: Math.round(cpl[me][cpl[me].length - 1]), phase: phaseOf(b.fen, i) };
  });

  const stats = {};
  for (const c of ['w', 'b']) {
    const accuracyC = gameAccuracy(acc[c], wts[c]);
    const ph = k => (phase[c][k][0].length >= 3 ? gameAccuracy(phase[c][k][0], phase[c][k][1]) : null);
    stats[c] = { accuracy: accuracyC, acpl: mean(cpl[c]), rating: estimateRating(accuracyC, acc[c].length), moves: acc[c].length, phases: { open: ph('open'), mid: ph('mid'), end: ph('end') } };
  }
  return { headers, items, pos, acc: { w: stats.w.accuracy, b: stats.b.accuracy }, cnt, stats };
}

// "Ask Stockfish": a deeper look at one position with a few candidate moves, each with the line the engine expects.
// Scores come back from the side to move's view; like everything else here they are converted to White's.
export async function explore(eng, fen, depth, n = 3) {
  const c = new Chess(fen), turn = c.turn();
  if (c.isGameOver()) return [];
  const raw = await eng.explore(fen, depth, n);
  return raw.map(l => {
    const w = toWhite(l, turn);
    const steps = replay(fen, l.pv, 10);
    return { ...mkLine(steps[0]?.san || '?', fen, steps, w), win: w.win };
  }).filter(l => l.steps.length);
}
