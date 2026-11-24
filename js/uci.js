// The words Stockfish speaks (UCI), as pure functions: no worker, no DOM, so they can be tested line by line.

// One `info` line -> { k, cp|mate, pv, depth, seldepth, nodes, wdl } or null when the line carries no usable score.
// Bound lines (aspiration-window fails) are skipped: they are not real scores. `wdl` is [win, draw, loss] in per mille from the
// side to move's view and is only there when the engine was asked for it (UCI_ShowWDL).
export function parseInfo(line) {
  if (typeof line !== 'string' || !line.startsWith('info') || / (lowerbound|upperbound)/.test(line)) return null;
  const s = / score (cp|mate) (-?\d+)/.exec(line), p = / pv (.+)$/.exec(line);
  if (!s || !p) return null;
  const num = re => { const m = re.exec(line); return m ? +m[1] : undefined; };
  const w = / wdl (\d+) (\d+) (\d+)/.exec(line);
  const out = { k: num(/ multipv (\d+)/) ?? 1, [s[1]]: +s[2], pv: p[1].trim().split(/\s+/) };
  const depth = num(/ depth (\d+)/), seldepth = num(/ seldepth (\d+)/), nodes = num(/ nodes (\d+)/);
  if (depth != null) out.depth = depth;
  if (seldepth != null) out.seldepth = seldepth;
  if (nodes != null) out.nodes = nodes;
  if (w) out.wdl = [+w[1], +w[2], +w[3]];
  return out;
}

// The `go` command. `moves` restricts the root to those moves ("how good is exactly this one?").
export const goCommand = (depth, moves) => `go depth ${depth}` + (moves && moves.length ? ' searchmoves ' + moves.join(' ') : '');
