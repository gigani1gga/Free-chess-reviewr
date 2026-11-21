// Fake "Stockfish" web worker. It speaks UCI the way stockfish.js does (queues commands until its .wasm is loaded,
// replies with strings via postMessage) and plays by a tiny alpha-beta search. It is concatenated after
// chess-core.js by build-site.mjs, with a CONFIG line prepended. Strength is irrelevant; the protocol is what's tested.
/* global CONFIG, ChessCore, Chess */
const C = ChessCore;
const MATE = 30000;
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

const out = line => postMessage(line);
const queue = [];
let ready = false;

function evalSide(s) {
  let v = 0;
  for (let i = 0; i < 64; i++) {
    const p = s.board[i]; if (!p) continue;
    const t = p.toLowerCase(), sign = C.colorOf(p) === 'w' ? 1 : -1;
    const r = i >> 3, f = i & 7, centre = 3 - Math.max(Math.abs(r - 3.5), Math.abs(f - 3.5)) + 0.5;
    v += sign * (VAL[t] + (t === 'p' || t === 'k' ? 0 : centre * 4));
  }
  return s.turn === 'w' ? v : -v;
}

const capScore = (s, m) => {
  const v = s.board[m.to] ? VAL[s.board[m.to].toLowerCase()] : m.ep ? 100 : 0;
  return v * 10 - VAL[s.board[m.from].toLowerCase()] + (m.promo ? 800 : 0);
};

function qsearch(s, alpha, beta, depth) {
  const stand = evalSide(s);
  if (depth === 0 || stand >= beta) return stand;
  alpha = Math.max(alpha, stand);
  const caps = C.legal(s).filter(m => s.board[m.to] || m.ep || m.promo).sort((a, b) => capScore(s, b) - capScore(s, a));
  for (const m of caps) {
    const sc = -qsearch(C.apply(s, m), -beta, -alpha, depth - 1);
    if (sc >= beta) return sc;
    alpha = Math.max(alpha, sc);
  }
  return alpha;
}

