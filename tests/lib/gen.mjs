// Random but LEGAL chess: games, positions and PGNs for fuzzing. Uses the kit's stand-in move generator (itself checked against an
// independent oracle in the `chess` suite), with a bias towards captures/checks/promotions so games reach mates, endgames and
// promotions instead of shuffling pieces.
import { chessModule } from './chess.mjs';

export const uciOf = (C, m) => C.sqName(m.from) + C.sqName(m.to) + (m.promo || '');

// One random game from `fen`. Returns the starting FEN, the moves as UCI strings, and every position along the way.
export async function randomGame(r, { fen, maxPlies = 80, greed = 0.45 } = {}) {
  const { ChessCore: C } = await chessModule();
  let s = C.parseFen(fen || C.START_FEN);
  const startFen = C.toFen(s), ucis = [], fens = [startFen];
  for (let i = 0; i < maxPlies; i++) {
    const ms = C.legal(s);
    if (!ms.length || s.half >= 100) break;
    let pool = ms;
    if (r.chance(greed)) {
      const hot = ms.filter(m => s.board[m.to] || m.ep || m.promo || C.inCheck(C.apply(s, m)));
      const mates = ms.filter(m => { const n = C.apply(s, m); return C.inCheck(n) && !C.legal(n).length; });
      pool = mates.length ? mates : hot.length ? hot : ms;
    }
    const m = r.pick(pool);
    ucis.push(uciOf(C, m));
    s = C.apply(s, m); delete s._captured;
    fens.push(C.toFen(s));
  }
  return { startFen, ucis, fens };
}

// UCI moves -> PGN text (SAN from the stand-in), with a SetUp/FEN header when the game does not start from the usual position.
export async function toPgn({ startFen, ucis }, headers = {}) {
  const { Chess, ChessCore: C } = await chessModule();
  const c = new Chess(startFen);
  const sans = ucis.map(u => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
  const h = { Event: 'fuzz', White: 'W', Black: 'B', ...(startFen === C.START_FEN ? {} : { SetUp: '1', FEN: startFen }), ...headers };
  const startNo = +startFen.split(' ')[5] || 1, black = startFen.split(' ')[1] === 'b';
  let body = '';
  sans.forEach((san, i) => {
    const ply = i + (black ? 1 : 0), no = startNo + Math.floor(ply / 2);
    if (ply % 2 === 0) body += `${no}. ${san} `; else body += (i === 0 ? `${no}... ` : '') + san + ' ';
  });
  return Object.entries(h).map(([k, v]) => `[${k} "${v}"]`).join('\n') + '\n\n' + body.trim() + ' *';
}

// The same position with the colours swapped (White <-> Black, ranks reversed). Anything the app computes must be symmetric.
export function mirrorFen(fen) {
  const [pl, turn, cast, ep, half, full] = fen.split(' ');
  const swap = c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase());
  const placement = pl.split('/').reverse().map(row => [...row].map(ch => (/\d/.test(ch) ? ch : swap(ch))).join('')).join('/');
  const castling = cast === '-' ? '-' : [...cast].map(swap).sort((a, b) => 'KQkq'.indexOf(a) - 'KQkq'.indexOf(b)).join('');
  return [placement, turn === 'w' ? 'b' : 'w', castling, ep === '-' ? '-' : ep[0] + (9 - +ep[1]), half, full].join(' ');
}
export const mirrorUci = u => u.replace(/\d/g, d => 9 - d);

// A handful of varied starting points (openings, endgames, promotions, castling-rich) for random games.
export const STARTS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  '4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1',
  '8/P1P1P3/8/8/8/8/3p1p1p/4K2k w - - 0 1',
  'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
  'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
  // endgames that end in checkmate quickly, so random games reach mates (and the "mated"/"missed mate" paths) often
  'k7/8/1K6/8/8/8/8/7Q w - - 0 1',
  'r5k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1',
  '7k/8/5K2/8/8/8/8/6R1 w - - 0 1',
  '4k3/8/8/8/8/8/PPPPPPPP/RNBQKBNR b KQ - 0 1',
];
