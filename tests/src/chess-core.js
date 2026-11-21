// Minimal stand-in for chess.js v1 (only the API the app uses). npm is unavailable in the test sandbox, so the
// test site gets this file as vendor/chess.js, and the mock engine reuses it for move generation.
// It is validated against known perft counts in tests/perft.mjs, so the tests don't rest on an unchecked rewrite.
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES = 'abcdefgh';
const sqName = i => FILES[i & 7] + (8 - (i >> 3));
const sqIdx = s => (8 - +s[1]) * 8 + FILES.indexOf(s[0]);
const isW = p => p === p.toUpperCase();
const colorOf = p => (isW(p) ? 'w' : 'b');
const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const BD = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const RD = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function parseFen(fen) {
  const [pl, turn, cast, ep, half, full] = fen.trim().split(/\s+/);
  const board = new Array(64).fill(null);
  let i = 0;
  for (const ch of pl) {
    if (ch === '/') continue;
    if (/\d/.test(ch)) i += +ch; else board[i++] = ch;
  }
  if (i !== 64) throw new Error('Invalid FEN: ' + fen);
  return { board, turn, cast: cast === '-' ? '' : cast, ep: ep && ep !== '-' ? sqIdx(ep) : -1, half: +half || 0, full: +full || 1 };
}

function toFen(s) {
  let pl = '';
  for (let r = 0; r < 8; r++) {
    let e = 0;
    for (let f = 0; f < 8; f++) {
      const p = s.board[r * 8 + f];
      if (!p) e++; else { if (e) pl += e; e = 0; pl += p; }
    }
    if (e) pl += e;
    if (r < 7) pl += '/';
  }
  return `${pl} ${s.turn} ${s.cast || '-'} ${s.ep >= 0 ? sqName(s.ep) : '-'} ${s.half} ${s.full}`;
}

// Squares of `by`-coloured pieces that attack `sq` (pins ignored, like chess.js).
function attackersOf(board, sq, by) {
  const out = [], r = sq >> 3, f = sq & 7, w = by === 'w';
  const at = (rr, ff) => (rr < 0 || rr > 7 || ff < 0 || ff > 7 ? null : board[rr * 8 + ff]);
  const pr = w ? r + 1 : r - 1, pp = w ? 'P' : 'p';
  for (const df of [-1, 1]) if (at(pr, f + df) === pp) out.push(pr * 8 + f + df);
  for (const [dr, df] of KN) if (at(r + dr, f + df) === (w ? 'N' : 'n')) out.push((r + dr) * 8 + f + df);
  for (const [dr, df] of KG) if (at(r + dr, f + df) === (w ? 'K' : 'k')) out.push((r + dr) * 8 + f + df);
  const slide = (dirs, kinds) => {
    for (const [dr, df] of dirs) {
      let rr = r + dr, ff = f + df;
      while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
        const p = board[rr * 8 + ff];
        if (p) { if (colorOf(p) === by && kinds.includes(p.toUpperCase())) out.push(rr * 8 + ff); break; }
        rr += dr; ff += df;
      }
    }
  };
  slide(BD, 'BQ'); slide(RD, 'RQ');
  return out;
}

const kingSq = (board, c) => board.indexOf(c === 'w' ? 'K' : 'k');
const inCheck = s => attackersOf(s.board, kingSq(s.board, s.turn), s.turn === 'w' ? 'b' : 'w').length > 0;

