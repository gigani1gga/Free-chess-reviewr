// Rendering and navigation of a finished review.
import { drawBoard, preloadPieces } from './board.js';
import { META, BAD, moveIcon } from './meta.js';
import { $, esc, fmtEval, moveNo } from './util.js';

// Only draw the red reply when the move itself loses something (not when it merely missed a win).
const PUNISHED = ['hang', 'trade', 'allowMate'];
const ASK_LABEL = 'Ask Stockfish what it would play here';
// R: the finished review. ply: the move on screen. V: a line being played on the board ({ line, i }), or null.
let R = null, ply = 0, flip = false, V = null, asker = null, answer = null, askToken = 0, asking = false;

const step = d => (V ? view(V.i + d) : go(ply + d));
const edge = end => (V ? view(end ? V.line.steps.length : 0) : go(end ? Infinity : 0));

export function initUI({ ask } = {}) {
  asker = ask;
  preloadPieces();
  $('first').onclick = () => edge(false);
  $('prev').onclick = () => step(-1);
  $('next').onclick = () => step(1);
  $('last').onclick = () => edge(true);
  $('flip').onclick = () => { flip = !flip; V ? view(V.i) : go(ply); };
  $('pvexit').onclick = () => go(ply);
  $('lines').addEventListener('click', e => {
    const b = e.target.closest('button.ln');
    if (b && R) preview(R.items[ply - 1]?.lines[+b.dataset.k]);
  });
  $('answer').addEventListener('click', e => {
    const b = e.target.closest('button.ln');
    if (b && answer) preview(answer.lines[+b.dataset.k]);
  });
  $('ask').onclick = askNow;
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
    if (e.key === 'Escape' && V) { e.preventDefault(); go(ply); return; }
    const k = { ArrowLeft: () => step(-1), ArrowRight: () => step(1), Home: () => edge(false), End: () => edge(true) }[e.key];
    if (!k) return;
    e.preventDefault();
    k();
  });
}

export function hideReview() {
  R = null; V = null; answer = null; askToken++;
  $('review').hidden = true;
}

