// A fake Stockfish for Node-side tests: the same object the app's analysis code talks to ({ kind, analyze(fen, depth), explore() }),
// answering from the side to move's point of view like UCI, with scores/lines that are DETERMINISTIC functions of the position:
//   - a material evaluation plus noise that depends only on (seed, position, move), so a game gets the same grades every run
//   - mate scores: "mate 1" when a move mates, "mate -1" when it walks into a mate in one
//   - everything is computed from the White-to-move version of the position and mapped back, so a position and its colour-swapped
//     twin get exactly mirrored answers (a grading difference between them is then a bug in the app, not in the fake)
//   - `glitch` makes it occasionally return a single line, a one-move line, or a line with an illegal tail, like a real engine's
//     odd moments, to check the app copes
import { chessModule } from './chess.mjs';
import { mirrorFen, mirrorUci } from './gen.mjs';
import { hash } from './prng.mjs';

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

export async function fakeEngine({ seed = 1, noise = 70, glitch = 0, kind = 'fake', id, depthNoise = false, wdl = false } = {}) {
  const { ChessCore: C } = await chessModule();
  const calls = [];
  const uci = m => C.sqName(m.from) + C.sqName(m.to) + (m.promo || '');
  const material = s => { let v = 0; for (const p of s.board) if (p) v += (p === p.toUpperCase() ? 1 : -1) * VAL[p.toLowerCase()]; return v; };
  const noiseOf = (key, spread) => { const h = hash(key + '|' + seed); const base = ((h & 0xffff) / 0xffff - 0.5) * 2 * spread; return ((h >>> 16) % 17 === 0 ? base * 6 : base); }; // fat tails: the odd blunder

  // Noise is keyed on the position WITHOUT the fullmove counter: a colour-swapped game starts with Black to move, so its counters
  // differ from the original's even though the positions are exact mirrors.
  const keyOf = f => f.split(' ').slice(0, 5).join(' ');
  function canonicalLines(fen, n, only) {                // fen: White to move; `only`: the root moves to search (searchmoves)
    const s = C.parseFen(fen), ms = C.legal(s), key = keyOf(fen);
    if (!ms.length) return [];
    const opts = ms.filter(m => !only || only.includes(uci(m))).map(m => {
      const t = C.apply(s, m), u = uci(m);
      const replies = C.legal(t);
      if (C.inCheck(t) && !replies.length) return { m, u, mate: 1, score: 100000 };
      if (!replies.length || t.half >= 100) return { m, u, cp: 0, score: 0 };
      // static: material after the move, less what the opponent can grab at once (one capture deep)
      const grab = Math.max(0, ...replies.map(r => (t.board[r.to] ? VAL[t.board[r.to].toLowerCase()] : r.ep ? 100 : 0)));
      const cp = Math.round(material(t) - grab * 0.5 + noiseOf(key + u, noise));
      return { m, u, t, cp, score: cp };
    });
    opts.sort((a, b) => b.score - a.score || (a.u < b.u ? -1 : 1));
    const top = opts.slice(0, Math.max(n, 3));
    for (const o of top) { // does it walk into a mate in one?
      if (o.mate || !o.t) continue;
      if (C.legal(o.t).some(r => { const w = C.apply(o.t, r); return C.inCheck(w) && !C.legal(w).length; })) { o.mate = -1; o.cp = undefined; o.score = -99999; }
    }
    top.sort((a, b) => b.score - a.score || (a.u < b.u ? -1 : 1));
    const g = glitch ? hash('g' + key + seed) % 100 / 100 : 1;
    const want = g < glitch / 3 ? 1 : n;
    return top.slice(0, want).map(o => {
      const pv = [o.u];
      let t = o.t;
      const len = g < glitch / 3 * 2 && g >= glitch / 3 ? 1 : 2 + (hash(key + o.u) % 5);
      while (t && pv.length < len) {                     // greedy continuation
        const ms2 = C.legal(t);
        if (!ms2.length) break;
        const pick = ms2.map(r => ({ r, k: (t.board[r.to] ? VAL[t.board[r.to].toLowerCase()] : 0) + noiseOf(key + pv.join() + uci(r), 60) })).sort((a, b) => b.k - a.k || (uci(a.r) < uci(b.r) ? -1 : 1))[0].r;
        pv.push(uci(pick)); t = C.apply(t, pick);
      }
      if (g >= glitch / 3 * 2 && g < glitch) pv.push('a1a1'); // an illegal move at the end of the line
      return o.mate ? { mate: o.mate, pv } : { cp: o.cp, pv };
    });
  }

  // A plausible win/draw/loss from a score (side to move's view): only there when the fake is made with `wdl: true`.
  const withWdl = l => {
    if (!wdl) return l;
    const sc = l.mate != null ? (l.mate > 0 ? 9999 : -9999) : l.cp;
    const d = Math.round(400 * Math.exp(-((sc / 400) ** 2))), p = 1 / (1 + Math.exp(-sc / 180)), w = Math.round((1000 - d) * p);
    return { ...l, wdl: [w, d, 1000 - d - w] };
  };
  function lines(fen, n, only) {
    const black = fen.split(' ')[1] === 'b';
    const canon = canonicalLines(black ? mirrorFen(fen) : fen, n, black && only ? only.map(mirrorUci) : only);
    return (black ? canon.map(l => ({ ...l, pv: l.pv.map(mirrorUci) })) : canon).map(withWdl);
  }

  const eng = {
    kind, name: 'Fake Stockfish', calls, probes: [],
    async analyze(fen, depth) { calls.push(fen); if (depthNoise && depth) { /* depth is accepted and ignored, like a deterministic engine */ } return lines(fen, 2); },
    async explore(fen, depth, n = 3) { calls.push('explore ' + fen); return lines(fen, n); },
    async probe(fen, depth, { moves, multipv = 2 } = {}) { eng.probes.push({ fen, depth, moves, multipv }); return lines(fen, multipv, moves); },
    terminate() {},
  };
  if (id) eng.id = id;
  return eng;
}
