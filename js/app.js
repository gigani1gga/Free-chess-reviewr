import { Chess } from '../vendor/chess.js';
import { Engine } from './engine.js';
import { loadGame } from './fetchgame.js';
import { winPct, accuracy, classify, sacrifice, tags, explain, META } from './review.js';
import { drawBoard } from './board.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const status = (t, p = 0) => { $('status').textContent = t; $('bar').style.width = p + '%'; };
const BAD = ['inaccuracy', 'mistake', 'miss', 'blunder'];

let eng = null, R = null, ply = 0, flip = false;
const cache = new Map();

$('go').addEventListener('click', run);
$('link').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

async function run() {
  $('go').disabled = true;
  $('review').hidden = true;
  try {
    const raw = $('pgn').value.trim() || $('link').value.trim();
    if (!raw) throw new Error('Paste a game link first.');
    status('Finding your game…', 2);
    const pgn = await loadGame(raw, $('user').value.trim());
    const g = new Chess();
    g.loadPgn(pgn);
    const mvs = g.history({ verbose: true });
    if (!mvs.length) throw new Error('That game has no moves.');
    const fens = [mvs[0].before, ...mvs.map(m => m.after)];
    const depth = +$('depth').value;
    if (!eng) {
      status('Starting Stockfish…', 4);
      const e = new Engine();
      await e.init();
      eng = e;
    }
    const pos = [];
    for (let i = 0; i < fens.length; i++) {
      status(`Analyzing position ${i} of ${fens.length - 1}…`, 5 + (95 * i) / fens.length);
      pos.push(await analyse(fens[i], depth));
    }
    R = build(g.header(), mvs, pos);
    ply = 0;
    show();
    status('Done.', 100);
  } catch (e) {
    status('⚠ ' + (e.message || e), 0);
  }
  $('go').disabled = false;
}

async function analyse(fen, depth) {
  const key = fen + depth;
  if (cache.has(key)) return cache.get(key);
  const c = new Chess(fen), t = c.turn();
  let res;
  if (c.isCheckmate()) res = { fen, turn: t, win: t === 'w' ? 0 : 100, lines: [] };
  else if (c.isGameOver()) res = { fen, turn: t, win: 50, lines: [] };
  else {
    const s = t === 'w' ? 1 : -1; // engine scores are from the side to move; convert to White's view
    const lines = (await eng.analyze(fen, depth)).map(l => {
      const mate = l.mate != null ? l.mate * s : null, cp = l.cp != null ? l.cp * s : null;
      return { mate, cp, pv: l.pv, win: mate != null ? (mate > 0 ? 100 : 0) : winPct(cp) };
    });
    const L = lines[0] || { win: 50, pv: [] };
    res = { fen, turn: t, lines, win: L.win, mate: L.mate, cp: L.cp, best: L.pv[0] };
  }
  cache.set(key, res);
  return res;
}

function build(h, mvs, pos) {
  const acc = { w: [], b: [] }, cnt = { w: {}, b: {} };
  let prev = 0;
  const items = mvs.map((m, i) => {
    const b = pos[i], a = pos[i + 1], me = m.color;
    const pov = w => (me === 'w' ? w : 100 - w);
    const wb = pov(b.win), wa = pov(a.win), drop = Math.max(0, wb - wa);
    const isBest = m.from + m.to + (m.promotion || '') === b.best;
    const gap = b.lines[1] ? wb - pov(b.lines[1].win) : null;
    const cls = classify({ drop, isBest, wb, wa, gap, sac: sacrifice(m, a.fen), prev });
    prev = drop;
    acc[me].push(accuracy(drop));
    cnt[me][cls] = (cnt[me][cls] || 0) + 1;
    let bestSan = null;
    if (b.best && !isBest) {
      try { bestSan = new Chess(b.fen).move({ from: b.best.slice(0, 2), to: b.best.slice(2, 4), promotion: b.best[4] }).san; } catch {}
    }
    const tg = tags({ m, b, a, drop, wb, wa, cls });
    return { m, cls, best: isBest ? null : b.best, text: explain({ m, cls, tg, bestSan, wa, i }) };
  });
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return { h, mvs, pos, items, acc: { w: avg(acc.w), b: avg(acc.b) }, cnt };
}

