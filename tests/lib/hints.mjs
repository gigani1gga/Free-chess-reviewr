// Turns an error message into "where to look". A failure that says what to do next saves an AI (or a person) a round of
// guessing. Rules are checked in order; the first match wins. `meta.covers` (project files a test exercises) is always appended.
const RULES = [
  [/stand-in lacks|STAND-IN/i, 'The app now uses a chess.js method the kit\'s stand-in (src/chess-core.js) does not have. Add it there (same behaviour as chess.js v1), then rerun `node kit.mjs run --only chess`.'],
  [/unexpected browser problems/i, 'The page logged a console error, threw, or got an HTTP error/failed request. See the artifact log for the full list; the first entry is usually the root cause.'],
  [/did not respond in time|Stockfish did not respond/i, 'An engine command timed out. Check js/engine.js ask()/LOAD_MS and what the mock variant (src/mock-engine.js behavior) actually answers.'],
  [/expected .* got|expected "/i, 'A value differed from what the test pins down. If the app change was intentional, update the test; if not, the diff in this message is the regression.'],
  [/timed out after/i, 'The test itself hung. Run it alone (`node kit.mjs run --only <id> --workers 1`) to rule out load; then look at the screenshot artifact to see where the UI got stuck.'],
  [/overflow|wider than the screen/i, 'Layout: something is wider than the viewport. Check style.css for fixed widths / long unbroken text.'],
  [/snapshot/i, 'The review output changed. If intended: `node kit.mjs snapshot --update` and review the diff; otherwise js/review.js, coach.js or analysis.js changed behaviour by accident.'],
  [/seed/i, 'Property test failure: rerun with the printed seed (`--seed N`) to reproduce exactly; the shrunk input is in the message.'],
  [/net::|ERR_/i, 'A network request failed. Tests mock Lichess/Chess.com; an un-mocked external URL in the app will fail here.'],
  [/Cannot find module|ERR_MODULE_NOT_FOUND|does not provide an export/i, 'An import in the app does not resolve (file renamed? export removed?). `node kit.mjs run --only static` lists every broken import.'],
];
export function hintFor(message = '', name = '', meta = {}) {
  const hit = RULES.find(([r]) => r.test(message));
  const files = (meta.covers || []).length ? ` Files involved: ${meta.covers.join(', ')}.` : '';
  return (hit ? hit[1] : 'Read the message above; rerun just this test with `node kit.mjs run --only "<id>"`.') + files;
}
