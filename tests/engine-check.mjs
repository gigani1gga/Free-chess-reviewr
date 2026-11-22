// Stockfish compatibility check: does THIS Stockfish behave the way the app needs, and what exactly did it print when not?
//   node engine-check.mjs                         (finds Stockfish by itself; falls back to the built-in mock)
//   node engine-check.mjs --bin /usr/games/stockfish
//   node engine-check.mjs --js node_modules/stockfish/src/stockfish-19-lite-single.js
//   node engine-check.mjs --site _site --kind best   (the engine files of a built site)
//   node engine-check.mjs --depth 16 --html build/engine-report.html
// Exit code 1 if any check FAILS. WARN means "works, but look at it". Writes build/engine-report.json (+ .html).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UciProc, anomalies, buildDir, cli, kitRoot, readInfo, resolveSpec } from './lib/uci.mjs';
import * as P from './lib/positions.mjs';
import { installWorker } from './lib/worker-shim.mjs';

const v = cli();
const DEPTH = +(v.depth || 12);
const STARTUP_MS = +(v['startup-ms'] || 240000); // the app waits this long for the first load
const SEARCH_MS = +(v['search-ms'] || 120000);   // and this long for one search
const spec = resolveSpec(v);
const quiet = !!v.quiet;
const QUICK = !!v.quick; // lighter positions and no speed test: for self-tests and fast looks
const HEAVY = QUICK ? P.START : P.KIWIPETE;
fs.mkdirSync(buildDir, { recursive: true });

// The chess library used to judge move legality: your real chess.js if CHESS_JS points at it, else the kit's stand-in.
async function loadChess() {
  if (process.env.CHESS_JS) return { Chess: (await import(pathToFileURL(path.resolve(process.env.CHESS_JS)).href)).Chess, label: 'chess.js at ' + process.env.CHESS_JS };
  const file = path.join(buildDir, 'chess-module.mjs');
  fs.writeFileSync(file, fs.readFileSync(path.join(kitRoot, 'src/chess-core.js'), 'utf8') + '\nexport { Chess, ChessCore };\n');
  return { Chess: (await import(pathToFileURL(file).href + '?' + Date.now())).Chess, label: 'the kit\'s chess.js stand-in' };
}
const { Chess, label: chessLabel } = await loadChess();

const results = [];
const failed = new Set();
const say = s => { if (!quiet) console.log(s); };
const ok = (c, msg) => { if (!c) throw new Error(msg); };
async function check(id, name, fn, { needs = [], warn = false } = {}) {
  const t0 = Date.now();
  const bad = needs.find(n => failed.has(n));
  let status = 'PASS', detail = '';
  if (bad) { status = 'SKIP'; detail = `skipped: "${bad}" did not pass`; failed.add(id); } // a skipped check blocks the ones that need it too
  else {
    try {
      const r = await fn();
      if (r && typeof r === 'object' && r.warn) { status = 'WARN'; detail = r.warn; } else if (typeof r === 'string') detail = r;
    } catch (e) { status = warn ? 'WARN' : 'FAIL'; detail = e.message; }
  }
  if (status === 'FAIL') failed.add(id);
  results.push({ id, name, status, detail, ms: Date.now() - t0 });
  say(`${status.padEnd(5)} ${name}${detail ? '\n        ' + detail : ''}  (${Date.now() - t0} ms)`);
}

const eng = new UciProc(spec);
let engineName = '?', options = new Map();
const send = c => eng.send(c);
const isReady = async (ms = 30000) => { const m = eng.mark(); send('isready'); await eng.waitFor(l => l === 'readyok', ms, '"readyok"', m); };
const setopt = (n, val) => options.has(n) && send(`setoption name ${n} value ${val}`);

// One search; resolves with what the app would read from it.
async function search(fen, { depth = DEPTH, mpv, ms = SEARCH_MS } = {}) {
  if (mpv) setopt('MultiPV', mpv);
  const t0 = Date.now(), m = eng.mark();
  send('position fen ' + fen);
  send('go depth ' + depth);
  const done = await eng.waitFor(l => l.startsWith('bestmove'), ms, `"bestmove" after "go depth ${depth}"`, m);
  const info = readInfo(eng.lines.slice(m, done.index));
  return { ...info, best: done.line.split(/\s+/)[1], bestLine: done.line, ms: Date.now() - t0 };
}
const firstIllegal = (fen, pv) => {
  const c = new Chess(fen);
  for (let i = 0; i < pv.length; i++) {
    let m = null;
    try { m = c.move({ from: pv[i].slice(0, 2), to: pv[i].slice(2, 4), promotion: pv[i][4] }); } catch { /* illegal */ }
    if (!m) return i;
  }
  return -1;
};
const score = l => (l.mate != null ? Math.sign(l.mate) * (100000 - Math.abs(l.mate)) : l.cp);
const winning = l => l && ((l.mate != null && l.mate > 0) || (l.cp != null && l.cp > 300));