function negamax(s, depth, alpha, beta, ply) {
  const ms = C.legal(s);
  if (!ms.length) return C.inCheck(s) ? -MATE + ply : 0;
  if (s.half >= 100) return 0;
  if (depth === 0) return qsearch(s, alpha, beta, CONFIG.qdepth);
  ms.sort((a, b) => capScore(s, b) - capScore(s, a));
  for (const m of ms) {
    const sc = -negamax(C.apply(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (sc >= beta) return sc;
    alpha = Math.max(alpha, sc);
  }
  return alpha;
}

function rootSearch(s, depth) {
  const res = C.legal(s).map(m => ({ m, sc: -negamax(C.apply(s, m), depth - 1, -MATE - 1, MATE + 1, 1) }));
  res.sort((a, b) => b.sc - a.sc);
  return res;
}

const uciMove = m => C.sqName(m.from) + C.sqName(m.to) + (m.promo || '');
const scoreStr = sc => {
  if (Math.abs(sc) > MATE - 200) {
    const p = MATE - Math.abs(sc);
    return sc > 0 ? `mate ${Math.ceil(p / 2)}` : `mate -${Math.floor(p / 2) || 1}`;
  }
  return `cp ${Math.round(sc)}`;
};

const MODERN = [
  'Debug Log File type string default <empty>', 'NumaPolicy type string default auto', 'Threads type spin default 1 min 1 max 1024',
  'Hash type spin default 16 min 1 max 33554432', 'Clear Hash type button', 'Ponder type check default false',
  'MultiPV type spin default 1 min 1 max 256', 'Skill Level type spin default 20 min 0 max 20', 'Move Overhead type spin default 10 min 0 max 5000',
  'nodestime type spin default 0 min 0 max 10000', 'UCI_Chess960 type check default false', 'UCI_LimitStrength type check default false',
  'UCI_Elo type spin default 1320 min 1320 max 3190', 'UCI_ShowWDL type check default false', 'SyzygyPath type string default <empty>',
];
const LEGACY = [
  'Debug Log File type string default', 'Contempt type spin default 24 min -100 max 100', 'Analysis Contempt type combo default Both var Off var White var Black var Both',
  'Threads type spin default 1 min 1 max 512', 'Hash type spin default 16 min 1 max 131072', 'Clear Hash type button', 'Ponder type check default false',
  'MultiPV type spin default 1 min 1 max 500', 'UCI_AnalyseMode type check default false', 'UCI_Chess960 type check default false',
];

let state = C.parseFen(C.START_FEN), multipv = 1;

function handle(cmd) {
  const [w, ...rest] = cmd.trim().split(/\s+/);
  if (w === 'uci') {
    out(`id name ${CONFIG.name}`);
    out('id author the Stockfish developers (see AUTHORS file)');
    (CONFIG.options === 'legacy' ? LEGACY : MODERN).forEach(o => out('option name ' + o));
    out('uciok');
  } else if (w === 'isready') {
    if (CONFIG.behavior !== 'no-readyok') out('readyok');
  } else if (w === 'setoption') {
    const m = /^setoption name (.+?)(?: value (.*))?$/.exec(cmd.trim());
    if (m && m[1] === 'MultiPV') multipv = +m[2];
    const known = m && (CONFIG.options === 'legacy' ? LEGACY : MODERN).some(o => o.startsWith(m[1] + ' type'));
    if (m && !known) out(`No such option: ${m[1]}`);
  } else if (w === 'position') {
    if (rest[0] === 'fen') state = C.parseFen(rest.slice(1).join(' '));
    else state = C.parseFen(C.START_FEN);
  } else if (w === 'go') {
    const d = +(rest[rest.indexOf('depth') + 1] || 12);
    if (CONFIG.behavior === 'no-bestmove') { out('info string search started'); return; }
    const t0 = Date.now();
    const cache = {};
    for (let dd = 1; dd <= d; dd++) {
      const sd = Math.min(dd, CONFIG.cap);
      const res = cache[sd] || (cache[sd] = rootSearch(state, sd));
      if (!res.length) break;
      if (dd === 1) out('info string NNUE evaluation using nn-mock.nnue');
      for (let k = 0; k < Math.min(multipv, res.length); k++) {
        const r = res[k];
        out(`info depth ${dd} seldepth ${dd + 2} multipv ${k + 1} score ${scoreStr(r.sc)} nodes ${dd * 1000} nps 900000 hashfull 3 tbhits 0 time ${Date.now() - t0} pv ${uciMove(r.m)}`);
      }
      // A bound line that must be ignored (real engines emit these on aspiration-window fails).
      if (dd === d) out(`info depth ${dd} seldepth ${dd} multipv 1 score cp 9999 lowerbound nodes 5 time 1 pv ${uciMove(res[0].m)}`);
      if (CONFIG.behavior === 'garbage' && dd === d) { out('info depth 1 currmove e2e4 currmovenumber 1'); out(''); }
    }
    const res = cache[Math.min(d, CONFIG.cap)];
    out(res && res.length ? `bestmove ${uciMove(res[0].m)}` : 'bestmove (none)');
  }
  // 'stop', 'ucinewgame', 'quit': nothing to do for a synchronous mock.
}

onmessage = e => { if (ready) setTimeout(() => handle(String(e.data)), 0); else queue.push(String(e.data)); };

if (CONFIG.behavior === 'crash') throw new Error('mock wasm abort');

// Real stockfish.js fetches <same name>.wasm; if it is missing the engine never comes up. Mimic that.
const wasmUrl = self.location.href.replace(/\.js(\?.*)?$/, '.wasm');
fetch(wasmUrl).then(r => {
  if (!r.ok) throw new Error('wasm ' + r.status);
  return r.arrayBuffer();
}).then(buf => {
  setTimeout(() => {
    ready = true;
    if (CONFIG.behavior === 'wasm-size-note') out('info string wasm bytes ' + buf.byteLength);
    queue.splice(0).forEach(c => setTimeout(() => handle(c), 0));
  }, CONFIG.loadDelay || 0);
}).catch(() => { /* stay silent forever, like the real thing when the wasm is missing */ });
