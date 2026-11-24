// Assembles a test copy of the deployed site (same layout the deploy workflow produces) with the mock engine and the chess.js
// stand-in. Usage: node build-site.mjs [outDir]      (PROJECT_ROOT=/path/to/game-review if the kit is not inside the project)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot, siteDir, kitRoot } from './lib/env.mjs';
import { CONFIGS, configKey, loadBook } from './lib/book.mjs';

const hashFile = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12);

// Every engine variant the tests (and the playground) can pick. `behavior` is what the mock does wrong, on purpose.
export const VARIANTS = (() => {
  const base = { name: 'Stockfish 19 (mock)', cap: 3, qdepth: 4, loadDelay: 300, options: 'modern', behavior: 'normal' };
  return {
    'stockfish-19-single': { ...base, name: 'Stockfish 19 (mock full)' },
    'stockfish-19-lite-single': { ...base, name: 'Stockfish 19 Lite (mock)', cap: 2, qdepth: 2, loadDelay: 50 },
    'mock-legacy': { ...base, name: 'Stockfish 10 (mock legacy options)', cap: 2, qdepth: 2, options: 'legacy' },
    'mock-hang': { ...base, behavior: 'no-readyok' },
    'mock-crash': { ...base, behavior: 'crash' },
    'mock-nobest': { ...base, behavior: 'no-bestmove' },
    'mock-garbage': { ...base, cap: 2, qdepth: 2, behavior: 'garbage' },
    'mock-slowload': { ...base, loadDelay: 2500 },
    'mock-slowsearch': { ...base, cap: 2, qdepth: 2, loadDelay: 50, searchDelay: 600 },
    'mock-nowasm': { ...base },
  };
})();

export function buildSite({ root = projectRoot(), out = siteDir(), strictChess = process.env.KIT_STRICT_CHESS !== '0', quiet = false } = {}) {
  if (!root) throw new Error('could not find the Game Review project (index.html + js/). Set PROJECT_ROOT=/path/to/game-review');
  for (const f of ['index.html', 'style.css', 'js']) if (!fs.existsSync(path.join(root, f))) throw new Error(`the project at ${root} has no ${f}`);
  fs.rmSync(out, { recursive: true, force: true });
  for (const d of ['engine', 'vendor', 'pieces', 'icons']) fs.mkdirSync(path.join(out, d), { recursive: true });

  fs.cpSync(path.join(root, 'index.html'), path.join(out, 'index.html'));
  fs.cpSync(path.join(root, 'style.css'), path.join(out, 'style.css'));
  fs.cpSync(path.join(root, 'js'), path.join(out, 'js'), { recursive: true });
  fs.cpSync(path.join(root, 'js/sw.js'), path.join(out, 'sw.js')); // the workflow copies it to the site root

  // vendor/chess.js: the stand-in. In strict mode touching a method it does not have records it and throws, so a new use of some
  // chess.js API in the app shows up as "STAND-IN LACKS Chess.foo" instead of an unrelated crash (or a silent try/catch swallow).
  const core = fs.readFileSync(path.join(kitRoot, 'src/chess-core.js'), 'utf8');
  const strict = `
const __Impl = Chess;
const __misses = (globalThis.__chessMisses ||= new Set());
const __ok = new Set(['then', 'toJSON', 'constructor', 'inspect', 'asymmetricMatch', '$$typeof', 'nodeType', 'tagName']);
const __Strict = new Proxy(__Impl, { construct(t, a) {
  const o = Reflect.construct(t, a);
  return new Proxy(o, { get(obj, p) {
    if (typeof p === 'string' && !(p in obj) && !p.startsWith('_') && !__ok.has(p)) {
      __misses.add(p);
      const m = 'STAND-IN LACKS Chess.' + p + ': the app used a chess.js method the test kit does not implement (add it to src/chess-core.js)';
      console.error(m);
      throw new Error(m);
    }
    return Reflect.get(obj, p);
  } });
} });
export { __Strict as Chess };
`;
  fs.writeFileSync(path.join(out, 'vendor/chess.js'), core + (strictChess ? strict : '\nexport { Chess };\n'));

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><circle cx="22" cy="22" r="16" fill="#888"/></svg>';
  for (const p of 'wP wN wB wR wQ wK bP bN bB bR bQ bK'.split(' ')) fs.writeFileSync(path.join(out, `pieces/${p}.svg`), svg);
  const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black"><circle cx="12" cy="12" r="9"/></svg>';
  const ICONS = 'sparkles zap star thumbs-up book-open arrow-right check circle-alert triangle-alert x octagon-x skip-back skip-forward chevron-left chevron-right arrow-up-down'.split(' ');
  for (const i of ICONS) fs.writeFileSync(path.join(out, `icons/${i}.svg`), icon);

  const engineSrc = fs.readFileSync(path.join(kitRoot, 'src/mock-engine.js'), 'utf8');
  const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(200000, 7)]);
  const { books, why: bookWhy } = loadBook();
  for (const [name, cfg0] of Object.entries(VARIANTS)) {
    const cfg = books && books[configKey(cfg0)] && !['no-readyok', 'crash', 'no-bestmove'].includes(cfg0.behavior) ? { ...cfg0, book: books[configKey(cfg0)] } : cfg0;
    fs.writeFileSync(path.join(out, `engine/${name}.js`), `const CONFIG = ${JSON.stringify(cfg)};\n${core}\n${engineSrc}`);
    if (name !== 'mock-nowasm') fs.writeFileSync(path.join(out, `engine/${name}.wasm`), wasm);
  }
  fs.writeFileSync(path.join(out, 'engine/manifest.json'), JSON.stringify({ best: 'stockfish-19-single.js', fast: 'stockfish-19-lite-single.js' }));

  const meta = { builtAt: new Date().toISOString(), root, strictChess, book: bookWhy, variants: Object.keys(VARIANTS), files: Object.fromEntries(['index.html', 'style.css', ...fs.readdirSync(path.join(root, 'js')).map(f => 'js/' + f)].map(f => [f, hashFile(path.join(root, f))])) };
  fs.writeFileSync(path.join(out, '__kit.json'), JSON.stringify(meta));
  if (!quiet) console.log('test site written to', out + (bookWhy === 'ok' ? '' : `   (mock book not used: ${bookWhy}; tests will be slower)`));
  return meta;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildSite({ out: process.argv[2] ? path.resolve(process.argv[2]) : siteDir() }); } catch (e) { console.error(e.message); process.exit(2); }
}
