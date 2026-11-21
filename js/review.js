import { Chess } from '../vendor/chess.js';
import { BAD } from './meta.js';

const V = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };      // material value
const A = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };    // attacker value (king never captures into defence)
const N = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
export const accuracy = drop => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));

export function classify({ drop, isBest, wb, wa, gap, sac, prev }) {
  if (sac && drop <= 2 && wa >= 50 && wb < 92) return 'brilliant';
  if (isBest && gap != null && gap >= 12 && wb > 12 && wb < 92 && wa < 97) return 'great';
  if (drop >= 20) return 'blunder';
  if (drop >= 5) return prev >= 10 ? 'miss' : drop >= 10 ? 'mistake' : 'inaccuracy';
  if (isBest || drop <= 0.3) return 'best';
  return drop <= 2 ? 'excellent' : 'good';
}

const play = (fen, u) => {
  const c = new Chess(fen);
  try { return { c, m: c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }) }; }
  catch { return null; }
};

// A piece is "sacrificed" if it lands on a square where it can be taken for a net material loss.
export function sacrifice(m, afterFen) {
  if (m.piece === 'p' || m.piece === 'k') return false;
  const c = new Chess(afterFen);
  const opp = m.color === 'w' ? 'b' : 'w';
  const att = c.attackers(m.to, opp);
  if (!att.length) return false;
  const minA = Math.min(...att.map(s => A[c.get(s).type]));
  const gain = m.captured ? V[m.captured] : 0;
  const defended = c.attackers(m.to, m.color).length > 0;
  return V[m.piece] - gain >= 2 && (minA < V[m.piece] || !defended);
}

const ORDER = ['mated', 'missMate', 'allowMate', 'hang', 'trade', 'missCap', 'thrown', 'swing', 'sac', 'only'];

export function tags({ m, b, a, drop, wb, wa, cls }) {
  const t = [];
  const pov = x => (x == null ? null : m.color === 'w' ? x : -x);
  const bm = pov(b.mate), am = pov(a.mate);
  if (a.over === 'mate') t.push(['mated', {}]);
  if (bm > 0 && !(am > 0)) t.push(['missMate', { n: bm === 1 ? 'one' : bm }]);
  else if (am < 0 && !(bm < 0)) t.push(['allowMate', { n: am === -1 ? 'one' : -am }]);

  if (drop >= 5) {
    const r = a.best && play(a.fen, a.best);
    if (r && r.m.captured) {
      const recapture = r.c.moves({ verbose: true }).some(x => x.to === r.m.to && x.captured);
      if (!recapture && V[r.m.captured] >= 1) t.push(['hang', { piece: N[r.m.captured], sq: r.m.to }]);
      else if (recapture && V[r.m.captured] - V[r.m.piece] >= 2) t.push(['trade', { lost: N[r.m.captured], taker: N[r.m.piece] }]);
    }
    const q = b.best && play(b.fen, b.best);
    if (q && q.m.captured && V[q.m.captured] >= 3 && q.m.san !== m.san) t.push(['missCap', { piece: N[q.m.captured], sq: q.m.to }]);
    if (wb >= 70 && wa <= 55) t.push(['thrown', {}]);
    else if (wb > 40 && wa <= 25) t.push(['swing', {}]);
  }
  if (cls === 'brilliant') t.push(['sac', { piece: N[m.piece] }]);
  if (cls === 'great') t.push(['only', {}]);
  return t.sort((x, y) => ORDER.indexOf(x[0]) - ORDER.indexOf(y[0]));
}

// ---- Sentence pools: pick a headline, add up to 2 tag clauses, then "best was" + eval state.
const P = {
  brilliant: ['{san} is brilliant! A real sacrifice that the engine backs up.', '{san}!! Bold, and it actually works.', 'What a find: {san}.'],
  great: ['{san} is a great move.', '{san} is the key move in this position.', 'Well spotted: {san}.'],
  best: ['{san} is the best move.', '{san} is exactly what the engine wanted.', 'Top choice: {san}.', '{san} is spot on.'],
  excellent: ['{san} is excellent.', '{san} is almost as good as the best move.', 'Very solid: {san}.'],
  good: ['{san} is a good move.', '{san} is fine.', '{san} does the job.'],
  inaccuracy: ['{san} is an inaccuracy.', '{san} is slightly imprecise.', '{san} is not the most accurate.'],
  mistake: ['{san} is a mistake.', '{san} is a real slip.', '{san} hurts the position.'],
  miss: ['{san} misses a chance.', '{me} missed a chance with {san}.', '{san} lets {opp} off the hook.'],
  blunder: ['{san} is a blunder.', '{san} is a serious blunder.', 'Ouch, {san} is a big blunder.'],
};
const T = {
  mated: ['Checkmate!', '{san} is checkmate. Game over.'],
  missMate: ['{me} missed mate in {n}.', 'There was a forced mate in {n} here.', 'Mate in {n} was on the board.'],
  allowMate: ['This allows mate in {n}.', '{opp} now has a forced mate in {n}.', 'It walks into a forced mate in {n}.'],
  hang: ['The {piece} on {sq} is left hanging.', '{opp} can just take the {piece} on {sq} for free.', 'This leaves the {piece} on {sq} undefended.'],
  trade: ['{me} loses material: the {lost} falls to a {taker}.', '{opp} wins the exchange by taking the {lost} with a {taker}.'],
  missCap: ['{me} could have won the {piece} on {sq}.', 'A free {piece} on {sq} was there for the taking.'],
  thrown: ['{me} was clearly winning and this throws most of it away.', 'This gives back a big advantage.'],
  swing: ['The game swings and {me} is now clearly worse.', 'This turns the position in {opp}’s favour.'],
  sac: ['{me} gives up the {piece} but the follow-up justifies it.', 'The {piece} sacrifice works tactically.'],
  only: ['It is the only move that keeps things under control.', 'Everything else was much worse.'],
};
const BETTER = ['Best was {best}.', 'The engine preferred {best}.', '{best} was the move.', '{best} was the better try.'];
const STATE = [[85, 'completely winning'], [65, 'clearly better'], [55, 'slightly better'], [45, null], [35, 'slightly worse'], [15, 'clearly worse'], [0, 'completely lost']];

export function explain({ m, cls, tg, bestSan, wa, i }) {
  let s = i * 7919 + 13; // seeded, so the same game always reads the same
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const me = m.color === 'w' ? 'White' : 'Black', opp = m.color === 'w' ? 'Black' : 'White';
  const fill = (t, v = {}) => t.replace(/\{(\w+)\}/g, (_, k) => ({ san: m.san, me, opp, best: bestSan, ...v })[k] ?? '');
  if (tg.some(t => t[0] === 'mated')) return fill(pick(T.mated));
  const out = [fill(pick(P[cls]))];
  tg.slice(0, 2).forEach(([k, v]) => out.push(fill(pick(T[k]), v)));
  if (bestSan && BAD.includes(cls)) out.push(fill(pick(BETTER)));
  if (['mistake', 'miss', 'blunder', 'brilliant'].includes(cls)) {
    const st = STATE.find(x => wa >= x[0])[1];
    out.push(st ? `${me} is now ${st}.` : 'The position is now roughly equal.');
  }
  return out.join(' ');
}
