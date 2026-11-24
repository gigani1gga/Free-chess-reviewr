// node lib/syntax-check.mjs file.js : exit 0 if the file parses as an ES module (copies it to .mjs so node --check treats it as one).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const f = process.argv[2], tmp = f + '.check.mjs';
fs.copyFileSync(f, tmp);
const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
fs.rmSync(tmp, { force: true });
process.exit(r.status === 0 ? 0 : 1);
