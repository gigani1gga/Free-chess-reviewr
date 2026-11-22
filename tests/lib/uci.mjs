// Talks UCI to ANY Stockfish from Node: a native binary, an npm build (stockfish-*.js run with node), or the built-in mock.
// Everything the engine prints (stdout, stderr, exit) is kept in one transcript so errors can be shown afterwards.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
export const kitRoot = path.resolve(here, '..');
export const buildDir = path.join(kitRoot, 'build');

export function cli(extra = {}) {
  const { values } = parseArgs({
    strict: false,
    options: {
      bin: { type: 'string' }, js: { type: 'string' }, mock: { type: 'string' }, site: { type: 'string' }, kind: { type: 'string' },
      depth: { type: 'string' }, json: { type: 'string' }, html: { type: 'string' }, 'startup-ms': { type: 'string' },
      'search-ms': { type: 'string' }, 'no-app': { type: 'boolean' }, quiet: { type: 'boolean' }, quick: { type: 'boolean' }, url: { type: 'string' },
      timeout: { type: 'string' }, ...extra,
    },
  });
  return values;
}

const which = name => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
};

// Decides which engine to test. Order: flags, then environment, then whatever Stockfish is installed, then the mock.
export function resolveSpec(v, env = process.env) {
  const site = v.site && path.resolve(v.site);
  if (v.bin) return { kind: 'bin', path: path.resolve(v.bin), label: `binary ${v.bin}` };
  if (v.js) return { kind: 'js', path: path.resolve(v.js), label: `node ${v.js}` };
  if (v.mock != null) return { kind: 'mock', variant: v.mock === '' || v.mock === 'true' ? 'normal' : v.mock, label: `built-in mock (${v.mock === 'true' ? 'normal' : v.mock || 'normal'})` };
  if (site) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(site, 'engine/manifest.json'), 'utf8'));
      const f = m[v.kind || 'fast'] || m.fast || m.best;
      if (f && !/^mock/.test(f) && !/mock/.test(fs.readFileSync(path.join(site, 'engine', f), 'utf8').slice(0, 400))) return { kind: 'js', path: path.join(site, 'engine', f), label: `site engine ${f}` };
      if (f) return { kind: 'mock', variant: 'normal', label: `the site's mock engine (${f}), run through the built-in mock` };
    } catch { /* fall through */ }
  }
  if (env.STOCKFISH_BIN) return { kind: 'bin', path: env.STOCKFISH_BIN, label: `binary ${env.STOCKFISH_BIN}` };
  if (env.STOCKFISH_JS) return { kind: 'js', path: env.STOCKFISH_JS, label: `node ${env.STOCKFISH_JS}` };
  const bin = which('stockfish') || ['/usr/games/stockfish', '/usr/local/bin/stockfish', '/opt/homebrew/bin/stockfish'].find(p => fs.existsSync(p));
  if (bin) return { kind: 'bin', path: bin, label: `installed binary ${bin}` };
  for (const base of [process.cwd(), path.resolve(kitRoot, '..'), env.PROJECT_ROOT].filter(Boolean)) {
    for (const f of ['stockfish-19-lite-single.js', 'stockfish-18-lite-single.js', 'stockfish-17.1-lite-single.js', 'stockfish-lite-single.js']) {
      const p = path.join(base, 'node_modules/stockfish/src', f);
      if (fs.existsSync(p)) return { kind: 'js', path: p, label: `npm package ${f}` };
    }
  }
  return { kind: 'mock', variant: 'normal', label: 'built-in mock (no real Stockfish found: set STOCKFISH_BIN or STOCKFISH_JS)', fallback: true };
}

const command = spec =>
  spec.kind === 'bin' ? [spec.path, []]
  : spec.kind === 'js' ? [process.execPath, [spec.path]]
  : [process.execPath, [path.join(kitRoot, 'mock-cli.mjs'), spec.variant || 'normal']];