function pseudo(s) {
  const out = [], { board, turn } = s, w = turn === 'w', opp = w ? 'b' : 'w';
  const push = (from, to, extra = {}) => out.push({ from, to, ...extra });
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || colorOf(p) !== turn) continue;
    const t = p.toUpperCase(), r = i >> 3, f = i & 7;
    if (t === 'P') {
      const dir = w ? -1 : 1, start = w ? 6 : 1, last = w ? 0 : 7;
      const add = (to, extra) => {
        if ((to >> 3) === last) for (const pr of 'qrbn') push(i, to, { ...extra, promo: pr }); else push(i, to, extra);
      };
      const one = (r + dir) * 8 + f;
      if (!board[one]) {
        add(one, {});
        const two = (r + 2 * dir) * 8 + f;
        if (r === start && !board[two]) push(i, two, { dbl: true });
      }
      for (const df of [-1, 1]) {
        const ff = f + df; if (ff < 0 || ff > 7) continue;
        const to = (r + dir) * 8 + ff, tp = board[to];
        if (tp && colorOf(tp) === opp) add(to, {});
        else if (!tp && to === s.ep) push(i, to, { ep: true });
      }
    } else if (t === 'N' || t === 'K') {
      for (const [dr, df] of t === 'N' ? KN : KG) {
        const rr = r + dr, ff = f + df; if (rr < 0 || rr > 7 || ff < 0 || ff > 7) continue;
        const tp = board[rr * 8 + ff];
        if (!tp || colorOf(tp) === opp) push(i, rr * 8 + ff);
      }
      if (t === 'K') {
        const row = w ? 7 : 0, ks = w ? 'K' : 'k', qs = w ? 'Q' : 'q';
        if (i === row * 8 + 4 && !attackersOf(board, i, opp).length) {
          const rook = w ? 'R' : 'r';
          if (s.cast.includes(ks) && board[row * 8 + 7] === rook && !board[row * 8 + 5] && !board[row * 8 + 6] &&
              !attackersOf(board, row * 8 + 5, opp).length && !attackersOf(board, row * 8 + 6, opp).length) push(i, row * 8 + 6, { castle: 'k' });
          if (s.cast.includes(qs) && board[row * 8] === rook && !board[row * 8 + 1] && !board[row * 8 + 2] && !board[row * 8 + 3] &&
              !attackersOf(board, row * 8 + 3, opp).length && !attackersOf(board, row * 8 + 2, opp).length) push(i, row * 8 + 2, { castle: 'q' });
        }
      }
    } else {
      for (const [dr, df] of t === 'B' ? BD : t === 'R' ? RD : [...BD, ...RD]) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const tp = board[rr * 8 + ff];
          if (!tp) push(i, rr * 8 + ff);
          else { if (colorOf(tp) === opp) push(i, rr * 8 + ff); break; }
          rr += dr; ff += df;
        }
      }
    }
  }
  return out;
}

function apply(s, m) {
  const board = s.board.slice(), p = board[m.from], w = s.turn === 'w';
  const captured = m.ep ? board[m.to + (w ? 8 : -8)] : board[m.to];
  board[m.to] = m.promo ? (w ? m.promo.toUpperCase() : m.promo) : p;
  board[m.from] = null;
  if (m.ep) board[m.to + (w ? 8 : -8)] = null;
  if (m.castle) {
    const row = w ? 7 : 0;
    if (m.castle === 'k') { board[row * 8 + 5] = board[row * 8 + 7]; board[row * 8 + 7] = null; }
    else { board[row * 8 + 3] = board[row * 8]; board[row * 8] = null; }
  }
  let cast = s.cast;
  const strip = chs => { for (const c of chs) cast = cast.replace(c, ''); };
  if (p === 'K') strip('KQ'); if (p === 'k') strip('kq');
  for (const [sq, c] of [[63, 'K'], [56, 'Q'], [7, 'k'], [0, 'q']]) if (m.from === sq || m.to === sq) strip(c);
  const ep = m.dbl ? (m.from + m.to) / 2 : -1;
  return {
    board, turn: w ? 'b' : 'w', cast, ep,
    half: p.toUpperCase() === 'P' || captured ? 0 : s.half + 1, full: s.full + (w ? 0 : 1),
    _captured: captured,
  };
}

function legal(s) {
  const me = s.turn;
  return pseudo(s).filter(m => {
    const n = apply(s, m);
    return !attackersOf(n.board, kingSq(n.board, me), me === 'w' ? 'b' : 'w').length;
  });
}

function insufficient(board) {
  const rest = board.filter(p => p && p.toUpperCase() !== 'K').map(p => p.toUpperCase());
  if (!rest.length) return true;
  if (rest.length === 1 && 'BN'.includes(rest[0])) return true;
  return false;
}

class Chess {
  constructor(fen = START_FEN) { this.load(fen); }

