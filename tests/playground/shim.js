// Injected into the app's index.html by the playground, before any app script. Controlled by query parameters on the page URL:
//   kit_cores=N  kit_mem=GB  kit_scale=N  kit_net=ok|slow|fail|timeout|empty   (the engine variant is chosen by a cookie)
(() => {
  const q = new URLSearchParams(location.search), post = m => { try { parent.postMessage({ kit: true, ...m }, '*'); } catch { /* */ } };
  const def = (o, k, v) => { try { Object.defineProperty(o, k, { get: () => v, configurable: true }); } catch { /* */ } };
  if (q.get('kit_cores')) def(Navigator.prototype, 'hardwareConcurrency', +q.get('kit_cores'));
  if (q.get('kit_mem')) def(Navigator.prototype, 'deviceMemory', +q.get('kit_mem'));
  // long app timeouts (>= 100 s) shortened so "the engine never answers" can be watched in seconds
  const scale = +(q.get('kit_scale') || 1), st = window.setTimeout.bind(window);
  if (scale > 1) window.setTimeout = (f, ms, ...a) => st(f, ms >= 100000 ? ms / scale : ms, ...a);

  // every Worker the app starts, and every UCI line in both directions
  const W = window.Worker; let n = 0;
  window.Worker = class extends W {
    constructor(u, o) {
      super(u, o); const id = ++n, name = String(u).split('/').pop(); post({ type: 'worker', id, name, event: 'start' });
      this.addEventListener('message', e => post({ type: 'uci', id, name, dir: '<', line: typeof e.data === 'string' ? e.data : JSON.stringify(e.data) }));
      this.addEventListener('error', e => post({ type: 'uci', id, name, dir: '!', line: 'worker error: ' + (e.message || 'failed to load') }));
      const pm = this.postMessage.bind(this); this.postMessage = (m, ...r) => { post({ type: 'uci', id, name, dir: '>', line: typeof m === 'string' ? m : JSON.stringify(m) }); return pm(m, ...r); };
      const tm = this.terminate.bind(this); this.terminate = () => { post({ type: 'worker', id, name, event: 'terminate' }); return tm(); };
    }
  };
  // console + errors
  for (const k of ['error', 'warn']) { const o = console[k].bind(console); console[k] = (...a) => { post({ type: 'console', level: k, text: a.map(x => x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x)).join(' ') }); o(...a); }; }
  addEventListener('error', e => post({ type: 'console', level: 'error', text: `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})` }));
  addEventListener('unhandledrejection', e => post({ type: 'console', level: 'error', text: 'unhandled rejection: ' + (e.reason?.stack || e.reason) }));
  setInterval(() => { const m = globalThis.__chessMisses; if (m && m.size) post({ type: 'console', level: 'error', text: 'STAND-IN LACKS chess.js: ' + [...m].join(', ') }); }, 2000);

  // Lichess / Chess.com behaviour
  const net = q.get('kit_net') || 'real';
  if (net !== 'real') {
    const real = window.fetch.bind(window), PGN = '[Event "Playground"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n';
    const CORS = { 'access-control-allow-origin': '*' };
    window.fetch = async (input, init) => {
      const url = String(input?.url || input), host = (() => { try { return new URL(url).host; } catch { return ''; } })();
      if (!/lichess\.org|chess\.com$/.test(host)) return real(input, init);
      post({ type: 'net', url, mode: net });
      if (net === 'fail') throw new TypeError('Failed to fetch');
      if (net === 'timeout') return new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      if (net === 'slow') await new Promise(r => st(r, 4000));
      if (net === 'empty') return new Response('', { status: 404, headers: CORS });
      if (host.endsWith('lichess.org')) return new Response(PGN, { status: 200, headers: { ...CORS, 'content-type': 'application/x-chess-pgn' } });
      if (/callback/.test(url)) return new Response('blocked', { status: 403, headers: CORS });
      return new Response(JSON.stringify({ games: [{ url: 'https://www.chess.com/game/live/1234567890', pgn: PGN }] }), { status: 200, headers: { ...CORS, 'content-type': 'application/json' } });
    };
  }
  post({ type: 'ready', cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory, net, scale });
})();
