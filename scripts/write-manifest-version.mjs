#!/usr/bin/env node
/**
 * Stamp the package version into the shipped JSON manifests whose version
 * fields the plugin's resolution path and the MCP install read.
 *
 * The version lives in exactly one place — package.json. Three shipped JSON
 * files carry it as published data (an installer, or the hook's
 * `plugin_version()`, reads it at runtime, so it cannot be a runtime
 * `package.json` read):
 *
 *   1. plugin/.claude-plugin/plugin.json  — `version` (read by hook-common.sh
 *      `plugin_version()`, which `resolve_pinned_bin` installs against).
 *   2. server.json                         — `version` + `packages[0].version`
 *      (the MCP-server manifest; the package a clean install resolves).
 *   3. .claude-plugin/marketplace.json     — `plugins[0].version` (the
 *      marketplace listing; its top-level `version` is the marketplace *schema*
 *      version, not the CLI version, and is left alone).
 *
 * This is the fix for "a clean install of a published release installs a stale
 * CLI": server.json was hand-edited to 5.0.2 and never bumped while package.json
 * moved to 5.2.0. Generated at build time so a release bump can never be
 * hand-copied (or forgotten) into any of these — the same generated-file pattern
 * as `src/version.generated.ts` (write-version.mjs) and the SKILL.md banner
 * (build-skills.mjs). `verify:version-fresh` asserts the committed copies match.
 *
 * plugin.json is stamped with a targeted regex so its compact one-line `keywords`
 * array is preserved (a JSON round-trip would expand it and churn the published
 * file). server.json and marketplace.json are already fully multi-line, so a
 * `JSON.stringify(obj, null, 2)` round-trip reproduces them byte-for-byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// package.json is the single source of truth for the version.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = String(pkg.version || '0.0.0');

// A bare semver literal is what we want — reject anything surprising so a bad
// package.json can't silently ship a garbage version string (same guard as
// write-version.mjs).
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`write-manifest-version: refusing to stamp invalid version "${version}"`);
  process.exit(1);
}

// 1. plugin.json — exactly one top-level `version` key. Fail loudly if the shape
//    ever changes (a second version key would otherwise be silently missed).
{
  const file = path.join(root, 'plugin', '.claude-plugin', 'plugin.json');
  const text = readFileSync(file, 'utf-8');
  const re = /"version"\s*:\s*"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"/g;
  const matches = text.match(re);
  if (!matches || matches.length !== 1) {
    console.error(
      `write-manifest-version: plugin.json must have exactly one "version" key, found ${matches ? matches.length : 0}`,
    );
    process.exit(1);
  }
  const stamped = text.replace(re, `"version": "${version}"`);
  if (JSON.parse(stamped).version !== version) {
    console.error('write-manifest-version: plugin.json stamp did not take');
    process.exit(1);
  }
  writeFileSync(file, stamped);
}

// 2. server.json — two version fields, both the CLI version.
{
  const file = path.join(root, 'server.json');
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  if (!Array.isArray(data.packages) || !data.packages[0]) {
    console.error('write-manifest-version: server.json has no packages[0]');
    process.exit(1);
  }
  data.version = version;
  data.packages[0].version = version;
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// 3. marketplace.json — plugins[0].version only; the top-level `version` is the
//    marketplace schema version and is deliberately left untouched.
{
  const file = path.join(root, '.claude-plugin', 'marketplace.json');
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  if (!Array.isArray(data.plugins) || !data.plugins[0]) {
    console.error('write-manifest-version: marketplace.json has no plugins[0]');
    process.exit(1);
  }
  data.plugins[0].version = version;
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

process.stdout.write(
  `write-manifest-version → stamped version ${version} into plugin.json, server.json, marketplace.json\n`,
);
