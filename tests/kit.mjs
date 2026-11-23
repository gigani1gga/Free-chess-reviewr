#!/usr/bin/env node
// The one entry point for humans and AI agents.   node kit.mjs help
// Exit codes: 0 everything passed · 1 test failures · 2 environment problem (no project, no browser...) · 3 usage error
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildDir, findChrome, findPlaywright, kitRoot, projectRoot } from './lib/env.mjs';
import { affectedTests } from './lib/impact.mjs';

const SCHEMA = 1;
const RES = path.join(buildDir, 'results');
const REPORT = path.join(buildDir, 'report.json'), REPORT_MD = path.join(buildDir, 'report.md'), INDEX = path.join(buildDir, 'index.json'), GREEN = path.join(buildDir, 'last-green.json');
// stage 1 suites are independent and cheap: they run side by side. Stage 2 (browser) runs alone so timings are honest.
const SUITES = {
  static: { stage: 1, needsProject: true, what: 'syntax, imports, DOM ids, CSS classes, kit data' },
  perft: { stage: 1, what: 'move generator vs published perft counts' },
  chess: { stage: 1, what: 'chess.js stand-in vs independent oracle (differential fuzz, SAN, PGN)' },
  kit: { stage: 1, what: 'the kit checks itself (mock engine, book, generators)' },
  unit: { stage: 1, needsProject: true, what: 'review.js / coach.js / analysis.js logic, boundaries' },
  fuzz: { stage: 1, needsProject: true, what: 'property + metamorphic fuzzing with shrinking' },
  snapshot: { stage: 1, needsProject: true, what: 'golden-master reviews (24 games)' },
  workflow: { stage: 1, needsProject: true, py: 'workflow-test.py', what: 'deploy.yml run in a sandbox' },
  e2e: { stage: 2, needsProject: true, browser: true, what: 'real Chrome against the built site with a mock Stockfish' },
};
const ALL = Object.keys(SUITES);

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
const { values: F, positionals: P } = parseArgs({
  args: cmd === argv[0] ? argv.slice(1) : argv, strict: false, allowPositionals: true,
  options: {
    json: { type: 'boolean' }, human: { type: 'boolean' }, only: { type: 'string' }, tag: { type: 'string' }, seed: { type: 'string' }, fast: { type: 'boolean' },
    workers: { type: 'string' }, retries: { type: 'string' }, 'budget-ms': { type: 'string' }, bail: { type: 'boolean' }, strict: { type: 'boolean' },
    changed: { type: 'string' }, all: { type: 'boolean' }, update: { type: 'boolean' }, deep: { type: 'boolean' }, max: { type: 'string' }, files: { type: 'string' },
    suite: { type: 'string' }, port: { type: 'string' }, 'no-build': { type: 'boolean' }, 'no-open': { type: 'boolean' }, quiet: { type: 'boolean' },
  },
});
const agent = F.json || (!F.human && !process.stdout.isTTY);
const say = (...a) => console.log(...a);
const die = (code, msg) => { console.error(msg); process.exit(code); };
const root = projectRoot();
const rel = p => path.relative(process.cwd(), p) || '.';
fs.mkdirSync(RES, { recursive: true });

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const needProject = () => { if (!root) die(2, 'ENV: no project found. Set PROJECT_ROOT=/path/to/game-review (the folder with index.html and js/), or put the kit inside it.'); };

