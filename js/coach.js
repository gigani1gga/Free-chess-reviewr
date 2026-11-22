// Turns what Stockfish said (its best line before a move, its best reply after it) into plain-language reasons.
// Nothing is guessed: every sentence is checked against the board by replaying the engine's own lines.
// Only needs the same chess.js API the rest of the app uses.
import { Chess } from '../vendor/chess.js';
import { fmtEval } from './util.js';

const V = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };   // material value
const A = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }; // attacker value (a king only captures what nobody guards)
export const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const FILES = 'abcdefgh';
const idx = s => (8 - +s[1]) * 8 + FILES.indexOf(s[0]);
const sqn = i => FILES[i & 7] + (8 - (i >> 3));
const isW = p => p === p.toUpperCase();
const side = p => (isW(p) ? 'w' : 'b');

// ---- a tiny board scanner (piece placement only) -------------------------------------------------------------------
const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const BD = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const RD = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function board(fen) {
  const b = new Array(64).fill(null);
  let i = 0;
  for (const ch of fen.split(' ')[0]) {
    if (ch === '/') continue;
    if (/\d/.test(ch)) i += +ch; else b[i++] = ch;
  }
  return b;
}

// Squares a piece covers (including squares holding its own pieces, which it then defends). Pins are ignored.
function attacksFrom(b, i) {
  const p = b[i], t = p.toLowerCase(), r = i >> 3, f = i & 7, out = [];
  const add = (rr, ff) => { if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) out.push(rr * 8 + ff); };
  if (t === 'p') { const d = isW(p) ? -1 : 1; add(r + d, f - 1); add(r + d, f + 1); }
  else if (t === 'n') KN.forEach(([a, c]) => add(r + a, f + c));
  else if (t === 'k') KG.forEach(([a, c]) => add(r + a, f + c));
  else {
    for (const [dr, df] of t === 'b' ? BD : t === 'r' ? RD : [...BD, ...RD]) {
      let rr = r + dr, ff = f + df;
      while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { out.push(rr * 8 + ff); if (b[rr * 8 + ff]) break; rr += dr; ff += df; }
    }
  }
  return out;
}

// For one side: how many of its pieces cover each square, and the value of the cheapest one.
function cover(b, color) {
  const n = new Array(64).fill(0), min = new Array(64).fill(Infinity);
  b.forEach((p, i) => {
    if (!p || side(p) !== color) return;
    for (const t of attacksFrom(b, i)) { n[t]++; min[t] = Math.min(min[t], A[p.toLowerCase()]); }
  });
  return { n, min };
}

// Pieces of `color` (never the king) that the other side wins by capturing: nobody guards them, or a cheaper piece attacks them.
export function loose(b, color) {
  const mine = cover(b, color), theirs = cover(b, color === 'w' ? 'b' : 'w'), out = [];
  b.forEach((p, i) => {
    if (!p || side(p) !== color || p.toLowerCase() === 'k') return;
    const t = p.toLowerCase();
    if (theirs.n[i] && (!mine.n[i] || theirs.min[i] < V[t])) out.push({ i, t });
  });
  return out.sort((x, y) => V[y.t] - V[x.t]);
}

// ---- replaying engine lines ----------------------------------------------------------------------------------------
// Plays a UCI line from `fen`; stops quietly at the first move that is not legal (a line must never break the review).
export function replay(fen, pv = [], max = 10) {
  const out = [];
  let c;
  try { c = new Chess(fen); } catch { return out; }
  for (const u of (pv || []).slice(0, max)) {
    let m = null;
    try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { /* illegal */ }
    if (!m) break;
    out.push(m);
  }
  return out;
}

// The plain, serialisable form the UI keeps.
export const plain = s => ({ san: s.san, from: s.from, to: s.to, fen: s.after, uci: s.from + s.to + (s.promotion || '') });

// ["12.Nxe5", "Bxe5", "13.Qh5+"] (or ["12…Bxe5", "13.Qh5+"] when the line starts with Black).
export function fmtMoves(startFen, steps) {
  const f = startFen.split(' ');
  let n = +f[5] || 1;
  return steps.map((s, i) => {
    const black = (s.color || (i % 2 ? (f[1] === 'w' ? 'b' : 'w') : f[1])) === 'b';
    const txt = black ? (i === 0 ? `${n}…${s.san}` : s.san) : `${n}.${s.san}`;
    if (black) n++;
    return txt;
  });
}
export const fmtLine = (startFen, steps) => fmtMoves(startFen, steps).join(' ');

