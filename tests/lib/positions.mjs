// Hand-checked positions. Each answer is forced, so any real Stockfish should find it at modest depth.
export const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
export const SCHOLAR_PGN = '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';

export const TACTICS = [
  { id: 'scholar-mate', name: 'mate in 1: Qxf7# (Scholar\'s mate)', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', best: ['h5f7'], mate: 1 },
  { id: 'back-rank', name: 'mate in 1: Ra8# (back rank)', fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', best: ['a1a8'], mate: 1 },
  { id: 'free-queen', name: 'wins a free queen: Rxd5', fen: '4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1', best: ['d2d5'] },
];
export const MATED_IN_1 = { name: 'side to move is mated next move (score must be negative)', fen: '7k/8/5K2/8/8/8/8/6Q1 b - - 0 1' };
export const WHITE_UP_QUEEN = '4k3/8/8/8/8/8/8/Q3K3 w - - 0 1';
export const BLACK_UP_QUEEN = 'q3k3/8/8/8/8/8/8/4K3 b - - 0 1'; // the same position with the colours swapped
export const PROMOTION = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
export const CHECKMATED = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1';
export const STALEMATED = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
// positions whose principal variations get replayed through the chess library (castling, en passant, promotions, pins)
export const PV_POSITIONS = [
  START, KIWIPETE,
  'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
  'rnbqkb1r/pp1p1ppp/5n2/2pPp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 4',
];