say(`Engine: ${spec.label}`);
say(`Depth ${DEPTH}; chess rules from ${chessLabel}\n`);

// ---- 1. start-up -------------------------------------------------------------------------------------------------------
await check('uci-handshake', 'starts and answers "uci" with uciok', async () => {
  const m = eng.mark();
  send('uci');
  const r = await eng.waitFor(l => l === 'uciok', STARTUP_MS, '"uciok"', m);
  for (const l of eng.lines.slice(m, r.index)) {
    if (l.startsWith('id name ')) engineName = l.slice(8).trim();
    const o = /^option name (.+?) type (\w+)(.*)$/.exec(l);
    if (o) options.set(o[1], { type: o[2], rest: o[3].trim() });
  }
  ok(engineName !== '?', 'no "id name" line before uciok');
  return `${engineName}; ${options.size} options`;
});
const fatal = ['uci-handshake'];
await check('options', 'has the options the app uses (MultiPV, Hash)', async () => {
  ok(options.has('MultiPV'), 'no MultiPV option: the app could only show one line per position (no "better line" comparisons)');
  const notes = [];
  if (!options.has('Hash')) notes.push('no Hash option (the app\'s memory setting would be ignored)');
  const known = ['Threads', 'UCI_AnalyseMode', 'Contempt', 'Analysis Contempt'].filter(o => options.has(o));
  return notes.length ? { warn: notes.join('; ') } : `also present: ${known.join(', ') || 'none of Threads / UCI_AnalyseMode / Contempt'}`;
}, { needs: fatal });
await check('readyok', 'answers "isready" with readyok', () => isReady(STARTUP_MS), { needs: fatal });
fatal.push('readyok');
await check('setoption', 'accepts the options the app sets, with no error output', async () => {
  const before = eng.log.length;
  setopt('MultiPV', 2); setopt('Hash', 16); setopt('Contempt', 0); setopt('Analysis Contempt', 'Off'); setopt('UCI_AnalyseMode', 'true');
  await isReady();
  const bad = anomalies(eng.log.slice(before));
  ok(!bad.length, 'engine complained: ' + bad.map(b => b.text).join(' | '));
}, { needs: fatal });