export class UciProc {
  constructor(spec) {
    this.spec = spec;
    this.t0 = Date.now();
    this.log = [];      // { t, dir: '>' sent | '<' received | '!' stderr/exit/spawn problem, text }
    this.lines = [];    // stdout lines only, in order
    this.stderr = [];
    this.exited = null;
    this.spawnError = null;
    this.waiters = new Set();
    this.onLine = null;
    this.onExit = null;
    const [cmd, args] = command(spec);
    this.p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', ebuf = '';
    this.p.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { this.push(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    });
    this.p.stderr.on('data', d => {
      ebuf += d;
      let i;
      while ((i = ebuf.indexOf('\n')) >= 0) {
        const l = ebuf.slice(0, i).replace(/\r$/, ''); ebuf = ebuf.slice(i + 1);
        if (l.trim()) { this.stderr.push(l); this.note('!', 'stderr: ' + l); }
      }
    });
    this.p.on('error', e => { this.spawnError = e; this.note('!', 'could not start: ' + e.message); this.wake(); });
    this.p.on('exit', (code, sig) => {
      if (buf) this.push(buf);
      this.exited = { code, sig };
      this.note('!', `process exited (code ${code}${sig ? ', signal ' + sig : ''})`);
      this.wake();
      this.onExit?.(this.exited);
    });
    this.p.stdin.on('error', () => {});
  }
  note(dir, text) { this.log.push({ t: Date.now() - this.t0, dir, text }); }
  push(line) { this.lines.push(line); this.note('<', line); this.onLine?.(line); this.wake(); }
  wake() { for (const w of [...this.waiters]) w(); }
  mark() { return this.lines.length; }
  send(cmd) { this.note('>', cmd); if (!this.exited && !this.spawnError) this.p.stdin.write(cmd + '\n'); }
  kill() { try { this.p.kill('SIGKILL'); } catch { /* already gone */ } }

  // Resolves with { line, index } for the first stdout line at or after `from` that satisfies `test`.
  waitFor(test, ms, what, from = 0) {
    return new Promise((res, rej) => {
      let scanned = from;
      const finish = () => { clearTimeout(timer); this.waiters.delete(check); };
      const check = () => {
        for (; scanned < this.lines.length; scanned++) if (test(this.lines[scanned])) { finish(); return res({ line: this.lines[scanned], index: scanned }); }
        if (this.spawnError) { finish(); return rej(new Error(`the engine could not be started: ${this.spawnError.message}`)); }
        if (this.exited) { finish(); return rej(new Error(`the engine process exited (code ${this.exited.code}) while waiting for ${what}`)); }
      };
      const timer = setTimeout(() => { finish(); rej(new Error(`no ${what} within ${ms} ms`)); }, ms);
      this.waiters.add(check);
      check();
    });
  }
}

// Lines that mean "something is wrong", wherever the engine printed them.
const BAD = /\b(unknown command|no such option|error|warning|fatal|abort(ed)?|assertion|invalid|illegal|could not|cannot|can't|failed|not found|corrupt)\b/i;
export function anomalies(log) {
  const out = [];
  for (const e of log) {
    if (e.dir === '!' && !/process exited \(code 0/.test(e.text)) out.push(e);
    else if (e.dir === '<' && !/^info (depth|currmove)/.test(e.text) && BAD.test(e.text)) out.push(e);
  }
  return out;
}

// Same reading of an `info` line as js/engine.js: skip bound lines, keep the last line per multipv index.
export function readInfo(lines) {
  const out = [];
  let depth = 0, nps = 0;
  for (const l of lines) {
    if (!l.startsWith('info')) continue;
    const d = / depth (\d+)/.exec(l); if (d) depth = Math.max(depth, +d[1]);
    const n = / nps (\d+)/.exec(l); if (n) nps = +n[1];
    if (/ (lower|upper)bound/.test(l)) continue;
    const s = / score (cp|mate) (-?\d+)/.exec(l), p = / pv (.+)$/.exec(l);
    if (!s || !p) continue;
    const k = +(/ multipv (\d+)/.exec(l)?.[1] ?? 1);
    out[k - 1] = { [s[1]]: +s[2], pv: p[1].trim().split(' ') };
  }
  return { lines: out.filter(Boolean), depth, nps };
}
