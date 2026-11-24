// Mutation testing: how good are the tests, really? Small deliberate bugs ("mutants": >= turned into >, && into ||, a constant nudged)
// are planted in a COPY of the app's logic files, one at a time, and the fast Node suites are run against each copy. A mutant that
// makes some test fail is "killed" (good: the tests notice that kind of bug). One that survives is a blind spot: a real bug of
// that shape would ship. Survivors are listed with file and line so tests can be added there.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildDir, kitRoot, siteDir } from './env.mjs';
import { rng } from './prng.mjs';
import { TAG_FILES } from './impact.mjs';

const OPS = [
  ['>= to >', /(?<![=!<>])>=(?!=)/, '>'], ['> to >=', /(?<![=!<>\-])\s>\s(?!=)/, ' >= '],
  ['<= to <', /<=(?!=)/, '<'], ['< to <=', /(?<![=!<>])\s<\s(?!=)/, ' <= '],
  ['=== to !==', /===/, '!=='], ['!== to ===', /!==/, '==='],
  ['&& to ||', /&&/, '||'], ['|| to &&', /\|\|/, '&&'],
  ['true to false', /\btrue\b/, 'false'], ['false to true', /\bfalse\b/, 'true'],
  ['+ to -', /(?<=[\w)\]])\s\+\s(?=[\w(])/, ' - '], ['- to +', /(?<=[\w)\]])\s-\s(?=[\w(])/, ' + '],
  ['* to /', /(?<=[\w)\]])\s\*\s(?=[\w(])/, ' / '],
  ['Math.max to Math.min', /Math\.max/, 'Math.min'], ['Math.min to Math.max', /Math\.min/, 'Math.max'],
  ['constant + 1', /(?<![\w.$'"#-])(\d+(?:\.\d+)?)(?![\w.'"])/, null],
  ['! removed', /(?<![!=])!(?=[\w(])/, ''],
];
// Lines that are mostly text or markup are not logic: mutating them only creates noise.
const SKIP_LINE = /^\s*(import|export\s*\{|\/\/|\*|\/\*)|`|<[a-z/]|'[^']*[a-z]{4,}[^']*'.*'[^']*[a-z]{4,}|case\s|console\./i;

export function candidates(file, code) {
  const out = [];
  code.split('\n').forEach((line, i) => {
    if (SKIP_LINE.test(line)) return;
    const body = line.replace(/\/\/.*$/, '');
    for (const [op, re, rep] of OPS) {
      const m = re.exec(body);
      if (!m) continue;
      const after = rep == null ? body.replace(re, (all, n) => String(+n === 0 ? 1 : +n + (Number.isInteger(+n) ? 1 : 0.5))) : body.replace(re, rep);
      if (after === body) continue;
      out.push({ file, line: i + 1, op, before: body.trim(), after: after.trim(), full: line.replace(body, after) });
    }
  });
  return out;
}

const run = (script, args, env, timeout) => new Promise(resolve => {
  const p = spawn(process.execPath, [path.join(kitRoot, script), ...args], { env: { ...process.env, ...env, KIT_QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d));
  const t = setTimeout(() => { p.kill('SIGKILL'); out += '\nTIMEOUT'; }, timeout);
  p.on('close', code => { clearTimeout(t); resolve({ code, out }); });
});

export async function mutationRun({ files = ['review.js', 'analysis.js', 'coach.js', 'util.js', 'engine.js'], max = 40, seed = 1, workers = 2, suites = ['suites/unit.mjs', 'suites/fuzz.mjs', 'suites/snapshot.mjs'], deep = false, onProgress = () => {} } = {}) {
  const site = siteDir();
  const all = [];
  for (const f of files) all.push(...candidates(f, fs.readFileSync(path.join(site, 'js', f), 'utf8')));
  // A deterministic sample, spread across files and operators (not just the first N lines).
  const r = rng(seed), pool = [...all];
  for (let i = pool.length - 1; i > 0; i--) { const j = r.int(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const picked = pool.slice(0, max).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const root = path.join(buildDir, 'mut');
  fs.rmSync(root, { recursive: true, force: true });
  // The baseline: the UNMUTATED code must pass these exact runs, or "a test failed" would not mean "the test caught the bug".
  fs.mkdirSync(path.join(root, 'base'), { recursive: true });
  fs.cpSync(path.join(site, 'js'), path.join(root, 'base/js'), { recursive: true });
  fs.cpSync(path.join(site, 'vendor'), path.join(root, 'base/vendor'), { recursive: true });
  for (const s of suites) {
    if (!fs.existsSync(path.join(kitRoot, s))) continue;
    const res = await run(s, ['--budget-ms', '500', '--seed', '1', '--retries', '0'], { KIT_SITE: path.join(root, 'base') }, 60000);
    if (res.code !== 0) throw new Error(`the unmutated app already fails ${s} with the mutation settings, so mutation results would be meaningless:\n${res.out.split('\n').filter(l => /^(FAIL|XPASS)/.test(l)).slice(0, 3).join('\n')}`);
  }
  const results = [];
  let next = 0;
  const worker = async w => {
    while (next < picked.length) {
      const k = next++, m = picked[k], dir = path.join(root, `m${k}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.cpSync(path.join(site, 'js'), path.join(dir, 'js'), { recursive: true });
      fs.cpSync(path.join(site, 'vendor'), path.join(dir, 'vendor'), { recursive: true });
      const target = path.join(dir, 'js', m.file), lines = fs.readFileSync(target, 'utf8').split('\n');
      lines[m.line - 1] = m.full;
      fs.writeFileSync(target, lines.join('\n'));
      const syntax = await run('lib/syntax-check.mjs', [target], {}, 10000);
      let status = 'survived', by = '';
      if (syntax.code !== 0) status = 'invalid'; // the mutation broke the syntax: not a useful mutant
      else {
        for (const s of suites) {
          if (!fs.existsSync(path.join(kitRoot, s))) continue;
          const res = await run(s, ['--budget-ms', '500', '--seed', '1', '--retries', '0'], { KIT_SITE: dir }, 60000);
          if (res.code !== 0) { status = 'killed'; by = s.replace(/^suites\/|\.mjs$/g, '') + ': ' + (res.out.split('\n').find(l => /^(FAIL|XPASS)/.test(l)) || 'a test failed').replace(/^FAIL\s+/, '').slice(0, 110); break; }
        }
      }
      // --deep: a mutant the Node suites missed gets a second chance against the browser tests that exercise that file.
      if (status === 'survived' && deep) {
        const tags = Object.entries(TAG_FILES).filter(([, fs2]) => fs2.includes('js/' + m.file)).map(([t]) => t);
        fs.cpSync(site, dir, { recursive: true, filter: src => !/[\\/]js$/.test(src) || true });
        fs.writeFileSync(path.join(dir, 'js', m.file), lines.join('\n'));
        const res = await run('suites/e2e.mjs', ['--tag', tags.join(','), '--retries', '0', '--workers', '2', '--timeout', '60000', '--bail'], { KIT_SITE: dir }, 240000);
        if (res.code !== 0) { status = 'killed'; by = 'e2e: ' + (res.out.split('\n').find(l => /^FAIL/.test(l)) || 'a browser test failed').replace(/^FAIL\s+/, '').slice(0, 110); }
      }
      fs.rmSync(dir, { recursive: true, force: true });
      const rec = { id: k + 1, file: 'js/' + m.file, line: m.line, op: m.op, before: m.before, after: m.after, status, by };
      results.push(rec);
      onProgress(rec, results.length, picked.length);
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
  results.sort((a, b) => a.id - b.id);
  const valid = results.filter(x => x.status !== 'invalid'), killed = valid.filter(x => x.status === 'killed').length;
  return { candidates: all.length, tried: results.length, invalid: results.length - valid.length, killed, survived: valid.length - killed, score: valid.length ? killed / valid.length : 1, results };
}
