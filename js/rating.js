// How good a position is (expected points), how much a move loses, and how a whole game is rated.
// No dependencies. Everything that is a judgement call is a named constant here, so it can be tuned in one place.
//
// Modelled on what Chess.com publishes about Game Review ("Expected Points": a move is graded by the expected points it
// loses; thresholds 0 / 0.02 / 0.05 / 0.10 / 0.20; stricter for stronger players). Chess.com's own model and its Game Rating
// are not public, so the numbers below are an approximation, not a copy.

const K = 0.00368208; // Lichess' fit of centipawns to winning chances
export const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-K * cp)) - 1);
export const accuracy = drop => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// A weaker player turns the same advantage into a win less often, so a "lost" pawn matters less to them. 1 = no adjustment
// (also used when the rating is unknown); 0.6 at 600 and below.
export const eloScale = elo => (elo > 0 ? clamp(0.6 + (0.4 * (elo - 600)) / 1800, 0.6, 1) : 1);
// How much more forgiving the special grades (brilliant, great) are for weaker players: 0 for 2400+, 0.4 at 600.
export const generosity = elo => 1 - eloScale(elo);

// Expected points (0-100, White's view) of a line {cp|mate, wdl?}. Prefers Stockfish's own win/draw/loss estimate when it was
// asked for it (it knows a dead-drawn endgame from a won one; centipawns alone do not), otherwise the cp curve.
export function lineWin(l) {
  if (!l) return 50;
  if (l.mate != null) return l.mate > 0 ? 100 : l.mate < 0 ? 0 : 50;
  if (Array.isArray(l.wdl)) {
    const [w, d, x] = l.wdl, t = w + d + x;
    if (t > 0) return ((w + d / 2) / t) * 100;
  }
  return winPct(l.cp ?? 0);
}

// An engine line ({cp|mate, pv, wdl?} from the side to move's view, as UCI reports it) in White's view, with its expected points.
export function toWhite(l, turn) {
  const s = turn === 'w' ? 1 : -1;
  const out = { mate: l.mate != null ? l.mate * s : null, cp: l.cp != null ? l.cp * s : null, pv: l.pv };
  if (Array.isArray(l.wdl)) out.wdl = s === 1 ? l.wdl : [l.wdl[2], l.wdl[1], l.wdl[0]];
  if (l.depth != null) out.depth = l.depth;
  out.win = lineWin(out);
  return out;
}

// The same, from `color`'s point of view and adjusted for that player's rating (mates are never adjusted).
export function winFor(l, color, elo = 0) {
  const w = lineWin(l), mine = color === 'w' ? w : 100 - w;
  if (l && l.mate != null && l.mate !== 0) return mine;
  return 50 + (mine - 50) * eloScale(elo);
}

// Centipawn loss helper: a line's score in centipawns from White's view, mates counted as +-1000, everything clipped to +-1000.
export const cpOf = l => (!l ? 0 : l.mate != null ? (l.mate > 0 ? 1000 : l.mate < 0 ? -1000 : 0) : clamp(l.cp ?? 0, -1000, 1000));

// ---- a whole game ---------------------------------------------------------------------------------------------------
// Lichess' approach: moves in sharp positions count more (volatility weighting), and a harmonic mean makes one terrible move
// cost more than a plain average would. Both are averaged.
export function volatility(wins, i, n = wins.length) {
  const size = clamp(Math.round(n / 10), 2, 8), win = wins.slice(i, i + size);
  if (win.length < 2) return 0.5;
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
  return clamp(sd, 0.5, 12);
}

export function gameAccuracy(accs, weights) {
  if (!accs.length) return 0;
  const w = weights && weights.length === accs.length ? weights : accs.map(() => 1);
  const wsum = w.reduce((a, b) => a + b, 0);
  const weighted = accs.reduce((s, a, i) => s + a * w[i], 0) / wsum;
  const harmonic = accs.length / accs.reduce((s, a) => s + 1 / Math.max(a, 1), 0);
  return (weighted + harmonic) / 2;
}

// Opening / middlegame / endgame from the pieces on the board (knights 3, bishops 3, rooks 5, queens 9, both sides together;
// a full board is 62). The opening is only the first ten moves, and only while most of the pieces are still there.
export function phaseOf(fen, ply) {
  let m = 0;
  for (const ch of fen.split(' ')[0]) m += { n: 3, b: 3, r: 5, q: 9 }[ch.toLowerCase()] || 0;
  if (m <= 24) return 'end';
  return ply < 20 && m >= 50 ? 'open' : 'mid';
}

// Accuracy -> an estimated rating for the game. Anchors are typical accuracies of rated players, interpolated; this is an
// estimate of how well the game was played, not a measured rating. Returns null for very short games, where it means nothing.
const ANCHORS = [[25, 200], [40, 400], [52, 650], [62, 900], [70, 1200], [76, 1500], [82, 1800], [87, 2100], [91, 2400], [95, 2700], [98, 3000], [100, 3200]];
export function estimateRating(acc, moves) {
  if (!(moves >= 8) || !Number.isFinite(acc)) return null;
  if (acc <= ANCHORS[0][0]) return ANCHORS[0][1];
  for (let i = 1; i < ANCHORS.length; i++) {
    const [a1, r1] = ANCHORS[i], [a0, r0] = ANCHORS[i - 1];
    if (acc <= a1) return Math.round((r0 + ((r1 - r0) * (acc - a0)) / (a1 - a0)) / 50) * 50;
  }
  return ANCHORS[ANCHORS.length - 1][1];
}
