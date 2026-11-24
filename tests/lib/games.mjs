// Games the kit reviews. Real, famous or hand-made, so a human can judge "does this review make sense".
// Every one is replayed through the chess stand-in by the `static` suite, so a typo here fails loudly.
export const GAMES = {
  scholar: { name: "Scholar's mate (3...Nf6?? allows Qxf7#)", pgn: '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0', plies: 7 },
  ruy: { name: 'Ruy Lopez, castling both sides', pgn: '[White "Ruy"]\n[Black "Lopez"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *', plies: 20 },
  immortal: {
    name: 'The Immortal Game (Anderssen–Kieseritzky 1851): sacrifices, mate',
    pgn: '[Event "London"]\n[White "Anderssen, Adolf"]\n[Black "Kieseritzky, Lionel"]\n[Result "1-0"]\n\n1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5 8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8 15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6 21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0',
    plies: 45,
  },
  stalemate: {
    name: "Sam Loyd's 10-move stalemate (game ends drawn)",
    pgn: '[White "Loyd"]\n[Black "Shortest"]\n[Result "1/2-1/2"]\n\n1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. h4 Rah6 5. Qxc7 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6 1/2-1/2',
    plies: 19,
  },
  enpassant: { name: 'En passant and a promotion with capture', pgn: '[White "W"]\n[Black "B"]\n\n1. e4 a6 2. e5 d5 3. exd6 Nf6 4. dxc7 Qxd2+ 5. Bxd2 Ne4 6. cxb8=Q Rxb8 *', plies: 12 },
  promotion: { name: 'Started from a position (SetUp/FEN): promotion, under-promotion', pgn: '[SetUp "1"]\n[FEN "8/P6k/8/8/8/8/6K1/8 w - - 0 1"]\n[White "W"]\n[Black "B"]\n\n1. a8=N+ Kg6 2. Nb6 Kf5 3. Nd5 Ke5 4. Nc3 *', plies: 7 },
  // Chess.com exports look like this: clock comments, "1..." numbering for Black, extra headers.
  chesscom: {
    name: 'Chess.com style PGN (clock comments, 1... numbering, extra headers)',
    pgn: '[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2025.01.02"]\n[White "alice"]\n[Black "bob"]\n[Result "1-0"]\n[WhiteElo "1500"]\n[BlackElo "1480"]\n[TimeControl "600"]\n[Termination "alice won by checkmate"]\n[ECOUrl "https://www.chess.com/openings/Bishops-Opening"]\n\n1. e4 {[%clk 0:09:58.9]} 1... e5 {[%clk 0:09:57.1]} 2. Qh5 {[%clk 0:09:55]} 2... Nc6 {[%clk 0:09:50.2]} 3. Bc4 {[%clk 0:09:49]} 3... Nf6 {[%clk 0:09:40]} 4. Qxf7# {[%clk 0:09:30]} 1-0',
    plies: 7,
  },
  // Lichess exports: NAG symbols, a variation, ';' comment, CRLF line ends.
  lichess: {
    name: 'Lichess style PGN (annotations, a variation, NAGs)',
    pgn: '[Event "Rated Blitz game"]\r\n[Site "https://lichess.org/abcd1234"]\r\n[White "alice"]\r\n[Black "bob"]\r\n[Result "1-0"]\r\n\r\n1. e4 e5 2. Qh5?! { a risky early queen } Nc6 3. Bc4 (3. Nf3 $1 Nf6) 3... Nf6?? $4 4. Qxf7# 1-0\r\n',
    plies: 7,
  },
};
export const pgnOf = id => GAMES[id].pgn;

// Games used by the mock-engine "book" (every position of these is precomputed; see lib/book.mjs).
export const BOOK_GAMES = ['scholar', 'ruy', 'immortal', 'stalemate', 'enpassant', 'promotion'];
