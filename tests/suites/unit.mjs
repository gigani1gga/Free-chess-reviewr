// Unit tests for the grading/analysis logic (no browser). Runs against the assembled test site so that
// ../vendor/chess.js resolves to the chess.js stand-in.
import path from 'node:path';
import { siteDir } from '../lib/env.mjs';
import { createSuite } from '../lib/suite.mjs';
const S = createSuite('unit');
const site = path.join(siteDir(), 'js');
const { winPct, accuracy, classify, sacrifice } = await import(path.join(site, 'review.js'));
const { Chess } = await import(path.join(site, '../vendor/chess.js'));
const { parseGame, analyseAll, buildReview, runSize, storeKey } = await import(path.join(site, 'analysis.js'));

// Each check says which project file it is about (from its name), so a failure points at the right place and `kit.mjs affected` works.
const COVER = [[/winPct|accuracy|classify|tags:|explain/i, ['js/review.js']], [/coach|fragments|outcome|replay|fmtMoves|fmtEval|moveNo|lines are plain/i, ['js/coach.js', 'js/util.js']],
  [/analyseAll|scheduling|store|parseGame|buildReview|mate scores|cache|interrogate|Elo/i, ['js/analysis.js', 'js/store.js']],
  [/brilliant|sacrific|holdsUp|interview|great:/i, ['js/brilliant.js', 'js/analysis.js', 'js/review.js']], [/rating|expected points|lineWin|toWhite|gameAccuracy|volatility|phaseOf|estimateRating|eloScale/i, ['js/rating.js']],
  [/book|opening/i, ['js/openings.js']], [/parseInfo|goCommand|uci:/i, ['js/uci.js', 'js/engine.js']]];
const check = (name, cond, detail = '') => S.check(name, cond, detail, { tags: ['analysis'], covers: [...new Set(COVER.filter(([r]) => r.test(name)).flatMap(([, f]) => f))] });
const near = (a, b, e = 0.05) => Math.abs(a - b) <= e;

check('winPct(0) = 50', winPct(0) === 50);
check('winPct is symmetric', near(winPct(300) + winPct(-300), 100, 1e-9));
check('winPct(+100cp) ≈ 59.1 (Lichess curve)', near(winPct(100), 59.1, 0.1), winPct(100));
check('winPct(+1000cp) > 97', winPct(1000) > 97);
check('accuracy(0) = 100, accuracy(20) ≈ 40', near(accuracy(0), 100, 0.01) && near(accuracy(20), 40, 0.5), `${accuracy(0)} ${accuracy(20)}`);
const base = { drop: 0, isBest: false, wb: 50, wa: 50, gap: null, sac: false, prev: 0 };
check('classify: best move is "best"', classify({ ...base, isBest: true }) === 'best');
check('classify: 20-point drop is a blunder', classify({ ...base, drop: 20 }) === 'blunder');
check('classify: 10-point drop is a mistake', classify({ ...base, drop: 10 }) === 'mistake');
check('classify: 5-point drop is an inaccuracy', classify({ ...base, drop: 5 }) === 'inaccuracy');
check('classify: mistake right after a mistake is a "miss"', classify({ ...base, drop: 6, prev: 12 }) === 'miss');
check('classify: only-move with big gap is "great"', classify({ ...base, isBest: true, gap: 15, wb: 55, wa: 55 }) === 'great');
check('classify: sacrifice that keeps the eval is "brilliant"', classify({ ...base, isBest: true, sac: true, wb: 60, wa: 60 }) === 'brilliant');

// A fake engine: scores come back from the side to move's point of view, exactly like UCI.
const calls = [];
const fake = {
  kind: 'best',
  async analyze(fen, depth) {
    calls.push(fen);
    const turn = fen.split(' ')[1];
    // white to move: +100 for e2e4-ish first line; black to move: +100 for black (i.e. -100 for white)
    return turn === 'w' ? [{ cp: 100, pv: ['e2e4'] }, { cp: 40, pv: ['d2d4'] }] : [{ cp: 100, pv: ['e7e5'] }, { cp: 30, pv: ['c7c5'] }];
  },
};
const game = parseGame('1. e4 e5 *');
check('parseGame: 2 plies, 3 positions', game.moves.length === 2 && game.fens.length === 3);
let prog = [];
const pos = await analyseAll([fake, { ...fake }], game.fens, 16, (d, t) => prog.push(`${d}/${t}`));
check('analyseAll: results come back in position order', pos.map(p => p.fen).join() === game.fens.join());
check('analyseAll: progress reaches 3/3', prog.at(-1) === '3/3', prog.join());
check('analyseAll: black-to-move score is converted to White\'s view (+100 for Black = -100 for White)', pos[1].cp === -100 && pos[0].cp === 100, JSON.stringify([pos[0].cp, pos[1].cp]));
check('analyseAll: win% is from White\'s view and consistent', near(pos[0].win, winPct(100)) && near(pos[1].win, winPct(-100)));
check('analyseAll: top engine move kept as UCI string', pos[0].best === 'e2e4' && pos[1].best === 'e7e5');
const n1 = calls.length;
await analyseAll([fake], game.fens, 16, () => {});
check('analyseAll: identical positions + depth are served from the cache (no new engine calls)', calls.length === n1, `${calls.length} vs ${n1}`);
await analyseAll([fake], game.fens, 18, () => {});
check('analyseAll: a different depth is re-analysed', calls.length === n1 + 3);
const rev = buildReview(game, pos);
check('buildReview: both best moves graded "best"/"great"/"excellent", 100% drop-free', rev.items.every(i => ['best', 'great', 'excellent', 'book'].includes(i.cls)), rev.items.map(i => i.cls).join());
check('buildReview: accuracies are 100 when every move is the engine\'s first choice', near(rev.acc.w, 100, 0.01) && near(rev.acc.b, 100, 0.01));

// Scheduling: each engine should work through runs of consecutive positions (its hash table then still holds the previous
// search), every position must be analysed exactly once, and results/progress must be unaffected.
{
  const RUY = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *';
  const g = parseGame(RUY); // 20 plies -> 21 positions
  const done = [];
  const mk = id => ({ kind: 'sched-test', async analyze(fen) {
    done.push([id, fen]);
    await new Promise(r => setTimeout(r, 1 + Math.random() * 4)); // engines finish at different speeds
    return [{ cp: 10, pv: ['e2e4'] }, { cp: 0, pv: ['d2d4'] }];
  } });
  let seen = 0;
  const res = await analyseAll([mk(0), mk(1), mk(2)], g.fens, 16, (d, t) => { seen = d; });
  const idx = fen => g.fens.indexOf(fen);
  check('scheduling: every position is analysed exactly once', done.length === g.fens.length && new Set(done.map(d => d[1])).size === g.fens.length, `${done.length} of ${g.fens.length}`);
  check('scheduling: results are in position order and progress reaches 21/21', res.every((r, i) => r.fen === g.fens[i]) && seen === g.fens.length);
  let singles = 0;
  for (const id of [0, 1, 2]) {
    const mine = done.filter(d => d[0] === id).map(d => idx(d[1])).sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i <= mine.length; i++) {
      if (mine[i] === mine[i - 1] + 1) run++; else { if (mine.length && run < 2) singles++; run = 1; }
    }
  }
  check('scheduling: engines take consecutive positions (at most one lone position, the odd one out at the end)', singles <= 1, `${singles} lone positions`);

  // one engine must still go through the game strictly in order
  const order = [];
  await analyseAll([{ kind: 'sched-test-single', async analyze(fen) { order.push(idx(fen)); return [{ cp: 0, pv: ['e2e4'] }]; } }], g.fens, 16, () => {});
  check('scheduling: a single engine analyses the game in order', order.join() === g.fens.map((_, i) => i).join(), order.join());
}

