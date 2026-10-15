#!/usr/bin/env node
/**
 * verify-version-fresh — assert the committed version stamp still matches its
 * single source.
 *
 * The version lives in exactly one place — package.json. `scripts/write-version.mjs`
 * stamps it into `src/version.generated.ts`, which `tsc` then compiles into the
 * CLI's `--version` literal. `src/version.spec.ts` checks the *value* at test
 * time (a version bump without a rebuild), but nothing checks the generated
 * file's *freshness* against the generator — a hand-edited `version.generated.ts`
 * (or a stale one after a partial build) silently ships a version string that no
 * longer matches package.json, which is the stale-binary defect in a new costume.
 *
 * This gate regenerates `src/version.generated.ts` into a temp tree and fails
 * when the committed file differs from the regenerated output — the same shape
 * as `verify-hook-log-path.mjs`: it never rewrites the committed file (that would
 * mask a bad edit), it fails with exit 1 and names the stale file, and the fix
 * is a loud `npm run build:version`.
 *
 * Usage (from app/):
 *   node scripts/verify-version-fresh.mjs
 *
 * Exit code: 0 iff the committed `src/version.generated.ts` byte-matches the
 * generator's current output; 1 otherwise (stale file named).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const GENERATOR = join(ROOT, 'scripts', 'write-version.mjs');
const COMMITTED = 'src/version.generated.ts';

function fail(msg) {
  console.error(`verify:version-fresh: ${msg}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'ca-version-fresh-'));
try {
  const regen = spawnSync(process.execPath, [GENERATOR, '--out-dir', tmp], {
    encoding: 'utf-8',
  });
  if (regen.status !== 0) {
    fail(`generator exited ${regen.status}: ${(regen.stderr || regen.stdout).trim()}`);
  }

  const committed = readFileSync(join(ROOT, COMMITTED), 'utf8');
  const regenerated = readFileSync(join(tmp, COMMITTED), 'utf8');
  if (committed !== regenerated) {
    fail(
      `stale generated file — ${COMMITTED} differs from the single source ` +
        `(scripts/write-version.mjs). Run \`npm run build:version\` and re-run verify:close.`,
    );
  }

  console.log(`verify:version-fresh: ${COMMITTED} matches the single source.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// The shipped JSON manifests also carry the version (as published data the
// plugin's resolution path and the MCP install read). They are stamped by
// scripts/write-manifest-version.mjs at build time; a hand-bump of package.json
// without a rebuild leaves them stale — the exact Directive I defect. Assert
// each one still equals package.json, naming the file on mismatch.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const pkgVersion = String(pkg.version || '0.0.0');

const MANIFEST_CHECKS = [
  {
    file: 'plugin/.claude-plugin/plugin.json',
    label: 'plugin/.claude-plugin/plugin.json (plugin version)',
    get: (o) => o.version,
  },
  {
    file: 'server.json',
    label: 'server.json version',
    get: (o) => o.version,
  },
  {
    file: 'server.json',
    label: 'server.json packages[0].version',
    get: (o) => o.packages?.[0]?.version,
  },
  {
    file: '.claude-plugin/marketplace.json',
    label: '.claude-plugin/marketplace.json plugins[0].version',
    get: (o) => o.plugins?.[0]?.version,
  },
];

for (const check of MANIFEST_CHECKS) {
  let declared;
  try {
    declared = check.get(JSON.parse(readFileSync(join(ROOT, check.file), 'utf-8')));
  } catch (err) {
    fail(`cannot read ${check.file}: ${err.message}`);
  }
  if (declared !== pkgVersion) {
    fail(
      `version mismatch — ${check.label} declares ${declared ?? '(missing)'} but ` +
        `package.json declares ${pkgVersion}. Run \`npm run build\` to re-stamp the shipped manifests.`,
    );
  }
}

console.log(
  `verify:version-fresh: shipped manifests (plugin.json, server.json, marketplace.json) match package.json ${pkgVersion}.`,
);