// ---------- running suites ----------
function passArgs(suite) {
  const a = [];
  for (const k of ['only', 'tag', 'seed', 'workers', 'retries', 'budget-ms']) if (F[k]) a.push(`--${k}`, F[k]);
  for (const k of ['fast', 'bail', 'strict']) if (F[k]) a.push(`--${k}`);
  if (F.update && suite === 'snapshot') a.push('--update');
  return a;
}
function runSuite(name, extra = [], env = {}) {
  const s = SUITES[name];
  const out = path.join(RES, `${name}.json`);
  try { fs.rmSync(out, { force: true }); } catch { /* */ }
  const args = s.py ? [path.join(kitRoot, s.py)] : [path.join(kitRoot, 'suites', `${name}.mjs`), ...passArgs(name), ...extra];
  const t0 = Date.now();
  return new Promise(resolve => {
    const p = spawn(s.py ? 'python3' : process.execPath, args, { cwd: kitRoot, env: { ...process.env, ...(root ? { PROJECT_ROOT: root } : {}), KIT_RESULT: out, KIT_QUIET: '1', ...env } });
    let text = '';
    p.stdout.on('data', d => { text += d; });
    p.stderr.on('data', d => { text += d; });
    p.on('error', e => resolve({ name, doc: null, text: String(e), code: 127, ms: Date.now() - t0 }));
    p.on('close', code => {
      let doc = readJson(out);
      if (!doc && s.py) doc = parsePy(name, text, Date.now() - t0);
      resolve({ name, doc, text, code, ms: Date.now() - t0 });
    });
  });
}
// workflow-test.py prints "PASS  name" / "FAIL  name\n      detail"
function parsePy(name, text, ms) {
  const results = [], lines = text.split('\n');
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
  lines.forEach((l, i) => {
    const m = /^(PASS|FAIL)\s+(.*)$/.exec(l); if (!m) return;
    const detail = m[1] === 'FAIL' ? (lines[i + 1] || '').trim() : '';
    results.push({ id: `${name}/${slug(m[2])}`, suite: name, name: m[2], status: m[1] === 'PASS' ? 'pass' : 'fail', ms: 0, attempts: 1, tags: ['workflow'], covers: ['.github/workflows/deploy.yml'], detail });
  });
  if (!results.length) results.push({ id: `${name}/runs`, suite: name, name: 'workflow test runs', status: 'fail', ms: 0, attempts: 1, tags: ['workflow'], covers: [], detail: text.slice(-600) });
  const c = s => results.filter(r => r.status === s).length;
  return { suite: name, ms, summary: { pass: c('pass'), fail: c('fail'), flaky: 0, skip: 0, xfail: 0, xpass: 0, warn: 0, total: results.length }, results };
}
function buildSiteNow() {
  if (F['no-build']) return true;
  const r = spawnSync(process.execPath, [path.join(kitRoot, 'build-site.mjs')], { cwd: kitRoot, env: { ...process.env, PROJECT_ROOT: root, KIT_QUIET: '1' }, encoding: 'utf8' });
  if (r.status !== 0) { console.error('build-site failed:\n' + (r.stdout + r.stderr).slice(-800)); return false; }
  return true;
}

const summaryLine = s => [`${s.pass} ok`, s.fail && `${s.fail} FAIL`, s.xpass && `${s.xpass} XPASS`, s.flaky && `${s.flaky} flaky`, s.warn && `${s.warn} warn`, s.xfail && `${s.xfail} known`, s.skip && `${s.skip} skip`].filter(Boolean).join(', ');