const fmt = p => p.mate != null ? (p.mate > 0 ? 'M' : '-M') + Math.abs(p.mate)
  : p.cp != null ? (p.cp > 0 ? '+' : '') + (p.cp / 100).toFixed(1)
  : p.win === 100 ? '1-0' : p.win === 0 ? '0-1' : '½';

function show() {
  const { h, items, acc, cnt, pos } = R;
  $('review').hidden = false;
  const nm = (n, e) => `<div><b>${esc(n)}</b>${e ? ` <small>(${esc(e)})</small>` : ''}</div>`;
  $('players').innerHTML = nm(h.White || 'White', h.WhiteElo) + `<div class="mut">${esc(h.Result || '')}</div>` + nm(h.Black || 'Black', h.BlackElo);
  $('acc').innerHTML = ['w', 'b'].map(c => `<div class="ac"><div class="big">${acc[c].toFixed(1)}</div><small>${c === 'w' ? 'White' : 'Black'} accuracy</small><div class="chips">` +
    Object.keys(META).filter(k => cnt[c][k]).map(k => `<span style="--c:${META[k][1]}">${cnt[c][k]} ${META[k][2]}</span>`).join('') + '</div></div>').join('');
  $('moves').innerHTML = items.map((it, i) => (i % 2 === 0 ? `<span class="no">${i / 2 + 1}.</span>` : '') +
    `<button data-p="${i + 1}" style="--c:${META[it.cls][1]}">${esc(it.m.san)}<i>${META[it.cls][0]}</i></button>`).join('');
  const n = pos.length - 1, pts = pos.map((p, i) => `${(i / n) * 400},${80 - p.win * 0.8}`).join(' ');
  $('graph').innerHTML = `<svg viewBox="0 0 400 80" preserveAspectRatio="none"><polygon points="0,80 ${pts} 400,80" fill="#e8e8e8"/><line id="gm" y1="0" y2="80" stroke="#e8a33d" stroke-width="2"/></svg>`;
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
    arrow: it && it.best && BAD.includes(it.cls) ? { from: it.best.slice(0, 2), to: it.best.slice(2, 4) } : null,
  });
  const f = $('fill').style;
  f.height = pos.win + '%';
  f.bottom = flip ? 'auto' : '0';
  f.top = flip ? '0' : 'auto';
  $('ev').textContent = 'Eval ' + fmt(pos) + ' (White’s view)';
  $('card').innerHTML = !it
    ? '<p>Step through with ▶ or tap any move below. A green arrow shows what you should have played.</p>'
    : `<span class="badge" style="--c:${META[it.cls][1]}">${META[it.cls][0]}</span><b>${Math.ceil(ply / 2)}${it.m.color === 'w' ? '.' : '…'} ${esc(it.m.san)}</b><p>${esc(it.text)}</p>`;
  document.querySelectorAll('#moves button').forEach(b => {
    const on = +b.dataset.p === ply;
    b.classList.toggle('on', on);
    if (on) b.scrollIntoView({ block: 'nearest' });
  });
  const gm = $('gm');
  if (gm) { gm.setAttribute('x1', (ply / n) * 400); gm.setAttribute('x2', (ply / n) * 400); }
}

$('first').onclick = () => go(0);
$('prev').onclick = () => go(ply - 1);
$('next').onclick = () => go(ply + 1);
$('last').onclick = () => go(1e9);
$('flip').onclick = () => { flip = !flip; go(ply); };
$('moves').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(+b.dataset.p); });
$('graph').addEventListener('click', e => {
  if (!R) return;
  const r = e.currentTarget.getBoundingClientRect();
  go(Math.round(((e.clientX - r.left) / r.width) * R.items.length));
});
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (e.key === 'ArrowLeft') go(ply - 1);
  if (e.key === 'ArrowRight') go(ply + 1);
});
