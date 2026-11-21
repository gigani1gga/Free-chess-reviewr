// Talks UCI to Stockfish. Workers are loaded from your own site (engine/), never a CDN.
// "best": full-strength Stockfish (big neural net, ~94 MB). "fast": Lite build, several workers.
// Both are the single-threaded builds because GitHub Pages can't send the headers multi-threading needs, so extra speed
// comes from running whole positions in parallel, one position per worker.
const isMobile = () => navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
// The Lite build is tiny (about 2 MB plus a 16 MB hash per worker), so on a desktop it can use most of the cores. Phones and
// devices that report less than 4 GB stay at 3. One core is always left for the page.
const FAST_WORKERS = () => {
  const roomy = !isMobile() && (navigator.deviceMemory ?? 4) >= 4;
  return Math.max(1, Math.min(roomy ? 6 : 3, (navigator.hardwareConcurrency || 2) - 1));
};
// Every full-strength worker holds its own copy of the net plus its own hash, so a second one only runs where there is
// clearly room: a desktop browser that reports at least 8 GB (Chromium only; Firefox and Safari report nothing and keep
// one worker) and has 4 or more cores. Phones and small machines stay at one.
const BEST_WORKERS = () => (!isMobile() && (navigator.deviceMemory || 0) >= 8 && (navigator.hardwareConcurrency || 1) >= 4 ? 2 : 1);
const MULTIPV = 2;
const PROFILE = {
  best: { workers: BEST_WORKERS, hash: 64, label: 'full strength' },
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
    set('MultiPV', MULTIPV);
    set('Hash', PROFILE[this.kind].hash);
    // Stockfish's "contempt" makes the side to move look ~0.2 pawns better than it really is. Compared across
    // two positions (before / after a move) that bias reads as a loss on every single move, so switch it off.
    set('Contempt', 0);
    set('Analysis Contempt', 'Off');
    set('UCI_AnalyseMode', 'true');
    // Names this exact engine setup: a result saved on the device (store.js) is only reused when all of this matches.
    this.id = [this.main, this.name, 'mpv' + MULTIPV, 'hash' + PROFILE[this.kind].hash].join('|');
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
  // no-cache: GitHub Pages lets browsers keep files for 10 minutes, and an old manifest would point at engine files a new deploy replaced.
  const r = await fetch('engine/manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('Engine files are missing. Run the GitHub Action first.');
  const manifest = await r.json();
  const main = manifest[kind] || manifest.best || manifest.fast;
  if (!main) throw new Error('Engine files are missing. Run the GitHub Action first.');
  const engines = Array.from({ length: PROFILE[kind].workers() }, () => new Engine(main, kind));
  // The first engine starts alone when there are several full-strength ones: it downloads the engine files and the service
  // worker caches them, so the others start from the device instead of each downloading ~94 MB at the same time.
  let res;
  if (kind === 'best' && engines.length > 1) {
    const head = (await Promise.allSettled([engines[0].init()]))[0];
    res = [head, ...(head.status === 'fulfilled' ? await Promise.allSettled(engines.slice(1).map(e => e.init())) : [])];
  } else {
    res = await Promise.allSettled(engines.map(e => e.init()));
  }
  const ready = engines.filter((_, i) => res[i]?.status === 'fulfilled');
  engines.forEach(e => { if (!ready.includes(e)) e.terminate(); });
  if (!ready.length) throw res[0].reason;
  return ready;
}

export const disposePool = pool => pool.forEach(e => e.terminate());
