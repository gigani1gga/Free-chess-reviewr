const FILES = 'abcdefgh';
const pieceUrl = p => `pieces/${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}.svg`;

// Warm the browser cache so pieces never pop in while stepping through a game.
export function preloadPieces() {
  for (const p of 'PNBRQKpnbrqk') new Image().src = pieceUrl(p);
}

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
      const piece = p ? `<img src="${pieceUrl(p)}" alt="" draggable="false">` : '';
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
    h += `<svg viewBox="0 0 8 8" aria-hidden="true"><line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}"/>` +
         `<polygon points="${x2},${y2} ${bx - uy * 0.17},${by + ux * 0.17} ${bx + uy * 0.17},${by - ux * 0.17}"/></svg>`;
  }
  el.innerHTML = h;
}
