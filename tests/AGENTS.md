# Using this kit (for AI agents)

Goal: after you change the chess reviewer, find out in under a minute whether you broke something, and where.

## The loop

1. Edit the app.
2. `PROJECT_ROOT=<app folder> node kit.mjs verify` (output is one JSON line when piped; add `--human` for text).
   - First run: everything (~45 s). Later runs: only what your changed files can affect (`build/last-green.json` remembers the last green state).
3. `ok: true` and exit code 0 → done. Otherwise read `failures[]`. Each has `detail`, `hint`, `covers` (project files to look at), `artifacts` (screenshots, `failure.txt`) and `rerun`.
4. `node kit.mjs explain <id>` shows the test source and the files it covers. Fix the **app** (or the test, if the test is wrong), then `node kit.mjs run --only '^<id>$'` and `verify` again.
5. Before finishing, run `node kit.mjs verify --all` once.

`build/report.md` is the same information, short enough to paste.

## Reading results

| status | meaning | what to do |
|---|---|---|
| fail | broken | fix |
| flaky | passed only on retry | a race or timeout: investigate, do not ignore (`--strict` makes it fail) |
| xpass | a test marked as a known bug now passes | remove the `xfail` marker from the test |
| xfail | known bug, still failing | leave |
| warn | worth a look, not a failure (e.g. unused export, HTML hygiene) | optional |

Exit codes: 0 pass · 1 failures · 2 environment (run `node kit.mjs doctor`) · 3 usage error.

## Which command when

- Changed grading/coach/analysis logic → `verify` (unit, fuzz, snapshot, e2e all react). 
- Changed engine handling (`js/engine.js`) → `verify`; for a real binary also `node kit.mjs engine --bin <stockfish>`.
- Changed `.github/workflows/deploy.yml` → `verify` (workflow suite runs the real shell in a sandbox).
- Want more confidence → `node kit.mjs fuzz` (random games; **prints a seed**, reproduce with `--seed N`; failures are shrunk to the shortest game).
- Want to know if the tests are any good → `node kit.mjs mutate` (survivors = unprotected code; `--deep` also uses browser tests).
- Need to *see* the app → `node kit.mjs play` (humans) – engine variants, phone size, Lichess/Chess.com failure modes, UCI log.

## Snapshots

`suites/snapshot.mjs` stores golden reviews (`snapshots/review.json`). A snapshot failure means the review output **changed**. If the change is the intended result of your edit, run `node kit.mjs snapshot --update` and say so in your summary; if not, it is a bug. Never update snapshots just to get green.

## Rules of thumb

- Never edit a test to make it pass unless the test is wrong. Say why when you do.
- A fuzz failure prints a seed and a minimal PGN: replay it with `node kit.mjs run fuzz --seed N`.
- `STAND-IN LACKS Chess.x` means the app calls a chess.js method the kit's stand-in (`src/chess-core.js`) does not have. Add it there (then `node kit.mjs book`), do not remove the call from the app.
- The kit never talks to the network and never needs the real Stockfish or chess.js (the stand-in is checked against an independent move generator and published perft numbers).
- Test ids are stable: `suite/slug-of-the-name`. Counts and random values never appear in names.
- Everything the kit writes goes to `build/` (safe to delete).
