# How the review grades a game

Modelled on what Chess.com publishes about Game Review. Chess.com's own model and its Game Rating are not public, so the
numbers here are an approximation, not a copy. Every judgement-call constant lives in `js/rating.js` or `js/review.js`.

## Talking to Stockfish (`js/uci.js`, `js/engine.js`, `js/brilliant.js`)

The review asks Stockfish more than "what is the best move?":

| Question | UCI | Used for |
|---|---|---|
| How good is *exactly this move*? | `go depth N searchmoves <move>` | A move outside the top lines gets its own score, instead of a guess from the next position |
| What are the best alternatives? | MultiPV lines | "Would you have been winning anyway?", only-move gaps |
| Follow your line: what material is given up? | the move's principal variation, replayed on the board | A real sacrifice is a loss of material in *the engine's* line, not a heuristic |
| Does it hold when you look deeper? | `go depth N+4`, MultiPV 3 | Rejects brilliants that only look good at shallow depth |
| Win / draw / loss chances | `UCI_ShowWDL` | Expected points that know a drawn ending from a won one |

Only a handful of moves per game need the follow-up questions (`interrogate` in `js/analysis.js`). Answers are cached and
stored on the device. If the engine cannot answer, the move is graded from the first pass and the review is not affected.
The "Extra Stockfish questions" option switches this off.

The card shows the conversation ("What Stockfish said about this move") for brilliant and great moves and for sacrifices
that were close to brilliant but were not, including why.

## Grades

Expected points are 0-100 from the mover's side (from Stockfish's win/draw/loss when available, else a centipawn curve),
softened a little for weaker players when the PGN has Elo headers.

| Grade | Rule |
|---|---|
| Book | the position after the move is in the opening book (`js/openings.js`), game starts from the normal start position |
| Forced | the only legal move |
| Brilliant | a real piece sacrifice (net -2 or worse in the engine's line, a piece lost), best or within 2 points, not left worse than equal, not already completely winning (92+), the best *other* move not completely winning either (90+), not a recapture, and the deeper look agrees |
| Great | best move, not a recapture, and either the only good move (next best is 12+ points worse) or the move that changes the outcome (equal to winning, losing to equal) with an 8+ gap |
| Best / Excellent / Good | best move; up to 2 points lost; up to 5 |
| Inaccuracy / Mistake / Blunder | 5 / 10 / 20 points lost |
| Miss | an inaccuracy or mistake right after the opponent's mistake |

## Game accuracy, rating and stats

* Per-move accuracy: Lichess' curve of the expected points lost.
* Game accuracy: moves in sharp positions weigh more (volatility weighting), averaged with the harmonic mean so one terrible
  move costs more than a plain average says.
* Game rating: an estimate interpolated from accuracy, rounded to 50, withheld under 8 moves. It estimates how well the game
  was played; it is not a measured rating.
* Also: average centipawn loss, and accuracy in the opening / middlegame / endgame.

## Tests

`node tests/kit.mjs verify --all` (see `tests/AGENTS.md`). Stockfish itself is mocked in the kit: the real engine's
`searchmoves` and `UCI_ShowWDL` output should be confirmed once with `kit.mjs`'s engine check on a machine that has it.
