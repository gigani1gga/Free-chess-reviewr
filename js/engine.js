// Talks UCI to Stockfish. Workers are loaded from your own site (engine/), never a CDN.
// "best": full-strength Stockfish (big neural net, ~94 MB, one worker is plenty). "fast": Lite build, a few workers.
// Both are the single-threaded builds because GitHub Pages can't send the headers multi-threading needs.
const FAST_WORKERS = () => Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
const PROFILE = {
  best: { workers: () => 1, hash: 64, label: 'full strength' },
  fast: { workers: FAST_WORKERS, hash: 16, label: 'lite' },
};
const LOAD_MS = 240000; // the first load downloads the engine, so be patient

export class Engine {
  constructor(main, kind) {
    this.main = main;
    this.kind = kind;
    this.pending = new Set();
  }

  async init() {
    this.w = new Worker('engine/' + this.main);
    this.w.onmessage = e => {
      const line = typeof e.data === 'string' ? e.data : '';
      for (const p of [...this.pending]) p.line(line);
    };
    this.w.onerror = () => this.fail(new Error('Stockfish crashed.'));
    const options = new Set();
    await this.ask('uci', 'uciok', LOAD_MS, l => {
      if (l.startsWith('id name ')) this.name = l.slice(8).trim();
      const o = /^option name (.+?) type /.exec(l);
      if (o) options.add(o[1]);
    });
    const set = (name, value) => options.has(name) && this.send(`setoption name ${name} value ${value}`);
    set('MultiPV', 2);
    set('Hash', PROFILE[this.kind].hash);
    // Stockfish's "contempt" makes the side to move look ~0.2 pawns better than it really is. Compared across
    // two positions (before / after a move) that bias reads as a loss on every single move, so switch it off.
    set('Contempt', 0);
    set('Analysis Contempt', 'Off');
    set('UCI_AnalyseMode', 'true');
    await this.ask('isready', 'readyok', LOAD_MS);
    return this;
  }

  send(cmd) { this.w.postMessage(cmd); }

  // Send a command and resolve with the first line starting with `done`; `onLine` sees every line.
  ask(cmd, done, ms = 30000, onLine) {
    return new Promise((res, rej) => {
      const finish = () => { clearTimeout(t); this.pending.delete(p); };
      const p = {
        line: l => {
          onLine?.(l);
          if (l.startsWith(done)) { finish(); res(l); }
        },
        rej: err => { finish(); rej(err); },
      };
      const t = setTimeout(() => { this.send('stop'); p.rej(new Error('Stockfish did not respond in time.')); }, ms);
      this.pending.add(p);
      this.send(cmd);
    });
  }

  fail(err) { for (const p of [...this.pending]) p.rej(err); }

  terminate() {
    this.fail(new Error('Cancelled.'));
    this.w?.terminate();
  }

  // Up to 2 lines from the side to move's point of view: [{cp|mate, pv:[uci...]}]
  async analyze(fen, depth) {
    const lines = [];
    this.send('position fen ' + fen);
    await this.ask('go depth ' + depth, 'bestmove', 120000, l => {
      if (!l.startsWith('info') || / (lower|upper)bound/.test(l)) return;
      const s = / score (cp|mate) (-?\d+)/.exec(l);
      const p = / pv (.+)$/.exec(l);
      if (!s || !p) return;
      const k = +(/ multipv (\d+)/.exec(l)?.[1] ?? 1);
      lines[k - 1] = { [s[1]]: +s[2], pv: p[1].trim().split(' ') };
    });
    return lines.filter(Boolean);
  }
}

// Starts the engine(s) for a profile. Falls back to however many workers managed to start; throws only if none did.
export async function createPool(kind = 'best') {
  const r = await fetch('engine/manifest.json');
  if (!r.ok) throw new Error('Engine files are missing. Run the GitHub Action first.');
  const manifest = await r.json();
  const main = manifest[kind] || manifest.best || manifest.fast;
  if (!main) throw new Error('Engine files are missing. Run the GitHub Action first.');
  const engines = Array.from({ length: PROFILE[kind].workers() }, () => new Engine(main, kind));
  const res = await Promise.allSettled(engines.map(e => e.init()));
  const ready = engines.filter((_, i) => res[i].status === 'fulfilled');
  engines.forEach(e => { if (!ready.includes(e)) e.terminate(); });
  if (!ready.length) throw res[0].reason;
  return ready;
}

export const disposePool = pool => pool.forEach(e => e.terminate());
