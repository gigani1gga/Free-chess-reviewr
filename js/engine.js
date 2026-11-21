// Talks UCI to Stockfish. The worker is loaded from your own site (engine/), never a CDN.
export class Engine {
  async init() {
    const r = await fetch('engine/manifest.json');
    if (!r.ok) throw new Error('Engine files are missing. Run the GitHub Action first.');
    const { main } = await r.json();
    this.fns = new Set();
    this.w = new Worker('engine/' + main);
    this.w.onmessage = e => {
      const l = typeof e.data === 'string' ? e.data : '';
      this.fns.forEach(f => f(l));
    };
    this.w.onerror = e => console.error('Stockfish worker error', e);
    await this.ask('uci', 'uciok', 20000);
    this.w.postMessage('setoption name MultiPV value 2');
    await this.ask('isready', 'readyok', 20000);
  }

  ask(cmd, done, ms = 30000, onLine) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.fns.delete(f);
        rej(new Error('Stockfish did not respond in time.'));
      }, ms);
      const f = l => {
        if (onLine) onLine(l);
        if (l.startsWith(done)) { clearTimeout(t); this.fns.delete(f); res(l); }
      };
      this.fns.add(f);
      this.w.postMessage(cmd);
    });
  }

  // Returns up to 2 lines from the side to move's point of view: [{cp|mate, pv:[uci...]}]
  async analyze(fen, depth) {
    const lines = [];
    this.w.postMessage('position fen ' + fen);
    await this.ask('go depth ' + depth, 'bestmove', 60000, l => {
      if (!l.startsWith('info')) return;
      const s = / score (cp|mate) (-?\d+)/.exec(l);
      const p = / pv (.+)$/.exec(l);
      if (!s || !p) return;
      const k = +((/ multipv (\d+)/.exec(l) || [0, 1])[1]);
      lines[k - 1] = { [s[1]]: +s[2], pv: p[1].trim().split(' ') };
    });
    return lines.filter(Boolean);
  }
}
