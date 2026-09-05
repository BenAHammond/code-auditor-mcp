#!/usr/bin/env bash
# build-go.sh — copy the Go analyzer subprocess into dist/languages/go/.
#
# `tsc` emits dist/languages/go/GoAdapter.js (the tree-sitter adapter) but does
# not copy the subprocess it replaced: the prebuilt `analyzer` binary, `main.go`,
# `go.mod`, or the `analyzer-src/` Go module that `ensureGoAnalyzerBuilt` falls
# back to compiling with `go build`. Without this step the Go analysis subprocess
# is absent from every build, and the runtime degrades the way it silently
# degraded for months: no binary, and nothing to build one from.
#
# This is the same file-accounting as build:grammars and download:natives — a
# file silently dropped from dist is a hard error, not a "not supported".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SRC_GO="$APP_DIR/src/languages/go"
DIST_GO="$APP_DIR/dist/languages/go"

mkdir -p "$DIST_GO"

# JSON-RPC entry point and its module definition.
cp "$SRC_GO/main.go" "$DIST_GO/main.go"
cp "$SRC_GO/go.mod" "$DIST_GO/go.mod"

# The analyzer Go module — source only. `go build` compiles from these; the
# checked-in analyzer-binary/main blobs inside analyzer-src/ are stale dev
# artifacts and are deliberately not shipped.
mkdir -p "$DIST_GO/analyzer-src"
for f in analyzer.go indexer.go parser.go solid.go types.go testconventions.go go.mod; do
  cp "$SRC_GO/analyzer-src/$f" "$DIST_GO/analyzer-src/$f"
done

# Prebuilt binary: fast path for the platform it targets (currently darwin/amd64).
# Other platforms fall back to `go build` via ensureGoAnalyzerBuilt.
if [ -f "$SRC_GO/analyzer" ]; then
  cp "$SRC_GO/analyzer" "$DIST_GO/analyzer"
  chmod +x "$DIST_GO/analyzer"
fi

echo "Go analyzer subprocess copied to dist/languages/go/"
