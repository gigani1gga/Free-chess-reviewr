# game-review test kit

Tests for the static chess game reviewer. No real Stockfish, no real chess.js, no network.

```
PROJECT_ROOT=/path/to/game-review node kit.mjs verify --human
```

| need | command |
|---|---|
| check after an edit (fast, change-aware) | `node kit.mjs verify` |
| everything | `node kit.mjs verify --all` |
| one suite / test | `node kit.mjs run unit` · `node kit.mjs run e2e --only keyboard` |
| random games | `node kit.mjs fuzz [--seed N]` |
| are the tests any good? | `node kit.mjs mutate [--deep]` |
| try things by hand | `node kit.mjs play` |
| environment problems | `node kit.mjs doctor` |
| list / explain tests | `node kit.mjs list` · `node kit.mjs explain <id>` |

Needs Node 20+. Browser suites and the playground also need Playwright and Chrome (`PLAYWRIGHT_PATH`, `CHROME_PATH`); the workflow suite needs python3 + pyyaml. Everything else runs on Node alone.

## What is in it

| suite | checks | about |
|---|---|---|
| static | syntax, imports, DOM ids, CSS classes, chess.js methods used, kit data | typos and dead references, instantly |
| perft | move generator against published counts | the chess stand-in is right |
| chess | stand-in vs an independent 0x88 generator on random games, SAN/PGN contract | the "chess.js" the tests use is right |
| unit | win%, accuracy, grade boundaries, coach text, analysis scheduling | logic, both sides of every threshold |
| fuzz | random games with oracle-verified lines, colour-swap and cache metamorphic tests, damaged PGNs, noisy UCI | bugs nobody thought of; shrinks to the shortest failing game |
| snapshot | 24 golden reviews | unintended changes in output |
| workflow | deploy.yml run in a sandbox | the published site is assembled correctly |
| e2e | real Chrome, mock Stockfish (healthy, crashing, hanging, garbage, slow…), screen sizes, special games, keyboard, races | what a person would hit |
| kit | the kit checks itself | the tools are trustworthy |

Mutation score: 85% of 40 sampled mutants are caught by the Node suites alone (`node kit.mjs mutate`); `--deep` adds browser tests for the rest.

Speed: the browser suite went from ~8 minutes to ~30 s (no service-worker wait, parallel pool, precomputed engine "book"); the Node suites take under 20 s together.

## Playground

`node kit.mjs play` opens the app next to a panel: pick a sample game, an engine variant (healthy, crash, hang, garbage, slow…), CPU/memory, phone screen, and what Lichess/Chess.com do (ok, slow, fail, timeout). The panel shows every UCI line in both directions, console errors, and lets you type UCI to a mock engine and run any test from the browser.

## Layout

`kit.mjs` CLI · `suites/` · `lib/` (framework, oracle, generators, mutation) · `src/` (chess stand-in + mock engine) · `playground/` · `snapshots/` · `data/mock-book.json` (precomputed searches, self-invalidating) · `build/` (output, safe to delete) · `AGENTS.md` · `kit.manifest.json`

`engine-check.mjs` (real Stockfish compatibility) and `kit-selftest.mjs` are unchanged in purpose; see their headers.