// ---------- report ----------
function rerunCmd(r) { return `node kit.mjs run ${r.suite} --only '^${esc(r.id)}$'${F.seed ? ` --seed ${F.seed}` : ''}`; }
function buildReport(runs, ms, extra = {}) {
  const results = runs.flatMap(r => r.doc ? r.doc.results : [{ id: `${r.name}/crashed`, suite: r.name, name: `${r.name} suite crashed`, status: 'fail', ms: 0, attempts: 1, tags: [], covers: [], detail: r.text.slice(-800) }]);
  const sum = { pass: 0, fail: 0, flaky: 0, skip: 0, xfail: 0, xpass: 0, warn: 0, total: results.length };
  for (const r of results) sum[r.status] = (sum[r.status] || 0) + 1;
  const bad = results.filter(r => r.status === 'fail' || r.status === 'xpass' || (F.strict && r.status === 'flaky'));
  const rep = {
    schema: SCHEMA, command: `kit.mjs ${cmd}`, at: new Date().toISOString(), ms, project: root, ok: bad.length === 0 && !extra.envError, seed: F.seed ? +F.seed : null, ...extra,
    summary: sum,
    suites: Object.fromEntries(runs.map(r => [r.name, { ms: r.ms, code: r.code, ...(r.doc?.summary || { crashed: true }) }])),
    failures: bad.map(r => ({ id: r.id, suite: r.suite, name: r.name, status: r.status, detail: r.detail, hint: r.hint, covers: r.covers, artifacts: r.artifacts, rerun: rerunCmd(r), explain: `node kit.mjs explain ${r.id}` })),
    flaky: results.filter(r => r.status === 'flaky').map(r => ({ id: r.id, name: r.name, attempts: r.attempts, detail: r.detail })),
    warnings: results.filter(r => r.status === 'warn').map(r => ({ id: r.id, name: r.name, detail: r.detail })),
    knownBugs: results.filter(r => r.status === 'xfail').map(r => ({ id: r.id, name: r.name, xfail: r.xfail })),
    slowest: [...results].sort((a, b) => b.ms - a.ms).slice(0, 5).map(r => ({ id: r.id, ms: r.ms })),
  };
  return { rep, results };
}
function markdown(rep) {
  const L = [`# Test report — ${rep.ok ? 'PASS' : 'FAIL'}`, '', `${summaryLine(rep.summary)} of ${rep.summary.total} checks in ${(rep.ms / 1000).toFixed(1)} s${rep.seed != null ? ` (seed ${rep.seed})` : ''}`, ''];
  L.push('| suite | result | time |', '|---|---|---|');
  for (const [k, v] of Object.entries(rep.suites)) L.push(`| ${k} | ${v.crashed ? 'CRASHED' : summaryLine(v)} | ${(v.ms / 1000).toFixed(1)} s |`);
  if (rep.failures.length) {
    L.push('', '## Failures');
    for (const f of rep.failures) {
      L.push('', `### ${f.id}${f.status === 'xpass' ? ' (known bug now passes)' : ''}`, f.name, '```', String(f.detail || '').slice(0, 800), '```');
      if (f.hint) L.push(`Hint: ${f.hint}`);
      if (f.covers?.length) L.push(`Files: ${f.covers.join(', ')}`);
      if (f.artifacts) L.push(`Artifacts: ${Object.values(f.artifacts).join(', ')}`);
      L.push(`Rerun: \`${f.rerun}\``);
    }
  }
  if (rep.flaky.length) L.push('', '## Flaky (passed only on retry — investigate)', ...rep.flaky.map(f => `- ${f.id} (${f.attempts} attempts): ${String(f.detail).split('\n')[0]}`));
  if (rep.warnings.length) L.push('', '## Warnings', ...rep.warnings.slice(0, 15).map(w => `- ${w.name}: ${String(w.detail).split('\n')[0]}`));
  if (rep.knownBugs.length) L.push('', '## Known bugs (xfail)', ...rep.knownBugs.map(k => `- ${k.id}: ${k.xfail}`));
  return L.join('\n') + '\n';
}
function emit(rep, results) {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({ ...rep, results: results.map(r => ({ id: r.id, status: r.status, ms: r.ms })) }, null, 1));
  fs.writeFileSync(REPORT_MD, markdown(rep));
  if (agent) {
    say(JSON.stringify({ ok: rep.ok, summary: rep.summary, ms: rep.ms, suites: rep.suites, failures: rep.failures.map(f => ({ id: f.id, name: f.name, detail: String(f.detail || '').split('\n').slice(0, 4).join(' | '), hint: f.hint, files: f.covers, rerun: f.rerun })), flaky: rep.flaky.map(f => f.id), report: rel(REPORT), markdown: rel(REPORT_MD) }));
  } else {
    say('');
    for (const f of rep.failures) say(`FAIL ${f.id}\n     ${String(f.detail || '').split('\n').slice(0, 3).join('\n     ')}${f.hint ? '\n     hint: ' + f.hint : ''}\n     rerun: ${f.rerun}`);
    for (const f of rep.flaky) say(`FLAKY ${f.id}`);
    say(`\n${rep.ok ? 'PASS' : 'FAIL'}  ${summaryLine(rep.summary)} in ${(rep.ms / 1000).toFixed(1)} s   report: ${rel(REPORT_MD)}`);
  }
}

// ---------- project hashing (for `verify`) ----------
function projectFiles() {
  const out = {};
  const walk = (d, base) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (['node_modules', '_site', 'site', 'tests', 'game-review-test-kit', 'build'].includes(e.name)) continue;
      const p = path.join(d, e.name), r = path.posix.join(base, e.name);
      if (e.isDirectory()) walk(p, r); else if (/\.(js|mjs|html|css|yml|yaml|json|svg)$/.test(e.name)) out[r] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root, '');
  return out;
}
const changedSince = base => Object.keys({ ...base, ...projectFiles() }).filter(f => base[f] !== projectFiles()[f]);

