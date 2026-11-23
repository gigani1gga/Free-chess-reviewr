// Checks that need no browser and no engine: does the project even hang together? Catches the dumb, expensive mistakes first
// (a typo'd import, an element id that no longer exists, a chess.js method the kit does not have) with the exact file and name.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDir, projectRoot, siteDir } from '../lib/env.mjs';
import { createSuite } from '../lib/suite.mjs';
import { chessModule } from '../lib/chess.mjs';
import { GAMES } from '../lib/games.mjs';
import { loadBook, sourceHash } from '../lib/book.mjs';

const S = createSuite('static');
const root = projectRoot();
const meta = (covers, extra = {}) => ({ tags: ['static'], covers, ...extra });
if (!root) { S.check('project found', false, 'PROJECT_ROOT is not set and no folder with index.html + js/ was found next to the kit'); S.finish(); await new Promise(() => {}); }

const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const jsFiles = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js')).sort();
const html = read('index.html'), css = read('style.css');
const src = Object.fromEntries(jsFiles.map(f => [f, read('js/' + f)]));
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

// 1. every file parses as an ES module ------------------------------------------------------------------------------------
fs.mkdirSync(path.join(buildDir, 'tmp'), { recursive: true });
for (const f of jsFiles) {
  const tmp = path.join(buildDir, 'tmp', `syntax-${f}.mjs`);
  fs.writeFileSync(tmp, src[f]);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  S.check(`js/${f} is valid JavaScript (ES module)`, r.status === 0, (r.stderr || '').split('\n').slice(0, 4).join(' | '), meta(['js/' + f]));
}

