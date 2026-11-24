// The chess.js stand-in: published perft counts live in perft.mjs; here it is also compared, position by position, with an
// INDEPENDENT move generator (lib/oracle.mjs) over thousands of random games, and its chess.js-style API (SAN, PGN, flags) is
// pinned down. If this suite is green, the kit's chess rules can be trusted; if it is red, nothing downstream means anything.
//   --seed N        replay a random run exactly        --budget-ms N   how long the random part may run (default 4000)
import { chessModule } from '../lib/chess.mjs';
import { GAMES } from '../lib/games.mjs';
import { mirrorFen, randomGame, STARTS, toPgn } from '../lib/gen.mjs';
import * as O from '../lib/oracle.mjs';
import { newSeed, rng } from '../lib/prng.mjs';
import { createSuite } from '../lib/suite.mjs';

const S = createSuite('chess');
const seed = S.opts.seed ?? newSeed();
const budget = S.opts.budgetMs ?? 2500;
const { Chess, ChessCore: C } = await chessModule();
const meta = { tags: ['chess'], covers: ['src/chess-core.js'] };
const check = (n, c, d = '') => S.check(n, c, d, meta);
const uci = m => C.sqName(m.from) + C.sqName(m.to) + (m.promo || '');
const sorted = a => [...a].sort();
const oracleAttacked = (o, q88, byWhite) => O.attackedBy(o, q88, byWhite);
const diff = (a, b) => ({ onlyA: a.filter(x => !b.includes(x)), onlyB: b.filter(x => !a.includes(x)) });

// ---- 1. random games: same legal moves, same flags, same resulting positions as the oracle ---------------------------------
{
  const r = rng(seed), t0 = Date.now();
  let games = 0, positions = 0, bad = null;
  while (!bad && Date.now() - t0 < budget) {
    const g = await randomGame(r, { fen: r.chance(0.5) ? r.pick(STARTS) : undefined, maxPlies: 30 + r.int(90), greed: r.chance(0.5) ? 0.2 : 0.7 });
    games++;
    for (let i = 0; i < g.fens.length && !bad; i++) {
      const fen = g.fens[i], s = C.parseFen(fen), o = O.parse(fen);
      positions++;
      const mine = sorted(C.legal(s).map(uci)), theirs = O.legalUci(fen);
      if (mine.join() !== theirs.join()) { const d = diff(mine, theirs); bad = `legal moves differ in ${fen}: only stand-in ${JSON.stringify(d.onlyA)}, only oracle ${JSON.stringify(d.onlyB)}`; break; }
      const chk = C.inCheck(s);
      if (chk !== O.inCheck(o)) { bad = `check differs in ${fen}: stand-in ${chk}`; break; }
      const c = new Chess(fen);
      if (c.isCheckmate() !== (chk && !theirs.length) || c.isStalemate() !== (!chk && !theirs.length)) { bad = `mate/stalemate flags wrong in ${fen}`; break; }
      if (c.moves().length !== theirs.length) { bad = `moves() has ${c.moves().length} entries, oracle has ${theirs.length} in ${fen}`; break; }
      // every square: attacked by White / by Black, same answer (pins ignored in both)
      for (let q = 0; q < 64 && !bad; q++) {
        const name = C.sqName(q), q88 = (7 - (q >> 3)) * 16 + (q & 7);
        for (const by of ['w', 'b']) {
          const a = c.attackers(name, by).length > 0, b = oracleAttacked(o, q88, by === 'w');
          if (a !== b) bad = `attackers(${name}, ${by}) = ${a} but the oracle says ${b} in ${fen}`;
        }
      }
      if (i + 1 < g.fens.length && !bad) { // the move that was played leads to the position the oracle gets, too
        const u = g.ucis[i], m = O.legal(o).find(x => O.uci(x) === u);
        const after = O.make(o, m), got = g.fens[i + 1].split(' ');
        const placement = O.toFenPlacement(after);
        if (placement !== got[0] || (after.white ? 'w' : 'b') !== got[1]) { bad = `after ${u} in ${fen}: stand-in ${got[0]} ${got[1]}, oracle ${placement} ${after.white ? 'w' : 'b'}`; break; }
        const rights = [...'KQkq'].filter(x => after.cast.has(x)).join('') || '-';
        if (rights !== got[2]) { bad = `after ${u} in ${fen}: castling rights stand-in ${got[2]}, oracle ${rights}`; break; }
        const epName = after.ep >= 0 ? O.uci({ from: after.ep, to: after.ep }).slice(0, 2) : '-';
        if (epName !== got[3]) { bad = `after ${u} in ${fen}: en passant square stand-in ${got[3]}, oracle ${epName}`; break; }
      }
    }
  }
  S.opts.quiet || console.log(`   (differential: ${positions} positions of ${games} random games)`);
  check('stand-in vs independent oracle: legal moves, check/mate/stalemate, attackers, castling rights and en passant agree on random games', !bad, `${bad} [seed ${seed}]`);
}