// Material the `color` side nets over a line, counted only up to the last quiet move so a capture that the engine's
// line cuts off before the recapture is never reported as a win. A line that ends in mate counts in full.
export function outcome(steps, color) {
  const mated = steps.length && steps[steps.length - 1].san.endsWith('#');
  let last = -1;
  steps.forEach((s, i) => { if (!s.captured) last = i; });
  const upto = mated ? steps.length - 1 : last;
  let net = 0;
  for (let i = 0; i <= upto; i++) {
    const s = steps[i], v = (s.captured ? V[s.captured] : 0) + (s.promotion ? V[s.promotion] - 1 : 0);
    net += s.color === color ? v : -v;
  }
  return { net, mate: !!mated };
}

export function material(n) {
  const a = Math.abs(n);
  return a === 1 ? 'a pawn' : a === 3 ? 'a piece' : a === 5 ? 'a rook' : a === 9 ? 'a queen' : `about ${a} points of material`;
}

// ---- what a single move does ---------------------------------------------------------------------------------------
const ORDER = ['mate', 'promote', 'winFree', 'winUp', 'trade', 'fork', 'check', 'rescue', 'protect', 'threat', 'castle', 'develop', 'centre'];

export function purpose(s) {
  if (s.san.endsWith('#')) return [['mate', {}]];
  const me = s.color, opp = me === 'w' ? 'b' : 'w', B = board(s.before), Z = board(s.after);
  const to = idx(s.to), from = idx(s.from), out = [];
  const theirs = cover(Z, opp);
  if (s.promotion) out.push(['promote', { piece: NAME[s.promotion] }]);
  if (s.captured) {
    const v = { piece: NAME[s.captured], taker: NAME[s.piece], sq: s.to };
    if (!theirs.n[to]) out.push(['winFree', v]);
    else if (V[s.captured] - V[s.piece] >= 2) out.push(['winUp', v]);
    else if (V[s.captured] >= 3) out.push(['trade', v]);
  }
  if (s.san.includes('+')) out.push(['check', {}]);

  const lostAfter = loose(Z, me);
  if (s.piece !== 'k' && !lostAfter.some(x => x.i === to)) {
    const t = attacksFrom(Z, to).filter(q => {
      const p = Z[q];
      if (!p || side(p) === me) return false;
      const ty = p.toLowerCase();
      return ty === 'k' || (ty !== 'p' && (V[ty] > V[s.piece] || !theirs.n[q]));
    }).map(q => Z[q].toLowerCase()).sort((x, y) => A[y] - A[x]);
    if (t.length >= 2) out.push(['fork', { a: NAME[t[0]], b: NAME[t[1]], same: t[0] === t[1] }]);
  }

  const wasLoose = loose(B, me).filter(x => V[x.t] >= 3);
  if (wasLoose.length) {
    const moved = wasLoose.find(x => x.i === from);
    if (moved && !lostAfter.some(x => x.i === to)) out.push(['rescue', { piece: NAME[moved.t] }]);
    else {
      const saved = wasLoose.find(x => x.i !== from && !lostAfter.some(y => y.i === x.i));
      if (saved) out.push(['protect', { piece: NAME[saved.t], sq: sqn(saved.i) }]);
    }
  }
  const was = new Set(loose(B, opp).map(x => x.i));
  const now = loose(Z, opp).filter(x => V[x.t] >= 3 && !was.has(x.i));
  if (now.length && !out.some(k => k[0] === 'fork' || k[0] === 'check')) out.push(['threat', { piece: NAME[now[0].t], sq: sqn(now[0].i) }]);

  const full = +s.before.split(' ')[5] || 1;
  if (/[kq]/.test(s.flags || '')) out.push(['castle', {}]);
  else if ((s.piece === 'n' || s.piece === 'b') && full <= 12 && s.from[1] === (me === 'w' ? '1' : '8')) out.push(['develop', { piece: NAME[s.piece] }]);
  else if (s.piece === 'p' && full <= 10 && ['d4', 'e4', 'd5', 'e5'].includes(s.to)) out.push(['centre', {}]);
  return out;
}

