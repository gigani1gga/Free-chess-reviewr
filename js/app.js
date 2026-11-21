// Entry point: reads the form, loads the game, runs the engine, hands the review to the UI.
import { loadGame } from './fetchgame.js';
import { createPool, disposePool } from './engine.js';
import { parseGame, analyseAll, buildReview } from './analysis.js';
import { initUI, showReview, hideReview } from './ui.js';
import { $ } from './util.js';

let pool = null, busy = false;

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

    if (!pool) {
      status('Starting Stockfish…', 4);
      pool = await createPool();
    }
    const pos = await analyseAll(pool, game.fens, +$('depth').value, (done, total) =>
      status(`Analyzing position ${done} of ${total}…`, 5 + (95 * done) / total));

    showReview(buildReview(game, pos));
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
