#!/usr/bin/env bash
# verify-dist.sh — structural guard against "works in repo, broken as distributed"
#
# Runs after `npm pack` in CI/pre-publish. Installs the tarball into a temp dir
# with stock npm, require-checks both native deps, and confirms `code-audit --version`
# exits 0. This is what makes tarball-install regressions structurally unable to
# recur — not a dev-env check, but a stranger's install.
#
# @ast-grep/napi resolves its native binding via the platform-specific
# optionalDependencies (@ast-grep/napi-<platform>) — no bundled binaries, no
# NAPI_RS_NATIVE_LIBRARY_PATH. Guards 2–3 prove that resolution works from a
# stranger's clean install.
#
# Prerequisites (run in CI/pre-publish before this script):
#   cd app && npm pack    # produces code-auditor-mcp-*.tgz

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

fail() { echo -e "${RED}FAIL:${NC} $*"; exit 1; }
pass() { echo -e "${GREEN}PASS:${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }

# --- Locate tarball -----------------------------------------------------------
TARBALL=$(ls code-auditor-mcp-*.tgz 2>/dev/null | head -1)
if [ -z "$TARBALL" ]; then
  fail "No tarball found. Run 'npm pack' first in the app directory."
fi
TARBALL_PATH="$(pwd)/$TARBALL"
echo "Found tarball: $TARBALL_PATH"

# --- Guard: pack-content guard -------------------------------------------------
# The packed tarball must contain no native binding (.node), no compiled
# executable (ELF or Mach-O, detected by magic bytes — not by path), no .go
# source, and no compiled test output (dist/__tests__/). This is the structural
# proof that the bundled-native and Go-subprocess removals held in the artifact,
# independent of the dev environment. The file count and byte totals are reported
# as information only — nothing here asserts a specific size or count.
echo ""
echo "Checking the packed file list (no .node / ELF / Mach-O / .go / dist/__tests__/)..."
PACK_LIST_FILE="$(mktemp -t ca-pack-list-XXXXX)"
npm pack --dry-run --json > "$PACK_LIST_FILE" 2>/dev/null
node -e '
  const fs = require("fs");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
  catch (e) { console.error("FAIL: npm pack --dry-run --json emitted no parseable JSON"); process.exit(1); }
  const root = Array.isArray(parsed) ? parsed[0] : (parsed[Object.keys(parsed)[0]] || parsed);
  const files = (root && Array.isArray(root.files)) ? root.files : [];
  if (files.length === 0) { console.error("FAIL: empty pack list"); process.exit(1); }
  const isElf = (b) => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
  const isMachO = (b) => b.length >= 4 && (
    (b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && (b[3] === 0xce || b[3] === 0xcf)) ||
    (b[0] === 0xce && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) ||
    (b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) ||
    (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe)
  );
  const problems = [];
  for (const entry of files) {
    const p = entry.path;
    if (p.endsWith(".node")) problems.push("native binding (.node): " + p);
    if (p.endsWith(".go")) problems.push("Go source (.go): " + p);
    if (p.startsWith("dist/__tests__/")) problems.push("compiled test (dist/__tests__/): " + p);
    let head;
    try {
      const fd = fs.openSync(p, "r");
      head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
    } catch (e) {
      problems.push("unreadable pack entry: " + p);
      continue;
    }
    if (isElf(head)) problems.push("ELF executable (magic bytes): " + p);
    if (isMachO(head)) problems.push("Mach-O executable (magic bytes): " + p);
  }
  if (problems.length) {
    console.error("FAIL - packed file list contains forbidden content:");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }
  console.log("  OK: " + files.length + " files, " + (root.size || 0) + " bytes tarball / " + (root.unpackedSize || 0) + " bytes unpacked - no .node, no ELF/Mach-O, no .go, no dist/__tests__/");
' "$PACK_LIST_FILE"
rm -f "$PACK_LIST_FILE"

# --- Scratch directory ---------------------------------------------------------
SCRATCH=$(mktemp -d -t ca-verify-dist-XXXXX)
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

echo "Scratch dir: $SCRATCH"

# --- Install tarball with stock npm, no lockfile ------------------------------
echo ""
echo "Installing tarball (stock npm, no lockfile, no project-local npmrc)..."
cd "$SCRATCH"
npm init -y --silent 2>/dev/null

# Deliberately use stock npm: no --ignore-scripts, no custom config.
# If this fails, a stranger gets a broken install.
if npm install "$TARBALL_PATH" --no-save 2>&1; then
  pass "npm install completed"
else
  rc=$?
  fail "npm install exited $rc — tarball install is broken on stock npm"
fi

# --- Guard 1: better-sqlite3 binding presence & load --------------------------
# better-sqlite3 is V8-ABI (not N-API) and loads its .node lazily at
# `new Database()`. npm 11.2+/12 block install scripts by default (allowScripts),
# so on those a stock `npm install` skips prebuild-install and leaves no binding.
# That is a *clear-error* path the tool must handle (asserted in Guard 9), not a
# hard failure here.
echo ""
echo "Checking better-sqlite3..."
BINDING="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ -f "$BINDING" ]; then
  if node -e "
    try {
      const sql = require('better-sqlite3');
      const db = new sql(':memory:');
      db.exec('SELECT 1 AS ok');
      console.log(JSON.stringify(db.prepare('SELECT 1 AS one').get()));
      db.close();
    } catch(e) {
      console.error('LOAD ERROR:', e.message);
      process.exit(1);
    }
  " 2>&1; then
    pass "better-sqlite3 loads and executes SQL"
  else
    fail "better-sqlite3 binding present but failed to load"
  fi
else
  warn "better-sqlite3 binding absent — install script blocked (npm 12 default); the tool's clear-error path is asserted in Guard 9"
fi

# --- Guard 2: @ast-grep/napi resolves its platform optional dep ---------------
echo ""
echo "Checking @ast-grep/napi (platform optional dependency)..."
if node -e "
  // No NAPI_RS_NATIVE_LIBRARY_PATH and no bundled dist/native — @ast-grep/napi's
  // requireNative() must fall back to require('@ast-grep/napi-<platform>').
  delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  try {
    const napi = require('@ast-grep/napi');
    // ast-grep parse signature is parse(lang, source), not parse(source)
    const testRoot = napi.parse('TypeScript', 'let x = 1;');
    if (!testRoot || !testRoot.root) {
      console.error('MISSING API: root or root.root()');
      process.exit(1);
    }
    console.log('API ok — parse/kind present, parse(TypeScript, src) works');
  } catch(e) {
    console.error('LOAD ERROR:', e.message);
    process.exit(1);
  }
" 2>&1; then
  pass "@ast-grep/napi loads via its platform optional dependency"
else
  fail "@ast-grep/napi did not load — the platform optional dependency is missing or mismatched"
fi

# --- Guard 3: @ast-grep/napi succeeds a real parse ----------------------------
echo ""
echo "Checking @ast-grep/napi can parse..."
if node -e "
  delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  const napi = require('@ast-grep/napi');
  const root = napi.parse('TypeScript', 'function add(a: number, b: number): number { return a + b; }');
  const node = root.root();
  const kind = node.kind();
  if (!kind || !node.text()) {
    console.error('Parse produced no output');
    process.exit(1);
  }
  console.log('Parsed root node kind:', kind);
" 2>&1; then
  pass "@ast-grep/napi parses TypeScript successfully"
else
  fail "@ast-grep/napi parse failed"
fi

# --- Guard 4: CLI entry point exits 0 -----------------------------------------
echo ""
echo "Checking code-audit --version..."
if node node_modules/code-auditor-mcp/dist/cli.js --version 2>&1; then
  pass "code-audit --version exits 0"
else
  fail "code-audit --version did not exit 0"
fi

# --- Guard 5: CLI entry point loads napi (tests full optional-dep chain) ------
echo ""
echo "Checking code-audit changed (tests full optional-dep chain)..."
mkdir -p fixtures
echo 'function add(a: number, b: number): number { return a + b; }' > fixtures/test.ts
CHANGED_OUT=""
CHANGED_RC=0
# Capture the exit code inside an `if` so a non-zero exit (the blocked-install
# clear error) does not trip `set -e` before we can classify it. The `changed`
# command runs the real audit path, whose K10 cache GC would reap superseded
# pinned-CLI copies and abandoned project indexes from the fallback OS cache, so
# XDG_CACHE_HOME is pointed at the throwaway scratch dir (the same isolation
# Guard 10 applies to the pinned-install fallback).
if CHANGED_OUT=$(XDG_CACHE_HOME="$SCRATCH/cache" node node_modules/code-auditor-mcp/dist/cli.js changed --json --fail-on-zero-files fixtures/test.ts 2>&1); then
  CHANGED_RC=0
else
  CHANGED_RC=$?
fi
if [ "$CHANGED_RC" -eq 0 ]; then
  pass "code-audit changed runs end-to-end"
elif echo "$CHANGED_OUT" | grep -qi "better-sqlite3 could not load its native SQLite binding"; then
  # npm 12 blocked better-sqlite3's install script: a non-zero exit carrying the
  # clear cause+fix is the expected, correct behavior (asserted in Guard 9).
  pass "code-audit changed surfaced the clear better-sqlite3 error (blocked install)"
else
  fail "code-audit changed exited $CHANGED_RC without the clear better-sqlite3 error — bootstrap or napi load failed at runtime"
fi

# --- Guard 6: web-tree-sitter WASM loadable -----------------------------------
echo ""
echo "Checking web-tree-sitter WASM..."
if node -e "
  try {
    const Parser = require('web-tree-sitter');
    if (typeof Parser === 'object' && Parser.default) {
      // ES module interop
      const p = Parser.default;
      console.log('web-tree-sitter available');
    } else {
      console.log('web-tree-sitter available');
    }
  } catch(e) {
    console.error('LOAD ERROR:', e.message);
    process.exit(1);
  }
" 2>&1; then
  pass "web-tree-sitter loads"
else
  fail "web-tree-sitter did not load"
fi

# --- Guard 7: WASM grammar files present in package ---------------------------
echo ""
echo "Checking WASM grammars shipped..."
MISSING=0
for grammar in tree-sitter-typescript.wasm tree-sitter-tsx.wasm tree-sitter-go.wasm tree-sitter-css.wasm tree-sitter-scss.wasm; do
  if [ -f "node_modules/code-auditor-mcp/dist/grammars/$grammar" ]; then
    echo "  OK: $grammar"
  else
    echo "  MISSING: $grammar"
    MISSING=1
  fi
done
if [ "$MISSING" -eq 0 ]; then
  pass "All WASM grammars present in dist/grammars/"
else
  fail "Some WASM grammars are missing from the distributed package"
fi

# --- Guard 9: npm-12 blocked install scripts → node:sqlite carries the load --
# npm 11.2+ and 12 block dependency install scripts by default (allowScripts), so
# a stranger on npm 12 installs the tarball and better-sqlite3's prebuild is
# skipped. Spec 51 makes that harmless on Node 23.4+: the builtin node:sqlite
# needs no install script, so the audit must now *succeed*. On older Node without
# node:sqlite, the audit must still fail naming the cause AND the fix — never the
# cryptic "Database not initialized" or the generic "corrupted/locked" hint.
# `--ignore-scripts` reproduces that blocked path deterministically regardless of
# the local npm version, so this guard runs on every release commit.
echo ""
echo "Simulating npm-12 blocked install (--ignore-scripts)..."
BLOCKED_DIR="$SCRATCH/blocked"
mkdir -p "$BLOCKED_DIR"
cd "$BLOCKED_DIR"
npm init -y --silent 2>/dev/null
npm install "$TARBALL_PATH" --no-save --ignore-scripts >/dev/null 2>&1
mkdir -p fixtures
echo 'function add(a: number, b: number): number { return a + b; }' > fixtures/test.ts
BLOCKED_RC=0
if BLOCKED_OUT=$(XDG_CACHE_HOME="$SCRATCH/cache" node node_modules/code-auditor-mcp/dist/cli.js changed --json --fail-on-zero-files fixtures/test.ts 2>&1); then
  BLOCKED_RC=0
else
  BLOCKED_RC=$?
fi
# Does the Node running this guard ship node:sqlite? If so, a blocked
# better-sqlite3 build is irrelevant and the audit must succeed end-to-end.
if node -e "const { DatabaseSync } = require('node:sqlite'); if (typeof DatabaseSync !== 'function') process.exit(1);" 2>/dev/null; then
  if [ "$BLOCKED_RC" -eq 0 ]; then
    pass "blocked install still succeeds on node:sqlite-capable Node (builtin backend, no native install)"
  elif echo "$BLOCKED_OUT" | grep -qi "Database not initialized" \
    || echo "$BLOCKED_OUT" | grep -qi "could not load its native SQLite binding"; then
    fail "blocked install failed even though node:sqlite is available — the builtin backend did not take over"
  else
    fail "blocked install failed on node:sqlite-capable Node (exit $BLOCKED_RC): $BLOCKED_OUT"
  fi
else
  if echo "$BLOCKED_OUT" | grep -qi "Database not initialized"; then
    fail "blocked install surfaced the cryptic 'Database not initialized' — cause and fix are missing"
  elif echo "$BLOCKED_OUT" | grep -qi "corrupted, locked, or on a read-only"; then
    fail "blocked install surfaced the generic storage hint instead of naming the missing better-sqlite3 binding"
  elif echo "$BLOCKED_OUT" | grep -qi "better-sqlite3 could not load its native SQLite binding" \
    && echo "$BLOCKED_OUT" | grep -qi "npm install-scripts approve better-sqlite3"; then
    pass "blocked install yields the clear better-sqlite3 cause + fix"
  else
    fail "blocked install did not produce the clear better-sqlite3 error (unexpected output)"
  fi
fi
cd "$SCRATCH"

# --- Guard 10: pinned-install fallback resolves to a running CLI ---------------
# The hook's last-resort path installs `code-auditor-mcp@<version>` to a
# deterministic cache dir and invokes `node_modules/.bin/code-audit` by absolute
# path — NOT `npx -p <pkg> <bin>`, which a same-named binary earlier in PATH (a
# global shim, or a volta shim) shadows, routing the "fallback" back to the stale
# binary it was meant to replace. A marketplace install copies only `plugin/` (no
# sibling `../dist/`), so on a machine with no project-local or global code-audit
# this is the ONLY path to a CLI. Prove two things: (a) resolve_code_audit — in the
# environment the hook actually reaches it in, i.e. no other code-audit on PATH —
# emits the pinned install's absolute bin path at the exact version (never a `^`
# range), and (b) that path is a running CLI reporting that exact version.
echo ""
echo "Checking pinned-install fallback..."

# The static check (a) below must reach the install rung, which only happens when
# no compatible `code-audit` is on PATH (resolution is version-aware: bundled
# sibling, then a version-matched project-local or global, then the pinned
# install). Build a PATH that drops only the directories that provide `code-audit`
# so `command -v code-audit` fails, leaving node/npm at their real locations
# (e.g. `.nvm/.../bin`, `/usr/local/bin`). Symlinking is NOT safe here: npm's bin
# wrappers resolve `npm-cli.js` relative to `dirname "$0"`, so a symlinked copy
# looks for the script next to itself and dies with "Cannot find module …".
CLEAN_PATH=""
OLDIFS="$IFS"; IFS=:
for _d in $PATH; do
  _d="${_d:-.}"
  [ -x "$_d/code-audit" ] && continue
  if [ -n "$CLEAN_PATH" ]; then CLEAN_PATH="${CLEAN_PATH}:$_d"; else CLEAN_PATH="$_d"; fi
done
IFS="$OLDIFS"

PLUGIN_SRC="node_modules/code-auditor-mcp/plugin"
FAKE_PLUGIN="$SCRATCH/marketplace-plugin"
mkdir -p "$FAKE_PLUGIN/.claude-plugin" "$FAKE_PLUGIN/scripts"
cp "$PLUGIN_SRC/scripts/hook-common.sh" "$FAKE_PLUGIN/scripts/hook-common.sh"

# Pin to the latest PUBLISHED version (the to-be-released manifest version is not
# on the registry yet at verify time); the mechanism is identical, only the
# version string differs. Write it into the fake manifest so plugin_version feeds
# resolve_pinned_bin the exact spec.
PUBLISHED_VERSION="$(npm view code-auditor-mcp version 2>/dev/null || true)"
if [ -z "$PUBLISHED_VERSION" ]; then
  warn "npm registry unreachable — skipping pinned-install fallback check"
else
  echo "{\"version\": \"$PUBLISHED_VERSION\"}" > "$FAKE_PLUGIN/.claude-plugin/plugin.json"

  # A controlled cache root so the install is assertable and does not pollute the
  # user's real ~/.cache/code-auditor.
  PIN_CACHE="$SCRATCH/pin-cache"

  # (a) Static — resolve_code_audit installs the exact version and emits the
  # absolute bin path. Run from a neutral dir (the hook runs from the user's
  # project, not the packed tarball whose package.json is named code-auditor-mcp).
  PIN_CHECK_DIR="$(mktemp -d -t ca-pin-check-XXXXX)"
  RESOLVED="$(cd "$PIN_CHECK_DIR" && CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN" XDG_CACHE_HOME="$PIN_CACHE" PATH="$CLEAN_PATH" bash -c '
    unset CLAUDE_PROJECT_DIR
    . "$CLAUDE_PLUGIN_ROOT/scripts/hook-common.sh"
    resolve_code_audit
  ' 2>/dev/null || true)"
  cd "$SCRATCH"
  rm -rf "$PIN_CHECK_DIR"

  EXPECTED_BIN="$PIN_CACHE/code-auditor/cli/$PUBLISHED_VERSION/node_modules/.bin/code-audit"
  if [ "$RESOLVED" = "$EXPECTED_BIN" ]; then
    pass "resolve_code_audit emits the pinned install's absolute bin path at $PUBLISHED_VERSION"
  else
    fail "resolve_code_audit emitted '$RESOLVED' — expected absolute bin '$EXPECTED_BIN' (an npx or ^range form resolves against a PATH the hook does not control)"
  fi

  # (b) Runtime — the emitted path is a running CLI at the exact version.
  RUNTIME_OUT="$("$EXPECTED_BIN" --version 2>&1 || true)"
  RUNTIME_SEM="$(printf '%s' "$RUNTIME_OUT" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' | head -n 1 || true)"
  if [ "$RUNTIME_SEM" = "$PUBLISHED_VERSION" ]; then
    pass "pinned install $EXPECTED_BIN --version → $RUNTIME_SEM (matches)"
  else
    fail "pinned install reported '$RUNTIME_OUT' (semver ${RUNTIME_SEM:-none}) — expected $PUBLISHED_VERSION"
  fi
fi

# --- Done ---------------------------------------------------------------------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  All distribution checks PASSED${NC}"
echo -e "${GREEN}========================================${NC}"
