// The one test framework every suite in the kit uses, so they all behave and report the same way:
//   - tests have a stable id (`suite/slug`), tags, and the project files they exercise (`covers`)
//   - async tests run through a small worker pool (--workers), each with a hard time limit
//   - a failed test is retried (--retries); passing on the retry is reported as FLAKY, never silently as PASS
//   - `xfail` marks a known bug: it must keep failing (xfail) and is flagged (xpass) the day it is fixed
//   - results go to the terminal (human or compact "agent" form) and to a JSON file (KIT_RESULT) that kit.mjs merges
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { artifactsDir } from './env.mjs';
import { hintFor } from './hints.mjs';

export const als = new AsyncLocalStorage(); // the test that is running right now (so helpers can attach pages/artifacts to it)
export const current = () => als.getStore();
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);

export function readOptions(argv = process.argv.slice(2), env = process.env) {
  const { values: v } = parseArgs({
    args: argv, strict: false,
    options: {
      only: { type: 'string' }, skip: { type: 'string' }, tag: { type: 'string' }, workers: { type: 'string' }, retries: { type: 'string' },
      timeout: { type: 'string' }, json: { type: 'string' }, quiet: { type: 'boolean' }, list: { type: 'boolean' }, seed: { type: 'string' },
      'budget-ms': { type: 'string' }, strict: { type: 'boolean' }, bail: { type: 'boolean' }, fast: { type: 'boolean' }, site: { type: 'string' },
    },
  });
  const num = (a, e, d) => (a != null && a !== '' ? +a : e != null && e !== '' ? +e : d);
  return {
    only: v.only ?? env.KIT_ONLY ?? '', skip: v.skip ?? env.KIT_SKIP ?? '', tag: v.tag ?? env.KIT_TAG ?? '',
    workers: num(v.workers, env.KIT_WORKERS, null), retries: num(v.retries, env.KIT_RETRIES, null), timeout: num(v.timeout, env.KIT_TIMEOUT, null),
    result: v.json ?? env.KIT_RESULT ?? '', quiet: !!(v.quiet ?? env.KIT_QUIET), list: !!(v.list ?? env.KIT_LIST), seed: num(v.seed, env.KIT_SEED, null),
    budgetMs: num(v['budget-ms'], env.KIT_BUDGET_MS, null), strict: !!(v.strict ?? env.KIT_STRICT), bail: !!(v.bail ?? env.KIT_BAIL), fast: !!(v.fast ?? env.KIT_FAST),
  };
}

const re = s => { try { return new RegExp(s, 'i'); } catch { return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } };

