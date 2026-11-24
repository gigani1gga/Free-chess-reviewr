// Property-based tests of the app's review logic: instead of a few hand-picked games, thousands of random legal ones, checked
// against rules that must hold for EVERY game ("properties"). Failures are shrunk to the shortest game that still fails and come
// with the seed, so they replay exactly:   node kit.mjs fuzz --seed 123
//   --seed N   --budget-ms N (per property, default 2500)
import { siteDir, importFile } from '../lib/env.mjs';
import path from 'node:path';
import { chessModule } from '../lib/chess.mjs';
import { fakeEngine } from '../lib/fake-engine.mjs';
import { mirrorFen, mirrorUci, randomGame, STARTS, toPgn } from '../lib/gen.mjs';
import { GAMES } from '../lib/games.mjs';
import * as O from '../lib/oracle.mjs';
import { newSeed, rng } from '../lib/prng.mjs';
import { createSuite } from '../lib/suite.mjs';

const S = createSuite('fuzz', { workers: 1, timeout: 90000 });
const seed = S.opts.seed ?? newSeed();
const budget = S.opts.budgetMs ?? 2500;
const js = f => importFile(path.join(siteDir(), 'js', f));
const { Chess, ChessCore: C } = await chessModule();
const { winPct, accuracy, classify } = await js('review.js');
const { parseGame, analyseAll, buildReview } = await js('analysis.js');
const { META } = await js('meta.js');
const { fmtEval } = await js('util.js');
const { coach, replay } = await js('coach.js');
const { Engine } = await js('engine.js');

const meta = (extra = {}) => ({ tags: ['analysis', 'fuzz'], covers: ['js/review.js', 'js/analysis.js', 'js/coach.js'], ...extra });
const seen = { cls: {}, games: 0, plies: 0, mates: 0, tags: {} };
let uniq = 0;

