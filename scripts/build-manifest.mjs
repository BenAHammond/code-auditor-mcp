#!/usr/bin/env node
/**
 * Generate the shipped-plugin manifest: a mapping of plugin-relative path →
 * sha256 for every file the plugin ships, so a SessionStart drift-check can
 * detect an installed plugin that has diverged from what was published.
 *
 * The version lives in exactly one place — package.json. The manifest carries it
 * too, so a drift warning can name the version the install *should* be.
 *
 * The manifest is generated from the source tree at build time and committed
 * (like `build:version`'s `src/version.generated.ts` and `build:skills`'s
 * stamped SKILL.md), so the npm `files` glob `plugin/...` ships a manifest that
 * records the source-tree checksums. At SessionStart, `hook-drift-check.sh`
 * re-hashes the *installed* files and compares them against this manifest — the
 * check that would have caught the two-way silent drift in board row 7 (the
 * installed hook-audit.sh gaining a scoping block the source lacked, while the
 * installed plugin.json/SKILL.md sat a version behind).
 *
 * The manifest must hash the files as they will be shipped, so it runs *after*
 * `build:skills` (which stamps the version banner into SKILL.md) in the build
 * chain. It lists every plugin file except itself — a manifest cannot checksum
 * itself — and skips `.DS_Store` and the version-banner stamp's own outputs are
 * just the files as they now are.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// package.json is the single source of truth for the version.
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const version = String(pkg.version || '0.0.0');

const pluginRoot = path.join(__dirname, '..', 'plugin');
const manifestPath = path.join(pluginRoot, '.claude-plugin', 'manifest.json');

/**
 * Assert the layout the hooks depend on. Every hook self-locates the plugin root
 * as the grand-parent of its own directory: `plugin_root()` in hook-common.sh
 * resolves `<root>` from `<root>/scripts/hook-common.sh`, and hooks.json launches
 * the sibling scripts in that same `scripts/` dir. That derivation is only correct
 * while `scripts/hook-common.sh` sits exactly one level below the plugin root, so a
 * reorganization that moves, renames, or nests `scripts/` — or that relocates the
 * hook scripts out of it — must fail the build here rather than silently ship a
 * hook that can no longer find itself.
 */
function assertLayout(root) {
  const required = [
    'scripts/hook-common.sh',
    'scripts/hook-audit.sh',
    'scripts/hook-self-audit.sh',
    'scripts/hook-warm.sh',
    'scripts/hook-drift-check.sh',
    'hooks/hooks.json',
  ];
  for (const rel of required) {
    const full = path.join(root, rel);
    if (!existsSync(full) || !statSync(full).isFile()) {
      process.stderr.write(
        `build:manifest FAILED: plugin layout invariant broken — expected "${rel}" at ` +
        `"<plugin-root>/${rel}", but it is not a regular file there. The hooks self-locate ` +
        `the plugin root from <plugin-root>/scripts/hook-common.sh; move or rename scripts/ ` +
        `and the derivation breaks.\n`
      );
      process.exit(1);
    }
  }
}

assertLayout(pluginRoot);

/** Recursively hash every file under `dir`, keyed by its `base`-relative path. */
function walk(dir, base, files = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, files);
    } else if (entry.isFile()) {
      if (full === manifestPath) continue; // a manifest cannot checksum itself
      const rel = path.relative(base, full).split(path.sep).join('/');
      files[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }
  return files;
}

const files = walk(pluginRoot, pluginRoot);
// Sort keys so the committed manifest is a stable diff across regenerations
// (readdirSync order is not guaranteed), not a churn of reordered keys.
const sorted = {};
for (const rel of Object.keys(files).sort()) sorted[rel] = files[rel];
const manifest = { version, files: sorted };

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`build:manifest → ${Object.keys(files).length} files, version ${version}\n`);