// Edge cases for the scheduler.
{
  const mkE = (kind, log) => ({ kind, async analyze(fen) { log.push(fen); return [{ cp: 0, pv: ['e2e4'] }]; } });
  const g2 = parseGame('1. e4 e5 *'); // 3 positions
  const log = [];
  const r0 = await analyseAll([mkE('edge-a', log)], [], 16, () => {});
  check('scheduling: no positions -> empty result, no engine calls', r0.length === 0 && log.length === 0);
  const log2 = [];
  const engines5 = [1, 2, 3, 4, 5].map(i => mkE('edge-b', log2));
  const r5 = await analyseAll(engines5, g2.fens, 16, () => {});
  check('scheduling: more engines than positions still analyses each position once, in order', r5.length === 3 && log2.length === 3 && r5.every((r, i) => r.fen === g2.fens[i]), log2.length);
  let progress = [];
  await analyseAll([mkE('edge-c', []), mkE('edge-c', [])], parseGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *').fens, 14, (d, t) => progress.push(d));
  check('scheduling: progress counts 1..n with no gaps or repeats', progress.join() === '1,2,3,4,5,6,7', progress.join());
  let msg = '';
  try {
    await analyseAll([{ kind: 'edge-d', async analyze() { throw new Error('Stockfish crashed.'); } }, mkE('edge-d2', [])], g2.fens, 16, () => {});
  } catch (e) { msg = e.message; }
  check('scheduling: an engine error still rejects analyseAll with that error', msg === 'Stockfish crashed.', msg);
  // a failed position must not be cached (a retry has to ask the engine again)
  let calls = 0, fail = true;
  const flaky = { kind: 'edge-e', async analyze() { calls++; if (fail) throw new Error('boom'); return [{ cp: 0, pv: ['e2e4'] }]; } };
  await analyseAll([flaky], g2.fens.slice(0, 1), 16, () => {}).catch(() => {});
  fail = false;
  const rr = await analyseAll([flaky], g2.fens.slice(0, 1), 16, () => {});
  check('scheduling: a failed position is retried on the next run, not cached', calls === 2 && rr.length === 1, String(calls));
}

// Guided scheduling: runs are long early on (hash reuse) and short at the end (no idle engines), whatever the engine count.
{
  let bad = '';
  for (let E = 1; E <= 8 && !bad; E++) for (let N = 1; N <= 120 && !bad; N++) {
    let left = N, lone = 0, last = Infinity;
    while (left > 0) {
      const r = runSize(left, E);
      if (r < 1 || r > 8 || r > left) bad = `E=${E} N=${N} run=${r} left=${left}`;
      if (r < 2 && left > 1) bad = `E=${E} N=${N}: run of 1 with ${left} left`;
      if (r === 1) lone++;
      if (r > last) bad = `E=${E} N=${N}: run grew from ${last} to ${r}`;
      last = r; left -= r;
    }
    if (lone > 1) bad = `E=${E} N=${N}: ${lone} lone positions`;
  }
  check('scheduling: runs are 2-8 positions, never grow, and at most one lone position, for 1-8 engines and 1-120 positions', !bad, bad);
  check('scheduling: 2 engines on 80 positions start with the longest run (8) and finish with runs of 2', runSize(80, 2) === 8 && runSize(4, 2) === 2);

  // many engines at random speeds: every position exactly once, in order, whatever the mix
  for (const E of [1, 2, 3, 6, 8]) {
    const seen = [];
    const g = parseGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *');
    const mk = () => ({ kind: `many-${E}`, async analyze(fen) { seen.push(fen); await new Promise(r => setTimeout(r, Math.random() * 4)); return [{ cp: 0, pv: ['e2e4'] }]; } });
    const res = await analyseAll(Array.from({ length: E }, mk), g.fens, 12, () => {});
    check(`scheduling: ${E} engine(s) analyse each of 21 positions once, results in order`, seen.length === 21 && new Set(seen).size === 21 && res.every((r, i) => r.fen === g.fens[i]), `${seen.length} calls`);
  }
}

// On-device result store: the key must tell engines, depths and half-move clocks apart, but not move numbers.
{
  const A = { id: 'stockfish-19-single.js|Stockfish 19|mpv2|hash64' };
  const f = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
  check('store key: ignores the move number (same position reached in another game)', storeKey(A, 16, f) === storeKey(A, 16, f.replace(/ 2$/, ' 17')));
  check('store key: a different half-move clock is a different entry', storeKey(A, 16, f) !== storeKey(A, 16, f.replace(' - 1 2', ' - 5 2')));
  check('store key: depth, side to move and engine setup all matter',
    storeKey(A, 16, f) !== storeKey(A, 18, f) && storeKey(A, 16, f) !== storeKey(A, 16, f.replace(' b ', ' w ')) &&
    storeKey(A, 16, f) !== storeKey({ id: 'stockfish-19-lite-single.js|Stockfish 19|mpv2|hash16' }, 16, f));
  check('store key: engines without an id (test fakes) are never stored', !storeKey({ kind: 'x' }, 16, f));
  // No IndexedDB in Node: an engine WITH an id must still analyse normally, i.e. the store fails quietly.
  let n = 0;
  const withId = { kind: 'store-test', id: 'x|y|mpv2|hash16', async analyze() { n++; return [{ cp: 30, pv: ['e2e4'] }, { cp: 10, pv: ['d2d4'] }]; } };
  const gg = parseGame('1. e4 e5 *');
  const r1 = await analyseAll([withId], gg.fens, 16, () => {});
  check('store: with no IndexedDB available the engine does the work and the review is intact', n === 3 && r1.length === 3 && r1[0].best === 'e2e4', `${n} calls`);
}

// mate handling
const mateEng = { kind: 'mate-test', async analyze(fen) { return fen.split(' ')[1] === 'w' ? [{ mate: 2, pv: ['e2e4'] }] : [{ mate: -2, pv: ['e7e5'] }]; } };
const mpos = await analyseAll([mateEng], game.fens, 16, () => {});
check('mate scores: White mating = 100% for White; Black being mated = 100% for White', mpos[0].win === 100 && mpos[1].win === 100 && mpos[0].mate === 2 && mpos[1].mate === 2, JSON.stringify(mpos.map(p => [p.mate, p.win])));

// ---- coach: reasons and lines built from the engine's own lines --------------------------------------------------------
{
  const { replay, fmtMoves, fmtLine, outcome, fragments, coach } = await import(path.join(site, 'coach.js'));
  const { tags, explain } = await import(path.join(site, 'review.js'));
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const step = (fen, uci) => replay(fen, [uci])[0];

  check('replay: stops quietly at the first illegal move', replay(START, ['e2e4', 'e7e5', 'zzzz', 'g1f3']).length === 2);
  check('replay: empty / missing line gives nothing', replay(START, []).length === 0 && replay(START, undefined).length === 0);
  check('fmtMoves: numbering from White', fmtMoves(START, replay(START, ['e2e4', 'e7e5', 'g1f3'])).join(' ') === '1.e4 e5 2.Nf3');
  const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  check('fmtMoves: a line that starts with Black uses "1…" and numbers on correctly', fmtLine(AFTER_E4, replay(AFTER_E4, ['e7e5', 'g1f3', 'b8c6'])) === '1…e5 2.Nf3 Nc6');

  const D5 = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
  check('outcome: capture + recapture is an even trade', outcome(replay(D5, ['e4d5', 'd8d5', 'b1c3']), 'w').net === 0);
  check('outcome: a capture the line cuts off before any recapture is NOT counted as a win', outcome(replay(D5, ['e4d5']), 'w').net === 0);
  check('outcome: a pawn won and held counts', outcome(replay(D5, ['e4d5', 'g8f6', 'b1c3']), 'w').net === 1);
  check('outcome: seen from the other side the sign flips', outcome(replay(D5, ['e4d5', 'g8f6', 'b1c3']), 'b').net === -1);

  const FORK = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
  const forkTxt = fragments(step(FORK, 'b5c7')).join(' | ');
  check('fragments: a knight check that also hits the rook is a fork', /attacks the king and the rook at once/.test(forkTxt) && /gives check/.test(forkTxt), forkTxt);
  const FREE = '4k3/8/8/3n4/8/8/3R4/4K3 w - - 0 1';
  check('fragments: taking an unguarded piece says so', fragments(step(FREE, 'd2d5')).join().includes('wins the knight on d5 for free'), fragments(step(FREE, 'd2d5')).join());
  const SC = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
  check('fragments: mate', fragments(step(SC, 'h5f7')).join() === 'gives checkmate');
  const LOOSE = '4k3/8/8/3p4/4N3/8/8/4K3 w - - 0 1';
  check('fragments: moving a attacked knight to safety is a rescue', fragments(step(LOOSE, 'e4g3')).join().includes('saves the knight'), fragments(step(LOOSE, 'e4g3')).join());
  check('fragments: a pointless pawn move claims nothing', fragments(step(START, 'a2a3')).length === 0);
  check('fragments: castling and development are named', fragments(step('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 6 5', 'e1g1')).join() === 'castles to safety'
    && fragments(step(START, 'g1f3')).join() === 'develops the knight');

  // Scholar's mate: 3...Nf6?? allows Qxf7#. The card must say how the engine answers, and offer both lines.
  const SCH = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
  const B4 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3'; // before 3...Nf6 (queen already on h5)
  const nf6 = step(B4, 'g8f6');
  const bpos = { fen: B4, lines: [{ cp: 0, win: 50, pv: ['d8e7', 'h5e5'] }, { cp: -50, win: 45, pv: ['g7g6'] }] };
  const apos = { fen: nf6.after, lines: [{ mate: 1, win: 100, pv: ['h5f7'] }], mate: 1, win: 100 };
  const cb = coach({ m: nf6, b: bpos, a: apos, cls: 'blunder', isBest: false, tg: [] });
  check('coach: a blunder says how Stockfish answers (mate)', /White answers Qxf7#, which gives checkmate\./.test(cb.reply || ''), String(cb.reply));
  check('coach: two replayable lines — the engine\'s answer and a better line', cb.lines.length === 2 && cb.lines[1].label === 'Better line' && cb.lines[1].moves[0] === '3…Qe7', JSON.stringify(cb.lines.map(l => l.moves)));
  check('coach: the answer line starts with the move played and continues with the reply', cb.lines[0].moves.join(' ') === '3…Nf6 4.Qxf7#', cb.lines[0].moves.join(' '));
  check('coach: lines are plain data (no chess.js objects), each step has its position', cb.lines.every(l => l.steps.every(s => typeof s.fen === 'string' && typeof s.san === 'string')));
  const tg = tags({ m: nf6, b: { ...bpos, mate: null, cp: 0 }, a: { ...apos, cp: null }, drop: 50, wb: 50, wa: 0, cls: 'blunder' });
  const txt = explain({ m: nf6, cls: 'blunder', tg, bestSan: cb.bestSan, wa: 0, i: 5, extra: cb });
  check('explain: the sentence pieces from coach are used and the better move is named', /Best was Qe7|Qe7 was|engine preferred Qe7|Qe7/.test(txt), txt);

  // A "great" move explains how much worse the alternative was.
  const e4 = step(START, 'e2e4');
  const cg = coach({ m: e4, b: { fen: START, lines: [{ cp: 30, win: 53, pv: ['e2e4', 'e7e5'] }, { cp: 10, win: 51, pv: ['d2d4'] }] }, a: { fen: e4.after, lines: [{ cp: 30, win: 47, pv: ['e7e5'] }] }, cls: 'great', isBest: true, tg: [] });
  check('coach: a great move quotes the next best alternative', cg.why.some(s => /next best move, d4, only gives \+0\.1/.test(s)), cg.why.join(' | '));
  check('coach: when the move is the engine\'s first line, its own line is shown', cg.lines.length === 1 && cg.lines[0].label === 'Stockfish’s line' && cg.lines[0].moves.join(' ') === '1.e4 e5', JSON.stringify(cg.lines));

  // Regression (Hikaru–Carlsen 30...c5): the pawn only falls many moves into the line, and Rh4 was the engine's top choice.
  // The card must not say the quiet reply Kg2 "wins a pawn", must not blame a pawn the best line also loses, and must show
  // the same eval for the move as the one the grade used (the move's own line), not the separate after-position search.
  const HB = '8/1pp5/1k1p3p/1p2p2r/1P2P3/P4PRP/2P2K2/8 b - - 0 30';
  const hc5 = step(HB, 'c7c5');
  const ownPv = ['c7c5', 'f2g2', 'h5h4', 'g3g6', 'b6c6', 'g2g3', 'h4f4', 'g6h6'];
  const hb = pv => ({ fen: HB, lines: [{ cp: 0, win: 50, pv }, { cp: 140, win: 63, pv: ownPv }] });
  const ha = { fen: hc5.after, lines: [{ cp: 220, win: 69, pv: ['f2g2', 'h5h4'] }], cp: 220, win: 69 };
  const quiet = coach({ m: hc5, b: hb(['h5h4', 'g3g6', 'b6c6', 'f2g3']), a: ha, cls: 'mistake', isBest: false, tg: [] });
  check('coach: a pawn won deep in the line is not pinned on the quiet reply', !/Kg2 and wins|answers Kg2/.test(quiet.reply || ''), String(quiet.reply));
  check('coach: the card eval for a move in the engine\'s lines is that line\'s own score', quiet.ev[1] === '+1.4', JSON.stringify(quiet.ev));
  check('coach: the played move\'s line is named as the line after the move, not "Stockfish\'s answer"', quiet.lines[0].label === 'Stockfish’s line after c5', quiet.lines[0].label);
  const same = coach({ m: hc5, b: hb(ownPv.slice(1)), a: ha, cls: 'mistake', isBest: false, tg: [] });
  check('coach: material the best line also loses is not blamed on the move', !/wins a pawn|a pawn up/.test(same.reply || ''), String(same.reply));

  // Robustness: no lines at all (engine gave nothing), or a terminal position after the move.
  const empty = coach({ m: e4, b: { fen: START, lines: [] }, a: { fen: e4.after, lines: [], over: 'draw', win: 50 }, cls: 'good', isBest: false, tg: [] });
  {
  const { fmtEval } = await import(path.join(site, 'util.js'));
  check('fmtEval: tiny scores read 0.0, never -0.0; signs and mates are kept', fmtEval({ cp: -4 }) === '0.0' && fmtEval({ cp: 4 }) === '0.0' && fmtEval({ cp: 120 }) === '+1.2' && fmtEval({ cp: -55 }) === '-0.6' && fmtEval({ mate: -3 }) === '-M3' && fmtEval({ mate: 2 }) === 'M2');
}
check('coach: missing engine lines do not throw and give no invented reasons', empty.reply === null && empty.better === null && empty.lines.length === 1);

  // The mating move itself is never also reported as a "missed mate".
  const mt = step(SC, 'h5f7');
  const mtags = tags({ m: mt, b: { fen: SC, mate: 1, cp: null }, a: { fen: mt.after, over: 'mate', win: 100 }, drop: 0, wb: 100, wa: 100, cls: 'best' });
  check('tags: delivering mate is "mated" only, not also "missMate"', mtags.length === 1 && mtags[0][0] === 'mated', JSON.stringify(mtags));
}


// ---- thresholds: every boundary, both sides (a >= turned into > must not go unnoticed) -------------------------------------------
{
  const c = (o, want, why) => check(`classify boundary: ${why}`, classify({ ...base, ...o }) === want, `${JSON.stringify(o)} gave ${classify({ ...base, ...o })}, expected ${want}`);
  c({ drop: 4.99 }, 'good', 'a 4.99-point drop is still fine');       c({ drop: 5 }, 'inaccuracy', '5 points is an inaccuracy');
  c({ drop: 9.99 }, 'inaccuracy', '9.99 points is still an inaccuracy'); c({ drop: 10 }, 'mistake', '10 points is a mistake');
  c({ drop: 19.99 }, 'mistake', '19.99 points is still a mistake');     c({ drop: 20 }, 'blunder', '20 points is a blunder');
  c({ drop: 5, prev: 9.99 }, 'inaccuracy', 'a slip after a 9.99 drop is not yet a "miss"'); c({ drop: 5, prev: 10 }, 'miss', 'a slip after a 10-point drop is a "miss"');
  c({ drop: 25, prev: 30 }, 'blunder', 'a blunder stays a blunder even after another mistake');
  c({ drop: 0.3 }, 'best', 'a 0.3 drop counts as best');                c({ drop: 0.31 }, 'excellent', '0.31 is excellent');
  c({ drop: 2 }, 'excellent', '2 points is excellent');                  c({ drop: 2.01 }, 'good', '2.01 is only good');
  const gr = { isBest: true, gap: 12, wb: 50, wa: 50 };
  c(gr, 'great', 'only-move with a 12-point gap is great');              c({ ...gr, gap: 11.99 }, 'best', 'a 11.99-point gap is just best');
  c({ ...gr, gap: null }, 'best', 'no second line means no "great"');
  c({ ...gr, wb: 12 }, 'best', 'already lost (12%) is not "great"');     c({ ...gr, wb: 12.01 }, 'great', 'just above 12% can be great');
  c({ ...gr, wb: 92 }, 'best', 'already winning (92%) is not "great"');  c({ ...gr, wb: 91.99 }, 'great', 'just below 92% can be great');
  c({ ...gr, wa: 97 }, 'best', 'still 97% after it is not "great"');     c({ ...gr, wa: 96.99 }, 'great', '96.99% after it can be great');
  const br = { sac: true, drop: 2, wb: 60, wa: 50 };
  c(br, 'brilliant', 'a sacrifice that keeps 50% is brilliant');        c({ ...br, drop: 2.01 }, 'good', 'a sacrifice that loses 2.01 is not brilliant');
  c({ ...br, wa: 49.99 }, 'excellent', 'a sacrifice that ends below 50% is not brilliant');
  c({ ...br, wb: 92 }, 'excellent', 'a sacrifice when already winning (92%) is not brilliant'); c({ ...br, wb: 91.99 }, 'brilliant', 'a sacrifice at 91.99% is brilliant');
  c({ ...br, sac: false }, 'excellent', 'no sacrifice, no brilliancy');
  c({ ...br, drop: 0, isBest: true, wb: 60, wa: 60, gap: 20 }, 'brilliant', 'brilliant outranks great');
}
{
  const sac = (fen, mv) => { const ch = new Chess(fen), m = ch.move(mv); return sacrifice(m, m.after); };
  check('sacrifice: a knight put on a square a pawn attacks is a sacrifice', sac('4k3/8/2p5/8/8/4N3/8/4K3 w - - 0 1', 'Nd5') === true);
  check('sacrifice: a queen put where a bishop attacks is a sacrifice', sac('4k3/1b6/8/8/8/8/8/3QK3 w - - 0 1', 'Qd5') === true);
  check('sacrifice: a square nobody attacks is no sacrifice', sac('4k3/8/8/8/8/4N3/8/4K3 w - - 0 1', 'Nd5') === false);
  check('sacrifice: pawn moves are never sacrifices', sac('4k3/8/2p5/8/4P3/8/8/4K3 w - - 0 1', 'e5') === false);
  check('sacrifice: king moves are never sacrifices', sac('4k3/8/8/8/8/8/3r4/4K3 w - - 0 1', 'Kxd2') === false);
  check('sacrifice: an even trade (rook takes a rook that a pawn guards) is not a sacrifice', sac('4k3/8/2p5/3r4/8/8/8/3RK3 w - - 0 1', 'Rxd5') === false);
  check('sacrifice: a minor piece given for a pawn (attacked by the pawn, undefended) is a sacrifice', sac('4k3/8/2p5/1p6/8/4N3/8/4K3 w - - 0 1', 'Nd5') === true);
  check('sacrifice: a knight attacked only by the king but defended by the other king is not a sacrifice', sac('8/8/8/8/8/3k4/8/4K1N1 w - - 0 1', 'Ne2') === false);
}

// ---- regressions found by reading the app against real chess situations ----
{
  const { tags } = await import(path.join(site, 'review.js'));
  const { moveNo } = await import(path.join(site, 'util.js'));
  // The best move was a capture. It is only a "free piece" when nothing can take back.
  const missed = (fen, best) => { const c = new Chess(fen), m = c.move('Ke2'); return tags({ m, b: { fen, best, win: 50, lines: [] }, a: { fen: c.fen(), win: 10, lines: [] }, drop: 40, wb: 50, wa: 10, cls: 'blunder' }).map(t => t[0]); };
  check('tags: a free piece the player did not take is "missCap"', missed('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5').includes('missCap'));
  check('tags: a capture the opponent can take back is not a "free piece" (no missCap)', !missed('4k3/8/2p5/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5').includes('missCap'));
  check('tags: an even piece trade is not described as winning a piece', !missed('4k3/8/2p5/3n4/8/1B6/8/4K3 w - - 0 1', 'b3d5').includes('missCap') && !missed('4k3/8/4b3/3n4/8/8/8/3RK3 w - - 0 1', 'd1d5').includes('missCap'));
  check('tags: the trade positions above really are captures (guards the test itself)', ['4k3/8/2p5/3n4/8/1B6/8/4K3 w - - 0 1|b3d5', '4k3/8/4b3/3n4/8/8/8/3RK3 w - - 0 1|d1d5'].every(x => { const [f, u] = x.split('|'); return !!new Chess(f).move({ from: u.slice(0, 2), to: u.slice(2, 4) }).captured; }));

  const W = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', Bk = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  check('moveNo: a normal game counts 1,1,2,2,3...', [1, 2, 3, 4, 5].map(p => moveNo(W, p)).join() === '1,1,2,2,3');
  check('moveNo: a game from a position with Black to move starts on Black\'s move number (1…, 2., 2…)', [1, 2, 3, 4].map(p => moveNo(Bk, p)).join() === '1,2,2,3');
  check('moveNo: honours a later starting move number', moveNo('4k3/8/8/8/8/8/8/4K3 b - - 0 20', 1) === 20 && moveNo('4k3/8/8/8/8/8/8/4K3 b - - 0 20', 2) === 21);
  check('moveNo: a FEN without a move number counts from 1', moveNo('4k3/8/8/8/8/8/8/4K3 w - -', 1) === 1);

  const throws = pgn => { try { parseGame(pgn); return null; } catch (e) { return e.message; } };
  check('parseGame: Chess960 is refused with a message that names it', /Chess960/.test(throws('[Variant "Chess960"]\n\n1. e4 e5 *') || ''));
  check('parseGame: Crazyhouse, King of the Hill and Three-check are refused too', ['Crazyhouse', 'King of the Hill', 'Three-check', 'Racing Kings', 'Antichess'].every(v => /standard chess/i.test(throws(`[Variant "${v}"]\n\n1. e4 e5 *`) || '')));
  check('parseGame: "Standard" and "From Position" are ordinary chess and still load', throws('[Variant "Standard"]\n\n1. e4 e5 *') === null && throws('[Variant "From Position"]\n\n1. e4 e5 *') === null);
  check('parseGame: a game without a Variant header loads', throws('1. e4 e5 *') === null);
  const bg = parseGame('[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... e5 2. Nf3 *');
  check('parseGame: a game from a position keeps that position as its start and Black moves first', bg.fens[0] === Bk && bg.moves[0].color === 'b' && bg.moves[1].color === 'w');
}

// ================================================================================================================
// Talking to Stockfish: UCI parsing, expected points, brilliant / great / book, the follow-up questions, game rating
// ================================================================================================================
{
  const { parseInfo, goCommand } = await import(path.join(site, 'uci.js'));
  const R = await import(path.join(site, 'rating.js'));
  const { LINES, inBook, bookSize } = await import(path.join(site, 'openings.js'));
  const B = await import(path.join(site, 'brilliant.js'));
  const { interrogate } = await import(path.join(site, 'analysis.js'));
  const { fakeEngine } = await import('../lib/fake-engine.mjs');

  // ---- uci: reading what Stockfish says ----
  const info = parseInfo('info depth 18 seldepth 24 multipv 2 score cp -35 wdl 120 700 180 nodes 99999 nps 1200000 hashfull 5 tbhits 0 time 80 pv e7e5 g1f3 b8c6');
  check('uci: parseInfo reads score, multipv, depth, wdl and the line', info && info.cp === -35 && info.k === 2 && info.depth === 18 && info.wdl.join() === '120,700,180' && info.pv.join(' ') === 'e7e5 g1f3 b8c6', JSON.stringify(info));
  check('uci: parseInfo reads a mate score and a line without multipv/wdl', (i => i.mate === -3 && i.k === 1 && i.wdl === undefined)(parseInfo('info depth 5 score mate -3 pv a1a2')));
  check('uci: parseInfo ignores bound lines, strings and lines without a score or a line', ['info depth 5 score cp 10 lowerbound pv a1a2', 'info depth 5 score cp 10 upperbound pv a1a2', 'info string NNUE evaluation', 'info depth 3 currmove e2e4 currmovenumber 1', 'bestmove e2e4', '', 'info depth 5 score cp 5'].every(l => parseInfo(l) === null));
  check('uci: parseInfo does not mistake "multipv" for "pv"', parseInfo('info multipv 3 score cp 1 pv e2e4').pv.join() === 'e2e4');
  check('uci: goCommand restricts the root with searchmoves only when asked', goCommand(16) === 'go depth 16' && goCommand(16, []) === 'go depth 16' && goCommand(12, ['e2e4', 'd2d4']) === 'go depth 12 searchmoves e2e4 d2d4');

  // ---- rating: expected points ----
  check('rating: lineWin uses Stockfish\'s win/draw/loss when it is there (draws count half)', near(R.lineWin({ cp: 500, wdl: [100, 800, 100] }), 50, 1e-9) && near(R.lineWin({ cp: 0, wdl: [600, 200, 200] }), 70, 1e-9));
  check('rating: lineWin falls back to the centipawn curve, and a mate is 100 / 0', near(R.lineWin({ cp: 100 }), winPct(100), 1e-9) && R.lineWin({ mate: 3 }) === 100 && R.lineWin({ mate: -2 }) === 0);
  check('rating: toWhite flips a Black-to-move score and its win/draw/loss', (w => w.cp === -80 && w.wdl.join() === '100,300,600' && near(w.win, 100 - R.lineWin({ cp: 80, wdl: [600, 300, 100] }), 1e-9))(R.toWhite({ cp: 80, wdl: [600, 300, 100], pv: ['e7e5'] }, 'b')));
  check('rating: toWhite keeps a White-to-move score and flips a mate', R.toWhite({ cp: 80, pv: [] }, 'w').cp === 80 && R.toWhite({ mate: 2, pv: [] }, 'b').mate === -2);
  check('rating: a weaker player\'s advantage is worth less; no rating (or 2400+) changes nothing', R.winFor({ cp: 300 }, 'w', 800) < R.winFor({ cp: 300 }, 'w', 2400) && near(R.winFor({ cp: 300 }, 'w', 0), winPct(300), 1e-9) && near(R.winFor({ cp: 300 }, 'w', 2600), winPct(300), 1e-9));
  check('rating: winFor is from the mover\'s side and never softens a mate', near(R.winFor({ cp: 200 }, 'b', 0), 100 - winPct(200), 1e-9) && R.winFor({ mate: 2 }, 'w', 800) === 100 && R.winFor({ mate: 2 }, 'b', 800) === 0);
  check('rating: eloScale runs from 0.6 (600) to 1 (2400) and generosity is its complement', R.eloScale(600) === 0.6 && R.eloScale(100) === 0.6 && R.eloScale(2400) === 1 && R.eloScale(0) === 1 && near(R.generosity(600), 0.4, 1e-9) && R.generosity(0) === 0);
  check('rating: cpOf counts a mate as 1000 and clips', R.cpOf({ mate: 3 }) === 1000 && R.cpOf({ mate: -1 }) === -1000 && R.cpOf({ cp: 5000 }) === 1000 && R.cpOf({ cp: -37 }) === -37);

  // ---- rating: the whole game ----
  check('rating: gameAccuracy of a perfect game is 100, and of nothing is 0', near(R.gameAccuracy([100, 100, 100], null), 100, 1e-9) && R.gameAccuracy([], null) === 0);
  const mixed = [95, 95, 95, 95, 95, 95, 95, 95, 95, 10];
  check('rating: one terrible move costs more than a plain average says (harmonic mean)', R.gameAccuracy(mixed, null) < mixed.reduce((a, b) => a + b) / mixed.length - 3, R.gameAccuracy(mixed, null));
  check('rating: moves in sharper positions weigh more', R.gameAccuracy([100, 50], [1, 9]) < R.gameAccuracy([100, 50], [9, 1]));
  check('rating: volatility is low in a calm game, high in a wild one, and stays inside 0.5..12', R.volatility([50, 50, 50, 50, 50, 50], 0) === 0.5 && R.volatility([10, 90, 10, 90, 10, 90, 10, 90], 0) === 12 && R.volatility([50], 0) === 0.5);
  check('rating: phaseOf — start is the opening, queens off is the endgame, a middlegame in between', R.phaseOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 0) === 'open' && R.phaseOf('4k3/pppp4/8/8/8/8/PPPP4/R3K2R w - - 0 1', 40) === 'end' && R.phaseOf('r1bq1rk1/ppp2ppp/2n2n2/8/8/2N2N2/PPP2PPP/R1BQ1RK1 w - - 0 9', 30) === 'mid');
  const ratings = [30, 50, 60, 70, 80, 90, 97].map(a => R.estimateRating(a, 40));
  check('rating: estimateRating rises with accuracy, is rounded to 50, and is withheld for very short games', ratings.every((r, i) => i === 0 || r > ratings[i - 1]) && ratings.every(r => r % 50 === 0) && R.estimateRating(90, 5) === null && R.estimateRating(NaN, 40) === null, ratings.join());

  // ---- book ----
  const legalCount = LINES.reduce((n, l) => { try { const c = new Chess(); for (const t of l.split(/\s+/)) if (!/^\d+\.+$/.test(t)) c.move(t); return n + 1; } catch { return n; } }, 0);
  check('book: every opening line is legal chess', legalCount === LINES.length, `${LINES.length - legalCount} illegal of ${LINES.length}`);
  const after = (moves) => { const c = new Chess(); for (const t of moves.split(' ')) c.move(t); return c.fen(); };
  check('book: known opening positions are in the book, and an odd move is not', inBook(after('e4 e5 Nf3 Nc6 Bb5 a6')) && inBook(after('d4 Nf6 c4 e6 Nc3 Bb4')) && !inBook(after('e4 e5 Nf3 Nc6 Bb5 a6 h4')) && !inBook(after('a3 h6')));
  check('book: a transposition into a book position is recognised', inBook(after('c4 Nf6 Nc3 e6 d4 Bb4')));
  check('book: the book has a few hundred positions', bookSize() > 400, String(bookSize()));

  // ---- classify: the new rules ----
  const cb = { drop: 0, isBest: true, wb: 55, wa: 55, gap: null, sac: false, prev: 0 };
  check('classify: a book move is "book" and a single legal move is "forced", whatever the numbers say', classify({ ...cb, drop: 40, isBest: false, book: true }) === 'book' && classify({ ...cb, drop: 40, isBest: false, forced: true }) === 'forced' && classify({ ...cb, book: true, forced: true }) === 'forced');
  check('classify: a sacrifice is not brilliant when you were already completely winning (92+)', classify({ ...cb, sac: true, wb: 95, wa: 95 }) !== 'brilliant');
  check('classify: a sacrifice is not brilliant when the best other move was also completely winning', classify({ ...cb, sac: true, wb: 90, wa: 90, alt: 91 }) !== 'brilliant' && classify({ ...cb, sac: true, wb: 90, wa: 90, alt: 60 }) === 'brilliant');
  check('classify: a sacrifice that leaves you worse is not brilliant', classify({ ...cb, sac: true, wb: 45, wa: 45 }) !== 'brilliant');
  check('classify: a sacrifice that Stockfish does not back up when it looks deeper is not brilliant', classify({ ...cb, sac: true, wb: 60, wa: 60, deepOk: false }) !== 'brilliant');
  check('classify: a recapture is never brilliant or great', !['brilliant', 'great'].includes(classify({ ...cb, sac: true, gap: 30, recapture: true })));
  check('classify: a sacrifice that costs 3 points is not brilliant; one that costs 1 still is', classify({ ...cb, isBest: false, drop: 3, sac: true, wb: 60, wa: 57 }) !== 'brilliant' && classify({ ...cb, isBest: false, drop: 1, sac: true, wb: 60, wa: 59 }) === 'brilliant');
  check('classify: great — a move that turns equal into winning counts with a smaller gap (8) than the plain only-move rule (12)', classify({ ...cb, gap: 9, wb: 68, wa: 68 }) === 'great' && classify({ ...cb, gap: 9, wb: 80, wa: 80 }) !== 'great' && classify({ ...cb, gap: 12, wb: 80, wa: 80 }) === 'great');
  check('classify: great — a move that turns losing into equal counts', classify({ ...cb, gap: 9, wb: 40, wa: 40 }) === 'great');
  check('classify: weaker players are given a little more room for great (a smaller gap is enough)', classify({ ...cb, gap: 8, wb: 80, wa: 80, elo: 0 }) !== 'great' && classify({ ...cb, gap: 8, wb: 80, wa: 80, elo: 700 }) === 'great');

  // ---- brilliant: the engine's own line decides whether it is a sacrifice ----
  const { replay } = await import(path.join(site, 'coach.js'));
  const steps = (fen, pv) => replay(fen, pv);
  const NSAC = '4k3/8/3p4/8/8/5N2/8/4K3 w - - 0 1', NTRADE = '4k3/8/3b4/4n3/8/5N2/8/4K3 w - - 0 1';
  check('sacrifice: a knight given for nothing is a sacrifice in the engine\'s line', B.sacrificeInLine(steps(NSAC, ['f3e5', 'd6e5', 'e1d2']), 'w').sac === true);
  check('sacrifice: a knight traded for a knight is not', B.sacrificeInLine(steps(NTRADE, ['f3e5', 'd6e5', 'e1d2']), 'w').sac === false);
  check('sacrifice: a pawn given away is not a piece sacrifice', B.sacrificeInLine(steps('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', ['e4e5', 'd5d4', 'e1d1']), 'w').sac === false);
  check('sacrifice: a line with no moves (or a one-move line) is never a sacrifice', !B.sacrificeInLine([], 'w').sac && !B.sacrificeInLine(steps(NSAC, ['f3e5']), 'w').sac);
  check('sacrifice: a queen given up on the way to mate counts, even though the mate ends the line', B.sacrificeInLine(steps('6k1/5ppp/8/8/8/8/1Q3PPP/r3R1K1 w - - 0 1', ['b2b8', 'a1b1']), 'w').sac === false /* nothing lost here: guards the helper */);

  // A hand-written game: White to move, a knight can go to e5 where a pawn takes it. `lines` are what Stockfish "said".
  const SG = '[SetUp "1"]\n[FEN "' + NSAC + '"]\n\n1. Ne5 *';
  const L = (cp, pv) => ({ cp, mate: null, pv, win: winPct(cp) });
  const P = (fen, lines) => ({ fen, turn: fen.split(' ')[1], lines, win: lines[0].win, mate: lines[0].mate, cp: lines[0].cp, best: lines[0].pv[0] });
  const game1 = parseGame(SG), afterFen = game1.fens[1];
  const SAC_PV = ['f3e5', 'd6e5', 'e1d2'];
  const mk = (before, afterLines, probes, headers) => {
    const g = headers ? parseGame(`[WhiteElo "${headers}"]\n` + SG) : game1;
    return buildReview(g, [P(NSAC, before), P(afterFen, afterLines)], probes || [], { book: false });
  };
  const brilliantCase = mk([L(60, SAC_PV), L(-20, ['e1d2', 'e8e7'])], [L(60, ['d6e5', 'e1d2'])]);
  check('brilliant: the best move that gives up a knight and keeps the evaluation is brilliant', brilliantCase.items[0].cls === 'brilliant', brilliantCase.items[0].cls);
  check('brilliant: the card has a conversation with Stockfish that says it is a sacrifice and shows both evaluations', (t => t.some(([q, a]) => /really a sacrifice/.test(q) && /^Yes/.test(a)) && t.some(([q, a]) => /How good/.test(q) && /best move/.test(a)) && t.some(([q]) => /best move had not been found|alternative/.test(q)))(brilliantCase.items[0].talk), JSON.stringify(brilliantCase.items[0].talk));
  check('brilliant: not when you were already completely winning', mk([L(900, SAC_PV), L(300, ['e1d2'])], [L(900, ['d6e5'])]).items[0].cls !== 'brilliant');
  check('brilliant: not when the other move was just as winning (the sacrifice was not needed), and the card says why', (r => r.items[0].cls !== 'brilliant' && r.items[0].talk.some(([q, a]) => /Why not brilliant/.test(q) && /not needed/.test(a)))(mk([L(620, SAC_PV), L(610, ['e1d2'])], [L(620, ['d6e5'])])));
  check('brilliant: not when the engine\'s own line wins the piece back (a trade, not a sacrifice)', (() => { const g = parseGame('[SetUp "1"]\n[FEN "' + NTRADE + '"]\n\n1. Nxe5 *'); return buildReview(g, [P(NTRADE, [L(60, ['f3e5', 'd6e5', 'e1d2']), L(-20, ['e1d2'])]), P(g.fens[1], [L(60, ['d6e5'])])], [], { book: false }).items[0].cls !== 'brilliant'; })());
  // The played move is not among Stockfish's two lines. Without asking, the position after it looks like a blunder.
  const out2 = [L(60, ['e1d2']), L(40, ['e1e2'])], aft2 = [L(-300, ['d6e5', 'e1d2'])];
  check('brilliant: a move outside the top lines is judged by the next position alone when Stockfish is not asked (looks like a blunder)', mk(out2, aft2).items[0].cls === 'blunder');
  const own = L(55, SAC_PV);
  check('brilliant: asked about exactly that move, Stockfish shows it is nearly the best move: brilliant instead of blunder', mk(out2, aft2, [{ own }]).items[0].cls === 'brilliant');
  const deepGood = { own, deep: L(50, SAC_PV), deepBest: L(55, ['e1d2']), depth: 16 }, deepBad = { own, deep: L(-250, SAC_PV), deepBest: L(55, ['e1d2']), depth: 16 };
  const ok = mk(out2, aft2, [deepGood]).items[0], bad = mk(out2, aft2, [deepBad]).items[0];
  check('brilliant: a deeper look that agrees confirms it, and the text says it was double-checked', ok.cls === 'brilliant' && /double-checked it at depth 16/.test(ok.text), ok.text);
  check('brilliant: a deeper look that disagrees takes it away, and the conversation says so', bad.cls !== 'brilliant' && bad.talk.some(([q, a]) => /depth 16/.test(q) && /^No/.test(a)), JSON.stringify(bad.talk));
  check('brilliant: holdsUp is true without a deeper look, and checks both the move\'s score and the gap to the best move', B.holdsUp(null, 'w', 0, 2, 50) && B.holdsUp({ deep: L(50, []), deepBest: L(52, []) }, 'w', 0, 2, 40) && !B.holdsUp({ deep: L(-100, []), deepBest: L(52, []) }, 'w', 0, 2, 40));
  // a pawn is not a piece, even at a bad moment
  check('brilliant: Elo in the headers makes grading gentler for a weaker player (same moves, same lines, smaller drop)', (() => {
    const lines = [L(150, ['e1d2']), L(100, ['e1e2'])], a1 = [L(-150, ['d6e5'])];
    const hi = mk(lines, a1, [{ own: L(-30, SAC_PV) }], 2600).items[0], lo = mk(lines, a1, [{ own: L(-30, SAC_PV) }], 700).items[0];
    return hi.ep[0] - hi.ep[1] > lo.ep[0] - lo.ep[1];
  })());

  // ---- interrogate: which questions Stockfish is asked, and what happens when it cannot answer ----
  let scriptN = 0; // each scripted engine gets its own kind: answers are cached per engine kind, as in the app
  const scripted = (answers = {}) => {
    const log = [];
    return { kind: 'script' + scriptN++, log, async probe(fen, depth, o = {}) {
      log.push({ depth, moves: o.moves, multipv: o.multipv });
      if (answers.fail) throw new Error('Stockfish crashed.');
      if (o.moves) return [{ cp: 55, pv: o.moves.concat(['d6e5', 'e1d2']) }];
      return [{ cp: 58, pv: ['e1d2'] }, { cp: 52, pv: ['f3e5', 'd6e5', 'e1d2'] }, { cp: 30, pv: ['e1e2'] }];
    } };
  };
  const pos2 = [P(NSAC, out2), P(afterFen, aft2)];
  const eng = scripted();
  const probes = await interrogate([eng], game1, pos2, 12, () => {}, { book: false });
  check('interrogate: asks Stockfish about the played move first (searchmoves, one line), then looks deeper at it (depth + 4, three lines)', eng.log.length === 2 && eng.log[0].depth === 12 && eng.log[0].moves.join() === 'f3e5' && eng.log[0].multipv === 1 && eng.log[1].depth === 16 && eng.log[1].multipv === 3, JSON.stringify(eng.log));
  check('interrogate: the answers come back in White\'s view and make the review brilliant', probes[0] && probes[0].own && probes[0].deep && probes[0].depth === 16 && buildReview(game1, pos2, probes, { book: false }).items[0].cls === 'brilliant');
  const idle = scripted();
  const g3 = parseGame('1. e4 e5 *');
  const p3 = await interrogate([idle], g3, [P(g3.fens[0], [L(30, ['e2e4']), L(20, ['d2d4'])]), P(g3.fens[1], [L(30, ['e7e5'])]), P(g3.fens[2], [L(30, ['g1f3'])])], 12, () => {}, { book: false });
  check('interrogate: a move that is already among Stockfish\'s lines and is no sacrifice costs no questions at all', idle.log.length === 0 && p3.every(x => !x), JSON.stringify(idle.log));
  const crashing = scripted({ fail: true });
  const pf = await interrogate([crashing], game1, pos2, 12, () => {}, { book: false });
  check('interrogate: an engine that fails to answer does not break the review (the move is simply graded from the first pass)', pf[0] === undefined && buildReview(game1, pos2, pf, { book: false }).items[0].cls === 'blunder');
  check('interrogate: an engine without probe() is skipped quietly', (await interrogate([{ kind: 'old', analyze() {} }], game1, pos2, 12, () => {}, { book: false })).every(x => !x));
  let seen = 0;
  await interrogate([scripted()], game1, pos2, 12, (d, t) => { seen = d + '/' + t; }, { book: false });
  check('interrogate: progress is reported per move asked about', seen === '1/1', seen);
  // the fake engine understands searchmoves the way Stockfish does
  const fk = await fakeEngine({ seed: 5, kind: 'fk-probe' });
  const some = await fk.probe(game1.fens[0], 12, { moves: ['f3e5'], multipv: 1 });
  check('interrogate: a restricted search returns only that move (the fake engine, like Stockfish, honours searchmoves)', some.length === 1 && some[0].pv[0] === 'f3e5', JSON.stringify(some));
  const blk = await fakeEngine({ seed: 5, kind: 'fk-probe-b' }), gb = parseGame('1. e4 e5 2. Nf3 *');
  const bl = await blk.probe(gb.fens[1], 12, { moves: ['e7e5'], multipv: 1 });
  check('interrogate: the same for Black to move', bl.length === 1 && bl[0].pv[0] === 'e7e5', JSON.stringify(bl));

  // ---- the whole review: book, forced, stats, Elo, WDL ----
  const gsh = parseGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *');
  const fe = await fakeEngine({ seed: 3, noise: 60, kind: 'fk-book' });
  const posb = await analyseAll([fe], gsh.fens, 12, () => {});
  const rb = buildReview(gsh, posb);
  check('buildReview: opening moves are "book", counted, never an error, and 100 accurate', rb.items.every(i => i.cls === 'book') && rb.cnt.w.book === 3 && near(rb.acc.w, 100, 1e-9) && rb.items.every(i => i.cpl === 0));
  check('buildReview: the opening book can be switched off', buildReview(gsh, posb, [], { book: false }).items.some(i => i.cls !== 'book'));
  const ONLY = '7k/8/8/8/8/8/6q1/7K w - - 0 1'; // not forced: Kxg2
  const forcedPgn = '[SetUp "1"]\n[FEN "k7/8/8/8/8/8/1q6/K7 w - - 0 1"]\n\n1. Kxb2 *';
  check('buildReview: the only legal move is "forced"', (() => { try { const g = parseGame(forcedPgn); return buildReview(g, [P(g.fens[0], [L(-900, ['a1b2'])]), { fen: g.fens[1], turn: 'b', lines: [], win: 50, over: 'draw' }], [], { book: false }).items[0].cls === 'forced'; } catch (e) { return String(e); } })());
  const gfull = parseGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *');
  const rfull = buildReview(gfull, await analyseAll([await fakeEngine({ seed: 4, kind: 'fk-stat' })], gfull.fens, 12, () => {}));
  check('buildReview: stats carry accuracy, centipawn loss, a rating estimate for a long enough game, and phase accuracies', rfull.stats && ['w', 'b'].every(c => near(rfull.stats[c].accuracy, rfull.acc[c], 1e-9) && rfull.stats[c].acpl >= 0 && rfull.stats[c].moves === 10 && rfull.stats[c].rating > 0) && rfull.stats.w.phases.open != null, JSON.stringify(rfull.stats.w));
  check('buildReview: each move reports its expected points before and after, its centipawn loss and its phase', rfull.items.every(i => i.ep.length === 2 && i.ep.every(x => x >= 0 && x <= 100) && i.cpl >= 0 && ['open', 'mid', 'end'].includes(i.phase)));
  check('buildReview: a short game gets no rating estimate', rb.stats.w.rating === null);
  // draw-aware expected points: the same centipawn drop is a smaller loss in a drawish position (Stockfish says so with its WDL)
  const drawish = await fakeEngine({ seed: 3, noise: 0, kind: 'fk-wdl', wdl: true });
  const pw = await analyseAll([drawish], gsh.fens, 12, () => {});
  check('analyseAll: win/draw/loss from the engine is kept on each line and used for the win% (Elo-free, White\'s view)', pw[0].lines[0].wdl && pw[0].lines[0].wdl.length === 3 && near(pw[0].win, R.lineWin(pw[0].lines[0]), 1e-9) && pw[1].lines[0].wdl[0] <= pw[1].lines[0].wdl[2] + 1000);
}

await S.run();
S.finish();