// ---- 2. the chess.js API the app relies on --------------------------------------------------------------------------------
{
  const r = rng(seed + 1), t0 = Date.now();
  let n = 0, bad = null;
  while (!bad && Date.now() - t0 < budget / 2) {
    const g = await randomGame(r, { fen: r.pick(STARTS), maxPlies: 60, greed: 0.6 });
    for (const fen of g.fens.slice(0, 40)) {
      const c = new Chess(fen), vm = c.moves({ verbose: true }), sans = vm.map(m => m.san);
      n++;
      if (new Set(sans).size !== sans.length) { bad = `two moves share one SAN in ${fen}: ${sans.join(' ')}`; break; }
      for (const m of vm) {
        const a = new Chess(fen).move(m.san), b = new Chess(fen).move({ from: m.from, to: m.to, promotion: m.promotion });
        if (a.lan !== m.lan || b.san !== m.san) { bad = `move("${m.san}") / move({from,to}) disagree with moves() in ${fen}`; break; }
        const after = new Chess(m.after);
        const suffix = after.isCheckmate() ? '#' : after.isCheck() ? '+' : '';
        if (!m.san.endsWith(suffix) || (!suffix && /[+#]$/.test(m.san))) { bad = `SAN "${m.san}" has the wrong check/mate suffix in ${fen}`; break; }
        if (m.before !== fen) { bad = `verbose move has before=${m.before}, expected ${fen}`; break; }
        if (m.captured !== undefined && !/c|e/.test(m.flags)) { bad = `capture without a c/e flag: ${m.san}`; break; }
        if (/=/.test(m.san) !== !!m.promotion) { bad = `promotion field and SAN disagree: ${m.san}`; break; }
      }
      if (bad) break;
    }
  }
  S.opts.quiet || console.log(`   (API: ${n} positions)`);
  check('chess.js API: SAN is unique and round-trips (move(san) = move({from,to})), check/mate suffixes, before/after, flags, promotion', !bad, `${bad} [seed ${seed + 1}]`);
}

// SAN for situations where chess.js has precise rules: disambiguation, castling, promotion suffixes, en passant, mate.
const sanOf = fen => new Chess(fen).moves();
const has = (fen, ...want) => { const m = sanOf(fen), miss = want.filter(w => !m.includes(w)); return { ok: !miss.length, miss, m }; };
for (const [name, fen, want, notWant = []] of [
  ['two rooks, same rank: file letter', '4k3/8/8/8/8/8/8/R5RK w - - 0 1', ['Rad1', 'Rgd1'], ['Rd1']],
  ['two knights: file letter', '4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1', ['Nbd2', 'Nfd2'], ['Nd2']],
  ['two rooks, same file: rank digit', '4k3/8/8/8/R7/8/8/R3K3 w - - 0 1', ['R1a2', 'R4a2'], ['Ra2']],
  ['three queens: file, rank and full square', '8/8/8/7k/8/Q7/8/Q1Q4K w - - 0 1', ['Qa1c3', 'Qcc3', 'Q3c3']],
  ['all four promotions, only the checking ones get "+"', '7k/P7/8/8/8/8/8/K7 w - - 0 1', ['a8=Q+', 'a8=R+', 'a8=B', 'a8=N']],
  ['castling both ways', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['O-O', 'O-O-O']],
  ['castling is not offered through an attacked square', '4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1', ['O-O-O'], ['O-O']],
  ['en passant is written as a pawn capture', 'rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3', ['exd6']],
  ['a pinned rook may only move along the pin', '4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1', ['Re3', 'Rxe8+'], ['Rd2', 'Rf2']],
]) {
  const h = has(fen, ...want), bad = notWant.filter(x => h.m.includes(x));
  check(`SAN: ${name}`, h.ok && !bad.length, `missing ${JSON.stringify(h.miss)}${bad.length ? ', should not exist ' + JSON.stringify(bad) : ''}; moves: ${h.m.join(' ')}`);
}
check('SAN: the mating move ends with #', new Chess('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4').move('Qxf7#').san === 'Qxf7#');
check('move(): an illegal move throws (the app relies on that to reject bad PGNs)', (() => { try { new Chess().move('Ke5'); return false; } catch { return true; } })());
check('move(): a promotion without a piece defaults to a queen', new Chess('7k/P7/8/8/8/8/8/K7 w - - 0 1').move({ from: 'a7', to: 'a8' }).promotion === 'q');

// ---- 3. PGN: the games the app will actually be given ------------------------------------------------------------------------
for (const [id, g] of Object.entries(GAMES)) {
  let c, err = '';
  try { c = new Chess(); c.loadPgn(g.pgn); } catch (e) { err = e.message; }
  const h = c ? c.history({ verbose: true }) : [];
  check(`PGN "${id}": ${g.name} loads with ${g.plies} plies`, h.length === g.plies, err || `got ${h.length}`);
  if (c && h.length) {
    const chain = h.every((m, i) => i === 0 || m.before === h[i - 1].after);
    check(`PGN "${id}": every move starts from the position the previous one ended in`, chain);
    const again = new Chess(h[0].before);
    for (const m of h) again.move(m.san);
    check(`PGN "${id}": replaying its SAN gives the same final position`, again.fen() === h.at(-1).after);
  }
}
check('PGN: headers are kept (including escaped quotes) and SetUp/FEN starts from that position', (() => {
  const c = new Chess(); c.loadPgn(GAMES.promotion.pgn + '');
  const h = c.header();
  const q = new Chess(); q.loadPgn('[White "A \\"B\\" C"]\n\n1. e4 *');
  return h.White === 'W' && c.history({ verbose: true })[0].before === '8/P6k/8/8/8/8/6K1/8 w - - 0 1' && q.header().White === 'A "B" C';
})());
{
  const r = rng(seed + 2);
  let bad = null, n = 0;
  const t0 = Date.now();
  while (!bad && Date.now() - t0 < budget / 2) {
    const g = await randomGame(r, { fen: r.chance(0.3) ? r.pick(STARTS) : undefined, maxPlies: 40 + r.int(80), greed: 0.5 });
    if (!g.ucis.length) continue;
    n++;
    const pgn = await toPgn(g);
    try {
      const c = new Chess(); c.loadPgn(pgn);
      const back = c.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
      if (back.join() !== g.ucis.join()) bad = `PGN round trip changed the game (${back.length} vs ${g.ucis.length} moves):\n${pgn}`;
    } catch (e) { bad = `PGN could not be read back: ${e.message}\n${pgn}`; }
  }
  S.opts.quiet || console.log(`   (PGN round trip: ${n} games)`);
  check('PGN: random games (start positions, promotions, castling) survive write -> read unchanged', !bad, `${bad} [seed ${seed + 2}]`);
}

// ---- 4. symmetry: swap the colours and nothing about the rules may change ------------------------------------------------------
{
  const r = rng(seed + 3), t0 = Date.now();
  let n = 0, bad = null;
  while (!bad && Date.now() - t0 < budget / 2) {
    const g = await randomGame(r, { fen: r.pick(STARTS), maxPlies: 60, greed: 0.6 });
    for (const fen of g.fens) {
      n++;
      const m = mirrorFen(fen), a = new Chess(fen), b = new Chess(m);
      if (a.moves().length !== b.moves().length || a.isCheckmate() !== b.isCheckmate() || a.isStalemate() !== b.isStalemate() || a.isCheck() !== b.isCheck()) { bad = `colour-swapped position behaves differently: ${fen} vs ${m}`; break; }
      if (mirrorFen(m) !== fen) { bad = `mirrorFen is not an involution for ${fen}`; break; }
    }
  }
  S.opts.quiet || console.log(`   (symmetry: ${n} positions)`);
  check('symmetry: positions and their colour-swapped twins have equal move counts and mate/stalemate/check flags', !bad, `${bad} [seed ${seed + 3}]`);
}
check('draw rules: fifty-move clock, insufficient material, threefold repetition', (() => {
  const a = new Chess('8/8/8/4k3/8/8/8/4K2R w - - 100 80').isDraw();       // 100 half-moves
  const b = new Chess('8/8/8/4k3/8/8/8/4KN2 w - - 0 1').isInsufficientMaterial() && new Chess('8/8/8/4k3/8/8/8/4K3 w - - 0 1').isInsufficientMaterial();
  const c = new Chess(); for (const m of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) c.move(m);
  return a && b && c.isThreefoldRepetition() && !new Chess('8/8/8/4k3/8/8/8/4K1BB w - - 0 1').isInsufficientMaterial();
})());

S.opts.list || console.log(`(random seed ${seed}; replay with: node kit.mjs run --suite chess --seed ${seed})`);
await S.run();
S.finish();
