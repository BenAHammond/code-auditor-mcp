#!/usr/bin/env bash
# download-natives.sh — collect @ast-grep/napi .node files for all platforms
#
# npm cli#4828 prevents platform-specific optionalDependencies from installing
# on stock npm. Our mitigation: bundle the .node files directly in the published
# package and use NAPI_RS_NATIVE_LIBRARY_PATH at runtime.
#
# Runs at build time (after tsc). Uses `npm pack` to download platform packages
# without platform checks, then extracts just the .node files. Every extracted or
# cached binary is verified against the pinned SHA512 digests in
# scripts/SHA512SUMS before it is written or reused — a mismatch fails the script
# non-zero so a tampered or silently-updated binary can never be bundled.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
NATIVE_DIR="$APP_DIR/dist/native"
SUMS_FILE="$SCRIPT_DIR/SHA512SUMS"
TMP_DIR=$(mktemp -d -t ca-natives-XXXXX)

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# Extract version from package.json dependencies
VERSION=$(node -e "console.log(require('$APP_DIR/package.json').dependencies['@ast-grep/napi'].replace('^','').replace('~',''))")
echo "Downloading @ast-grep/napi platform binaries v$VERSION"

if [ ! -f "$SUMS_FILE" ]; then
  echo "ERROR: $SUMS_FILE missing — cannot verify binaries" >&2
  exit 1
fi
PINNED_VERSION="$(grep '^# version:' "$SUMS_FILE" | head -1 | awk '{print $3}')"
if [ -n "$PINNED_VERSION" ] && [ "$PINNED_VERSION" != "$VERSION" ]; then
  echo "WARNING: SHA512SUMS pinned to v$PINNED_VERSION but package.json wants v$VERSION — digests are stale; update scripts/SHA512SUMS" >&2
fi

# verify_digest <node_name> <file> — 0 when <file>'s SHA512 matches the pinned
# digest for <node_name> in SHA512SUMS, non-zero otherwise (with a stderr message).
verify_digest() {
  local name="$1" file="$2" expected actual
  expected="$(awk -v n="$name" '$2 == n { print $1 }' "$SUMS_FILE")"
  if [ -z "$expected" ]; then
    echo "      ERROR: no pinned SHA512 for $name in $SUMS_FILE" >&2
    return 1
  fi
  actual="$(shasum -a 512 "$file" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    echo "      ERROR: SHA512 mismatch for $name" >&2
    echo "        expected $expected" >&2
    echo "        actual   $actual" >&2
    return 1
  fi
}

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

  # Idempotency: skip if already downloaded (correct size, non-empty) — but verify
  # the cached binary against the pinned digest before reusing it.
  dest="$NATIVE_DIR/$node_name"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    if ! verify_digest "$node_name" "$dest"; then
      echo "    ERROR: cached $node_name failed SHA512 verification — refusing to reuse" >&2
      exit 1
    fi
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
    rm -f "$TMP_DIR/$tarball"
    continue
  fi

  # Extract to a staging dir, verify the digest, then move into place. Verifying
  # *before* writing to $dest means a bad binary is never left in dist/native.
  staging="$TMP_DIR/$plat"
  mkdir -p "$staging"
  tar -xzf "$TMP_DIR/$tarball" -C "$staging" --strip-components=1 "$node_file"
  extracted="$staging/$(basename "$node_file")"
  if [ ! -f "$extracted" ]; then
    echo "    ERROR: could not extract .node file" >&2
    rm -f "$TMP_DIR/$tarball"
    continue
  fi
  if ! verify_digest "$node_name" "$extracted"; then
    echo "    ERROR: extracted $node_name failed SHA512 verification — refusing to ship" >&2
    rm -f "$TMP_DIR/$tarball"
    exit 1
  fi
  mv "$extracted" "$dest"
  echo "    -> $(basename "$dest") ($(du -h "$dest" | cut -f1))"

  # Clean up extracted package directory
  rm -f "$TMP_DIR/$tarball"
done

echo ""
echo "Native binaries:"
ls -lh "$NATIVE_DIR/"
echo ""
echo "Done. $(ls "$NATIVE_DIR" | wc -l) platform binaries in $NATIVE_DIR"
