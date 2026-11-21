// Static server that behaves like a GitHub Pages project site: served under /game-review/, correct MIME types,
// 10 minute cache, and NO cross-origin-isolation headers (so SharedArrayBuffer / multi-threaded WASM can't work).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
export function serve(dir, { base = '/game-review/', port = 0 } = {}) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push(`${req.method} ${url.pathname}`);
    if (!url.pathname.startsWith(base)) { res.writeHead(404); return res.end('not found'); }
    let rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'max-age=600' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok({ srv, log, url: `http://127.0.0.1:${srv.address().port}${base}`, close: () => new Promise(r => srv.close(r)) })));
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const s = await serve(path.resolve(process.argv[2] || 'build/site'));
  console.log('serving', s.url);
}
