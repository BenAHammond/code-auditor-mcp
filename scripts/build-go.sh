#!/usr/bin/env bash
# build-go.sh — copy the Go analyzer subprocess into dist/languages/go/.
#
# `tsc` emits dist/languages/go/GoAdapter.js (the tree-sitter adapter) but does
# not copy the subprocess it replaced: the prebuilt per-platform binaries,
# `main.go`, `go.mod`, or the `analyzer-src/` Go module that `ensureGoAnalyzerBuilt`
# falls back to compiling with `go build`. Without this step the Go analysis
# subprocess is absent from every build, and the runtime degrades the way it
# silently degraded for months: no binary, and nothing to build one from.
#
# This is the same file-accounting as build:grammars and download:natives — a
# file silently dropped from dist is a hard error, not a "not supported".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SRC_GO="$APP_DIR/src/languages/go"
DIST_GO="$APP_DIR/dist/languages/go"

mkdir -p "$DIST_GO"

# The single `analyzer` binary (darwin/amd64) is superseded by the per-platform
# binaries below. Remove any stale copy a prior build left in dist so it is not
# shipped as dead weight; the runtime resolves `analyzer-<goos>-<goarch>` only.
rm -f "$DIST_GO/analyzer" "$DIST_GO/analyzer.exe"

# JSON-RPC entry point and its module definition.
cp "$SRC_GO/main.go" "$DIST_GO/main.go"
cp "$SRC_GO/go.mod" "$DIST_GO/go.mod"

# The analyzer Go module — source only. `go build` compiles from these.
mkdir -p "$DIST_GO/analyzer-src"
for f in analyzer.go indexer.go parser.go solid.go types.go testconventions.go go.mod; do
  cp "$SRC_GO/analyzer-src/$f" "$DIST_GO/analyzer-src/$f"
done

# Prebuilt binaries: one per target platform, cross-compiled at CGO_ENABLED=0 so
# they are static and run with no Go toolchain on the host. The runtime resolves
# `analyzer-<goos>-<goarch>` for the platform Node is running on; a platform
# without a shipped binary falls back to a cache-dir `go build` (see
# ensureGoAnalyzerBuilt), which this script does not need to cover.
GO_BINARIES=(
  "analyzer-darwin-arm64"
  "analyzer-darwin-amd64"
  "analyzer-linux-amd64"
  "analyzer-linux-arm64"
  "analyzer-windows-amd64.exe"
)
for bin in "${GO_BINARIES[@]}"; do
  if [ -f "$SRC_GO/$bin" ]; then
    cp "$SRC_GO/$bin" "$DIST_GO/$bin"
    chmod +x "$DIST_GO/$bin"
  else
    echo "MISSING: $SRC_GO/$bin — run a cross-compile to produce it" >&2
    exit 1
  fi
done

echo "Go analyzer subprocess + ${#GO_BINARIES[@]} platform binaries copied to dist/languages/go/"