const PHRASE = {
  mate: () => 'gives checkmate',
  promote: v => `promotes to a ${v.piece}`,
  winFree: v => `wins the ${v.piece} on ${v.sq} for free`,
  winUp: v => `wins a ${v.piece} for a ${v.taker}`,
  trade: v => (v.taker === v.piece ? `trades off a ${v.piece}` : `trades the ${v.taker} for the ${v.piece}`),
  check: () => 'gives check',
  fork: v => (v.same ? `attacks two ${v.a}s at once` : `attacks the ${v.a} and the ${v.b} at once`),
  rescue: v => `saves the ${v.piece} from being captured`,
  protect: v => `deals with the threat to the ${v.piece} on ${v.sq}`,
  threat: v => `threatens the ${v.piece} on ${v.sq}`,
  castle: () => 'castles to safety',
  develop: v => `develops the ${v.piece}`,
  centre: () => 'fights for the centre',
};
const join = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// Up to `max` verb phrases for what the move does, most important first: ["wins the knight on e5 for free", "gives check"].
export function fragments(s, max = 2, only = null) {
  if (!s) return [];
  return purpose(s).filter(([k]) => !only || only.includes(k))
    .sort((x, y) => ORDER.indexOf(x[0]) - ORDER.indexOf(y[0])).slice(0, max).map(([k, v]) => PHRASE[k](v));
}
const PUNISH = ['mate', 'winFree', 'winUp', 'trade', 'fork', 'check'];

// ---- putting it together for one move of the game ------------------------------------------------------------------
const LINE_STEPS = 10;
export const mkLine = (label, start, steps, ev) => ({ label, start, steps: steps.map(plain), moves: fmtMoves(start, steps), ev: fmtEval(ev) });

// `pos` objects are the ones analysis.js builds (White's point of view). Returns the sentences for the card
// and the replayable lines for the board.
export function coach({ m, b, a, cls, isBest, tg }) {
  const me = m.color, who = me === 'w' ? 'White' : 'Black', opp = me === 'w' ? 'Black' : 'White';
  const tagKeys = tg.map(t => t[0]);
  const bestLine = b.lines[0], bestSteps = replay(b.fen, bestLine?.pv, LINE_STEPS);
  const bestSan = isBest ? null : bestSteps[0]?.san || null;
  const replySteps = a.lines?.[0] ? replay(a.fen, a.lines[0].pv, LINE_STEPS - 1) : [];
  const own = b.lines.find(l => l.pv[0] === m.from + m.to + (m.promotion || ''));
  const ownSteps = own ? replay(b.fen, own.pv, LINE_STEPS) : [];
  const after = ownSteps.length ? ownSteps : [m, ...replySteps];

  const lines = [];
  lines.push(mkLine(isBest ? 'Stockfish’s line' : 'Stockfish’s answer', b.fen, after, ownSteps.length ? own : a));
  if (!isBest && bestSteps.length) lines.push(mkLine('Better line', b.fen, bestSteps, bestLine));

  const bad = ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(cls);
  const why = [];
  let reply = null, better = null, slight = null;
  const f = fragments(m);

  if (!bad) {
    if (f.length) why.push(`${m.san} ${join(f)}.`);
    if (cls === 'brilliant') {
      const o = outcome(after, me);
      if (o.mate) why.push('The line ends in forced mate.');
      else if (o.net >= 1) why.push(`Stockfish’s line wins back ${material(o.net)}.`);
    }
    if (cls === 'great' && b.lines[1]) {
      const alt = replay(b.fen, b.lines[1].pv, 1)[0];
      if (alt) why.push(`The next best move, ${alt.san}, only gives ${fmtEval(b.lines[1])}.`);
    }
    if (bestSan && (cls === 'excellent' || cls === 'good')) slight = `Stockfish slightly preferred ${bestSan} (${fmtEval(bestLine)}).`;
  } else {
    if (!tagKeys.some(k => ['hang', 'trade', 'allowMate', 'mated'].includes(k)) && replySteps[0]) {
      const r = fragments(replySteps[0], 2, PUNISH);
      const o = outcome(after, me);
      let s = `${opp} answers ${replySteps[0].san}`;
      s += r.length ? `, which ${join(r)}` : '';
      const wins = !o.mate && o.net <= -1; // a line that ends in mate needs no material count
      s += wins ? `${r.length ? ', and' : ' and'} wins ${material(o.net)}` : '';
      if (r.length || wins) reply = s + '.';
    }
    const bf = fragments(bestSteps[0]);
    const ob = outcome(bestSteps, me);
    if (bf.length) better = `It ${join(bf)}.`;
    else if (ob.net >= 1 && ob.net > outcome(after, me).net) better = `That line wins ${material(ob.net)}.`;
  }
  return { why, reply, better, slight, lines, bestSan, ev: [fmtEval(b), fmtEval(a)] };
}