async function getIndex(refresh) {
  const cached = readJson(INDEX);
  if (cached && !refresh && cached.schema === SCHEMA) return cached;
  const tests = [];
  await Promise.all(ALL.filter(n => !SUITES[n].py && (root || !SUITES[n].needsProject)).map(async n => {
    const out = path.join(RES, `list-${n}.json`);
    await new Promise(res => { const p = spawn(process.execPath, [path.join(kitRoot, 'suites', `${n}.mjs`), '--list'], { cwd: kitRoot, env: { ...process.env, ...(root ? { PROJECT_ROOT: root } : {}), KIT_RESULT: out, KIT_BUDGET_MS: '50' }, stdio: 'ignore' }); p.on('close', res); p.on('error', res); });
    const d = readJson(out); if (d) for (const t of (d.list || d.results || [])) tests.push({ id: t.id, name: t.name, tags: t.tags, covers: t.covers, slow: t.slow, xfail: t.xfail, suite: n });
  }));
  const idx = { schema: SCHEMA, at: new Date().toISOString(), tests };
  fs.writeFileSync(INDEX, JSON.stringify(idx));
  return idx;
}

// ---------- commands ----------
const COMMANDS = {
  async help() {
    say(`game-review test kit — node kit.mjs <command>

  verify              THE command after editing the app: runs only what your changes can affect (everything the first time)
  run [suite..]       run suites (${ALL.join(', ')}); flags: --only <regex> --tag <t> --seed N --fast --workers N --retries N --bail --strict
  list [--suite s]    every test id with tags and the project files it covers
  explain <id>        test source, files, last result, artifacts, rerun command
  affected [files..]  which tests a change touches (--changed a.js,b.js; default: files changed since the last green run)
  fuzz [--seed N] [--budget-ms N]    random-game fuzzing, prints the seed to reproduce
  mutate [--max N] [--deep]          mutation test: do the tests notice deliberately broken code?
  snapshot [--update]                golden reviews; --update accepts the current output as the new truth
  doctor              check node, project, Chrome, Playwright, book freshness
  build               build the test site only (build/site)
  book                rebuild the mock-engine search book (after editing src/chess-core.js or src/mock-engine.js)
  play [--port N]     interactive playground in your browser
  selftest            the kit proves it notices broken Stockfish builds
  engine [args]       check a REAL Stockfish binary (node engine-check.mjs ...)
  manifest            machine-readable description of all of this

Reports: build/report.json (schema ${SCHEMA}), build/report.md. Output is JSON when piped, human text on a terminal (--json / --human to force).
Exit codes: 0 pass · 1 failures · 2 environment problem · 3 usage error.`);
    return 0;
  },

  async run() {
    const names = P.length ? P : (F.suite ? F.suite.split(',') : ALL);
    for (const n of names) if (!SUITES[n]) die(3, `unknown suite "${n}". Suites: ${ALL.join(', ')}`);
    return finishRun(names);
  },

  async verify() {
    needProject();
    const hashes = projectFiles(), green = readJson(GREEN);
    let names = ALL, only = null, why = 'no previous green run: running everything';
    if (F.all) why = 'running everything (--all)';
    else if (F.changed || green) {
      const changed = F.changed ? F.changed.split(',') : changedSince(green.files);
      if (!changed.length) { why = 'nothing changed since the last green run: re-running the fast checks'; names = ALL.filter(n => SUITES[n].stage === 1); F.fast = true; }
      else {
        const idx = await getIndex(), hit = affectedTests(changed, idx.tests);
        const e2e = hit.filter(t => t.suite === 'e2e').map(t => t.id);
        names = ALL.filter(n => SUITES[n].stage === 1);
        if (e2e.length) { names.push('e2e'); only = '^(' + e2e.map(esc).join('|') + ')$'; }
        why = `changed: ${changed.join(', ')} → stage 1 suites + ${e2e.length} browser test(s)`;
      }
    }
    if (!agent) say(`verify: ${why}`);
    const code = await finishRun(names, { only, why, onlySuite: 'e2e' });
    if (code === 0) fs.writeFileSync(GREEN, JSON.stringify({ at: new Date().toISOString(), files: hashes }));
    return code;
  },

  async list() {
    needProject();
    const idx = await getIndex(true);
    const t = F.suite ? idx.tests.filter(x => x.suite === F.suite) : idx.tests;
    if (agent) say(JSON.stringify({ count: t.length, tests: t.map(x => ({ id: x.id, tags: x.tags, covers: x.covers, slow: x.slow || undefined })) }));
    else { for (const x of t) say(`${x.id}${x.tags?.length ? '  [' + x.tags.join(',') + ']' : ''}`); say(`\n${t.length} tests (index: ${rel(INDEX)})`); }
    return 0;
  },

  async explain() {
    const id = P[0]; if (!id) die(3, 'usage: kit.mjs explain <test id>');
    const idx = await getIndex(), t = idx.tests.find(x => x.id === id) || idx.tests.find(x => x.id.includes(id));
    if (!t) die(3, `no test with id "${id}". Try: node kit.mjs list`);
    const rep = readJson(REPORT), last = rep?.failures?.find(f => f.id === t.id);
    // the source: find the line that registers this test by matching the slug of its name
    const file = path.join(kitRoot, 'suites', `${t.suite}.mjs`), src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
    const words = (t.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3).slice(0, 4);
    const at = src.findIndex(l => words.length && words.every(w => l.toLowerCase().includes(w)));
    const info = { id: t.id, name: t.name, suite: t.suite, tags: t.tags, covers: t.covers, source: at >= 0 ? { file: `suites/${t.suite}.mjs`, line: at + 1, snippet: src.slice(Math.max(0, at - 1), at + 14).join('\n') } : null, lastFailure: last || null, rerun: `node kit.mjs run ${t.suite} --only '^${esc(t.id)}$'` };
    if (agent) say(JSON.stringify(info)); else {
      say(`${info.id}\n${info.name}\ntags: ${(info.tags || []).join(', ') || '-'}\nproject files: ${(info.covers || []).join(', ') || '-'}\nrerun: ${info.rerun}`);
      if (info.source) say(`\n${info.source.file}:${info.source.line}\n${info.source.snippet}`);
      if (last) say(`\nlast failure:\n${last.detail}\n${last.hint ? 'hint: ' + last.hint : ''}\n${last.artifacts ? 'artifacts: ' + Object.values(last.artifacts).join(', ') : ''}`);
    }
    return 0;
  },

  async affected() {
    needProject();
    const green = readJson(GREEN);
    const changed = P.length ? P : F.changed ? F.changed.split(',') : green ? changedSince(green.files) : [];
    const idx = await getIndex(), hit = affectedTests(changed, idx.tests);
    if (agent) say(JSON.stringify({ changed, count: hit.length, ids: hit.map(t => t.id) })); else { say(`changed: ${changed.join(', ') || '(nothing / no baseline)'}`); for (const t of hit) say('  ' + t.id); say(`${hit.length} affected`); }
    return 0;
  },

  async fuzz() {
    needProject();
    const seed = F.seed || String(Math.floor(Math.random() * 1e6));
    F.seed = seed; F.quiet = true;
    if (!agent) say(`fuzz seed ${seed} (reproduce: node kit.mjs fuzz --seed ${seed})`);
    return finishRun(['chess', 'fuzz'], { seed: +seed });
  },

  async mutate() {
    needProject();
    const { mutationRun } = await import('./lib/mutate.mjs');
    const r = await mutationRun({ max: +(F.max || 40), seed: +(F.seed || 1), deep: !!F.deep, files: F.files ? F.files.split(',') : undefined, onProgress: (x, n, t) => { if (!agent) process.stdout.write(`\r  mutants ${n}/${t}  `); } });
    const surv = r.results.filter(x => x.status === 'survived');
    const out = { score: r.score, killed: r.killed, survived: surv.length, total: r.total, survivors: surv.map(s => ({ file: s.file, line: s.line, op: s.op, before: s.before, after: s.after })) };
    if (agent) say(JSON.stringify(out)); else { say(`\nmutation score ${(r.score * 100).toFixed(0)}% (${r.killed}/${r.total} killed)`); for (const s of out.survivors) say(`  SURVIVED ${s.file}:${s.line} ${s.op}: ${s.before} => ${s.after}`); say('Survivors are code the tests do not protect: add a test, or accept that the change is behaviour-neutral.'); }
    return 0;
  },

  async snapshot() { needProject(); return finishRun(['snapshot']); },

  async doctor() {
    const chrome = findChrome(), pw = findPlaywright(), book = readJson(path.join(kitRoot, 'data/mock-book.json'));
    let bookOk = null; try { const { sourceHash } = await import('./lib/book.mjs'); bookOk = !!book && book.hash === sourceHash(); } catch { /* */ }
    let py = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;
    const checks = [
      ['node >= 20', +process.versions.node.split('.')[0] >= 20, process.version],
      ['project found', !!root, root || 'set PROJECT_ROOT'],
      ['playwright', !!pw, pw || 'set PLAYWRIGHT_PATH or npm i playwright (needed for e2e/play only)'],
      ['chrome', !!chrome, chrome || 'set CHROME_PATH (needed for e2e/play only)'],
      ['python3 + pyyaml', py, py ? 'ok' : 'needed for the workflow suite only'],
      ['mock-engine book current', bookOk !== false, bookOk ? 'ok' : bookOk === null ? 'unknown' : 'stale: node kit.mjs book (only speed is affected)'],
    ];
    const hard = checks.filter(c => !c[1] && ['node >= 20', 'project found'].includes(c[0]));
    if (agent) say(JSON.stringify({ ok: !hard.length, checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })) }));
    else for (const [n, ok, d] of checks) say(`${ok ? 'ok  ' : 'MISS'} ${n.padEnd(26)} ${d}`);
    return hard.length ? 2 : 0;
  },

  async build() { needProject(); return buildSiteNow() ? (say(agent ? JSON.stringify({ ok: true, site: rel(path.join(buildDir, 'site')) }) : `built ${rel(path.join(buildDir, 'site'))}`), 0) : 2; },

  async book() { const { buildBook } = await import('./lib/book.mjs'); const r = await buildBook((n, t) => { if (!agent) process.stdout.write(`\r  ${n}/${t} `); }); say(agent ? JSON.stringify({ ok: true, ...(r && typeof r === 'object' ? r : {}) }) : '\nbook rebuilt'); return 0; },

  async play() {
    needProject();
    if (!buildSiteNow()) return 2;
    const args = [path.join(kitRoot, 'playground/server.mjs'), ...(F.port ? ['--port', F.port] : []), ...(F['no-open'] ? ['--no-open'] : [])];
    const p = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, PROJECT_ROOT: root } });
    return new Promise(res => p.on('close', c => res(c || 0)));
  },

  async selftest() { return passthrough('kit-selftest.mjs', P); },
  async engine() { return passthrough('engine-check.mjs', argv.slice(1)); },
  async manifest() { say(fs.readFileSync(path.join(kitRoot, 'kit.manifest.json'), 'utf8')); return 0; },
};

