// Assembles a test copy of the deployed site (same layout the workflow produces) with the mock engine and the chess.js
// stand-in. Usage: node build-site.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.PROJECT_ROOT || path.join(here, '..'));
const out = path.resolve(process.argv[2] || path.join(here, 'build', 'site'));
fs.rmSync(out, { recursive: true, force: true });
for (const d of ['engine', 'vendor', 'pieces', 'icons']) fs.mkdirSync(path.join(out, d), { recursive: true });

fs.cpSync(path.join(root, 'index.html'), path.join(out, 'index.html'));
fs.cpSync(path.join(root, 'style.css'), path.join(out, 'style.css'));
fs.cpSync(path.join(root, 'js'), path.join(out, 'js'), { recursive: true });
fs.cpSync(path.join(root, 'js/sw.js'), path.join(out, 'sw.js')); // the workflow copies it to the site root

const core = fs.readFileSync(path.join(here, 'src/chess-core.js'), 'utf8');
fs.writeFileSync(path.join(out, 'vendor/chess.js'), core + '\nexport { Chess };\n');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><circle cx="22" cy="22" r="16" fill="#888"/></svg>';
for (const p of 'wP wN wB wR wQ wK bP bN bB bR bQ bK'.split(' ')) fs.writeFileSync(path.join(out, `pieces/${p}.svg`), svg);
const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black"><circle cx="12" cy="12" r="9"/></svg>';
const ICONS = 'sparkles zap star thumbs-up check circle-alert triangle-alert x octagon-x skip-back skip-forward chevron-left chevron-right arrow-up-down'.split(' ');
for (const i of ICONS) fs.writeFileSync(path.join(out, `icons/${i}.svg`), icon);

const engineSrc = fs.readFileSync(path.join(here, 'src/mock-engine.js'), 'utf8');
const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(200000, 7)]);
const base = { name: 'Stockfish 19 (mock)', cap: 3, qdepth: 4, loadDelay: 300, options: 'modern', behavior: 'normal' };
const variants = {
  'stockfish-19-single': { ...base, name: 'Stockfish 19 (mock full)' },
  'stockfish-19-lite-single': { ...base, name: 'Stockfish 19 Lite (mock)', cap: 2, qdepth: 2, loadDelay: 50 },
  'mock-legacy': { ...base, name: 'Stockfish 10 (mock legacy options)', cap: 2, qdepth: 2, options: 'legacy' },
  'mock-hang': { ...base, behavior: 'no-readyok' },
  'mock-crash': { ...base, behavior: 'crash' },
  'mock-nobest': { ...base, behavior: 'no-bestmove' },
  'mock-garbage': { ...base, cap: 2, qdepth: 2, behavior: 'garbage' },
  'mock-slowload': { ...base, loadDelay: 2500 },
  'mock-nowasm': { ...base },
};
for (const [name, cfg] of Object.entries(variants)) {
  fs.writeFileSync(path.join(out, `engine/${name}.js`), `const CONFIG = ${JSON.stringify(cfg)};\n${core}\n${engineSrc}`);
  if (name !== 'mock-nowasm') fs.writeFileSync(path.join(out, `engine/${name}.wasm`), wasm);
}
fs.writeFileSync(path.join(out, 'engine/manifest.json'), JSON.stringify({ best: 'stockfish-19-single.js', fast: 'stockfish-19-lite-single.js' }));
console.log('test site written to', out);
