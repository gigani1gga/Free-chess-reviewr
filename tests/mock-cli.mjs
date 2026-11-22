// The mock Stockfish as a command-line UCI program (stdin/stdout), so the kit can test it exactly like a real engine.
// Usage: node mock-cli.mjs [variant]. Variants that are BAD on purpose let the kit prove it notices engine problems:
//   normal, legacy, garbage            fine (older options / noisy output)
//   crash, missing-wasm, no-readyok    never become ready
//   no-bestmove, slow                  search never ends / takes too long
//   illegal-pv, bad-bestmove           wrong moves in the output
//   wrong-sign, ignores-multipv        wrong meaning of scores / MultiPV ignored
//   stderr-noise, hangs-on-stop        prints errors / ignores "stop"
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2] || 'normal';
const core = fs.readFileSync(path.join(here, 'src/chess-core.js'), 'utf8');
const engine = fs.readFileSync(path.join(here, 'src/mock-engine.js'), 'utf8');
const base = { name: 'Stockfish 19 (mock, command line)', cap: 3, qdepth: 4, loadDelay: 0, options: 'modern', behavior: 'normal' };
const cfg = {
  ...base,
  ...({
    legacy: { name: 'Stockfish 10 (mock legacy options)', cap: 2, qdepth: 2, options: 'legacy' },
    garbage: { cap: 2, qdepth: 2, behavior: 'garbage' },
    crash: { behavior: 'crash' },
    'no-readyok': { behavior: 'no-readyok' },
    'no-bestmove': { behavior: 'no-bestmove' },
  })[variant],
};

const write = l => process.stdout.write(l + '\n');
const FLIP = /( score cp )(-?\d+)/;
const tOut = line => {
  if (variant === 'wrong-sign') return line.replace(FLIP, (_, a, n) => a + -n).replace(/( score mate )(-?\d+)/, (_, a, n) => a + -n);
  if (variant === 'ignores-multipv') return /^info .* multipv ([2-9])/.test(line) ? null : line;
  if (variant === 'illegal-pv') return /^info .* pv /.test(line) ? line + ' a1a1' : line;
  if (variant === 'bad-bestmove') return line.startsWith('bestmove') ? 'bestmove a1a1' : line;
  return line;
};
let greeted = false, noisy = false;
const tIn = cmd => {
  if (variant === 'hangs-on-stop' && (cmd === 'stop' || cmd.startsWith('go infinite'))) return null;
  if (variant === 'stderr-noise' && !greeted) { greeted = true; process.stderr.write('WARNING: NNUE file nn-mock.nnue could not be loaded\n'); }
  if (variant === 'stderr-noise' && cmd.startsWith('go') && !noisy) { noisy = true; write('info string ERROR: evaluation function failed to initialise'); }
  return cmd;
};

const sandbox = {
  self: { location: { href: 'file:///mock/stockfish-19-mock.js' } },
  fetch: async () => ({ ok: variant !== 'missing-wasm', arrayBuffer: async () => new ArrayBuffer(8) }),
  setTimeout, clearTimeout, Date, Math, console,
  postMessage: l => {
    const o = tOut(String(l));
    if (o == null) return;
    if (variant === 'slow' && o.startsWith('bestmove')) setTimeout(() => write(o), 3000); else write(o);
  },
};
vm.createContext(sandbox);
try { vm.runInContext(`const CONFIG = ${JSON.stringify(cfg)};\n${core}\n${engine}`, sandbox); }
catch (e) { process.stderr.write(`mock wasm abort: ${e.message}\n`); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', raw => {
  const cmd = tIn(raw.trim());
  if (cmd == null || cmd === '') return;
  if (cmd === 'quit') process.exit(0);
  sandbox.onmessage({ data: cmd });
});
rl.on('close', () => setTimeout(() => process.exit(0), 4000));
