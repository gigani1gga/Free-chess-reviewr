// The playground: the built site in an iframe, next to a panel that shows what the app and its engine are doing and lets you
// change the world around it (engine variant, CPU cores, memory, phone size, Lichess/Chess.com behaviour) and run the tests.
//   node kit.mjs play [--port 7777] [--no-open]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildDir, kitRoot, siteDir } from '../lib/env.mjs';
import { GAMES } from '../lib/games.mjs';

const { values: A } = parseArgs({ args: process.argv.slice(2), strict: false, options: { port: { type: 'string' }, 'no-open': { type: 'boolean' } } });
const SITE = siteDir(), BASE = '/game-review/';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };
const here = f => path.join(kitRoot, 'playground', f);
const cookie = (req, k) => (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(([n]) => n === k)?.[1];
const variants = () => { try { return JSON.parse(fs.readFileSync(path.join(SITE, '__kit.json'), 'utf8')).variants; } catch { return []; } };
const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p === '/') return send(res, 200, MIME['.html'], fs.readFileSync(here('index.html')));
  if (p === '/__kit/shim.js') return send(res, 200, MIME['.js'], fs.readFileSync(here('shim.js')));
  if (p === '/__kit/info.json') return send(res, 200, MIME['.json'], JSON.stringify({ variants: variants(), games: Object.entries(GAMES).map(([id, g]) => ({ id, name: g.name, plies: g.plies, pgn: g.pgn })) }));
  if (p === '/__kit/set') { const e = url.searchParams.get('engine') || ''; res.setHeader('set-cookie', `kit_engine=${/^[\w-]*$/.test(e) ? e : ''}; Path=/; SameSite=Lax`); return send(res, 200, MIME['.json'], '{"ok":true}'); }
  if (p === '/__kit/api/list') return kit(res, ['list', '--json']);
  if (p === '/__kit/api/report') { const f = path.join(buildDir, 'report.md'); return send(res, 200, 'text/plain; charset=utf-8', fs.existsSync(f) ? fs.readFileSync(f) : 'No report yet: run some tests.'); }
  if (p === '/__kit/api/run') return stream(req, res, url.searchParams.get('args') || '');
  if (!p.startsWith(BASE)) { res.writeHead(404); return res.end('not found'); }
  let rel = decodeURIComponent(p.slice(BASE.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(SITE, rel);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  if (rel === 'engine/manifest.json') {
    const v = cookie(req, 'kit_engine');
    if (v && fs.existsSync(path.join(SITE, 'engine', v + '.js'))) return send(res, 200, MIME['.json'], JSON.stringify({ best: v + '.js', fast: v + '.js' }));
  }
  if (rel === 'index.html') { // the shim must run before any app script
    const html = fs.readFileSync(file, 'utf8').replace(/<head[^>]*>/i, m => `${m}<script src="/__kit/shim.js"></script>`);
    return send(res, 200, MIME['.html'], html);
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

function kit(res, args) {
  const p = spawn(process.execPath, [path.join(kitRoot, 'kit.mjs'), ...args], { cwd: kitRoot, env: process.env });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.on('close', () => send(res, 200, MIME['.json'], out || '{}'));
}
let running = null;
function stream(req, res, args) {
  if (!/^[\w ./:^$|()\-,=']*$/.test(args) || /\b(play|mutate|book)\b/.test(args)) return send(res, 400, 'text/plain', 'bad args');
  if (running) return send(res, 409, 'text/plain', 'a run is already in progress');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const argv = (args.match(/'[^']*'|\S+/g) || []).map(s => s.replace(/^'|'$/g, ''));
  const p = running = spawn(process.execPath, [path.join(kitRoot, 'kit.mjs'), ...argv, '--human'], { cwd: kitRoot, env: process.env });
  const w = d => res.write(String(d).split('\n').map(l => `data: ${l}\n`).join('') + '\n');
  p.stdout.on('data', w); p.stderr.on('data', w);
  p.on('close', code => { running = null; res.write(`event: done\ndata: ${code}\n\n`); res.end(); });
  req.on('close', () => { if (running === p) p.kill(); });
}

server.listen(+(A.port || 7777), '127.0.0.1', () => {
  const port = server.address().port, url = `http://127.0.0.1:${port}/`;
  console.log(`playground: ${url}   (Ctrl+C to stop)`);
  if (!A['no-open'] && process.stdout.isTTY) spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', url] : [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
});
