// Unit tests for the grading/analysis logic (no browser). Runs against the assembled test site so that
// ../vendor/chess.js resolves to the chess.js stand-in.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(here, 'build/site/js');
const { winPct, accuracy, classify } = await import(path.join(site, 'review.js'));
const { parseGame, analyseAll, buildReview } = await import(path.join(site, 'analysis.js'));

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

// mate handling
const mateEng = { kind: 'mate-test', async analyze(fen) { return fen.split(' ')[1] === 'w' ? [{ mate: 2, pv: ['e2e4'] }] : [{ mate: -2, pv: ['e7e5'] }]; } };
const mpos = await analyseAll([mateEng], game.fens, 16, () => {});
check('mate scores: White mating = 100% for White; Black being mated = 100% for White', mpos[0].win === 100 && mpos[1].win === 100 && mpos[0].mate === 2 && mpos[1].mate === 2, JSON.stringify(mpos.map(p => [p.mate, p.win])));

console.log(fails ? `\n${fails} unit check(s) FAILED` : '\nall unit checks passed');
process.exit(fails ? 1 : 0);