const review = async (pgn, eng, depth = 12, extra = []) => {
  const g = parseGame(pgn);
  const pos = await analyseAll([eng, ...extra], g.fens, depth, () => {});
  return { g, pos, R: buildReview(g, pos, [], { book: false }) }; // book moves are position-specific, so they are not part of the colour-swap symmetry
};
const BADTEXT = /undefined|NaN|\bnull\b|\[object|\{[a-z]+\}|Infinity/;
const LEGAL_UCI = fen => new Set(O.legalUci(fen));

// ---- invariants that must hold for the review of ANY game -------------------------------------------------------------------
function invariants({ g, pos, R }) {
  const n = g.moves.length, e = [];
  if (R.items.length !== n) return `${R.items.length} items for ${n} moves`;
  if (pos.length !== n + 1) return `${pos.length} positions for ${n} moves`;
  const count = { w: {}, b: {} }, tot = { w: 0, b: 0 };
  R.items.forEach((it, i) => {
    const m = g.moves[i], who = m.color;
    if (!META[it.cls]) e.push(`ply ${i + 1} (${m.san}): unknown grade "${it.cls}"`);
    count[who][it.cls] = (count[who][it.cls] || 0) + 1; tot[who]++;
    seen.cls[it.cls] = (seen.cls[it.cls] || 0) + 1;
    for (const t of it.tags) seen.tags[t] = (seen.tags[t] || 0) + 1;
    if (typeof it.text !== 'string' || !it.text.trim()) e.push(`ply ${i + 1} (${m.san}): empty explanation`);
    else if (BADTEXT.test(it.text)) e.push(`ply ${i + 1} (${m.san}): explanation contains a template leak: "${it.text}"`);
    if (it.best) {
      if (!LEGAL_UCI(pos[i].fen).has(it.best)) e.push(`ply ${i + 1}: "best" ${it.best} is not a legal move in ${pos[i].fen}`);
      if (it.best === m.from + m.to + (m.promotion || '')) e.push(`ply ${i + 1}: best move equals the move played but is reported as an alternative`);
    }
    for (const l of it.lines || []) {
      let o = O.parse(l.start || pos[i].fen), ok = l.steps.length === l.moves.length;
      for (const s of l.steps) {
        const mv = O.legal(o).find(x => O.uci(x) === s.uci);
        if (!mv) { ok = false; e.push(`ply ${i + 1} "${l.label}": line step ${s.uci} is illegal in the position it is played from`); break; }
        o = O.make(o, mv);
        if (O.toFenPlacement(o) !== s.fen.split(' ')[0]) { e.push(`ply ${i + 1} "${l.label}": the position stored for ${s.san} is wrong`); break; }
      }
      if (!ok && !e.length) e.push(`ply ${i + 1} "${l.label}": steps/moves out of step`);
      if (/NaN|undefined/.test(l.ev)) e.push(`ply ${i + 1} "${l.label}": eval label "${l.ev}"`);
    }
    if (it.ev?.some(x => /NaN|undefined/.test(x))) e.push(`ply ${i + 1}: eval pair ${it.ev}`);
    if (!(it.ep && it.ep.length === 2 && it.ep.every(x => x >= 0 && x <= 100))) e.push(`ply ${i + 1} (${m.san}): expected points ${JSON.stringify(it.ep)} outside 0..100`);
    if (!(Number.isFinite(it.cpl) && it.cpl >= 0 && it.cpl <= 1000)) e.push(`ply ${i + 1} (${m.san}): centipawn loss ${it.cpl}`);
    if (['book', 'forced'].includes(it.cls) && it.cpl !== 0) e.push(`ply ${i + 1} (${m.san}): a ${it.cls} move lost ${it.cpl} centipawns`);
    if (it.cls === 'brilliant' && !(it.talk && it.talk.length)) e.push(`ply ${i + 1} (${m.san}): brilliant without a conversation to explain it`);
    for (const qa of it.talk || []) if (qa.length !== 2 || BADTEXT.test(qa.join(' '))) e.push(`ply ${i + 1} (${m.san}): bad conversation entry ${JSON.stringify(qa)}`);
  });
  for (const c of ['w', 'b']) {
    const st = R.stats?.[c];
    if (!st) { e.push(`no stats for ${c}`); continue; }
    if (!(st.accuracy >= 0 && st.accuracy <= 100)) e.push(`${c}: accuracy ${st.accuracy}`);
    if (!(st.acpl >= 0 && st.acpl <= 1000)) e.push(`${c}: acpl ${st.acpl}`);
    if (st.rating != null && !(st.rating >= 200 && st.rating <= 3200)) e.push(`${c}: rating estimate ${st.rating}`);
    for (const [k, v] of Object.entries(st.phases)) if (v != null && !(v >= 0 && v <= 100)) e.push(`${c}: ${k} accuracy ${v}`);
  }
  pos.forEach((p, i) => {
    if (!(p.win >= 0 && p.win <= 100)) e.push(`position ${i}: win% ${p.win} outside 0..100`);
    if (p.fen !== g.fens[i]) e.push(`position ${i}: fen differs from the game's`);
    if (p.cp != null && !Number.isFinite(p.cp)) e.push(`position ${i}: cp ${p.cp}`);
  });
  for (const w of ['w', 'b']) {
    const a = R.acc[w];
    if (!(Number.isFinite(a) && a >= 0 && a <= 100)) e.push(`${w} accuracy ${a} outside 0..100`);
    if (tot[w] === 0 && a !== 0) e.push(`${w} has no moves but accuracy ${a}`);
    for (const [k, v] of Object.entries(count[w])) if (R.cnt[w][k] !== v) e.push(`${w} grade count for ${k}: ${R.cnt[w][k]} but ${v} moves have it`);
    if (Object.values(R.cnt[w]).reduce((x, y) => x + y, 0) !== tot[w]) e.push(`${w} grade counts do not add up to ${tot[w]} moves`);
  }
  const last = g.moves.at(-1);
  if (last?.san.endsWith('#')) {
    if (pos.at(-1).over !== 'mate') e.push('the game ends in checkmate but the last position is not marked as mate');
    if (['inaccuracy', 'mistake', 'miss', 'blunder'].includes(R.items.at(-1).cls)) e.push(`the mating move ${last.san} was graded "${R.items.at(-1).cls}"`);
    seen.mates++;
  }
  return e.length ? e.slice(0, 3).join('\n') : null;
}

// Shortest prefix of the game that still fails `bad(prefixGame)`: so a 90-move failure is reported as the 5-move one it really is.
async function shrink(game, bad) {
  const lens = [...new Set([...[1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80].filter(l => l < game.ucis.length), game.ucis.length])];
  let hit = lens.at(-1);
  for (const L of lens) { if (await bad({ ...game, ucis: game.ucis.slice(0, L) })) { hit = L; break; } }
  for (let L = Math.max(1, (lens[lens.indexOf(hit) - 1] || 0) + 1); L < hit; L++) if (await bad({ ...game, ucis: game.ucis.slice(0, L) })) { hit = L; break; }
  return { ...game, ucis: game.ucis.slice(0, hit) };
}

async function forGames(label, r, run, { start = 0 } = {}) {
  const t0 = Date.now();
  let n = 0;
  while (n < 3 || Date.now() - t0 < budget) { // at least 3 games however slow the machine is: a loaded CPU must not fail the run
    const g = await randomGame(r, { fen: r.chance(0.4) ? r.pick(STARTS) : undefined, maxPlies: 4 + r.int(80), greed: r.pick([0.1, 0.4, 0.8]) });
    if (!g.ucis.length) continue;
    n++; seen.games++; seen.plies += g.ucis.length;
    const bad = async game => { try { return await run(game, n); } catch (e) { return `threw ${e.stack?.split('\n').slice(0, 3).join(' | ') || e}`; } };
    const msg = await bad(g);
    if (msg) {
      const small = await shrink(g, bad);
      throw new Error(`${label}\n${await bad(small)}\nshortest failing game (${small.ucis.length} plies):\n${await toPgn(small)}\n[seed ${seed}, game #${n}]`);
    }
  }
  return n;
}

// 1. every review is internally consistent --------------------------------------------------------------------------------
S.test('every random game reviews into a consistent result (grades, counts, accuracies, texts, lines all sound)', async () => {
  const r = rng(seed);
  const cfgs = [{ noise: 70, glitch: 0 }, { noise: 200, glitch: 0.3 }, { noise: 25, glitch: 0.1 }];
  const n = await forGames('review invariants broken', r, async (game, i) => {
    const eng = await fakeEngine({ seed: seed + i, ...cfgs[i % cfgs.length], kind: 'inv' + uniq++ });
    return invariants(await review(await toPgn(game), eng));
  });
  if (n < 3) throw new Error(`only ${n} games ran in the budget`);
}, meta());

// 2. colour symmetry: the same game with the colours swapped must be graded identically --------------------------------------
S.test('metamorphic: swapping the colours of a game changes no grade, no accuracy, no tag', async () => {
  const r = rng(seed + 1);
  await forGames('colour-swapped game is graded differently', r, async (game, i) => {
    const mirrored = { startFen: mirrorFen(game.startFen), ucis: game.ucis.map(mirrorUci) };
    const cfg = { seed: seed + i, noise: i % 2 ? 150 : 60, glitch: 0.2 };
    const a = await review(await toPgn(game), await fakeEngine({ ...cfg, kind: 'ma' + uniq++ }));
    const b = await review(await toPgn(mirrored), await fakeEngine({ ...cfg, kind: 'mb' + uniq++ }));
    for (let k = 0; k < a.R.items.length; k++) {
      const x = a.R.items[k], y = b.R.items[k];
      if (x.cls !== y.cls) return `ply ${k + 1} (${x.m.san} vs ${y.m.san}): graded "${x.cls}" but its colour-swapped twin "${y.cls}"`;
      if (x.tags.join() !== y.tags.join()) return `ply ${k + 1} (${x.m.san}): tags [${x.tags}] vs mirrored [${y.tags}]`;
      if (!x.text.replace(/White|Black/g, '_').startsWith(y.text.replace(/White|Black/g, '_').slice(0, 12)) && x.cls !== y.cls) return `ply ${k + 1}: texts differ`;
    }
    if (Math.abs(a.R.acc.w - b.R.acc.b) > 1e-9 || Math.abs(a.R.acc.b - b.R.acc.w) > 1e-9) return `accuracy ${a.R.acc.w.toFixed(3)}/${a.R.acc.b.toFixed(3)} vs mirrored ${b.R.acc.b.toFixed(3)}/${b.R.acc.w.toFixed(3)}`;
    return null;
  });
}, meta());

// 2b. the follow-up questions to Stockfish: any game, any engine noise: the review still holds together, and colours stay symmetric
S.test('follow-up questions: reviews with Stockfish\'s extra answers keep every invariant and stay colour-symmetric', async () => {
  const r = rng(seed + 7);
  const { interrogate } = await js('analysis.js');
  let asked = 0;
  await forGames('review with follow-up answers is inconsistent', r, async (game, i) => {
    const mirrored = { startFen: mirrorFen(game.startFen), ucis: game.ucis.map(mirrorUci) };
    const cfg = { seed: seed + i, noise: i % 2 ? 150 : 60, glitch: 0.1 };
    const both = [];
    for (const [gm, tag] of [[game, 'pa'], [mirrored, 'pb']]) {
      const eng = await fakeEngine({ ...cfg, kind: tag + uniq++ }), g = parseGame(await toPgn(gm));
      const pos = await analyseAll([eng], g.fens, 12, () => {});
      const probes = await interrogate([eng], g, pos, 12, () => {}, { book: false });
      asked += probes.filter(Boolean).length;
      both.push({ g, pos, R: buildReview(g, pos, probes, { book: false }) });
    }
    const bad = invariants(both[0]);
    if (bad) return bad;
    const [a, b] = both;
    for (let k = 0; k < a.R.items.length; k++) if (a.R.items[k].cls !== b.R.items[k].cls) return `ply ${k + 1}: graded "${a.R.items[k].cls}" but its colour-swapped twin "${b.R.items[k].cls}" (with follow-up answers)`;
    return null;
  });
  if (!(asked > 0)) throw new Error('the random games never triggered a single follow-up question: the test is not testing anything');
}, meta());

// 3. repeatability: same answer however the work is split between engines, and from cache ------------------------------------
S.test('metamorphic: 1, 2 or 3 engines, or a second run, give exactly the same review', async () => {
  const r = rng(seed + 2);
  await forGames('review depends on how the work was shared out', r, async (game, i) => {
    const pgn = await toPgn(game), cfg = { seed: seed + i, noise: 90, glitch: 0.15 };
    const mk = k => fakeEngine({ ...cfg, kind: 'rp' + k + uniq++ });
    const one = await review(pgn, await mk(1));
    const three = await review(pgn, await mk(3), 12, [await mk(3), await mk(3)]);
    const eng = await mk(5);
    const again = await review(pgn, eng), cached = await review(pgn, eng);
    const sig = x => JSON.stringify({ c: x.R.items.map(it => [it.cls, it.tags, it.text, it.best]), a: x.R.acc, p: x.pos.map(p => [p.win, p.cp, p.mate]) });
    if (sig(one) !== sig(three)) return '1 engine and 3 engines produced different reviews';
    if (sig(one) !== sig(again) || sig(again) !== sig(cached)) return 'the review changed between runs';
    if (eng.calls.length !== new Set(eng.calls).size) return 'a position was sent to the engine twice within one run';
    return null;
  });
}, meta());

// 4. numbers: grading functions behave on the whole input range ---------------------------------------------------------------
S.test('numeric properties: winPct and accuracy are monotone and bounded; every combination classifies; thresholds partition', async () => {
  let prev = -1, prevA = 101;
  for (let cp = -4000; cp <= 4000; cp += 5) {
    const w = winPct(cp);
    if (!(w >= 0 && w <= 100) || w < prev - 1e-12) throw new Error(`winPct(${cp}) = ${w} (previous ${prev}): not monotone or out of range`);
    if (Math.abs(winPct(cp) + winPct(-cp) - 100) > 1e-9) throw new Error(`winPct is not symmetric at ${cp}`);
    prev = w;
  }
  for (let d = 0; d <= 100; d += 0.5) {
    const a = accuracy(d);
    if (!(a >= 0 && a <= 100) || a > prevA + 1e-12) throw new Error(`accuracy(${d}) = ${a}: not decreasing or out of range`);
    prevA = a;
  }
  const vals = [0, 0.3, 0.31, 2, 2.1, 4.9, 5, 9.9, 10, 19.9, 20, 60, 100], pcts = [0, 5, 12, 40, 50, 60, 91, 92, 97, 100];
  let n = 0;
  for (const drop of vals) for (const wb of pcts) for (const wa of pcts) for (const gap of [null, 0, 11.9, 12, 40]) for (const isBest of [true, false]) for (const sac of [true, false]) for (const prev2 of [0, 9.9, 10, 50]) {
    if (isBest && drop !== 0) continue; // analysis.js sets drop = 0 for the engine's own move, so this state cannot occur
    n++;
    const c = classify({ drop, isBest, wb, wa, gap, sac, prev: prev2 });
    if (!META[c]) throw new Error(`classify gave "${c}" for ${JSON.stringify({ drop, wb, wa, gap, isBest, sac, prev: prev2 })}`);
    const special = c === 'brilliant' || c === 'great';
    if (drop >= 20 && c !== 'blunder' && !(c === 'brilliant' && drop <= 2)) throw new Error(`a ${drop}-point drop was graded "${c}"`);
    if (drop >= 5 && drop < 20 && !['inaccuracy', 'mistake', 'miss'].includes(c)) throw new Error(`a ${drop}-point drop was graded "${c}" (expected inaccuracy/mistake/miss)`);
    if (drop < 5 && !special && !['best', 'excellent', 'good'].includes(c)) throw new Error(`a ${drop}-point drop was graded "${c}"`);
    if (special && drop > 2 && c === 'brilliant') throw new Error('brilliant with a drop above 2');
  }
  for (let cp = -3000; cp <= 3000; cp += 7) {
    const f = fmtEval({ cp });
    if (/NaN|undefined|-0\.0/.test(f) || (cp > 4 && !f.startsWith('+')) || (cp < -4 && !f.startsWith('-'))) throw new Error(`fmtEval({cp:${cp}}) = "${f}"`);
  }
  for (const mate of [1, 2, 9, -1, -5]) if (fmtEval({ mate }) !== (mate > 0 ? 'M' : '-M') + Math.abs(mate)) throw new Error(`fmtEval mate ${mate}`);
  if (n < 1000) throw new Error('grid too small');
}, meta({ covers: ['js/review.js', 'js/util.js'] }));

// 5. garbage in: damaged PGNs end in a clean error, never a crash, never a wrong game -------------------------------------------
S.test('damaged PGNs (deleted/inserted/swapped text, junk, huge input): a clean error or a legal game, never a crash or a hang', async () => {
  const r = rng(seed + 3), t0 = Date.now();
  const base = Object.values(GAMES).map(g => g.pgn);
  const JUNK = ['{', '}', '(', ')', '[', ']', '"', '$', '\0', '‮', '1-0', '*', '..', '0-0', 'O-O-O-O', 'e9', 'Zz4', '=Q', '+#', '%', '\t', '\r\n', '😀', ';', '1.', '99.'];
  const mutate = s => {
    const k = 1 + r.int(4);
    for (let i = 0; i < k; i++) {
      const at = r.int(s.length + 1);
      switch (r.int(7)) {
        case 0: s = s.slice(0, at) + s.slice(at + 1 + r.int(8)); break;
        case 1: s = s.slice(0, at) + r.pick(JUNK) + s.slice(at); break;
        case 2: s = s.slice(0, at); break;
        case 3: { const a = r.int(s.length), b = r.int(s.length); s = s.slice(0, a) + s.slice(b, b + 12) + s.slice(a); break; }
        case 4: s = s.slice(0, at) + s.slice(at, at + 20).toUpperCase() + s.slice(at + 20); break;
        case 5: s = s.replace(/ /g, () => (r.chance(0.1) ? r.pick(['  ', '\n', '\t', '']) : ' ')); break;
        default: s = s + ' ' + s.slice(r.int(s.length)); break;
      }
    }
    return s;
  };
  const cases = [...base, '', ' ', '1.', '*', '[', '{{{{{{', '1. e4 {' + 'x'.repeat(60000) + '} e5', '1. e4 ' + '('.repeat(3000) + ')'.repeat(3000) + ' e5 *', '\0\0\0', '1. e4 e5 '.repeat(400)];
  let n = 0, valid = 0, errors = 0;
  while (n < 30 || Date.now() - t0 < budget) {
    const s = n < cases.length ? cases[n] : mutate(r.pick(base));
    n++;
    const t = Date.now();
    let g = null;
    try { g = parseGame(s); } catch (e) {
      if (!/^(Could not read that PGN\.|That game has no moves\.)$/.test(e.message)) throw new Error(`unexpected error "${e.message}" for input ${JSON.stringify(s.slice(0, 200))} [seed ${seed + 3}]`);
      errors++;
    }
    if (Date.now() - t > 2500) throw new Error(`parsing took ${Date.now() - t} ms for ${JSON.stringify(s.slice(0, 120))}…`);
    if (g) {
      valid++;
      if (!g.moves.length || g.fens.length !== g.moves.length + 1) throw new Error('a parsed game has an inconsistent number of positions');
      g.moves.forEach((m, i) => { if (!LEGAL_UCI(g.fens[i]).has(m.from + m.to + (m.promotion || ''))) throw new Error(`parseGame accepted an illegal move ${m.san} in ${g.fens[i]} [seed ${seed + 3}]\n${s.slice(0, 300)}`); });
    }
  }
  if (n < 30) throw new Error(`only ${n} inputs tried`);
  if (!errors || !valid) throw new Error(`fuzz was one-sided: ${valid} valid, ${errors} rejected out of ${n}`);
}, meta({ tags: ['fuzz', 'analysis', 'fetch'], covers: ['js/analysis.js'] }));

// 6. coach: any engine line, including illegal tails and missing parts, must not break the explanation -----------------------
S.test('coach() copes with odd engine lines (illegal tails, 1-move lines, missing lines) for any move of any game', async () => {
  const r = rng(seed + 4);
  const junkPv = ['a1a1', 'zz99', 'e2e4', 'e1e1', 'h7h8q', '0000'];
  await forGames('coach() threw or produced bad text', r, async game => {
    const pgn = await toPgn(game), g = parseGame(pgn);
    for (let i = 0; i < g.moves.length; i++) {
      const m = g.moves[i], before = g.fens[i], after = g.fens[i + 1];
      const mk = fen => {
        const side = fen.split(' ')[1];
        const n = r.int(4);
        const lines = Array.from({ length: n }, () => {
          const legal = O.legalUci(fen);
          const pv = legal.length ? [r.pick(legal)] : [];
          while (r.chance(0.6) && pv.length < 6) pv.push(r.pick(junkPv.concat(legal.length ? [r.pick(legal)] : [])));
          const win = r.int(101), mate = r.chance(0.15) ? (r.chance(0.5) ? 1 : -2) : null;
          return { cp: mate == null ? r.int(2000) - 1000 : null, mate, pv: pv.length ? pv : ['a1a1'], win: mate != null ? (mate > 0 ? 100 : 0) : win };
        });
        const top = lines[0];
        return { fen, turn: side, lines, win: top ? top.win : 50, mate: top?.mate ?? null, cp: top?.cp ?? null, best: top?.pv[0], ...(r.chance(0.05) ? { over: 'draw' } : {}) };
      };
      const b = mk(before), a = mk(after);
      const cls = r.pick(Object.keys(META)), isBest = r.chance(0.2);
      const out = coach({ m, b, a, cls, isBest, tg: [] });
      const all = [...out.why, out.reply, out.better, out.slight].filter(Boolean).join(' ');
      if (BADTEXT.test(all)) return `ply ${i + 1} (${m.san}): bad text "${all}"`;
      for (const l of out.lines) if (l.steps.length !== l.moves.length || l.steps.some(s => typeof s.fen !== 'string')) return `ply ${i + 1}: line "${l.label}" is inconsistent`;
    }
    return null;
  });
}, meta({ covers: ['js/coach.js'] }));

// 7. engine.js against a noisy UCI stream ---------------------------------------------------------------------------------------
S.test('Engine reads Stockfish output correctly through noise: bound lines, currmove, missing pv, junk, interleaved MultiPV', async () => {
  const r = rng(seed + 5);
  const MOVES = ['e2e4', 'd2d4', 'g1f3', 'a7a8q', 'e1g1', 'b8c6', 'h2h1n', 'c3d5', 'f1b5', 'e5d6'];
  class FakeWorker {
    constructor() { this.n = 0; FakeWorker.all.push(this); this.sent = []; this.mpv = 1; }
    out(l) { setTimeout(() => this.onmessage?.({ data: l }), 0); }
    postMessage(cmd) {
      this.sent.push(cmd);
      if (cmd === 'uci') { this.out('id name FakeFish 1'); this.out('option name MultiPV type spin default 1 min 1 max 256'); this.out('option name Hash type spin default 16 min 1 max 1024'); this.out(''); this.out('uciok'); }
      else if (cmd === 'isready') { this.out('info string hello'); this.out('readyok'); }
      else if (cmd.startsWith('setoption name MultiPV value ')) this.mpv = +cmd.split(' ').pop();
      else if (cmd.startsWith('go depth')) {
        const want = [], k = this.mpv, lines = [];
        for (let d = 1; d <= 6; d++) {
          for (let m = 1; m <= k; m++) {
            const mate = r.chance(0.12), v = mate ? r.int(9) - 4 || 1 : r.int(2001) - 1000;
            const pv = Array.from({ length: 1 + r.int(5) }, () => r.pick(MOVES));
            const bound = r.chance(0.15) ? r.pick([' lowerbound', ' upperbound']) : '';
            const noisy = r.chance(0.1);
            const l = `info depth ${d} seldepth ${d + 1} multipv ${m} score ${mate ? 'mate' : 'cp'} ${v}${bound} nodes ${d * 999} nps 1234567 hashfull 12 tbhits 0 time ${d * 7} pv ${pv.join(' ')}`;
            lines.push(noisy ? 'info string some noise ' + r.int(99) : l, r.chance(0.2) ? `info depth ${d} currmove ${r.pick(MOVES)} currmovenumber ${m}` : '', r.chance(0.1) ? `info depth ${d} multipv ${m} nodes 5 pv ${pv[0]}` : '');
            if (!noisy && !bound) want[m - 1] = { [mate ? 'mate' : 'cp']: v, pv };
          }
        }
        this.expected = want.filter(Boolean);
        lines.filter(x => x != null).forEach(l => this.out(l));
        this.out('bestmove e2e4 ponder e7e5');
      }
    }
    terminate() {}
  }
  FakeWorker.all = [];
  globalThis.Worker = FakeWorker;
  const t0 = Date.now();
  let n = 0;
  while (n < 5 || Date.now() - t0 < budget) {
    const eng = await new Engine('fake.js', 'fast').init();
    if (eng.name !== 'FakeFish 1') throw new Error(`engine name "${eng.name}"`);
    const w = FakeWorker.all.at(-1);
    for (const mode of ['analyze', 'explore']) {
      const res = mode === 'analyze' ? await eng.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 8) : await eng.explore('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 8, 3);
      const exp = w.expected;
      if (JSON.stringify(res) !== JSON.stringify(exp)) throw new Error(`${mode}: got ${JSON.stringify(res)}\nexpected ${JSON.stringify(exp)}\n[seed ${seed + 5}]`);
      if (mode === 'explore' && res.length > 3) throw new Error('explore returned more than 3 lines');
    }
    if (w.mpv !== 2) throw new Error(`MultiPV was left at ${w.mpv} after "Ask Stockfish" (should be back to 2)`);
    eng.terminate();
    n++;
  }
  delete globalThis.Worker;
  if (n < 5) throw new Error(`only ${n} rounds ran`);
}, meta({ tags: ['engine', 'fuzz'], covers: ['js/engine.js'] }));

// With a tiny budget (mutation runs, --fast) too few games run for this to mean anything, so it only applies to full runs.
if (budget < 1500) S.skipped('fuzz is not vacuous: it reached most grades, mates and many plies', `budget ${budget} ms is too small to judge coverage`);
else S.test('fuzz is not vacuous: it reached most grades, mates and many plies', async () => {
  const kinds = Object.keys(seen.cls).length;
  if (seen.games < 6 || seen.plies < 100) throw new Error(`only ${seen.games} games / ${seen.plies} plies were reviewed; raise --budget-ms`);
  if (kinds < 5) throw new Error(`only ${kinds} of ${Object.keys(META).length} grades appeared (${JSON.stringify(seen.cls)}): the fake engine or generator is too narrow`);
  if (!seen.mates) { // random play did not happen to mate this run: cover mate with a fixed game so the run is never vacuous by luck
    const m = invariants(await review('1. f3 e5 2. g4 Qh4#', await fakeEngine({ seed: 7, noise: 70, glitch: 0, kind: 'mate' + uniq++ })));
    if (m) throw new Error('fool\'s mate game: ' + m);
    if (!seen.mates) throw new Error('mate coverage failed: the fixed mate game was not recognised as a mate');
  }
  console.log(`   fuzz coverage: ${seen.games} games, ${seen.plies} plies; grades ${JSON.stringify(seen.cls)}; tags ${JSON.stringify(seen.tags)}`);
}, meta({ tags: ['fuzz'] }));

S.opts.list || console.log(`(random seed ${seed}; replay with: node kit.mjs fuzz --seed ${seed})`);
await S.run();
S.finish();
