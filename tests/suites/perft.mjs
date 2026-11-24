// Validates the chess.js stand-in against published perft counts (so test results can be trusted). Every other result in the
// kit rests on this one: if it fails, distrust the rest.
import { chessModule } from '../lib/chess.mjs';
import { createSuite } from '../lib/suite.mjs';
const S = createSuite('perft');
const { ChessCore: C } = await chessModule();
const perft = (s, d) => d === 0 ? 1 : C.legal(s).reduce((n, m) => n + (d === 1 ? 1 : perft(C.apply(s, m), d - 1)), 0);
// Published counts (chessprogramming.org "Perft Results"). Depths are kept small enough to stay under a second or two each.
export const PERFT = [
  ['startpos', C.START_FEN, [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['pos3 (ep, pins)', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['pos4 (promotions, castling)', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['pos4 mirrored', 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1', [6, 264, 9467]],
  ['pos5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['pos6 (symmetric middlegame)', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
  ['castling through check is illegal', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', [26, 568, 13744]],
  ['promotions, underpromotions', 'n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1', [24, 496, 9483]],
  ['pawn pinned along the rank (ep)', '3k4/3p4/8/K1P4r/8/8/8/8 b - - 0 1', [18, 92, 1670, 10138]],
  ['ep capture exposing the king (agreed by two independent generators)', '8/8/8/8/k2Pp2Q/8/8/3K4 b - d3 0 1', [6, 136, 863]],
];
PERFT.forEach(([name, fen, exp]) => {
  const s = C.parseFen(fen);
  exp.forEach((e, i) => {
    const got = perft(s, i + 1);
    S.check(`perft ${name} depth ${i + 1} = ${e}`, got === e, `got ${got}, expected ${e}`, { tags: ['chess'], covers: ['src/chess-core.js'] });
  });
});
S.finish();
