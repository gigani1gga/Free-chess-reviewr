// Talking to Stockfish to understand brilliant moves.
//
// A heuristic can only say "this piece lands on an attacked square". Whether that is a sacrifice, and whether it is *good*, is
// something only the engine knows, so the reviewer asks it:
//   1. "Play this exact move: how good is it?"                    (searchmoves: the move's own score, not a guess from the next position)
//   2. "Follow your line: how much material do I really give up?"  (the engine's own continuation, replayed on the board)
//   3. "And if I had not found it, what would I have had?"         (the best alternative from the MultiPV lines)
//   4. "Does it still hold when you look deeper?"                  (a deeper search of the played move and of the best move)
// Chess.com's rule of thumb is a *good piece sacrifice* that is the best or nearly the best move, that does not leave you in a
// bad position, and that you did not need because you were completely winning anyway. Steps 1-4 supply exactly those facts.
//
// Everything here is either a pure function of data (testable without an engine) or one small async function (`interview`)
// that only needs an object with `probe(fen, depth, { moves, multipv })`, which js/engine.js provides.
import { outcome, material } from './coach.js';
import { toWhite, winFor } from './rating.js';
import { fmtEval } from './util.js';

const SAC_NET = -2;     // material points the mover must be down at the end of the line (a piece for a pawn, an exchange)
const DEEP_EXTRA = 4;   // how much deeper the double-check looks
const MAX_DEPTH = 24;

// ---- 2. is it really a sacrifice? (reading the engine's line) --------------------------------------------------------
// Walks the line the engine expects after the move. The mover has sacrificed when, at the end of the line (counted only up to
// the last quiet move, so a capture the line cuts off before the recapture is never counted), a piece has been given up
// and the material balance for the mover is -2 or worse; a line that ends in mate counts if the deficit was ever that large.
export function sacrificeInLine(steps, color) {
  if (!steps || !steps.length) return { sac: false, net: 0, min: 0, mate: false, lost: null };
  let min = 0;
  for (let n = 1; n <= steps.length; n++) min = Math.min(min, outcome(steps.slice(0, n), color).net);
  const end = outcome(steps, color);
  const lostPiece = steps.find(s => s.color !== color && s.captured && s.captured !== 'p');
  const deficit = end.mate ? min : end.net;
  return { sac: !!lostPiece && deficit <= SAC_NET, net: end.net, min, mate: end.mate, lost: lostPiece ? lostPiece.captured : null };
}

// ---- 1 + 4. asking the engine ----------------------------------------------------------------------------------------
// Returns what Stockfish said, in White's point of view (the same as every other position result):
//   own      the played move searched on its own            (only when `need.own`)
//   deep     the played move at a greater depth             (only when `need.deep`)
//   deepBest the best move at that depth, deepAlt the best other move
//   depth    the depth `deep` was searched to
export async function interview(eng, { fen, played, depth, need }) {
  const turn = fen.split(' ')[1], rec = {};
  const one = async (d, moves) => { const r = (await eng.probe(fen, d, { moves, multipv: 1 }))[0]; return r ? toWhite(r, turn) : null; };
  if (need.own) {
    const own = await one(depth, [played]);
    if (own) rec.own = own;
  }
  if (need.deep) {
    const d = Math.min(MAX_DEPTH, depth + DEEP_EXTRA);
    const top = (await eng.probe(fen, d, { multipv: 3 })).map(l => toWhite(l, turn));
    if (top.length) {
      rec.depth = d;
      rec.deepBest = top[0];
      rec.deepAlt = top.find(l => l.pv[0] !== played) || null;
      rec.deep = top.find(l => l.pv[0] === played) || await one(d, [played]);
    }
  }
  return rec;
}

// Does the deeper look agree? Without a deeper look there is nothing to disagree with.
export function holdsUp(probe, color, elo, tol, floor) {
  if (!probe || !probe.deep || !probe.deepBest) return true;
  const own = winFor(probe.deep, color, elo), best = winFor(probe.deepBest, color, elo);
  return own >= floor && best - own <= tol + 1;
}

// ---- the conversation, in words --------------------------------------------------------------------------------------
const pct = x => Math.round(x) + '%';
// `g`: the facts judgeMove (analysis.js) collected. Returns [[question, answer], ...] for the card; [] when there is nothing to say.
export function interviewText(g, cls) {
  const qa = [], me = g.me === 'w' ? 'White' : 'Black';
  const info = g.sacInfo;
  if (g.sacCand || cls === 'brilliant') {
    if (info && info.sac) {
      qa.push([`Is ${g.m.san} really a sacrifice?`, `Yes. Following Stockfish’s line, ${me} gives up ${info.mate ? 'material on the way to mate' : material(-info.net)} (it ${info.lost ? 'loses a ' + NAMES[info.lost] : 'loses material'}).`]);
    } else if (info) {
      qa.push([`Is ${g.m.san} really a sacrifice?`, `No. In Stockfish’s line the material comes straight back (${info.net >= 0 ? 'even or better' : 'only ' + material(-info.net) + ' down'}).`]);
    } else {
      qa.push([`Is ${g.m.san} really a sacrifice?`, 'Probably: the piece lands where it can be taken, but the engine did not show a line to confirm it.']);
    }
  }
  if (g.own) qa.push(['How good is exactly this move?', `Stockfish scores it ${fmtEval(g.own)} (${pct(g.wa)} winning chances for ${me}), ${g.isBest ? 'the best move in the position' : g.drop > 0.3 ? `${g.drop.toFixed(1)} points below the best move` : 'as good as the best move'}.`]);
  if (g.alt != null && g.altLine) qa.push([g.isBest ? 'And if the best move had not been found?' : 'What was the alternative?', `The best other move, ${g.altSan || 'another move'}, only gives ${fmtEval(g.altLine)} (${pct(g.alt)}).`]);
  if (g.probe && g.probe.deep) qa.push([`Does it hold up at depth ${g.probe.depth}?`, g.deepOk ? `Yes: ${fmtEval(g.probe.deep)} at the deeper look${g.probe.deepBest && g.probe.deepBest.pv[0] !== g.played ? `, against ${fmtEval(g.probe.deepBest)} for the engine’s top choice` : ''}.` : `No: at the deeper look it scores ${fmtEval(g.probe.deep)}, against ${fmtEval(g.probe.deepBest)} for the best move.`]);
  if (cls !== 'brilliant' && g.sacCand) {
    const why = g.blocked;
    if (why) qa.push(['Why not brilliant?', why]);
  }
  return qa;
}
const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };
