#!/bin/bash
# Runs every check. Needs: node >= 18, python3 (+ PyYAML), git, Google Chrome, and the playwright package.
#   PLAYWRIGHT_PATH=/path/to/node_modules/playwright  CHROME=/path/to/chrome  ./run-all.sh [path/to/game-review.zip]
set -u
cd "$(dirname "$0")"
rc=0
run() { echo; echo "=== $1"; shift; "$@" || rc=1; }
mkdir -p build
{ cat src/chess-core.js; echo 'export { Chess, ChessCore };'; } > build/chess-module.mjs
run "chess stand-in vs published perft counts" node perft.mjs
run "build test site (mock Stockfish 19 + project files)" node build-site.mjs
run "unit: grading / analysis" node unit.mjs
run "deploy workflow: real script vs mock stockfish@19.0.1 package" python3 workflow-test.py "${1:-}"
run "end-to-end: real app in Chrome" node e2e.mjs
echo; [ $rc = 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit $rc
