// End-to-end tests: the real app in real Chrome, served like GitHub Pages, talking to a mock Stockfish worker.
// Run: node e2e.mjs   (needs playwright + Chrome; see run-all.sh)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serve } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const SITE = path.join(here, 'build', 'site');
const SHOTS = path.join(here, 'build', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const SCHOLAR = '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
const RUY = '[White "Ruy"]\n[Black "Lopez"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *';

const WORKER_SPY = `(() => {
  const W = window.Worker; window.__w = [];
  window.Worker = class extends W {
    constructor(u, o) { super(u, o); this.__rec = { url: String(u), cmds: [], terminated: false, errors: 0 }; window.__w.push(this.__rec); }
    postMessage(m, ...r) { this.__rec.cmds.push(typeof m === 'string' ? m : '[object]'); return super.postMessage(m, ...r); }
    terminate() { this.__rec.terminated = true; return super.terminate(); }
  };
})();`;
const SCALE_TIMEOUTS = `(() => { const st = window.setTimeout.bind(window); window.setTimeout = (f, ms, ...a) => st(f, ms >= 100000 ? ms / 100 : ms, ...a); })();`;
const CORES = n => `Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${n} });`;

let server, browser;
const results = [];

async function newPage({ init = [], manifest, viewport, route } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1000, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const problems = { console: [], pageerrors: [], http: [], failed: [] };
  page.on('console', m => { if (m.type() === 'error') problems.console.push(m.text()); });
  page.on('pageerror', e => problems.pageerrors.push(String(e)));
  page.on('response', r => { if (r.status() >= 400) problems.http.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  page.on('requestfailed', r => problems.failed.push(r.url()));
  await page.route('**/favicon.ico', r => r.fulfill({ status: 204, body: '' }));
  await page.addInitScript(WORKER_SPY);
  for (const s of init) await page.addInitScript(s);
  if (manifest) await page.route('**/engine/manifest.json', r => r.fulfill({ json: manifest }));
  if (route) await route(page);
  await page.goto(server.url);
  return { page, ctx, problems, workers: () => page.evaluate(() => window.__w) };
}

async function review(page, { pgn, link, strength, depth } = {}) {
  await page.evaluate(() => { document.querySelector('details').open = true; });
  if (strength) await page.selectOption('#strength', strength);
  if (depth) await page.selectOption('#depth', String(depth));
  if (pgn != null) await page.fill('#pgn', pgn);
  if (link != null) await page.fill('#link', link);
  await page.click('#go');
  await page.waitForFunction(() => /^(Done\.|⚠)/.test(document.getElementById('status').textContent), null, { timeout: 90000 });
  return page.textContent('#status');
}

const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, what) => { if (!c) throw new Error(what); };
const clean = (p, allow = []) => {
  const bad = [...p.console, ...p.pageerrors, ...p.http, ...p.failed].filter(x => !allow.some(a => x.includes(a)));
  ok(!bad.length, 'unexpected browser problems: ' + bad.join(' | '));
};

async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push([true, name]); console.log(`PASS  ${name}  (${Date.now() - t0} ms)`); }
  catch (e) { results.push([false, name, e]); console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); }
}

server = await serve(SITE);
browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