// ---- 2. searching ------------------------------------------------------------------------------------------------------
let start;
await check('search-start', `searches the start position to depth ${DEPTH}`, async () => {
  start = await search(P.START, { mpv: 2 });
  ok(start.lines.length >= 1, 'bestmove arrived but no usable "info ... score ... pv" line was printed: ' + start.bestLine);
  const r = start.depth < DEPTH ? { warn: `only reached depth ${start.depth} of ${DEPTH}` } : null;
  return r || `bestmove ${start.best}, depth ${start.depth}, ${start.ms} ms${start.nps ? `, ${Math.round(start.nps / 1000)}k nps` : ''}`;
}, { needs: fatal });
const S = ['search-start'];
await check('bestmove-matches-pv', 'bestmove is the first move of line 1 and is a legal move', async () => {
  ok(firstIllegal(P.START, [start.best]) === -1, `bestmove "${start.best}" is not legal in the start position`);
  ok(start.lines[0].pv[0] === start.best, `bestmove ${start.best} differs from the first move of line 1 (${start.lines[0].pv[0]})`);
}, { needs: S });
await check('multipv-2', 'MultiPV 2 gives two ordered lines (what "better line" relies on)', async () => {
  ok(start.lines.length === 2, `expected 2 lines, got ${start.lines.length}`);
  ok(score(start.lines[0]) >= score(start.lines[1]), `line 1 (${JSON.stringify({ cp: start.lines[0].cp, mate: start.lines[0].mate })}) scores below line 2`);
  ok(start.lines[0].pv[0] !== start.lines[1].pv[0], 'both lines start with the same move');
}, { needs: S });
await check('pv-legal', 'every line of every position replays as legal moves (castling, en passant, promotion, pins)', async () => {
  let n = 0;
  for (const fen of QUICK ? [P.START, P.PV_POSITIONS[2], P.PV_POSITIONS[5]] : P.PV_POSITIONS) {
    const r = await search(fen, { mpv: 2, depth: Math.min(DEPTH, 10) });
    for (const l of r.lines) {
      const i = firstIllegal(fen, l.pv);
      ok(i === -1, `illegal move "${l.pv[i]}" (#${i + 1} of the line "${l.pv.slice(0, i + 1).join(' ')}") in ${fen}`);
      n += l.pv.length;
    }
  }
  return `${n} moves replayed`;
}, { needs: S });
await check('mate-score', 'reports a forced mate as "score mate N" with the right move', async () => {
  for (const t of P.TACTICS.filter(x => x.mate)) {
    const r = await search(t.fen, { mpv: 1 });
    ok(r.lines[0]?.mate === t.mate, `${t.name}: expected mate ${t.mate}, got ${JSON.stringify(r.lines[0])}`);
    ok(r.best === t.best[0], `${t.name}: expected ${t.best[0]}, played ${r.best}`);
  }
}, { needs: S });
await check('mated-score', 'reports "being mated" as a NEGATIVE mate score (side to move\'s view)', async () => {
  const r = await search(P.MATED_IN_1.fen, { mpv: 1 });
  ok(r.lines[0]?.mate != null && r.lines[0].mate < 0, `${P.MATED_IN_1.name}: got ${JSON.stringify(r.lines[0])}`);
}, { needs: S });
await check('stm-pov', 'scores are from the side to move\'s view (the app flips them for Black)', async () => {
  const w = await search(P.WHITE_UP_QUEEN, { mpv: 1 }), b = await search(P.BLACK_UP_QUEEN, { mpv: 1 });
  ok(winning(w.lines[0]), `White to move, up a queen: got ${JSON.stringify(w.lines[0])}`);
  ok(winning(b.lines[0]), `Black to move, up a queen: got ${JSON.stringify(b.lines[0])}. If this is negative the engine reports scores from White\'s side, and every Black move in the app would be graded backwards`);
}, { needs: S });
await check('tactics', 'finds simple tactics (free queen, back-rank mate)', async () => {
  const miss = [];
  for (const t of P.TACTICS) { const r = await search(t.fen, { mpv: 1 }); if (!t.best.includes(r.best)) miss.push(`${t.name}: played ${r.best}`); }
  ok(!miss.length, miss.join('; '));
}, { needs: S });
await check('promotion', 'writes promotions as 5-character UCI moves (a7a8q)', async () => {
  const r = await search(P.PROMOTION, { mpv: 1 });
  ok(/^a7a8[qrbn]$/.test(r.best), `bestmove "${r.best}"`);
  ok(firstIllegal(P.PROMOTION, r.lines[0].pv) === -1, 'its line is not legal');
}, { needs: S });
await check('finished-games', 'checkmate / stalemate positions answer instead of hanging', async () => {
  const out = [];
  for (const [n, fen] of [['checkmate', P.CHECKMATED], ['stalemate', P.STALEMATED]]) {
    const m = eng.mark(); send('position fen ' + fen); send('go depth 5');
    const r = await eng.waitFor(l => l.startsWith('bestmove'), 15000, `"bestmove" in a ${n} position`, m);
    out.push(`${n}: ${r.line}`);
  }
  return out.join('; ') + ' (the app never searches these, it grades them itself)';
}, { needs: S });
await check('stop', '"go infinite" then "stop" ends with a bestmove', async () => {
  const m = eng.mark(); send('position fen ' + HEAVY); send('go infinite');
  await new Promise(r => setTimeout(r, 400)); send('stop');
  await eng.waitFor(l => l.startsWith('bestmove'), 10000, '"bestmove" after "stop"', m);
}, { needs: S });
await check('multipv-3-and-back', 'MultiPV 3 for "Ask Stockfish", then back to 2 with no stale third line', async () => {
  const three = await search(HEAVY, { mpv: 3, depth: Math.min(DEPTH, 10) });
  ok(three.lines.length === 3, `MultiPV 3 gave ${three.lines.length} lines`);
  const m = eng.mark(), two = await search(HEAVY, { mpv: 2, depth: Math.min(DEPTH, 10) });
  ok(two.lines.length === 2, `after setting MultiPV 2 again: ${two.lines.length} lines`);
  ok(!eng.lines.slice(m).some(l => / multipv 3 /.test(l)), 'still printing "multipv 3" after the option went back to 2');
}, { needs: S });
await check('speed', 'search speed is reasonable for a phone-sized job', async () => {
  if (QUICK) return { warn: 'skipped in --quick mode' };
  const r = await search(P.KIWIPETE, { mpv: 2, depth: DEPTH });
  const note = `depth ${r.depth} in ${r.ms} ms${r.nps ? ` (${Math.round(r.nps / 1000)}k nps)` : ''}`;
  return r.ms > SEARCH_MS * 0.5 ? { warn: `${note}: over half of the app's ${SEARCH_MS / 1000}s limit for one position` } : note;
}, { needs: S, warn: true });
await check('engine-errors', 'the engine printed no errors or warnings during all of this', async () => {
  const bad = anomalies(eng.log);
  ok(!bad.length, bad.length && `${bad.length} problem line(s), e.g. "${bad[0].text}" at ${bad[0].t} ms`);
}, { needs: ['uci-handshake'] });

