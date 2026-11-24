// Which parts of the project each kind of test exercises. Used for (1) hints on failures, (2) `kit.mjs affected` / `verify`,
// which run only the tests that can be affected by the files you changed.
//   tag  -> project files that tag exercises (a test with that tag "covers" them)
export const TAG_FILES = {
  engine: ['js/engine.js', 'js/app.js'],
  ask: ['js/ui.js', 'js/app.js', 'js/analysis.js', 'js/engine.js'],
  analysis: ['js/analysis.js', 'js/review.js', 'js/coach.js', 'js/meta.js'],
  ui: ['js/ui.js', 'js/board.js', 'js/util.js', 'js/meta.js', 'index.html', 'style.css'],
  layout: ['style.css', 'index.html', 'js/ui.js'],
  fetch: ['js/fetchgame.js', 'js/app.js'],
  store: ['js/store.js', 'js/analysis.js'],
  sw: ['js/sw.js', 'js/offline.js'],
  workflow: ['.github/workflows/deploy.yml'],
  chess: ['js/review.js', 'js/coach.js', 'js/analysis.js'],
  app: ['js/app.js', 'index.html'],
};
// Files that affect EVERYTHING that loads the page (a change here means: run it all).
export const GLOBAL_FILES = ['js/app.js', 'index.html'];

export const filesForTags = tags => [...new Set(tags.flatMap(t => TAG_FILES[t] || []))];

// Guess tags from a test name (so old tests did not need to be annotated one by one). Explicit tags in `meta` always win.
export function inferTags(name) {
  const t = new Set();
  const n = name.toLowerCase();
  if (/stockfish|engine|worker|uci|depth|multipv|hash|readyok|wasm|manifest|crash|hang/.test(n)) t.add('engine');
  if (/ask stockfish/.test(n)) t.add('ask');
  if (/coach|grades|navigation|explanation|board|keyboard/.test(n)) { t.add('ui'); t.add('analysis'); }
  if (/phone|screen|overflow|layout|viewport/.test(n)) t.add('layout');
  if (/lichess|chess\.com|link|input errors/.test(n)) t.add('fetch');
  if (/remembered|storage|stored|shared \(openings\)|finished positions/.test(n)) t.add('store');
  if (/service worker|downloaded once/.test(n)) t.add('sw');
  if (!t.size) t.add('app');
  return [...t];
}

// Which tests/suites to run for a set of changed project files.
//   `tests` is the merged list from `kit.mjs list`: [{ id, suite, tags, covers }]
export function affectedTests(changed, tests) {
  const ch = new Set(changed.map(f => f.replace(/^\.\//, '')));
  if (!ch.size) return [];
  const everything = [...ch].some(f => GLOBAL_FILES.includes(f));
  return tests.filter(t => {
    if (everything && t.suite === 'e2e') return true;
    const files = new Set([...(t.covers || []), ...filesForTags(t.tags || [])]);
    return [...ch].some(f => files.has(f)) || (t.suite === 'static');
  });
}