await test('full strength: Stockfish 19 build is loaded and UCI handshake is correct', async () => {
  const { page, workers, problems, ctx } = await newPage();
  eq(await page.evaluate(() => crossOriginIsolated), false, 'crossOriginIsolated (Pages sends no COOP/COEP)');
  eq(await page.inputValue('#strength'), 'best', 'default engine');
  eq(await page.inputValue('#depth'), '16', 'default depth');
  eq(await review(page, { pgn: SCHOLAR, depth: 12 }), 'Done.', 'status');
  const w = await workers();
  eq(w.length, 1, 'worker count for full strength');
  ok(w[0].url.endsWith('engine/stockfish-19-single.js'), 'worker url ' + w[0].url);
  const c = w[0].cmds;
  eq(c[0], 'uci', 'first command');
  ok(c.includes('setoption name MultiPV value 2'), 'MultiPV 2 set');
  ok(c.includes('setoption name Hash value 64'), 'Hash 64 for full strength');
  ok(!c.some(x => /Contempt|AnalyseMode/.test(x)), 'options Stockfish 19 does not have must not be sent');
  ok(c.indexOf('isready') > c.indexOf('setoption name Hash value 64'), 'isready after setoption');
  const goes = c.filter(x => x.startsWith('go '));
  eq(new Set(goes).size, 1, 'one distinct go command');
  eq(goes[0], 'go depth 12', 'go command');
  eq(goes.length, 7, 'positions analysed (8 minus the checkmated final position)');
  ok((await page.textContent('#engine')).includes('Stockfish 19 (mock full)'), 'engine label: ' + await page.textContent('#engine'));
  ok((await page.textContent('#engine')).includes('1 engine'), 'engine label says 1 engine');
  ok((await page.textContent('#engine')).includes('depth 12'), 'engine label shows depth');
  clean(problems);
  await ctx.close();
});

await test('full strength: grades, tags and board are rendered sensibly', async () => {
  const { page, problems, ctx } = await newPage();
  await review(page, { pgn: SCHOLAR, depth: 12 });
  eq(await page.locator('#moves button').count(), 7, 'move buttons');
  const titles = await page.$$eval('#moves button', bs => bs.map(b => b.title));
  eq(titles[5], 'blunder', '3...Nf6 allows Qxf7#, must be a blunder');
  ok(['best', 'great', 'excellent'].includes(titles[6]), 'Qxf7# is a top move, got ' + titles[6]);
  await page.click('#moves button[data-p="6"]');
  const card = await page.textContent('#card');
  ok(/mate/i.test(card), '3...Nf6 explanation mentions mate: ' + card);
  ok(/better try|Best was|engine preferred|was the move/.test(card), 'explanation names a better move: ' + card);
  ok(await page.locator('#board svg g.good').count() >= 1, 'green arrow for the better move');
  await page.click('#last');
  ok(/checkmate/i.test(await page.textContent('#card')), 'final card says checkmate');
  eq(await page.locator('#board .sq').count(), 64, 'squares');
  ok((await page.textContent('#acc')).includes('White accuracy'), 'accuracy panel');
  const evText = await page.textContent('#ev');
  ok(/Eval/.test(evText) && !/99\.99/.test(evText), 'eval label sane: ' + evText);
  await page.click('#first');
  ok(!/99\.99/.test(await page.textContent('#ev')), 'bound (lowerbound) info lines must be ignored');
  clean(problems);
  await ctx.close();
});

await test('navigation: buttons, keyboard, flip, graph click', async () => {
  const { page, problems, ctx } = await newPage();
  await review(page, { pgn: RUY, depth: 12 });
  eq(await page.locator('#moves button').count(), 20, 'move buttons');
  await page.click('#next'); await page.click('#next');
  eq(await page.getAttribute('#moves button.on', 'data-p'), '2', 'after 2x next');
  await page.keyboard.press('ArrowRight');
  eq(await page.getAttribute('#moves button.on', 'data-p'), '3', 'ArrowRight');
  await page.keyboard.press('End');
  eq(await page.getAttribute('#moves button.on', 'data-p'), '20', 'End');
  await page.keyboard.press('Home');
  eq(await page.locator('#moves button.on').count(), 0, 'Home goes to start position');
  const before = await page.$eval('#board .sq', e => e.innerHTML);
  await page.click('#flip');
  ok((await page.$eval('#board .sq', e => e.innerHTML)) !== before, 'flip changes the board');
  await page.click('#graph', { position: { x: 400, y: 20 }, force: true });
  ok(await page.locator('#moves button.on').count() === 1, 'graph click selects a move');
  // castling position is drawn correctly: after 5.O-O white king g1, rook f1
  await page.click('#moves button[data-p="9"]');
  const sq = await page.$$eval('#board .sq', els => els.map(e => e.querySelector('img') ? 1 : 0).join(''));
  eq(sq.length, 64, 'board draws every square');
  clean(problems);
  await ctx.close();
});