// ---- 3. the app's own engine code and review pipeline, driven by this engine -----------------------------------------------
const siteDir = path.resolve(v.site || path.join(buildDir, 'site'));
if (!v['no-app'] && fs.existsSync(path.join(siteDir, 'js/engine.js')) && !failed.size) {
  const shim = installWorker(spec);
  const imp = f => import(pathToFileURL(path.join(siteDir, 'js', f)).href + '?' + Date.now());
  const { Engine } = await imp('engine.js'), { parseGame, analyseAll, buildReview } = await imp('analysis.js');
  const app = new Engine('engine.js', 'fast');
  await check('app-engine', 'the app\'s own Engine class starts it and reads its lines', async () => {
    await app.init();
    const r = await app.analyze(P.TACTICS[0].fen, Math.min(DEPTH, 10));
    ok(r.length >= 1 && r[0].mate === 1 && r[0].pv[0] === 'h5f7', 'Engine.analyze gave ' + JSON.stringify(r[0]));
    return `${app.name}; id "${app.id}"`;
  });
  await check('app-explore', '"Ask Stockfish" search (3 lines) works and the engine goes back to 2 lines', async () => {
    const three = await app.explore(HEAVY, Math.min(DEPTH, 10), 3);
    ok(three.length === 3, `explore gave ${three.length} lines`);
    const two = await app.analyze(HEAVY, Math.min(DEPTH, 10));
    ok(two.length === 2, `analyze after explore gave ${two.length} lines`);
  }, { needs: ['app-engine'] });
  await check('app-review', 'a whole game is reviewed: blunder found, mate recognised, explanations and lines are sound', async () => {
    const g = parseGame(P.SCHOLAR_PGN);
    const pos = await analyseAll([app], g.fens, Math.min(DEPTH, 10), () => {});
    const R = buildReview(g, pos), it = R.items;
    ok(it.length === 7, `${it.length} moves reviewed, expected 7`);
    ok(['blunder', 'mistake'].includes(it[5].cls), `3...Nf6 (allows mate in 1) was graded "${it[5].cls}"`);
    ok(!['blunder', 'mistake', 'miss', 'inaccuracy'].includes(it[6].cls), `the mating move 4.Qxf7# was graded "${it[6].cls}"`);
    ok(/mate/i.test(it[5].text), 'the blunder\'s explanation never mentions the mate: ' + it[5].text);
    for (const x of it) {
      ok(typeof x.text === 'string' && x.text.length > 10, 'empty explanation for ' + x.m.san);
      for (const l of x.lines || []) ok(l.steps.every(s => typeof s.fen === 'string') && l.moves.length === l.steps.length, 'broken line for ' + x.m.san);
    }
    return `3...Nf6: ${it[5].cls}; "${it[5].text.slice(0, 90)}…"`;
  }, { needs: ['app-engine'] });
  app.terminate();
  shim.procs.forEach(p => { eng.log.push(...p.log.map(e => ({ ...e, text: '[app] ' + e.text }))); if (p.stderr.length) eng.stderr.push(...p.stderr); });
  shim.procs.forEach(p => p.kill());
  const extra = anomalies(shim.procs.flatMap(p => p.log));
  await check('app-engine-errors', 'the engine printed no errors while the app drove it', async () => { ok(!extra.length, extra.length && `${extra.length} problem line(s), e.g. "${extra[0].text}"`); });
} else if (!v['no-app']) {
  say('\n(app-level checks skipped: ' + (failed.size ? 'engine checks failed first' : `no built site at ${siteDir}; run build-site.mjs or pass --site`) + ')');
}

