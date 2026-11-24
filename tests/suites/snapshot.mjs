// Golden-master tests: the complete review (every grade, tag, evaluation, best move, sentence and accuracy) of fixed games, reviewed
// by the deterministic fake engine, is stored in snapshots/review.json. Any change to the app's grading or wording shows up as a
// precise per-move diff. Intended change?  node kit.mjs snapshot --update   (then read the diff in git before committing).
import fs from 'node:fs';
import path from 'node:path';
import { siteDir, importFile, kitRoot } from '../lib/env.mjs';
import { fakeEngine } from '../lib/fake-engine.mjs';
import { randomGame, STARTS, toPgn } from '../lib/gen.mjs';
import { GAMES } from '../lib/games.mjs';
import { rng } from '../lib/prng.mjs';
import { createSuite } from '../lib/suite.mjs';

const S = createSuite('snapshot', { timeout: 60000 });
const FILE = path.join(kitRoot, 'snapshots/review.json');
const update = process.env.KIT_UPDATE === '1' || process.argv.includes('--update');
const js = f => importFile(path.join(siteDir(), 'js', f));
const { parseGame, analyseAll, buildReview } = await js('analysis.js');
const stored = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const next = {};
const ENGINES = { steady: { seed: 11, noise: 70, glitch: 0 }, wild: { seed: 12, noise: 220, glitch: 0.25 } };
let k = 0;

async function summarise(pgn, cfg) {
  const g = parseGame(pgn), eng = await fakeEngine({ ...cfg, kind: 'snap' + k++ });
  const pos = await analyseAll([eng], g.fens, 12, () => {});
  const R = buildReview(g, pos);
  return {
    acc: [+R.acc.w.toFixed(2), +R.acc.b.toFixed(2)],
    cnt: { w: R.cnt.w, b: R.cnt.b },
    win: pos.map(p => Math.round(p.win * 10) / 10),
    moves: R.items.map(it => [it.m.san, it.cls, it.tags.join('+'), it.best || '', it.ev.join(' > '), it.lines.map(l => `${l.label}: ${l.moves.join(' ')} (${l.ev})`).join(' / '), it.text]),
  };
}
const diff = (a, b) => {
  const out = [];
  if (!a) return ['no snapshot recorded yet'];
  if (JSON.stringify(a.acc) !== JSON.stringify(b.acc)) out.push(`accuracy ${a.acc} -> ${b.acc}`);
  if (JSON.stringify(a.win) !== JSON.stringify(b.win)) out.push(`win% curve changed (${a.win.length} -> ${b.win.length} points)`);
  const n = Math.max(a.moves.length, b.moves.length), names = ['move', 'grade', 'tags', 'best', 'eval', 'lines', 'text'];
  for (let i = 0; i < n && out.length < 6; i++) {
    const x = a.moves[i] || [], y = b.moves[i] || [];
    for (let c = 0; c < 7; c++) if (x[c] !== y[c]) { out.push(`ply ${i + 1} ${y[0] ?? x[0]}: ${names[c]}\n         was: ${x[c]}\n         now: ${y[c]}`); break; }
  }
  return out;
};

const cases = [];
for (const [id, g] of Object.entries(GAMES)) for (const [en, cfg] of Object.entries(ENGINES)) cases.push([`${id} / ${en} engine`, () => g.pgn, cfg]);
// random but fixed games (seeded), for breadth: endgames, promotions, mates
const r = rng(2024);
for (let i = 0; i < 8; i++) {
  const g = await randomGame(r, { fen: STARTS[i % STARTS.length], maxPlies: 30 + r.int(40), greed: i % 2 ? 0.7 : 0.35 });
  if (g.ucis.length) { const pgn = await toPgn(g); cases.push([`random game ${i + 1} (${g.ucis.length} plies) / ${i % 2 ? 'wild' : 'steady'} engine`, () => pgn, ENGINES[i % 2 ? 'wild' : 'steady']]); }
}
for (const [name, pgn, cfg] of cases) {
  S.test(`snapshot: ${name}`, async () => {
    const now = await summarise(pgn(), cfg);
    next[name] = now;
    if (update) return;
    const d = diff(stored[name], now);
    if (d.length) throw new Error(`the review of "${name}" changed (snapshot):\n    ${d.join('\n    ')}\n    If this is intended: node kit.mjs snapshot --update`);
  }, { tags: ['analysis', 'snapshot'], covers: ['js/review.js', 'js/coach.js', 'js/analysis.js', 'js/meta.js', 'js/util.js'] });
}
await S.run({
  onEnd: () => {
    if (!update) return;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 1));
    console.log(`snapshot written: ${Object.keys(next).length} reviews -> ${path.relative(process.cwd(), FILE)}`);
  },
});
S.finish();