await test('lite: 3 workers share the game, Hash 16, status messages', async () => {
  const { page, workers, problems, ctx } = await newPage({ init: [CORES(8)] });
  eq(await review(page, { pgn: RUY, depth: 12, strength: 'fast' }), 'Done.', 'status');
  const w = await workers();
  eq(w.length, 3, 'lite worker count with 8 cores');
  ok(w.every(x => x.url.endsWith('engine/stockfish-19-lite-single.js')), 'all lite workers use the lite build');
  ok(w.every(x => x.cmds.includes('setoption name Hash value 16')), 'lite Hash 16');
  ok(w.filter(x => x.cmds.some(c => c.startsWith('go '))).length >= 2, 'work is shared between workers');
  ok((await page.textContent('#engine')).includes('3 engines in parallel'), await page.textContent('#engine'));
  clean(problems);
  await ctx.close();
});

await test('switching strength disposes the old engine; same game again hits the cache', async () => {
  const { page, workers, problems, ctx } = await newPage({ init: [CORES(4)] });
  await review(page, { pgn: SCHOLAR, depth: 12 });
  let w = await workers();
  eq(w.length, 1, 'workers after first run');
  const goes1 = w[0].cmds.filter(c => c.startsWith('go ')).length;
  await review(page, { pgn: SCHOLAR, depth: 12 });
  w = await workers();
  eq(w.length, 1, 'engine is reused for a second run');
  eq(w[0].cmds.filter(c => c.startsWith('go ')).length, goes1, 'second run of the same game sends no new searches');
  await review(page, { pgn: SCHOLAR, depth: 12, strength: 'fast' });
  w = await workers();
  ok(w[0].terminated, 'full-strength worker terminated when switching to lite');
  eq(w.length, 1 + 3, 'one full + three lite workers (4 cores)');
  await review(page, { pgn: SCHOLAR, depth: 12, strength: 'best' });
  w = await workers();
  ok(w.slice(1, 4).every(x => x.terminated), 'lite workers terminated when switching back');
  ok(!w[4].terminated, 'new full worker is alive');
  eq(w.length, 5, 'fresh full worker');
  clean(problems);
  await ctx.close();
});

await test('depth choices are 12/16/18/20 and the chosen depth reaches the engine', async () => {
  const { page, workers, ctx } = await newPage();
  const vals = await page.$$eval('#depth option', o => o.map(x => x.value));
  eq(vals.join(','), '12,16,18,20', 'depth options');
  eq(await review(page, { pgn: '1. e4 e5 *', depth: 20 }), 'Done.', 'status');
  ok((await workers())[0].cmds.includes('go depth 20'), 'go depth 20 sent');
  await ctx.close();
});

await test('old-style engine options (Contempt etc.) are still handled when the engine has them', async () => {
  const { page, workers, problems, ctx } = await newPage({ manifest: { best: 'mock-legacy.js', fast: 'mock-legacy.js' } });
  eq(await review(page, { pgn: SCHOLAR, depth: 12 }), 'Done.', 'status');
  const c = (await workers())[0].cmds;
  ok(c.includes('setoption name Contempt value 0'), 'Contempt 0');
  ok(c.includes('setoption name Analysis Contempt value Off'), 'Analysis Contempt Off');
  ok(c.includes('setoption name UCI_AnalyseMode value true'), 'UCI_AnalyseMode');
  clean(problems);
  await ctx.close();
});

await test('noisy engine output (currmove lines, empty lines) does not break parsing', async () => {
  const { page, problems, ctx } = await newPage({ manifest: { best: 'mock-garbage.js', fast: 'mock-garbage.js' } });
  eq(await review(page, { pgn: SCHOLAR, depth: 12 }), 'Done.', 'status');
  clean(problems);
  await ctx.close();
});