send('quit'); setTimeout(() => eng.kill(), 300);

// ---- 4. report ---------------------------------------------------------------------------------------------------------
const count = s => results.filter(r => r.status === s).length;
const problems = anomalies(eng.log);
const report = {
  when: new Date().toISOString(), engine: engineName, how: spec.label, depth: DEPTH, chess: chessLabel,
  options: Object.fromEntries(options), summary: { pass: count('PASS'), warn: count('WARN'), fail: count('FAIL'), skip: count('SKIP') },
  checks: results, engineErrors: problems,
  transcript: eng.log.length > 2500 ? [...eng.log.slice(0, 300), { t: 0, dir: '!', text: `… ${eng.log.length - 2500} lines left out …` }, ...eng.log.slice(-2200)] : eng.log,
};
const jsonPath = path.resolve(v.json || path.join(buildDir, 'engine-report.json'));
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 1));
const htmlPath = path.resolve(v.html || jsonPath.replace(/\.json$/, '.html'));
fs.writeFileSync(htmlPath, renderHtml(report));

const s = report.summary;
say(`\n${s.pass} passed, ${s.warn} warnings, ${s.fail} failed, ${s.skip} skipped  (${engineName})`);
if (problems.length) {
  say('\nWhat the engine printed that looks wrong:');
  problems.slice(0, 12).forEach(p => say(`  ${String(p.t).padStart(6)} ms  ${p.text}`));
}
if (s.fail) {
  const first = results.find(r => r.status === 'FAIL');
  say(`\nFirst failure: ${first.name}\n  ${first.detail}\nLast things said between the app and the engine:`);
  eng.log.slice(-14).forEach(e => say(`  ${e.dir} ${String(e.text).slice(0, 150)}`));
}
say(`\nFull report: ${htmlPath}`);

function renderHtml(r) {
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const col = { PASS: '#2e7d32', WARN: '#b26a00', FAIL: '#c62828', SKIP: '#777' };
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stockfish check</title>
<style>body{font:15px system-ui;margin:16px;max-width:900px}h1{font-size:1.3rem}.c{border-left:6px solid;padding:6px 10px;margin:6px 0;background:#8881}.d{color:#666;font-size:.9rem;overflow-wrap:anywhere}
pre{background:#0002;padding:8px;overflow:auto;font-size:.8rem;max-height:420px}code{background:#8882;padding:0 4px}</style>
<h1>Stockfish check: ${esc(r.engine)}</h1>
<p>${esc(r.how)} · depth ${r.depth} · ${esc(r.when)}<br><b>${r.summary.pass}</b> passed, <b>${r.summary.warn}</b> warnings, <b>${r.summary.fail}</b> failed, ${r.summary.skip} skipped</p>
${r.checks.map(c => `<div class="c" style="border-color:${col[c.status]}"><b style="color:${col[c.status]}">${c.status}</b> ${esc(c.name)} <span class="d">(${c.ms} ms)</span>${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}</div>`).join('')}
<h2>What the engine printed that looks wrong</h2>${r.engineErrors.length ? `<pre>${r.engineErrors.map(e => `${e.t} ms  ${esc(e.text)}`).join('\n')}</pre>` : '<p>Nothing.</p>'}
<h2>Options the engine offers</h2><pre>${esc(Object.entries(r.options).map(([k, o]) => `${k}  (${o.type}) ${o.rest}`).join('\n'))}</pre>
<h2>Full transcript</h2><details><summary>${r.transcript.length} lines (&gt; sent, &lt; received, ! problem)</summary><pre>${esc(r.transcript.map(e => `${String(e.t).padStart(6)} ${e.dir} ${e.text.slice(0, 220)}`).join('\n'))}</pre></details>`;
}
process.exit(report.summary.fail ? 1 : 0);
