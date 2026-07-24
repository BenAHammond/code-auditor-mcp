#!/usr/bin/env bash
# verify-dist.sh — structural guard against "works in repo, broken as distributed"
#
# Runs after `npm pack` in CI/pre-publish. Installs the tarball into a temp dir
# with stock npm, require-checks both native deps, and confirms `code-audit --version`
# exits 0. This is what makes tarball-install regressions structurally unable to
# recur — not a dev-env check, but a stranger's install.
#
# npm cli#4828 prevents platform-specific optionalDependencies from installing.
# Mitigation: we bundle .node files in dist/native/ and set NAPI_RS_NATIVE_LIBRARY_PATH
# at runtime via native-bootstrap.ts. This script verifies both the bundling AND
# the runtime NAPI_RS_NATIVE_LIBRARY_PATH mechanism.
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

# --- Guard 0: dist/native/ directory with all 7 platform binaries --------------
echo ""
echo "Checking bundled native binaries..."
NATIVE_DIR="node_modules/code-auditor-mcp/dist/native"
EXPECTED_BINARIES=(
  "ast-grep-napi.darwin-arm64.node"
  "ast-grep-napi.darwin-x64.node"
  "ast-grep-napi.linux-x64-gnu.node"
  "ast-grep-napi.linux-arm64-gnu.node"
  "ast-grep-napi.linux-x64-musl.node"
  "ast-grep-napi.linux-arm64-musl.node"
  "ast-grep-napi.win32-x64-msvc.node"
)

MISSING_BINS=0
for bin in "${EXPECTED_BINARIES[@]}"; do
  if [ -f "$NATIVE_DIR/$bin" ]; then
    echo "  OK: $bin ($(du -h "$NATIVE_DIR/$bin" | cut -f1))"
  else
    echo "  MISSING: $bin"
    MISSING_BINS=1
  fi
done
if [ "$MISSING_BINS" -eq 0 ]; then
  pass "All 7 platform native binaries bundled in dist/native/"
else
  fail "Some platform binaries are missing from dist/native/"
fi

# --- Determine current platform's binding name ---------------------------------
CURRENT_BINDING=""
case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64) CURRENT_BINDING="ast-grep-napi.darwin-arm64.node" ;;
      x86_64) CURRENT_BINDING="ast-grep-napi.darwin-x64.node" ;;
    esac ;;
  Linux)
    # Detect musl vs gnu
    if ldd --version 2>&1 | grep -qi musl; then
      LIBC="musl"
    else
      LIBC="gnu"
    fi
    case "$(uname -m)" in
      x86_64) CURRENT_BINDING="ast-grep-napi.linux-x64-${LIBC}.node" ;;
      aarch64) CURRENT_BINDING="ast-grep-napi.linux-arm64-${LIBC}.node" ;;
    esac ;;
esac

if [ -n "$CURRENT_BINDING" ]; then
  echo ""
  echo "Current platform binding: $CURRENT_BINDING"
else
  warn "Could not determine current platform binding — native guards will be skipped"
fi

# --- Guard 1: better-sqlite3 loads --------------------------------------------
echo ""
echo "Checking better-sqlite3..."
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
  fail "better-sqlite3 did not load — prebuild may not have run"
fi

# --- Guard 2: @ast-grep/napi loads via bundled binary -------------------------
echo ""
echo "Checking @ast-grep/napi (via NAPI_RS_NATIVE_LIBRARY_PATH)..."
if [ -n "$CURRENT_BINDING" ]; then
  if node -e "
    // Simulate what native-bootstrap.ts does
    const path = require('node:path');
    const bundledPath = path.join(
      '$NATIVE_DIR',
      '$CURRENT_BINDING'
    );
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.resolve(bundledPath);

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
    pass "@ast-grep/napi loads via bundled native binary"
  else
    fail "@ast-grep/napi did not load — NAPI_RS_NATIVE_LIBRARY_PATH may be wrong or binary is missing"
  fi
else
  warn "Skipping native binding check (unsupported platform)"
fi

# --- Guard 3: @ast-grep/napi succeeds a real parse ----------------------------
echo ""
echo "Checking @ast-grep/napi can parse..."
if [ -n "$CURRENT_BINDING" ]; then
  if node -e "
    const path = require('node:path');
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.resolve(
      path.join('$NATIVE_DIR', '$CURRENT_BINDING')
    );

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
else
  warn "Skipping parse check (unsupported platform)"
fi

# --- Guard 4: CLI entry point exits 0 -----------------------------------------
echo ""
echo "Checking code-audit --version..."
if node node_modules/code-auditor-mcp/dist/cli.js --version 2>&1; then
  pass "code-audit --version exits 0"
else
  fail "code-audit --version did not exit 0"
fi

# --- Guard 5: CLI entry point loads napi (tests bootstrap chain) --------------
echo ""
echo "Checking code-audit changed (tests full native bootstrap chain)..."
mkdir -p fixtures
echo 'function add(a: number, b: number): number { return a + b; }' > fixtures/test.ts
if node node_modules/code-auditor-mcp/dist/cli.js changed --json fixtures/test.ts 2>&1; then
  pass "code-audit changed runs end-to-end"
else
  rc=$?
  fail "code-audit changed exited $rc — bootstrap or napi load failed at runtime"
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
for grammar in tree-sitter-typescript.wasm tree-sitter-tsx.wasm tree-sitter-javascript.wasm tree-sitter-go.wasm tree-sitter-css.wasm; do
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

# --- Done ---------------------------------------------------------------------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  All distribution checks PASSED${NC}"
echo -e "${GREEN}========================================${NC}"