export function showReview(review) {
  R = review;
  ply = 0;
  clearAnswer();
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

  // Move numbers come from the position the game starts in (a game can start with Black to move, or at a later move).
  const start = pos[0].fen;
  $('stats').innerHTML = statsHtml(R.stats);

  $('moves').innerHTML = items.map((it, i) =>
    (it.m.color === 'w' ? `<span class="no">${moveNo(start, i + 1)}.</span>` : i === 0 ? `<span class="no">${moveNo(start, 1)}…</span>` : '') +
    `<button data-p="${i + 1}" style="--c:${META[it.cls].color}" title="${META[it.cls].label}">${esc(it.m.san)}<i>${moveIcon(it.cls)}</i></button>`).join('');

  const n = pos.length - 1;
  const pts = pos.map((p, i) => `${((i / n) * 400).toFixed(1)},${(80 - p.win * 0.8).toFixed(1)}`).join(' ');
  $('graph').innerHTML = `<svg viewBox="0 0 400 80" preserveAspectRatio="none"><polygon points="0,80 ${pts} 400,80" fill="#e8e8e8"/>` +
    `<line x1="0" x2="400" y1="40" y2="40" stroke="#777" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>` +
    `<line id="gm" y1="0" y2="80" stroke="#e8a33d" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  go(0);
}

const pct = x => (x == null ? '–' : x.toFixed(0) + '%');
// Per player: estimated rating of the game, average centipawn loss and accuracy in each phase.
function statsHtml(st) {
  if (!st) return '';
  const col = c => {
    const s = st[c];
    return `<div class="st"><b>${c === 'w' ? 'White' : 'Black'}</b>` +
      `<div>Game rating <i title="An estimate of how well this game was played, from its accuracy. Not a measured rating.">${s.rating ? '≈ ' + s.rating : '–'}</i></div>` +
      `<div>Avg. centipawn loss <i>${s.moves ? s.acpl.toFixed(0) : '–'}</i></div>` +
      `<div>Opening <i>${pct(s.phases.open)}</i> · Middlegame <i>${pct(s.phases.mid)}</i> · Endgame <i>${pct(s.phases.end)}</i></div></div>`;
  };
  return col('w') + col('b');
}

const arrow = (uci, kind) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), kind });

// Green: what should have been played. Red: how the opponent punishes the move (the engine's best reply).
function arrowsFor(it, pos) {
  const out = [];
  if (!it) return out;
  if (it.best && BAD.includes(it.cls)) out.push(arrow(it.best, 'good'));
  if (pos.best && it.tags.some(t => PUNISHED.includes(t))) out.push(arrow(pos.best, 'threat'));
  return out;
}

const lineBtn = (l, k) =>
  `<button class="ln" data-k="${k}"><span class="lb">${esc(l.label)}</span><span class="lv">${esc(l.ev)}</span><span class="lm">${esc(l.moves.join(' '))}</span></button>`;

// Plays one of Stockfish's lines on the board, one move at a time, with the same buttons and keys as the game.
function preview(line) {
  if (!R || !line || !line.steps.length) return;
  V = { line, i: 0 };
  view(1);
}

function view(i) {
  if (!R || !V) return;
  const { line } = V, n = line.steps.length;
  V.i = Math.max(0, Math.min(n, i));
  const at = V.i ? line.steps[V.i - 1] : null;
  drawBoard($('board'), at ? at.fen : line.start, { flip, last: at && { from: at.from, to: at.to } });
  $('pvbar').hidden = false;
  $('pvtxt').innerHTML = `<b>${esc(line.label)}</b> (${esc(line.ev)}): ` + line.moves.map((t, k) => (k + 1 === V.i ? `<b>${esc(t)}</b>` : esc(t))).join(' ');
  $('ev').textContent = `Playing a line · its eval ${line.ev} (White’s view)`;
}

function clearAnswer() {
  answer = null;
  askToken++;
  $('answer').innerHTML = '';
}

async function askNow() {
  if (!R || !asker || asking) return;
  const at = ply, fen = R.pos[at].fen, token = ++askToken, btn = $('ask');
  asking = true;
  btn.disabled = true;
  btn.textContent = 'Stockfish is thinking…';
  try {
    const lines = await asker(fen);
    if (token !== askToken || !R || at !== ply) return; // the person moved on; this answer is for another position
    answer = { ply: at, lines };
    $('answer').innerHTML = lines.length
      ? '<p class="mut">Stockfish’s top choices here (tap one to see the line):</p>' + lines.map(lineBtn).join('')
      : '<p class="mut">The game is over in this position, so there is nothing to ask.</p>';
  } catch (e) {
    if (token === askToken && R && at === ply) $('answer').innerHTML = `<p class="mut">⚠ ${esc(e.message || e)}</p>`;
  } finally {
    asking = false; // the engine is free again, whichever position the person is looking at now
    btn.disabled = false;
    btn.textContent = ASK_LABEL;
  }
}

function go(p) {
  if (!R) return;
  const n = R.items.length;
  V = null;
  $('pvbar').hidden = true;
  const was = ply;
  ply = Math.max(0, Math.min(n, p));
  if (ply !== was) clearAnswer(); // an answer (or one still being computed) belongs to one position
  const pos = R.pos[ply], it = R.items[ply - 1];

  drawBoard($('board'), pos.fen, {
    flip,
    last: it && { from: it.m.from, to: it.m.to },
    arrows: arrowsFor(it, pos),
  });

  const f = $('fill').style;
  f.height = pos.win + '%';
  f.bottom = flip ? 'auto' : '0';
  f.top = flip ? '0' : 'auto';
  $('ev').textContent = 'Eval ' + fmtEval(pos) + ' (White’s view)';

  $('card').innerHTML = !it
    ? '<p>Step through with the arrows or tap any move below. For each move you get Stockfish’s reasons, the line it expects, and a better line when there was one: tap a line to play it on the board. A green arrow shows what should have been played; a red one shows how the opponent can punish a move. You can also ask Stockfish what it would play in any position.</p>'
    : `<span class="badge" style="--c:${META[it.cls].color}">${moveIcon(it.cls)}</span><b>${moveNo(R.pos[0].fen, ply)}${it.m.color === 'w' ? '.' : '…'} ${esc(it.m.san)}</b><p>${esc(it.text)}</p>` +
      (it.ev?.length ? `<small class="mut evl">Eval ${esc(it.ev[0])} → ${esc(it.ev[1])} (White’s view)</small>` : '');
  // The conversation with Stockfish behind the grade (only for the moves where it mattered: sacrifices, brilliant, great).
  const talk = it && it.talk && it.talk.length ? it.talk : null;
  $('talk').hidden = !talk;
  $('talkbody').innerHTML = talk ? talk.map(([q, a]) => `<p><b>${esc(q)}</b><br>${esc(a)}</p>`).join('') : '';
  if (talk && it.cls === 'brilliant') $('talk').open = true;
  $('lines').innerHTML = it && it.lines ? it.lines.map(lineBtn).join('') : '';

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