export function createSuite(name, defaults = {}) {
  const o = readOptions();
  const cfg = { workers: o.workers ?? defaults.workers ?? 1, retries: o.retries ?? defaults.retries ?? 0, timeout: o.timeout ?? defaults.timeout ?? 60000 };
  const t0 = Date.now(), results = [], queue = [], ids = new Set();
  const only = o.only && re(o.only), skip = o.skip && re(o.skip), tags = o.tag ? o.tag.split(/[,|]/).filter(Boolean) : [];
  let stop = false;

  const idFor = n => { let id = `${name}/${slug(n)}`, k = 2; while (ids.has(id)) id = `${name}/${slug(n)}-${k++}`; ids.add(id); return id; };
  const selected = (id, n, meta) => {
    if (only && !only.test(id) && !only.test(n)) return false;
    if (skip && (skip.test(id) || skip.test(n))) return false;
    if (tags.length && !tags.some(t => (meta.tags || []).includes(t))) return false;
    if (o.fast && (meta.tags || []).includes('slow')) return false;
    return true;
  };

  const out = r => {
    results.push(r);
    const bad = !['pass', 'xfail', 'skip'].includes(r.status);
    if (o.quiet && !bad) return;
    const label = { pass: 'PASS ', fail: 'FAIL ', flaky: 'FLAKY', skip: 'SKIP ', xfail: 'XFAIL', xpass: 'XPASS', warn: 'WARN ' }[r.status] || r.status;
    const time = r.ms >= 50 ? `  (${r.ms} ms${r.attempts > 1 ? `, attempt ${r.attempts}` : ''})` : '';
    console.log(`${label} ${r.name}${time}${r.detail ? '\n      ' + String(r.detail).split('\n').slice(0, 4).join('\n      ') : ''}`);
    if (r.status === 'fail' && r.hint) console.log(`      hint: ${r.hint}`);
  };

  const api = {
    name, opts: o, cfg, results,
    // An immediate, synchronous check (unit-test style).
    check(n, cond, detail = '', meta = {}) {
      const id = idFor(n);
      if (!selected(id, n, meta)) return cond;
      const failed = !cond;
      let status = failed ? (meta.warn ? 'warn' : 'fail') : 'pass';
      if (meta.xfail) status = failed ? 'xfail' : 'xpass';
      out({ id, suite: name, name: n, status, ms: 0, attempts: 1, tags: meta.tags || [], covers: meta.covers || [], detail: failed ? String(detail) : meta.xfail && !failed ? 'expected to fail, but passes now: remove xfail' : '', ...(failed && !meta.xfail && !meta.warn ? { hint: hintFor(String(detail), n, meta) } : {}), ...(meta.xfail ? { xfail: meta.xfail } : {}) });
      return cond;
    },
    // A registered async test (run later by run()). `fn` may use current() to reach per-test state.
    test(n, fn, meta = {}) {
      const id = idFor(n);
      if (selected(id, n, meta)) queue.push({ id, name: n, fn, meta });
    },
    skipped(n, why, meta = {}) { out({ id: idFor(n), suite: name, name: n, status: 'skip', ms: 0, attempts: 0, tags: meta.tags || [], covers: meta.covers || [], detail: why }); },

    async run({ onFail, onEnd } = {}) {
      if (o.list) {
        const all = [...results.map(r => ({ id: r.id, name: r.name, tags: r.tags, covers: r.covers })), ...queue.map(q => ({ id: q.id, name: q.name, tags: q.meta.tags || [], covers: q.meta.covers || [], slow: (q.meta.tags || []).includes('slow'), xfail: q.meta.xfail || undefined }))];
        if (o.result) fs.writeFileSync(o.result, JSON.stringify({ suite: name, list: all }, null, 1)); else console.log(JSON.stringify(all, null, 1));
        process.exit(0);
      }
      let next = 0;
      const worker = async () => {
        while (!stop && next < queue.length) {
          const t = queue[next++];
          await runOne(t, onFail);
          if (o.bail && results.some(r => r.status === 'fail')) stop = true;
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(cfg.workers, queue.length || 1)) }, worker));
      await onEnd?.();
    },

    finish() {
      const count = s => results.filter(r => r.status === s).length;
      const summary = { pass: count('pass'), fail: count('fail'), flaky: count('flaky'), skip: count('skip'), xfail: count('xfail'), xpass: count('xpass'), warn: count('warn'), total: results.length };
      const failed = summary.fail + summary.xpass + (o.strict ? summary.flaky : 0);
      const doc = { suite: name, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, seed: o.seed, summary, results };
      if (o.result) { fs.mkdirSync(path.dirname(path.resolve(o.result)), { recursive: true }); fs.writeFileSync(o.result, JSON.stringify(doc, null, 1)); }
      const bits = [`${summary.pass} passed`, summary.fail && `${summary.fail} FAILED`, summary.flaky && `${summary.flaky} flaky`, summary.xfail && `${summary.xfail} known-bug`, summary.xpass && `${summary.xpass} unexpectedly fixed`, summary.skip && `${summary.skip} skipped`].filter(Boolean);
      console.log(`\n${name}: ${bits.join(', ')}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      const code = failed ? 1 : 0;
      process.exitCode = code;
      process.stdout.write('', () => process.exit(code));
      return doc;
    },
  };

  async function runOne(t, onFail) {
    const maxAttempts = 1 + (t.meta.retries ?? cfg.retries);
    const limit = t.meta.timeout ?? cfg.timeout;
    let firstErr = null, attempt = 0, status = 'fail', err = null, ms = 0, artifacts = {};
    while (attempt < maxAttempts) {
      attempt++;
      const state = { id: t.id, attempt, pages: [], contexts: [], cleanups: [], artifacts: {}, dir: path.join(artifactsDir, t.id.replace('/', '__')) };
      const s0 = Date.now();
      let timer;
      try {
        await als.run(state, () => Promise.race([
          Promise.resolve().then(t.fn),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`test timed out after ${limit} ms`)), limit); }),
        ]));
        err = null;
      } catch (e) { err = e; }
      clearTimeout(timer);
      ms = Date.now() - s0;
      if (err) { try { await onFail?.(state, err); } catch { /* artifact capture is best-effort */ } }
      for (const c of state.cleanups.reverse()) { try { await c(); } catch { /* ignore */ } }
      artifacts = { ...artifacts, ...state.artifacts };
      if (!err) { status = 'pass'; break; }
      firstErr ??= err;
      status = 'fail';
    }
    if (status === 'pass' && attempt > 1) status = 'flaky';
    if (t.meta.xfail) status = status === 'pass' ? 'xpass' : 'xfail';
    const msg = (firstErr || err)?.message || '';
    out({
      id: t.id, suite: name, name: t.name, status, ms, attempts: attempt, tags: t.meta.tags || [], covers: t.meta.covers || [],
      detail: status === 'pass' ? '' : status === 'xpass' ? 'expected to fail, but passes now: remove xfail' : msg.split('\n').slice(0, 6).join('\n'),
      ...(status === 'fail' || status === 'flaky' ? { hint: hintFor(msg, t.name, t.meta) } : {}),
      ...(Object.keys(artifacts).length ? { artifacts } : {}), ...(t.meta.xfail ? { xfail: t.meta.xfail } : {}),
    });
  }
  return api;
}