// 2. imports resolve, and the names imported are really exported ---------------------------------------------------------------
const exportsOf = code => {
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) m[1].split(',').forEach(x => { const n = x.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); });
  if (/export\s+default/.test(code)) names.add('default');
  return names;
};
const site = siteDir();
const resolveImport = (from, spec) => {
  if (!spec.startsWith('.')) return null; // a URL or bare package: out of scope here
  const inProject = path.resolve(root, path.dirname(from), spec);
  if (fs.existsSync(inProject)) return inProject;
  const inSite = path.resolve(site, path.dirname(from), spec); // vendor/chess.js is added by the deploy workflow
  return fs.existsSync(inSite) ? inSite : null;
};
const kitText = ['unit.mjs', 'fuzz.mjs', 'snapshot.mjs'].map(f => { try { return fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'); } catch { return ''; } }).join('\n'); // exports only the kit's tests use are not dead
const imported = {}; // file -> Set of names other files import from it (for the dead-export warning)
for (const f of jsFiles) {
  const code = stripComments(src[f]);
  for (const m of code.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)?\s*from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)) {
    const spec = m[3] || m[4];
    const file = resolveImport('js/' + f, spec);
    if (spec.startsWith('.') && !file) { S.check(`js/${f}: import '${spec}' resolves`, false, `no such file (looked in the project and in the built site)`, meta(['js/' + f])); continue; }
    if (!file || !m[2]) { if (file) S.check(`js/${f}: import '${spec}' resolves`, true, '', meta(['js/' + f])); continue; }
    const have = exportsOf(fs.readFileSync(file, 'utf8')), key = path.basename(file);
    const names = m[2].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    (imported[key] ||= new Set());
    for (const n of names) imported[key].add(n);
    const missing = names.filter(n => !have.has(n));
    S.check(`js/${f}: everything imported from '${spec}' is exported there`, !missing.length, `${spec} does not export: ${missing.join(', ')}`, meta(['js/' + f, 'js/' + path.basename(file)]));
  }
}
for (const f of jsFiles) {
  const unused = [...exportsOf(src[f])].filter(n => n !== 'default' && !(imported[f] || new Set()).has(n) && !new RegExp(`\\b${n.replace('$', '\\$')}\\b`).test(html) && !new RegExp(`\\b${n.replace('$', '\\$')}\\b`).test(kitText));
  S.check(`js/${f}: no exports that nothing imports (dead code)`, !unused.length, `unused: ${unused.join(', ')}`, meta(['js/' + f], { warn: true }));
}

// 3. the DOM the scripts expect is in index.html ------------------------------------------------------------------------------
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
S.check('index.html: element ids are unique', !dup.length, `duplicate ids: ${[...new Set(dup)].join(', ')}`, meta(['index.html']));
const used = new Map();
for (const f of jsFiles) for (const m of stripComments(src[f]).matchAll(/(?:\$|getElementById)\(\s*['"]([\w-]+)['"]\s*\)|querySelector\(\s*['"]#([\w-]+)['"]\s*\)/g)) used.set(m[1] || m[2], f);
const madeInJs = new Set(Object.values(src).flatMap(c => [...c.matchAll(/\bid=\\?["']([\w-]+)\\?["']/g)].map(m => m[1]))); // elements the scripts create themselves
const lost = [...used].filter(([id]) => !ids.includes(id) && !madeInJs.has(id));
S.opts.quiet || console.log(`   (${used.size} element ids checked)`);
S.check('every element id the scripts look up exists in index.html', !lost.length, lost.map(([id, f]) => `#${id} (used in js/${f})`).join(', '), meta(['index.html', ...jsFiles.map(f => 'js/' + f)]));

// 4. basic page hygiene --------------------------------------------------------------------------------------------------------
S.check('index.html: has lang, viewport meta and a title', /<html[^>]*\slang=/.test(html) && /<meta[^>]*name="viewport"/.test(html) && /<title>[^<]+<\/title>/.test(html), '', meta(['index.html']));
const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
S.check('index.html: every <img> has an alt attribute', imgs.every(t => /\salt=/.test(t)), imgs.filter(t => !/\salt=/.test(t)).join(' '), meta(['index.html']));
const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
const unnamed = buttons.filter(([, a, inner]) => !/aria-label=|title=/.test(a) && !inner.replace(/<[^>]*>/g, '').trim());
S.check('index.html: every <button> has text, an aria-label or a title (screen readers)', !unnamed.length, unnamed.map(m => m[0].slice(0, 80)).join(' | '), meta(['index.html'], { warn: true }));
const inputs = [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)].filter(([, , a]) => !/type="(hidden|checkbox|radio)"/.test(a));
// A field inside <label>text<input></label> is labelled by that label (no for= needed).
const inLabel = at => { const o = html.lastIndexOf('<label', at); return o >= 0 && html.lastIndexOf('</label>', at) < o; };
const unlabeled = inputs.filter(m => { const a = m[2], id = (a.match(/\sid="([^"]+)"/) || [])[1]; return !(/aria-label=|aria-labelledby=/.test(a) || inLabel(m.index) || (id && new RegExp(`<label[^>]*for="${id}"`).test(html))); });
S.check('index.html: every form field has a label or aria-label', !unlabeled.length, unlabeled.map(m => m[0].slice(0, 70)).join(' | '), meta(['index.html'], { warn: true }));
const leftovers = jsFiles.flatMap(f => stripComments(src[f]).split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => /\bdebugger\b|console\.log\(/.test(l)).map(([f, i]) => `js/${f}:${i}`));
S.check('js: no debugger statements or console.log left behind', !leftovers.length, leftovers.join(', '), meta(jsFiles.map(f => 'js/' + f), { warn: true }));
const todos = jsFiles.flatMap(f => src[f].split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => /\b(TODO|FIXME|XXX|HACK)\b/.test(l)).map(([f, i]) => `js/${f}:${i}`));
S.check('js: no TODO/FIXME markers', !todos.length, todos.join(', '), meta(jsFiles.map(f => 'js/' + f), { warn: true }));

// 5. CSS classes the scripts add exist in style.css ----------------------------------------------------------------------------
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => m[1]));
const htmlClasses = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
const jsClasses = new Map();
for (const f of jsFiles) {
  const code = stripComments(src[f]);
  for (const m of code.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([\w-]+)'/g)) jsClasses.set(m[1], f);
  for (const m of code.matchAll(/class="([\w\- ${}.]*)"/g)) for (const c of m[1].split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) jsClasses.set(c, f);
}
const noRule = [...jsClasses].filter(([c]) => !cssClasses.has(c) && !htmlClasses.has(c));
S.opts.quiet || console.log(`   (${jsClasses.size} CSS classes checked)`);
S.check('every CSS class the scripts use has a rule in style.css', !noRule.length, noRule.map(([c, f]) => `.${c} (js/${f})`).join(', '), meta(['style.css'], { warn: true }));

// 6. chess.js: every method the app calls on a Chess object exists in the kit's stand-in ----------------------------------------
{
  const { Chess } = await chessModule();
  const have = new Set(Object.getOwnPropertyNames(Chess.prototype));
  const calls = new Map();
  for (const f of jsFiles) {
    const code = stripComments(src[f]);
    const vars = new Set([...code.matchAll(/\b([\w$]+)\s*=\s*new Chess\(/g)].map(m => m[1]));
    for (const v of vars) for (const m of code.matchAll(new RegExp(`\\b${v.replace('$', '\\$')}\\.([A-Za-z_]\\w*)\\(`, 'g'))) calls.set(m[1], f);
    for (const m of code.matchAll(/new Chess\([^)]*\)\.([A-Za-z_]\w*)\(/g)) calls.set(m[1], f);
  }
  const lacking = [...calls].filter(([n]) => !have.has(n));
  S.opts.quiet || console.log(`   (chess.js methods the app calls: ${[...calls.keys()].sort().join(', ')})`);
  S.check('chess.js stand-in has every method the app calls', !lacking.length, `the app calls ${lacking.map(([n, f]) => `${n}() (js/${f})`).join(', ')}, which src/chess-core.js lacks. Add them, same behaviour as chess.js v1.`, meta(['src/chess-core.js']));
}

// 7. the kit's own test data ------------------------------------------------------------------------------------------------------
{
  const { Chess } = await chessModule();
  const bad = [];
  for (const [id, g] of Object.entries(GAMES)) { try { const c = new Chess(); c.loadPgn(g.pgn); if (c.history().length !== g.plies) bad.push(`${id}: ${c.history().length} plies, expected ${g.plies}`); } catch (e) { bad.push(`${id}: ${e.message}`); } }
  S.check('kit: every sample game in lib/games.mjs is legal and has the stated length', !bad.length, bad.join('; '), meta(['lib/games.mjs']));
  const { books, why } = loadBook();
  S.check('kit: the mock-engine book is current (a stale book is ignored, so this only costs speed)', !!books, why, meta(['src/mock-engine.js'], { warn: true }));
}
await S.run();
S.finish();
