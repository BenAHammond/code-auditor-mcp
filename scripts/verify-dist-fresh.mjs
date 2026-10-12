#!/usr/bin/env node
/**
 * verify-dist-fresh — assert the compiled CLI reflects the current source, by
 * content not mtime.
 *
 * The CLI integration tests (`src/cli-integration.spec.ts`, `src/__tests__/baseline.test.ts`,
 * `verify:gate-budget`, `verify:dist`) execute `dist/cli.js`, not `src/`. If that
 * compiled artifact does not correspond to the TypeScript it was built from, the
 * tests validate a stale CLI — a "green because nothing checked" result that can
 * ship regressions exactly like the Spec 45 warning-blocking change that a stale
 * dist masked.
 *
 * The previous shape of this gate compared `dist/cli.js`'s *mtime* against the
 * mtimes of its `tsc` inputs. An mtime is not a property of the artifact — it is
 * a property of how the filesystem happened to be touched, so a checkout, a
 * `cp -p`, or a `touch` could present a stale dist as fresh (or a fresh dist as
 * stale). This gate now compares *content*: it rebuilds into a temp dir and
 * byte-hashes `dist/cli.js` against the fresh `cli.js`. A real content difference
 * fails; a matching build passes regardless of how old the files are.
 *
 * It does not rebuild in place (rebuilding in place can mask a build failure);
 * it forces a loud `npm run build` first. The temp rebuild is a scratch copy, so
 * it never rewrites the committed `dist/`.
 *
 * Usage (from app/):
 *   node scripts/verify-dist-fresh.mjs
 *
 * Exit code: 0 iff `dist/cli.js` exists and byte-matches a fresh compile of the
 * current source; 1 otherwise (stale content or a failed rebuild).
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const TSC = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

function fail(msg) {
  console.error(`verify:dist-fresh: ${msg}`);
  process.exit(1);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

if (!existsSync(DIST_CLI)) {
  fail('dist/cli.js not found — run `npm run build` first.');
}

const committed = readFileSync(DIST_CLI);

const tmp = mkdtempSync(join(tmpdir(), 'ca-dist-fresh-'));
try {
  // Compile the current source into a scratch dir. Only `cli.js` is compared, so
  // the declaration/sourcemap artifacts land in the scratch dir and are discarded.
  // The flags MUST mirror `npm run build`'s plain `tsc` (which reads the project
  // tsconfig: sourceMap/declaration/declarationMap are all on) — overriding them
  // off here would strip the `//# sourceMappingURL=cli.js.map` trailer the real
  // build emits, so a *matching* build would still hash differently. The only
  // override is `--outDir`, which relocates output without changing any bytes.
  const build = spawnSync(
    TSC,
    ['--outDir', tmp],
    { encoding: 'utf-8', cwd: ROOT },
  );
  if (build.status !== 0) {
    fail(
      `the current source does not compile (tsc exited ${build.status}) — ` +
        `the committed dist cannot be trusted. Run \`npm run build\` and re-run verify:close.\n` +
        `${(build.stderr || build.stdout || '').trim()}`,
    );
  }

  const freshPath = join(tmp, 'cli.js');
  if (!existsSync(freshPath)) {
    fail('the scratch compile produced no cli.js — the build layout changed unexpectedly.');
  }
  const fresh = readFileSync(freshPath);

  const committedHash = sha256(committed);
  const freshHash = sha256(fresh);
  if (committedHash !== freshHash) {
    fail(
      `dist/cli.js does not match a fresh compile of the current source ` +
        `(dist ${committedHash.slice(0, 12)}… vs fresh ${freshHash.slice(0, 12)}…). ` +
        `The compiled CLI is stale and would validate code that is not what shipped. ` +
        `Run \`npm run build\` and re-run verify:close.`,
    );
  }

  console.log(`verify:dist-fresh: dist/cli.js matches a fresh compile (sha256 ${freshHash.slice(0, 12)}…).`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