  load(fen) {
    this._s = parseFen(fen);
    this._hist = [];
    this._headers = {};
    this._seen = [toFen(this._s).split(' ').slice(0, 4).join(' ')];
    return this;
  }
  fen() { return toFen(this._s); }
  turn() { return this._s.turn; }
  header(...args) {
    for (let i = 0; i < args.length; i += 2) this._headers[args[i]] = args[i + 1];
    return { ...this._headers };
  }
  get(sq) { const p = this._s.board[sqIdx(sq)]; return p ? { type: p.toLowerCase(), color: colorOf(p) } : undefined; }
  attackers(sq, color) { return attackersOf(this._s.board, sqIdx(sq), color || this._s.turn).map(sqName); }
  isCheck() { return inCheck(this._s); }
  isCheckmate() { return inCheck(this._s) && !legal(this._s).length; }
  isStalemate() { return !inCheck(this._s) && !legal(this._s).length; }
  isInsufficientMaterial() { return insufficient(this._s.board); }
  isThreefoldRepetition() { const k = this._seen[this._seen.length - 1]; return this._seen.filter(x => x === k).length >= 3; }
  isDraw() { return this._s.half >= 100 || this.isStalemate() || this.isInsufficientMaterial() || this.isThreefoldRepetition(); }
  isGameOver() { return this.isCheckmate() || this.isDraw(); }

  _san(s, m, all) {
    const p = s.board[m.from], t = p.toUpperCase();
    let san;
    if (m.castle) san = m.castle === 'k' ? 'O-O' : 'O-O-O';
    else {
      const cap = s.board[m.to] || m.ep;
      if (t === 'P') san = (cap ? FILES[m.from & 7] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo.toUpperCase() : '');
      else {
        const others = all.filter(o => o !== m && o.to === m.to && s.board[o.from] === p);
        let dis = '';
        if (others.length) {
          if (!others.some(o => (o.from & 7) === (m.from & 7))) dis = FILES[m.from & 7];
          else if (!others.some(o => (o.from >> 3) === (m.from >> 3))) dis = String(8 - (m.from >> 3));
          else dis = sqName(m.from);
        }
        san = t + dis + (cap ? 'x' : '') + sqName(m.to);
      }
    }
    const n = apply(s, m);
    if (inCheck(n)) san += legal(n).length ? '+' : '#';
    return san;
  }

  _verbose(s, m, all) {
    const p = s.board[m.from], n = apply(s, m);
    const o = {
      color: s.turn, from: sqName(m.from), to: sqName(m.to), piece: p.toLowerCase(),
      flags: m.castle ? m.castle : m.ep ? 'e' : n._captured ? 'c' : m.dbl ? 'b' : 'n',
      san: this._san(s, m, all), lan: sqName(m.from) + sqName(m.to) + (m.promo || ''),
      before: toFen(s), after: toFen(n),
    };
    if (n._captured) o.captured = n._captured.toLowerCase();
    if (m.promo) o.promotion = m.promo;
    return o;
  }

  moves({ verbose = false } = {}) {
    const s = this._s, all = legal(s);
    return all.map(m => (verbose ? this._verbose(s, m, all) : this._san(s, m, all)));
  }

  move(arg) {
    const s = this._s, all = legal(s);
    let m;
    if (typeof arg === 'string') {
      const clean = arg.replace(/[+#!?]+$/, '').replace(/0/g, 'O');
      m = all.find(x => this._san(s, x, all).replace(/[+#]/, '') === clean);
    } else {
      const from = sqIdx(arg.from), to = sqIdx(arg.to);
      m = all.find(x => x.from === from && x.to === to && (!x.promo || x.promo === (arg.promotion || 'q')));
    }
    if (!m) throw new Error('Invalid move: ' + JSON.stringify(arg));
    const v = this._verbose(s, m, all);
    this._s = apply(s, m);
    delete this._s._captured;
    this._hist.push(v);
    this._seen.push(toFen(this._s).split(' ').slice(0, 4).join(' '));
    return v;
  }

  history({ verbose = false } = {}) { return verbose ? this._hist.map(x => ({ ...x })) : this._hist.map(x => x.san); }

  loadPgn(pgn) {
    const headers = {};
    let body = pgn.replace(/\r/g, '');
    body = body.replace(/^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm, (_, k, v) => { headers[k] = v.replace(/\\(["\\])/g, '$1'); return ''; });
    body = body.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
    let prev;
    do { prev = body; body = body.replace(/\([^()]*\)/g, ' '); } while (body !== prev);
    body = body.replace(/\$\d+/g, ' ').replace(/\d+\.(\.\.)?/g, ' ');
    const tokens = body.split(/\s+/).filter(t => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
    this.load(headers.SetUp === '1' && headers.FEN ? headers.FEN : START_FEN);
    this._headers = headers;
    for (const t of tokens) this.move(t);
    return this;
  }
}

const ChessCore = { START_FEN, parseFen, toFen, legal, apply, inCheck, sqName, sqIdx, attackersOf, kingSq, colorOf };
