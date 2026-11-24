// The kit's chess.js stand-in as an importable ES module (src/chess-core.js is a plain script so it can also be pasted into the
// mock engine's worker file; this wraps it). Cached by content hash so it is rewritten only when the source changes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildDir, importFile, kitRoot } from './env.mjs';

let cached = null;
export async function chessModule() {
  if (cached) return cached;
  const src = fs.readFileSync(path.join(kitRoot, 'src/chess-core.js'), 'utf8');
  const h = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  const file = path.join(buildDir, `chess-module-${h}.mjs`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(file + '.tmp' + process.pid, src + '\nexport { Chess, ChessCore };\n');
    fs.renameSync(file + '.tmp' + process.pid, file); // atomic: parallel suites may race to create it
  }
  return (cached = await importFile(file));
}
