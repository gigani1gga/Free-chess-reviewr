// Where things are, and what this machine has. Nothing here is hard-coded to one sandbox: every path can be overridden by an
// environment variable, and the rest is discovered.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const buildDir = path.resolve(process.env.KIT_BUILD || path.join(kitRoot, 'build'));
export const artifactsDir = path.join(buildDir, 'artifacts');
export const siteDir = () => path.resolve(process.env.KIT_SITE || path.join(buildDir, 'site'));

const isProject = d => d && fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, 'js'));

// The Game Review project the kit tests. PROJECT_ROOT wins; else the parent folder (kit inside the project as tests/),
// else the working directory, else a sibling that looks like the project (kit unpacked beside it).
export function projectRoot() {
  const cands = [process.env.PROJECT_ROOT, path.resolve(kitRoot, '..'), process.cwd(), path.resolve(process.cwd(), '..')];
  try { for (const e of fs.readdirSync(path.resolve(kitRoot, '..'), { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) cands.push(path.join(path.resolve(kitRoot, '..'), e.name)); } catch { /* ignore */ }
  return cands.filter(Boolean).map(d => path.resolve(d)).find(isProject) || null;
}

const tryRequire = (spec, from) => { try { return createRequire(from)(spec); } catch { return null; } };
const ok = p => p && fs.existsSync(p);

// The playwright package. Order: PLAYWRIGHT_PATH, the usual sandbox location, kit/project node_modules, global npm.
export function findPlaywright() {
  const cands = [process.env.PLAYWRIGHT_PATH, '/opt/npm-tools/node_modules/playwright', path.join(kitRoot, 'node_modules/playwright'),
    path.join(kitRoot, '../node_modules/playwright'), path.join(process.cwd(), 'node_modules/playwright')];
  const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 });
  if (g.status === 0) cands.push(path.join(g.stdout.trim(), 'playwright'));
  for (const c of cands) if (ok(c)) return c;
  return null;
}
export function loadPlaywright() {
  const p = findPlaywright();
  if (!p) throw new Error('the playwright npm package was not found. Set PLAYWRIGHT_PATH=/path/to/node_modules/playwright (or `npm i playwright` next to the kit)');
  return createRequire(import.meta.url)(p);
}

// A Chrome/Chromium binary. Order: CHROME, common install paths, the browser playwright itself downloaded.
export function findChrome() {
  const cands = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
  for (const c of cands) if (ok(c)) return c;
  try { const p = loadPlaywright().chromium.executablePath(); if (ok(p)) return p; } catch { /* none */ }
  return null;
}
export const launchOptions = () => ({ executablePath: findChrome() || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,OptimizationHints,MediaRouter'] });

export const cpuCount = () => Math.max(1, os.cpus().length);
// How many browser tests to run at once. They mostly wait on timers rather than burn CPU, so this can exceed the core count a little.
export const defaultWorkers = () => Math.max(2, Math.min(4, cpuCount() + 1));

export const importFile = (file, bust = false) => import(pathToFileURL(file).href + (bust ? '?' + Date.now() + Math.random() : ''));
