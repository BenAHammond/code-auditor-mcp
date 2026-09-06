#!/usr/bin/env bash
# verify-clean-install.sh — clean-room install gate.
#
# verify:dist proves the *tarball* installs and its bundled natives load, but it
# runs stock `npm` against `dist/native/` binaries the repo pre-bundles — it
# cannot catch a broken *source* install. Three defects have each shipped green
# under it, because the check ran against a node_modules that was already correct:
#
#   1. A stale pnpm-lock.yaml — `pnpm install --frozen-lockfile` fails, or
#      resolves a dependency set that no longer matches package.json.
#   2. A missing pnpm.onlyBuiltDependencies allowlist — pnpm 10 skips native
#      build scripts, so better-sqlite3 gets no binding and esbuild no binary.
#   3. A platform-mismatched ~/.npmrc (`os=linux` on a Mac) — natives resolve or
#      compile for the wrong platform and fail ERR_DLOPEN_FAILED at load time.
#
# This gate replicates a stranger's first install: a fresh directory, no
# node_modules, `pnpm install --frozen-lockfile`, then the natives actually load
# and run. `--frozen-lockfile` is deliberate — a non-frozen install would
# silently regenerate a stale lockfile and mask defect #1.
#
# Exit 0 iff the install succeeds AND better-sqlite3 executes SQL, esbuild
# transforms, and @ast-grep/napi parses.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

fail() { echo -e "${RED}FAIL:${NC} $*"; exit 1; }
pass() { echo -e "${GREEN}PASS:${NC} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for f in package.json pnpm-lock.yaml; do
  [ -f "$f" ] || fail "missing $f — cannot stage a clean-room install."
done

# Prefer corepack so the install honors packageManager (pnpm@10.12.1); fall back
# to whatever `pnpm` is on PATH otherwise.
if command -v corepack >/dev/null 2>&1; then
  PNPM="corepack pnpm"
else
  PNPM="pnpm"
fi

SCRATCH=$(mktemp -d -t ca-verify-clean-install-XXXXX)
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

cp package.json pnpm-lock.yaml "$SCRATCH/"
cd "$SCRATCH"

echo ""
echo "Clean-room install: fresh dir, $PNPM install --frozen-lockfile ..."
if $PNPM install --frozen-lockfile 2>&1; then
  pass "pnpm install --frozen-lockfile completed"
else
  rc=$?
  fail "pnpm install --frozen-lockfile exited $rc — a clean checkout does not install"
fi

# ── Guard 1: better-sqlite3 binds AND executes SQL ─────────────────────────
# A mere require() succeeds even when the native binding is missing (the JS
# wrapper loads); the failure only surfaces on first use. Exercise it for real.
echo ""
echo "Checking better-sqlite3 executes SQL..."
if node -e "
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(x INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(42);
  const row = db.prepare('SELECT x FROM t').get();
  db.close();
  if (!row || row.x !== 42) { console.error('unexpected result:', row); process.exit(1); }
  console.log('better-sqlite3 bound and queried (x=' + row.x + ')');
" 2>&1; then
  pass "better-sqlite3 native binding present and working"
else
  fail "better-sqlite3 has no native binding — build script skipped (pnpm.onlyBuiltDependencies missing?)"
fi

# ── Guard 2: esbuild binary present ────────────────────────────────────────
# esbuild is a *transitive* dep (of tsx/vitest), so it is not hoisted to the
# scratch root — resolve it the way a dependent would. Its binary ships in the
# @esbuild/<platform> package; a wrong ~/.npmrc `os=` resolves the wrong platform
# and transformSync fails here.
echo ""
echo "Checking esbuild transforms..."
if node -e "
  const { createRequire } = require('node:module');
  const req = createRequire(require.resolve('tsx/package.json'));
  const esbuild = req('esbuild');
  const out = esbuild.transformSync('let x: number = 1;', { loader: 'ts' });
  if (!out || typeof out.code !== 'string' || out.code.length === 0) {
    console.error('empty transform output'); process.exit(1);
  }
  console.log('esbuild binary present and transforming (v' + esbuild.version + ')');
" 2>&1; then
  pass "esbuild binary present and working"
else
  fail "esbuild has no working binary — wrong-platform dependency or missing postinstall"
fi

# ── Guard 3: @ast-grep/napi loads via its platform optional dep ────────────
# @ast-grep/napi needs no build script — its prebuilt binary ships in
# @ast-grep/napi-<platform>. A wrong ~/.npmrc `os=` resolves the wrong platform
# package and require() fails here.
echo ""
echo "Checking @ast-grep/napi loads..."
if node -e "
  const napi = require('@ast-grep/napi');
  const root = napi.parse('TypeScript', 'let x = 1;');
  if (!root || !root.root || typeof root.root().kind !== 'function') process.exit(1);
  console.log('@ast-grep/napi parsed (platform optional dep resolved)');
" 2>&1; then
  pass "@ast-grep/napi native binding present"
else
  fail "@ast-grep/napi did not load — wrong-platform optional dependency (check ~/.npmrc os=)"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Clean-room install check PASSED${NC}"
echo -e "${GREEN}========================================${NC}"
