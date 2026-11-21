// Rendering and navigation of a finished review.
import { drawBoard, preloadPieces } from './board.js';
import { META, BAD, moveIcon } from './meta.js';
import { $, esc, fmtEval } from './util.js';

let R = null, ply = 0, flip = false;

export function initUI() {
  preloadPieces();
  $('first').onclick = () => go(0);
  $('prev').onclick = () => go(ply - 1);
  $('next').onclick = () => go(ply + 1);
  $('last').onclick = () => go(Infinity);
  $('flip').onclick = () => { flip = !flip; go(ply); };
  $('moves').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) go(+b.dataset.p);
  });
  $('graph').addEventListener('click', e => {
    if (!R) return;
    const r = e.currentTarget.getBoundingClientRect();
    go(Math.round(((e.clientX - r.left) / r.width) * R.items.length));
  });
  document.addEventListener('keydown', e => {
    if (!R || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const k = { ArrowLeft: ply - 1, ArrowRight: ply + 1, Home: 0, End: Infinity }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    go(k);
  });
}

export function hideReview() {
  R = null;
  $('review').hidden = true;
}

export function showReview(review) {
  R = review;
  const { headers: h, items, acc, cnt, pos } = R;
  $('review').hidden = false;

  const name = (n, elo) => `<div><b>${esc(n)}</b>${elo ? ` <small>(${esc(elo)})</small>` : ''}</div>`;
  $('players').innerHTML = name(h.White || 'White', h.WhiteElo) +
    `<div class="mut">${esc(h.Result || '')}</div>` + name(h.Black || 'Black', h.BlackElo);

  $('acc').innerHTML = ['w', 'b'].map(c =>
    `<div class="ac"><div class="big">${acc[c].toFixed(1)}</div><small>${c === 'w' ? 'White' : 'Black'} accuracy</small><div class="chips">` +
    Object.entries(META).filter(([k]) => cnt[c][k])
      .map(([k, m]) => `<span style="--c:${m.color}">${moveIcon(k)}${cnt[c][k]} ${m.label}</span>`).join('') +
    '</div></div>').join('');

  $('moves').innerHTML = items.map((it, i) =>
    (i % 2 === 0 ? `<span class="no">${i / 2 + 1}.</span>` : '') +
    `<button data-p="${i + 1}" style="--c:${META[it.cls].color}" title="${META[it.cls].label}">${esc(it.m.san)}<i>${moveIcon(it.cls)}</i></button>`).join('');

  const n = pos.length - 1;
  const pts = pos.map((p, i) => `${((i / n) * 400).toFixed(1)},${(80 - p.win * 0.8).toFixed(1)}`).join(' ');
  $('graph').innerHTML = `<svg viewBox="0 0 400 80" preserveAspectRatio="none"><polygon points="0,80 ${pts} 400,80" fill="#e8e8e8"/>` +
    `<line x1="0" x2="400" y1="40" y2="40" stroke="#777" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>` +
    `<line id="gm" y1="0" y2="80" stroke="#e8a33d" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  go(0);
}

function go(p) {
  if (!R) return;
  const n = R.items.length;
  ply = Math.max(0, Math.min(n, p));
  const pos = R.pos[ply], it = R.items[ply - 1];

  drawBoard($('board'), pos.fen, {
    flip,
    last: it && { from: it.m.from, to: it.m.to },
    arrow: it?.best && BAD.includes(it.cls) ? { from: it.best.slice(0, 2), to: it.best.slice(2, 4) } : null,
  });

  const f = $('fill').style;
  f.height = pos.win + '%';
  f.bottom = flip ? 'auto' : '0';
  f.top = flip ? '0' : 'auto';
  $('ev').textContent = 'Eval ' + fmtEval(pos) + ' (White’s view)';

  $('card').innerHTML = !it
    ? '<p>Step through with the arrows or tap any move below. A green arrow shows what should have been played.</p>'
    : `<span class="badge" style="--c:${META[it.cls].color}">${moveIcon(it.cls)}</span><b>${Math.ceil(ply / 2)}${it.m.color === 'w' ? '.' : '…'} ${esc(it.m.san)}</b><p>${esc(it.text)}</p>`;

  // Highlight the current move and keep it visible inside the move list only (never scroll the page).
  const list = $('moves');
  list.querySelector('button.on')?.classList.remove('on');
  const cur = list.querySelector(`button[data-p="${ply}"]`);
  if (cur) {
    cur.classList.add('on');
    list.scrollTop = Math.max(0, cur.offsetTop - (list.clientHeight - cur.offsetHeight) / 2);
  } else {
    list.scrollTop = 0;
  }

  const x = (ply / n) * 400;
  $('gm')?.setAttribute('x1', x);
  $('gm')?.setAttribute('x2', x);
}
