#!/usr/bin/env node
/**
 * Stamp the package version into the compiled build before `tsc` runs.
 *
 * The version lives in exactly one place — package.json. This writes it to
 * `src/version.generated.ts`, which `tsc` then compiles into `dist/` as a
 * literal. The CLI (`--version`) and the MCP server both read that literal, so
 * a stale binary reports the version it was *built as* — not whatever
 * package.json happens to be on disk at runtime.
 *
 * This is the fix for "a stale build announced itself as the source tree's
 * version and produced findings that looked like eight rules reverting at once."
 *
 * Runs at the START of the build chain (`build:version && tsc && …`) because
 * the file must exist before `tsc` compiles it. The generated file is committed
 * so `tsx src/cli.ts` (dev, no build) still works; it is regenerated on every
 * build, and `src/version.spec.ts` fails if it ever drifts from package.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// package.json is the single source of truth for the version.
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const version = String(pkg.version || '0.0.0');

// A bare semver literal is what we want — reject anything surprising so a bad
// package.json can't silently ship a garbage version string.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`write-version: refusing to stamp invalid version "${version}"`);
  process.exit(1);
}

const out = path.join(__dirname, '..', 'src', 'version.generated.ts');
const body =
  '// @generated — do not edit. Written by `scripts/write-version.mjs`.\n' +
  '//\n' +
  '// The build stamps the package.json version here so a compiled binary reports\n' +
  '// the version it was built as, not whatever package.json is on disk at runtime.\n' +
  '// Regenerate with `npm run build:version` (or any full build).\n' +
  `export const VERSION = '${version}';\n`;

writeFileSync(out, body);
process.stdout.write(`build:version → stamped VERSION=${version}\n`);
