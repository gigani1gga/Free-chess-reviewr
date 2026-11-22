// Unit tests for the grading/analysis logic (no browser). Runs against the assembled test site so that
// ../vendor/chess.js resolves to the chess.js stand-in.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(here, 'build/site/js');
const { winPct, accuracy, classify } = await import(path.join(site, 'review.js'));
const { parseGame, analyseAll, buildReview, runSize, storeKey } = await import(path.join(site, 'analysis.js'));

let fails = 0;
const check = (name, cond, detail = '') => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : `  ${detail}`)); if (!cond) fails++; };
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
check('buildReview: both best moves graded "best"/"great"/"excellent", 100% drop-free', rev.items.every(i => ['best', 'great', 'excellent'].includes(i.cls)), rev.items.map(i => i.cls).join());
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

console.log(fails ? `\n${fails} unit check(s) FAILED` : '\nall unit checks passed');
process.exit(fails ? 1 : 0);
