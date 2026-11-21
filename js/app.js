// Entry point: reads the form, loads the game, runs the engine, hands the review to the UI.
import { loadGame } from './fetchgame.js';
import { createPool, disposePool } from './engine.js';
import { parseGame, analyseAll, buildReview } from './analysis.js';
import { initUI, showReview, hideReview } from './ui.js';
import { keepEngineCached } from './offline.js';
import { $ } from './util.js';

let pool = null, busy = false;
const cacheReady = keepEngineCached(); // never rejects
const ENGINE_NOTE = { best: 'Downloading Stockfish 19 (about 94 MB the first time, then cached)…', fast: 'Starting Stockfish 19 Lite…' };

const status = (t, p = 0) => { $('status').textContent = t; $('bar').style.width = p + '%'; };

async function run() {
  if (busy) return;
  busy = true;
  $('go').disabled = true;
  hideReview();
  try {
    const raw = $('pgn').value.trim() || $('link').value.trim();
    if (!raw) throw new Error('Paste a game link first.');

    status('Finding your game…', 2);
    const game = parseGame(await loadGame(raw, $('user').value.trim()));

    const kind = $('strength').value;
    if (pool && pool[0].kind !== kind) { disposePool(pool); pool = null; }
    if (!pool) {
      status(ENGINE_NOTE[kind], 4);
      await cacheReady;
      pool = await createPool(kind);
    }
    const pos = await analyseAll(pool, game.fens, +$('depth').value, (done, total) =>
      status(`Analyzing position ${done} of ${total}…`, 5 + (95 * done) / total));

    showReview(buildReview(game, pos));
    $('engine').textContent = `Analysed by ${pool[0].name || 'Stockfish'} · depth ${$('depth').value} · ${pool.length > 1 ? pool.length + ' engines in parallel' : '1 engine'}`;
    status('Done.', 100);
  } catch (e) {
    status('⚠ ' + (e.message || e));
    // A timed-out or crashed engine can't be trusted; start fresh next time.
    if (pool && /Stockfish/.test(e.message || '')) { disposePool(pool); pool = null; }
  } finally {
    busy = false;
    $('go').disabled = false;
  }
}

initUI();
$('go').addEventListener('click', run);
$('link').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
