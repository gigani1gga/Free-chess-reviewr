# Tests

Run everything: `./run-all.sh [path/to/game-review.zip]`
(needs Node 18+, Python 3 with PyYAML, git, Google Chrome and the `playwright` npm package; set `PLAYWRIGHT_PATH` and `CHROME` if they are not in the usual places).

Real Stockfish and npm are not available in the sandbox this was written in, so the suite replaces them:

| Piece | What it is | Why you can trust it |
|---|---|---|
| `src/chess-core.js` | tiny stand-in for chess.js (only the API the app uses) | `perft.mjs` checks it against published move-count tables |
| `src/mock-engine.js` | fake Stockfish web worker: same UCI conversation, loads its `.wasm` like the real one, plays by a tiny search | variants simulate a hung engine, a crash, a missing `.wasm`, noisy output, old-style options |
| `build-site.mjs` | builds a copy of the deployed site (same folders as the workflow) | |
| `server.mjs` | serves it like GitHub Pages: sub-path, 10-minute cache, no COOP/COEP headers | |
| `workflow-test.py` | runs the real script blocks from `deploy.yml` with fake `npm`/`npx`/`curl` against a mock `stockfish@19.0.1` package | file names taken from the package README |
| `e2e.mjs` | the real app in real Chrome (incl. playing Stockfish's lines on the board and "Ask Stockfish"). `E2E_ONLY='coach|Ask' node e2e.mjs` runs just the tests whose name matches | |
| `unit.mjs` | grading maths, analysis logic, and `coach.js` (reasons and lines built from the engine's own lines: replay, material outcome, forks, rescues, mate wording) | positions are hand-made, so each expected sentence can be checked by eye |

What it can NOT tell you: how fast or how strong the real Stockfish 19 is, whether a phone has enough memory for the 94 MB build,
or that the real npm package has exactly the layout the README describes. Those need one real deploy.
