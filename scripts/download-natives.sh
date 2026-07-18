#!/usr/bin/env bash
# download-natives.sh — collect @ast-grep/napi .node files for all platforms
#
# npm cli#4828 prevents platform-specific optionalDependencies from installing
# on stock npm. Our mitigation: bundle the .node files directly in the published
# package and use NAPI_RS_NATIVE_LIBRARY_PATH at runtime.
#
# Runs at build time (after tsc). Uses `npm pack` to download platform packages
# without platform checks, then extracts just the .node files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
NATIVE_DIR="$APP_DIR/dist/native"
TMP_DIR=$(mktemp -d -t ca-natives-XXXXX)

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# Extract version from package.json dependencies
VERSION=$(node -e "console.log(require('$APP_DIR/package.json').dependencies['@ast-grep/napi'].replace('^','').replace('~',''))")
echo "Downloading @ast-grep/napi platform binaries v$VERSION"

PLATFORMS=(
  "darwin-arm64"
  "darwin-x64"
  "linux-x64-gnu"
  "linux-arm64-gnu"
  "linux-x64-musl"
  "linux-arm64-musl"
  "win32-x64-msvc"
)

mkdir -p "$NATIVE_DIR"

for plat in "${PLATFORMS[@]}"; do
  pkg="@ast-grep/napi-$plat"
  node_name="ast-grep-napi.$plat.node"

  # Idempotency: skip if already downloaded (correct size, non-empty)
  dest="$NATIVE_DIR/$node_name"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "  $pkg@$VERSION -> $node_name ($(du -h "$dest" | cut -f1)) [cached]"
    continue
  fi

  echo "  $pkg@$VERSION"

  # npm pack downloads without platform checks
  tarball=$(cd "$TMP_DIR" && npm pack "$pkg@$VERSION" --pack-destination . 2>&1 | tail -1)
  if [ ! -f "$TMP_DIR/$tarball" ]; then
    echo "    ERROR: npm pack failed for $pkg" >&2
    continue
  fi

  # Extract just the .node file
  node_file=$(tar -tzf "$TMP_DIR/$tarball" | grep '\.node$' | head -1)
  if [ -z "$node_file" ]; then
    echo "    ERROR: no .node file found in $tarball" >&2
    continue
  fi

  # Structure is package/<name>.node — strip the package/ dir
  tar -xzf "$TMP_DIR/$tarball" -C "$NATIVE_DIR" --strip-components=1 "$node_file"

  dest="$NATIVE_DIR/$(basename "$node_file")"
  if [ -f "$dest" ]; then
    echo "    -> $(basename "$dest") ($(du -h "$dest" | cut -f1))"
  else
    echo "    ERROR: could not extract .node file" >&2
  fi

  # Clean up extracted package directory
  rm -f "$TMP_DIR/$tarball"
done

echo ""
echo "Native binaries:"
ls -lh "$NATIVE_DIR/"
echo ""
echo "Done. $(ls "$NATIVE_DIR" | wc -l) platform binaries in $NATIVE_DIR"
