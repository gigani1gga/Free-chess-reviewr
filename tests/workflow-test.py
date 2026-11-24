#!/usr/bin/env python3
"""Runs the REAL shell/python from .github/workflows/deploy.yml in a sandbox with fake npm/npx/curl, against mock
copies of the stockfish@19.0.1 npm package (file names taken from the package README). Checks what lands in site/engine
and that the job fails loudly (instead of publishing a broken site) when the package isn't what the workflow expects."""
import os, shutil, stat, subprocess, sys, tempfile, textwrap, zipfile, json, yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.environ.get('PROJECT_ROOT') or os.path.dirname(HERE))
wf = yaml.safe_load(open(os.path.join(ROOT, '.github/workflows/deploy.yml')))
steps = {s.get('name'): s for s in wf['jobs']['build']['steps'] if 'name' in s}
ASSEMBLE = steps['Assemble site']['run']
UNZIP = steps['Unzip, keep folders, replace older files']['run']

ICONS = 'sparkles zap star thumbs-up book-open arrow-right check circle-alert triangle-alert x octagon-x skip-back skip-forward chevron-left chevron-right arrow-up-down'.split()

FAKE_NPM = r'''#!/bin/bash
# fake npm: only what deploy.yml calls
if [ "$1" = "init" ]; then echo '{}' > package.json; exit 0; fi
if [ "$1" = "i" ]; then
  echo "npm i $*" >> "$FAKE_LOG"
  case "$*" in *stockfish@19.0.1*) ;; *) echo "workflow must pin stockfish@19.0.1" >&2; exit 9;; esac
  mkdir -p node_modules/stockfish node_modules/chess.js node_modules/lucide-static/icons
  (cd "$SCENARIO_DIR/pkg" && find . -type f | while read f; do mkdir -p "$OLDPWD/node_modules/stockfish/$(dirname "$f")"; cp "$f" "$OLDPWD/node_modules/stockfish/$f"; done)
  for i in $ICONS; do [ "$MISSING_ICON" = "$i" ] || echo '<svg/>' > node_modules/lucide-static/icons/$i.svg; done
  exit 0
fi
echo "unexpected npm call: $*" >&2; exit 9
'''
FAKE_NPX = r'''#!/bin/bash
# fake npx esbuild e.js --bundle ... --outfile=PATH
for a in "$@"; do case "$a" in --outfile=*) out="${a#--outfile=}";; esac; done
[ -f e.js ] || { echo "esbuild entry e.js missing" >&2; exit 9; }
mkdir -p "$(dirname "$out")"; echo 'export class Chess {}' > "$out"
'''
FAKE_CURL = r'''#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done
[ -n "$out" ] && echo '<svg/>' > "$out"
'''

def sh(path, text):
    open(path, 'w').write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)

def build_pkg(d, files):
    for f in files:
        p = os.path.join(d, 'pkg', f)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'wb').write(b'\0asm' if f.endswith('.wasm') else b'// engine\n')

def pkg19(drop=(), extra=()):
    base = ['stockfish-19', 'stockfish-19-single', 'stockfish-19-lite', 'stockfish-19-lite-single']
    fs = [f'src/{b}.js' for b in base] + [f'src/{b}.wasm' for b in base] + ['src/stockfish-19-asm.js',
          'index.js', 'package.json', 'examples/loadEngine.js', 'scripts/cli.js', 'README.md']
    return [f for f in fs if f not in drop] + list(extra)

def run_assemble(files, env_extra=None):
    d = tempfile.mkdtemp(prefix='wf-')
    try:
        build_pkg(d, files)
        for n in ('index.html', 'style.css'): shutil.copy(os.path.join(ROOT, n), d)
        shutil.copytree(os.path.join(ROOT, 'js'), os.path.join(d, 'js'))
        bin_ = os.path.join(d, 'bin'); os.makedirs(bin_)
        sh(os.path.join(bin_, 'npm'), FAKE_NPM); sh(os.path.join(bin_, 'npx'), FAKE_NPX); sh(os.path.join(bin_, 'curl'), FAKE_CURL)
        work = os.path.join(d, 'repo'); os.makedirs(work)
        for n in ('index.html', 'style.css'): shutil.move(os.path.join(d, n), work)
        shutil.move(os.path.join(d, 'js'), work)
        env = dict(os.environ, PATH=bin_ + ':' + os.environ['PATH'], SCENARIO_DIR=d, FAKE_LOG=os.path.join(d, 'log'), ICONS=' '.join(ICONS))
        env.update(env_extra or {})
        # GitHub Actions runs `run:` blocks with: bash -e {0}
        r = subprocess.run(['bash', '-e', '-c', ASSEMBLE], cwd=work, env=env, capture_output=True, text=True)
        eng = os.path.join(work, 'site/engine')
        listing = sorted(os.listdir(eng)) if os.path.isdir(eng) else []
        manifest = json.load(open(os.path.join(eng, 'manifest.json'))) if 'manifest.json' in listing else None
        return r, listing, manifest, work
    finally:
        pass

fails = 0
def check(name, cond, detail=''):
    global fails
    print(('PASS  ' if cond else 'FAIL  ') + name + ('' if cond else f'\n      {detail}'))
    if not cond: fails += 1

