// Proves the kit notices Stockfish problems: runs engine-check against the built-in mock, healthy and deliberately broken,
// and requires the RIGHT check to fail each time (and none to fail for the healthy ones).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
const FAST = ['--depth', '6', '--no-app', '--quiet', '--quick'];
// [variant, extra flags, the check that must FAIL (null = nothing may fail), text that must show up in the engine-error list]
const CASES = [
  ['normal', [], null], ['legacy', [], null], ['garbage', [], null],
  ['crash', ['--startup-ms', '3000'], 'uci-handshake'],
  ['missing-wasm', ['--startup-ms', '1500'], 'uci-handshake'],
  ['no-readyok', ['--startup-ms', '1500'], 'readyok'],
  ['no-bestmove', ['--search-ms', '1500'], 'search-start'],
  ['slow', ['--search-ms', '1000'], 'search-start'],
  ['illegal-pv', [], 'pv-legal'],
  ['bad-bestmove', [], 'bestmove-matches-pv'],
  ['wrong-sign', [], 'stm-pov'],
  ['ignores-multipv', [], 'multipv-2'],
  ['stderr-noise', [], 'engine-errors', 'could not be loaded'],
  ['hangs-on-stop', [], 'stop'],
];
const run = ([variant, extra]) => new Promise(res => {
  const json = path.join(tmp, variant + '.json');
  const p = spawn(process.execPath, [path.join(here, 'engine-check.mjs'), '--mock', variant, '--json', json, ...FAST, ...extra], { stdio: 'ignore' });
  p.on('exit', code => res({ variant, code, report: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null }));
});

const out = [];
const N = Math.max(2, Math.min(6, os.cpus().length));
for (let i = 0; i < CASES.length; i += N) out.push(...await Promise.all(CASES.slice(i, i + N).map(run))); // as many at once as there are cores
let fails = 0;
CASES.forEach(([variant, , expect, text], i) => {
  const { code, report } = out[i];
  const failing = report ? report.checks.filter(c => c.status === 'FAIL').map(c => c.id) : ['(no report)'];
  const good = expect === null ? failing.length === 0 && code === 0 : failing.includes(expect) && code === 1
    && (!text || report.engineErrors.some(e => e.text.includes(text)));
  if (!good) fails++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${expect === null ? `healthy engine "${variant}" passes` : `broken engine "${variant}" is caught by "${expect}"`}${good ? '' : `  (failed: ${failing.join(', ') || 'nothing'}; exit ${code})`}`);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} kit self-test(s) FAILED` : '\nthe kit catches every kind of broken engine it knows about');
process.exit(fails ? 1 : 0);
