const G = { p: '♟\uFE0E', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const FILES = 'abcdefgh';

export function drawBoard(el, fen, { flip = false, last = null, arrow = null } = {}) {
  const at = {};
  fen.split(' ')[0].split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += +ch;
      else at[FILES[f++] + (8 - i)] = ch;
    }
  });

  let h = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const f = flip ? 7 - c : c, rk = flip ? r + 1 : 8 - r, id = FILES[f] + rk, p = at[id];
      const hl = last && (id === last.from || id === last.to) ? ' hl' : '';
      const piece = p ? `<span class="${p === p.toUpperCase() ? 'w' : 'b'}">${G[p.toLowerCase()]}</span>` : '';
      h += `<div class="sq ${(f + rk) % 2 ? 'd' : 'l'}${hl}">${piece}</div>`;
    }
  }

  if (arrow) {
    const xy = s => {
      const f = FILES.indexOf(s[0]), k = +s[1];
      return [(flip ? 7 - f : f) + 0.5, (flip ? k - 1 : 8 - k) + 0.5];
    };
    const [x1, y1] = xy(arrow.from), [x2, y2] = xy(arrow.to);
    const L = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / L, uy = (y2 - y1) / L;
    const bx = x2 - ux * 0.3, by = y2 - uy * 0.3;
    h += `<svg viewBox="0 0 8 8"><line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}"/>` +
         `<polygon points="${x2},${y2} ${bx - uy * 0.17},${by + ux * 0.17} ${bx + uy * 0.17},${by - ux * 0.17}"/></svg>`;
  }
  el.innerHTML = h;
}