# 1. the real layout of stockfish@19.0.1 -----------------------------------------------------------------------
r, ls, m, work = run_assemble(pkg19())
check('19.0.1 layout: job succeeds', r.returncode == 0, r.stdout + r.stderr)
check('19.0.1 layout: only the two single-threaded builds (+ their wasm) are published',
      ls == ['manifest.json', 'stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'stockfish-19-single.js', 'stockfish-19-single.wasm'], str(ls))
check('19.0.1 layout: manifest picks full as "best" and lite as "fast"', m == {'best': 'stockfish-19-single.js', 'fast': 'stockfish-19-lite-single.js'}, str(m))
check('19.0.1 layout: multi-threaded and asm builds are NOT copied (they would need COOP/COEP or be huge)',
      not any(x in ls for x in ('stockfish-19.js', 'stockfish-19.wasm', 'stockfish-19-lite.js', 'stockfish-19-asm.js')), str(ls))
check('19.0.1 layout: log prints the two engine file names', '"best":"stockfish-19-single.js"' in r.stdout and '"fast":"stockfish-19-lite-single.js"' in r.stdout, r.stdout[-400:])
check('19.0.1 layout: npm is called with the pinned version', 'stockfish@19.0.1' in open(os.path.join(os.path.dirname(work), 'log')).read())
for need in ('index.html', 'style.css', 'sw.js', 'js/engine.js', 'vendor/chess.js', 'pieces/wP.svg', 'pieces/bK.svg', 'icons/sparkles.svg', 'icons/arrow-up-down.svg'):
    check(f'site contains {need}', os.path.exists(os.path.join(work, 'site', need)))

# 2. same, but file names carry hashes (earlier Stockfish.js releases did this) --------------------------------
hashed = ['src/stockfish-17.1-single-a496a04.js', 'src/stockfish-17.1-single-a496a04.wasm', 'src/stockfish-17.1-lite-single-03e3232.js',
          'src/stockfish-17.1-lite-single-03e3232.wasm', 'src/stockfish-17.1-8e4d048.js', 'src/stockfish-17.1-8e4d048.wasm', 'src/stockfish-17.1-asm-341ff22.js']
r, ls, m, _ = run_assemble(hashed)
check('hashed names (older releases): still picks full + lite correctly', r.returncode == 0 and m == {'best': 'stockfish-17.1-single-a496a04.js', 'fast': 'stockfish-17.1-lite-single-03e3232.js'}, f'{m} {r.stderr}')

# 3. things going wrong must fail the job, never publish a half-broken engine folder ----------------------------
r, ls, m, _ = run_assemble(pkg19(drop=['src/stockfish-19-lite-single.js', 'src/stockfish-19-lite-single.wasm']))
check('lite build missing: job fails with an ::error::', r.returncode != 0 and '::error::' in r.stdout, r.stdout + r.stderr)
r, ls, m, _ = run_assemble(pkg19(drop=['src/stockfish-19-single.wasm']))
check('full .wasm missing: job fails naming the missing file', r.returncode != 0 and 'Missing stockfish-19-single.wasm' in r.stdout, r.stdout + r.stderr)
r, ls, m, _ = run_assemble(pkg19(drop=['src/stockfish-19-single.wasm'], extra=['src/stockfish-19-single-part-0.wasm', 'src/stockfish-19-single-part-1.wasm']))
check('split .wasm (old-style -part-N.wasm): job fails instead of publishing an engine that cannot start', r.returncode != 0, r.stdout + r.stderr)
r, ls, m, _ = run_assemble(pkg19(), {'MISSING_ICON': 'octagon-x'})
check('a lucide icon missing: job fails', r.returncode != 0, r.stdout + r.stderr)

# 4. icons used by the app are all covered by the workflow's icon list ---------------------------------------
import re
meta = open(os.path.join(ROOT, 'js/meta.js')).read(); html = open(os.path.join(ROOT, 'index.html')).read()
used = set(re.findall(r"icon: '([\w-]+)'", meta)) | set(re.findall(r'icons/([\w-]+)\.svg', html))
listed = set(re.search(r'for i in ([^;]+); do cp', ASSEMBLE).group(1).split())
check('every icon the app uses is copied by the workflow', used <= listed, f'missing: {used - listed}')
check('workflow icon list has no unused extras (keeps site small)', listed <= used, f'unused: {listed - used}')

# 5. the zip-unpacking step: the shipped zip drops files in the right places ----------------------------------
zip_path = sys.argv[1] if len(sys.argv) > 1 else None
if zip_path and os.path.exists(zip_path):
    for pat, expect_wf in ((None, False), ('true', True)):
        d = tempfile.mkdtemp(prefix='unz-')
        subprocess.run(['git', 'init', '-q', d]); subprocess.run(['git', '-C', d, 'config', 'user.email', 'a@b'])
        subprocess.run(['git', '-C', d, 'config', 'user.name', 'a'])
        os.makedirs(os.path.join(d, '.github/workflows')); open(os.path.join(d, '.github/workflows/deploy.yml'), 'w').write('old')
        shutil.copy(zip_path, os.path.join(d, 'game-review-updated.zip'))
        env = dict(os.environ, HAS_PAT=pat or 'false')
        r = subprocess.run(['python3', '-c', textwrap.dedent(UNZIP).split("python3 - <<'PY'\n", 1)[1].split('\nPY')[0]], cwd=d, env=env, capture_output=True, text=True)
        wf_now = open(os.path.join(d, '.github/workflows/deploy.yml')).read()
        check(f'zip unpack (WORKFLOW_PAT {"set" if pat else "not set"}): runs and places js files', r.returncode == 0 and os.path.exists(os.path.join(d, 'js/engine.js')), r.stdout + r.stderr)
        check(f'zip unpack (WORKFLOW_PAT {"set" if pat else "not set"}): workflow file {"replaced" if expect_wf else "skipped with a warning"}',
              (wf_now != 'old') == expect_wf and (expect_wf or '::warning::Skipped .github/workflows/deploy.yml' in r.stdout), r.stdout)
        check('zip unpack: zip is consumed', not os.path.exists(os.path.join(d, 'game-review-updated.zip')))

print(f'\n{"all workflow checks passed" if not fails else str(fails) + " workflow check(s) FAILED"}')
sys.exit(1 if fails else 0)
