// An independent move generator, written differently on purpose (0x88 board, make/unmake, check detection by "is the king's
// square attacked after the move") so it shares no code and no representation with src/chess-core.js. When the two agree on
// perft counts and on the legal-move list of thousands of random positions, a bug in one of them would have to be mirrored in
// the other. It is a test oracle: clarity over speed.
const FILES = 'abcdefgh';
const sq88 = (f, r) => r * 16 + f;                       // r: 0 = rank 1
const name88 = s => FILES[s & 7] + ((s >> 4) + 1);
const idx88 = n => sq88(FILES.indexOf(n[0]), +n[1] - 1);
const ON = s => !(s & 0x88);
const N_D = [31, 33, 14, 18, -31, -33, -14, -18], K_D = [1, -1, 16, -16, 15, 17, -15, -17], B_D = [15, 17, -15, -17], R_D = [1, -1, 16, -16];
const isWhite = p => p >= 'A' && p <= 'Z';

export function parse(fen) {
  const [placement, turn, castling, ep] = fen.trim().split(/\s+/);
  const b = new Array(128).fill('');
  placement.split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) { if (/\d/.test(ch)) f += +ch; else b[sq88(f++, 7 - i)] = ch; }
  });
  return { b, white: turn === 'w', cast: new Set(castling === '-' ? [] : castling.split('')), ep: ep && ep !== '-' ? idx88(ep) : -1 };
}

export function toFenPlacement(pos) {
  let out = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', e = 0;
    for (let f = 0; f < 8; f++) { const p = pos.b[sq88(f, r)]; if (!p) e++; else { if (e) row += e; e = 0; row += p; } }
    out.push(row + (e || ''));
  }
  return out.join('/');
}

function attacked(pos, sq, byWhite) {
  const { b } = pos, own = c => (byWhite ? isWhite(c) : c && !isWhite(c));
  const pawn = byWhite ? 'P' : 'p', N = byWhite ? 'N' : 'n', K = byWhite ? 'K' : 'k', B = byWhite ? 'B' : 'b', R = byWhite ? 'R' : 'r', Q = byWhite ? 'Q' : 'q';
  for (const d of byWhite ? [-15, -17] : [15, 17]) { const s = sq + d; if (ON(s) && b[s] === pawn) return true; }
  for (const d of N_D) { const s = sq + d; if (ON(s) && b[s] === N) return true; }
  for (const d of K_D) { const s = sq + d; if (ON(s) && b[s] === K) return true; }
  for (const [dirs, kinds] of [[B_D, [B, Q]], [R_D, [R, Q]]]) {
    for (const d of dirs) {
      for (let s = sq + d; ON(s); s += d) { if (b[s]) { if (own(b[s]) && kinds.includes(b[s])) return true; break; } }
    }
  }
  return false;
}
const kingOf = (pos, white) => pos.b.indexOf(white ? 'K' : 'k');
export const inCheck = pos => attacked(pos, kingOf(pos, pos.white), !pos.white);

function pseudo(pos) {
  const { b, white } = pos, out = [];
  const mine = c => c && isWhite(c) === white, theirs = c => c && isWhite(c) !== white;
  const add = (from, to, extra = {}) => out.push({ from, to, ...extra });
  for (let from = 0; from < 128; from++) {
    if (!ON(from) || !mine(b[from])) continue;
    const p = b[from], t = p.toLowerCase();
    if (t === 'p') {
      const up = white ? 16 : -16, start = white ? 1 : 6, last = white ? 7 : 0;
      const push = (to, extra) => { if ((to >> 4) === last) for (const pr of 'qrbn') add(from, to, { ...extra, promo: pr }); else add(from, to, extra); };
      if (ON(from + up) && !b[from + up]) {
        push(from + up, {});
        if ((from >> 4) === start && !b[from + 2 * up]) add(from, from + 2 * up, { double: true });
      }
      for (const d of [up - 1, up + 1]) {
        const to = from + d; if (!ON(to)) continue;
        if (theirs(b[to])) push(to, {});
        else if (to === pos.ep && !b[to]) add(from, to, { ep: true });
      }
    } else if (t === 'n' || t === 'k') {
      for (const d of t === 'n' ? N_D : K_D) { const to = from + d; if (ON(to) && !mine(b[to])) add(from, to); }
      if (t === 'k') {
        const r = white ? 0 : 7, ks = white ? 'K' : 'k', qs = white ? 'Q' : 'q', rook = white ? 'R' : 'r';
        if (from === sq88(4, r) && !attacked(pos, from, !white)) {
          if (pos.cast.has(ks) && b[sq88(7, r)] === rook && !b[sq88(5, r)] && !b[sq88(6, r)] && !attacked(pos, sq88(5, r), !white) && !attacked(pos, sq88(6, r), !white)) add(from, sq88(6, r), { castle: 'k' });
          if (pos.cast.has(qs) && b[sq88(0, r)] === rook && !b[sq88(1, r)] && !b[sq88(2, r)] && !b[sq88(3, r)] && !attacked(pos, sq88(3, r), !white) && !attacked(pos, sq88(2, r), !white)) add(from, sq88(2, r), { castle: 'q' });
        }
      }
    } else {
      for (const d of t === 'b' ? B_D : t === 'r' ? R_D : [...B_D, ...R_D]) {
        for (let to = from + d; ON(to); to += d) { if (!b[to]) add(from, to); else { if (theirs(b[to])) add(from, to); break; } }
      }
    }
  }
  return out;
}

// Plays a move on a COPY (make/unmake would be faster, but a copy cannot corrupt the caller's position).
export function make(pos, m) {
  const b = pos.b.slice(), white = pos.white, p = b[m.from], cast = new Set(pos.cast);
  b[m.to] = m.promo ? (white ? m.promo.toUpperCase() : m.promo) : p;
  b[m.from] = '';
  if (m.ep) b[m.to + (white ? -16 : 16)] = '';
  if (m.castle) {
    const r = white ? 0 : 7;
    if (m.castle === 'k') { b[sq88(5, r)] = b[sq88(7, r)]; b[sq88(7, r)] = ''; } else { b[sq88(3, r)] = b[sq88(0, r)]; b[sq88(0, r)] = ''; }
  }
  if (p === 'K') { cast.delete('K'); cast.delete('Q'); } if (p === 'k') { cast.delete('k'); cast.delete('q'); }
  for (const [s, c] of [[sq88(0, 0), 'Q'], [sq88(7, 0), 'K'], [sq88(0, 7), 'q'], [sq88(7, 7), 'k']]) if (m.from === s || m.to === s) cast.delete(c);
  return { b, white: !white, cast, ep: m.double ? (m.from + m.to) / 2 : -1 };
}

export function legal(pos) {
  return pseudo(pos).filter(m => { const n = make(pos, m); return !attacked(n, kingOf(n, pos.white), !pos.white); }); // the king may have moved: look it up AFTER the move
}
export const uci = m => name88(m.from) + name88(m.to) + (m.promo || '');
export const legalUci = fen => legal(parse(fen)).map(uci).sort();
export const perft = (pos, d) => (d === 0 ? 1 : legal(pos).reduce((n, m) => n + (d === 1 ? 1 : perft(make(pos, m), d - 1)), 0));

// Is square `sq` (0x88) attacked by the given colour in this position? (exported for tests)
export const attackedBy = (pos, sq, byWhite) => attacked(pos, sq, byWhite);