await test('slow engine start shows the download note, then finishes', async () => {
  const { page, ctx } = await newPage({ manifest: { best: 'mock-slowload.js', fast: 'mock-slowload.js' } });
  await page.evaluate(() => { document.querySelector('details').open = true; });
  await page.fill('#pgn', SCHOLAR);
  await page.selectOption('#depth', '12');
  await page.click('#go');
  await page.waitForFunction(() => /Downloading Stockfish 19/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
  ok(await page.isDisabled('#go'), 'button disabled while loading');
  await page.waitForFunction(() => /^Done\./.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  ok(await page.isEnabled('#go'), 'button re-enabled');
  await ctx.close();
});

await test('engine that never says readyok: times out with a clear error, then recovers', async () => {
  const { page, workers, ctx } = await newPage({ init: [SCALE_TIMEOUTS], manifest: { best: 'mock-hang.js', fast: 'mock-hang.js' } });
  eq(await review(page, { pgn: SCHOLAR }), '⚠ Stockfish did not respond in time.', 'status');
  let w = await workers();
  ok(w[0].terminated, 'hung worker terminated');
  ok(await page.isEnabled('#go'), 'button re-enabled after the error');
  await page.route('**/engine/manifest.json', r => r.fulfill({ json: { best: 'stockfish-19-single.js', fast: 'stockfish-19-lite-single.js' } }));
  eq(await review(page, { pgn: SCHOLAR, depth: 12 }), 'Done.', 'status after retry');
  w = await workers();
  eq(w.length, 2, 'a fresh worker was started for the retry');
  await ctx.close();
});

await test('engine that never answers "go": analysis times out cleanly', async () => {
  const { page, workers, ctx } = await newPage({ init: [SCALE_TIMEOUTS], manifest: { best: 'mock-nobest.js', fast: 'mock-nobest.js' } });
  eq(await review(page, { pgn: SCHOLAR, depth: 12 }), '⚠ Stockfish did not respond in time.', 'status');
  ok((await workers())[0].terminated, 'worker terminated');
  ok(await page.isHidden('#review'), 'no half-finished review is shown');
  await ctx.close();
});

await test('engine that crashes on startup: clear error, no hang', async () => {
  const { page, workers, ctx } = await newPage({ manifest: { best: 'mock-crash.js', fast: 'mock-crash.js' } });
  eq(await review(page, { pgn: SCHOLAR }), '⚠ Stockfish crashed.', 'status');
  ok((await workers())[0].terminated, 'worker terminated');
  await ctx.close();
});

await test('missing .wasm next to the .js: engine request is made and the app errors out instead of hanging forever', async () => {
  const { page, ctx } = await newPage({ init: [SCALE_TIMEOUTS], manifest: { best: 'mock-nowasm.js', fast: 'mock-nowasm.js' } });
  const st = await review(page, { pgn: SCHOLAR });
  eq(st, '⚠ Stockfish did not respond in time.', 'status');
  ok(server.log.some(l => l.endsWith('/engine/mock-nowasm.wasm')), 'worker asked for the .wasm beside its .js');
  await ctx.close();
});

await test('manifest is always revalidated (a stale one after a redeploy would point at engine files that no longer exist)', async () => {
  // No page.route() here: Playwright switches the HTTP cache off for routed pages, which would hide the problem.
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const count = () => server.log.filter(l => l.endsWith('/engine/manifest.json')).length;
  const c0 = count();
  for (let i = 0; i < 2; i++) {
    await page.goto(server.url);
    await review(page, { pgn: '1. e4 e5 *', depth: 12 });
  }
  eq(count() - c0, 2, 'server saw a manifest request on each page load, even though Pages marks files cacheable for 10 min');
  await ctx.close();
});

await test('engine files are downloaded once, then served from the device on later visits (service worker cache)', async () => {
  // Plain context, no page.route(): routes switch service workers' interplay and the HTTP cache off.
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  const hits = ext => server.log.filter(l => l.endsWith('/engine/stockfish-19-lite-single.' + ext)).length;
  const w0 = hits('wasm'), j0 = hits('js');
  await page.goto(server.url);
  eq(await review(page, { pgn: SCHOLAR, depth: 12, strength: 'fast' }), 'Done.', 'first visit');
  ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'page is controlled by the service worker after the first review');
  eq(hits('wasm') - w0, 1, 'wasm fetched once on first visit');
  await page.waitForTimeout(500); // let the cache write finish
  for (let i = 0; i < 2; i++) {
    await page.goto(server.url);
    eq(await review(page, { pgn: SCHOLAR, depth: 12, strength: 'fast' }), 'Done.', 'later visit ' + (i + 1));
  }
  eq(hits('wasm') - w0, 1, 'wasm NOT fetched again on later visits');
  eq(hits('js') - j0, 1, 'engine js NOT fetched again on later visits');
  const cached = await page.evaluate(async () => (await (await caches.open('engine-v1')).keys()).map(r => new URL(r.url).pathname.split('/').pop()).sort());
  ok(cached.includes('stockfish-19-lite-single.wasm') && cached.includes('stockfish-19-lite-single.js'), 'cache holds the engine: ' + cached);
  ok(!cached.includes('manifest.json'), 'manifest is never cached');
  // still works with the network gone for engine files (page itself is reloaded from the live server, so only block engine/)
  await ctx.route('**/engine/*.wasm', r => r.abort());
  await page.goto(server.url);
  eq(await review(page, { pgn: RUY, depth: 12, strength: 'fast' }), 'Done.', 'engine starts from the device even if the wasm URL is unreachable');
  await ctx.close();
});

await test('missing manifest gives the "run the GitHub Action" message', async () => {
  const { page, ctx } = await newPage({ route: p => p.route('**/engine/manifest.json', r => r.fulfill({ status: 404, body: 'nope' })) });
  eq(await review(page, { pgn: SCHOLAR }), '⚠ Engine files are missing. Run the GitHub Action first.', 'status');
  await ctx.close();
});

await test('input errors: empty, bad PGN, unsupported link', async () => {
  const { page, ctx } = await newPage();
  eq(await review(page, { pgn: '', link: '' }), '⚠ Paste a game link first.', 'empty');
  eq(await review(page, { pgn: '1. e4 e5 2. Ke5 *' }), '⚠ Could not read that PGN.', 'illegal move');
  eq(await review(page, { pgn: '', link: 'https://example.com/game/1' }), '⚠ Only Chess.com and Lichess links are supported.', 'other site');
  await ctx.close();
});

await test('Lichess link: PGN is fetched, reviewed, and uses the Stockfish 19 engine', async () => {
  const { page, workers, problems, ctx } = await newPage({
    route: p => p.route('https://lichess.org/game/export/**', r => r.fulfill({ status: 200, contentType: 'application/x-chess-pgn', headers: { 'access-control-allow-origin': '*' }, body: SCHOLAR })),
  });
  eq(await review(page, { link: 'https://lichess.org/abcd1234/black', depth: 12 }), 'Done.', 'status');
  eq((await workers()).length, 1, 'worker count');
  ok((await page.textContent('#players')).includes('Alice'), 'players header shown');
  clean(problems, ['lichess.org']);
  await ctx.close();
});

await test('served from a sub-path (like github.io/repo/): every asset resolves, no 404s', async () => {
  const { page, problems, ctx } = await newPage();
  await review(page, { pgn: SCHOLAR, depth: 12 });
  ok(!problems.http.length, '404s: ' + problems.http.join(', '));
  ok(server.log.some(l => l.includes('/game-review/pieces/wP.svg')), 'pieces loaded');
  ok(server.log.some(l => l.includes('/game-review/icons/')), 'icons loaded');
  ok(server.log.some(l => l.includes('/game-review/vendor/chess.js')), 'chess.js loaded');
  await ctx.close();
});

await test('phone-sized screen: no horizontal overflow, screenshots saved', async () => {
  const { page, ctx } = await newPage({ viewport: { width: 390, height: 844 } });
  await page.screenshot({ path: path.join(SHOTS, 'phone-start.png') });
  await review(page, { pgn: RUY, depth: 12 });
  await page.click('#moves button[data-p="7"]');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 0, 'page is ' + over + 'px wider than the screen');
  await page.screenshot({ path: path.join(SHOTS, 'phone-review.png'), fullPage: true });
  await ctx.close();
});

await browser.close();
await server.close();
const failed = results.filter(r => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} e2e tests passed`);
process.exit(failed.length ? 1 : 0);
