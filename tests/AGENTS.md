# Game Review test kit (for AI agents)

Tests the Game Review web app (static site: `index.html`, `style.css`, `js/*.js`, `.github/workflows/deploy.yml`) WITHOUT needing
npm, the Stockfish download, or network access. Real Stockfish is replaced by a mock worker that speaks UCI.

## Use
1. Put this folder anywhere (inside the project as `tests/`, or beside it).
2. `PROJECT_ROOT=/path/to/project ./run-all.sh [/path/to/uploaded.zip]`   (PROJECT_ROOT defaults to the parent folder)
   Optional env: `PLAYWRIGHT_PATH` (default /opt/npm-tools/node_modules/playwright), `CHROME` (default /usr/bin/google-chrome).
3. Read the output: `PASS`/`FAIL` lines, last line `ALL TESTS PASSED` or `SOME TESTS FAILED`. Exit code 0 = all passed.

Needs: Node 18+, Python 3 + PyYAML, git, Google Chrome, the `playwright` npm package. No network.

## What each step checks
- `perft.mjs`: the chess.js stand-in against published move counts (if this fails, distrust everything else).
- `unit.mjs`: grading maths (win%, accuracy, classification), score conversion, cache.
- `workflow-test.py`: runs the REAL shell/python blocks from `deploy.yml` with fake npm/npx/curl and a mock `stockfish@19.0.1` package.
- `e2e.mjs`: the real app in Chrome: engine handshake, full/lite profiles, depth, hang/crash/missing-file errors, navigation, phone layout.
  Screenshots land in `build/shots/`.

## Extending
- New engine misbehaviour: add a variant in `build-site.mjs` (`variants`) and a behaviour branch in `src/mock-engine.js`, then a test in `e2e.mjs`.
- Playwright disables the HTTP cache on pages that use `page.route()`; use a plain context for cache tests.
- The mock proves the app speaks UCI correctly, not that real Stockfish is fast/strong/fits in phone memory. Say so when reporting.
- If you find a bug, fix the project file, rerun, and confirm the failing test now passes (and ideally that it fails without the fix).