function passthrough(file, args) {
  return new Promise(res => { const p = spawn(process.execPath, [path.join(kitRoot, file), ...args], { stdio: 'inherit', cwd: kitRoot }); p.on('close', c => res(c ?? 1)); });
}

async function finishRun(names, extra = {}) {
  if (names.some(n => SUITES[n].browser)) {
    if (!findPlaywright() || !findChrome()) { const msg = 'ENV: e2e needs Playwright and Chrome (see: node kit.mjs doctor). Run the other suites with: node kit.mjs run ' + ALL.filter(n => !SUITES[n].browser).join(' '); if (agent) say(JSON.stringify({ ok: false, env: msg })); else console.error(msg); return 2; }
  }
  const prevOnly = F.only;
  if (extra.only) F.only = extra.only; // narrows the browser suite only (below)
  const t0 = Date.now(), runs = [];
  // `only` from verify applies to e2e alone; the other suites run in full.
  const stage1 = names.filter(n => SUITES[n].stage === 1), stage2 = names.filter(n => SUITES[n].stage === 2);
  if (names.some(n => SUITES[n].needsProject)) needProject();
  F.only = extra.only ? undefined : prevOnly;
  const prog = r => { if (!F.quiet && !agent) say(`  ${r.name.padEnd(9)} ${r.doc ? summaryLine(r.doc.summary) : 'NO RESULT'}  (${(r.ms / 1000).toFixed(1)} s)`); };
  if (root && names.some(n => !['perft', 'chess'].includes(n)) && !buildSiteNow()) return 2; // the site build is cheap; stale builds would test old code
  await Promise.all(stage1.map(async n => { const r = await runSuite(n); runs.push(r); prog(r); }));
  F.only = extra.only || prevOnly;
  for (const n of stage2) { const r = await runSuite(n); runs.push(r); prog(r); }
  const { rep, results } = buildReport(runs, Date.now() - t0, extra.why ? { why: extra.why } : {});
  emit(rep, results);
  return rep.ok ? 0 : 1;
}

if (!COMMANDS[cmd]) { console.error(`unknown command "${cmd}". Try: node kit.mjs help`); process.exit(3); }
COMMANDS[cmd]().then(c => process.exit(c ?? 0), e => { console.error(e?.stack || e); process.exit(2); });
