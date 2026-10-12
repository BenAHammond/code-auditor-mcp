#!/usr/bin/env node
/**
 * verify-hook-log-path — assert the committed hook-log path files still match
 * their single source.
 *
 * The hook-log channel spans two languages: `src/hookLog.ts` reads the log that
 * `plugin/scripts/hook-common.sh` (via `plugin/scripts/hook-log-path.sh`) writes.
 * The directory tail and file name are single-sourced in
 * `scripts/write-hook-log-path.mjs`, which stamps them into both
 * `src/hookLogPath.generated.ts` and `plugin/scripts/hook-log-path.sh`. A
 * generated artifact with no freshness check is the stale-`dist` failure in a new
 * costume: a hand-edited `hook-log-path.sh` (or a stale `.generated.ts`) silently
 * re-introduces the two-language drift this generator exists to kill, and the
 * fail-open reader turns that drift into "no notice" rather than an error, so the
 * suite stays green while the channel is dead.
 *
 * This gate regenerates both files into a temp tree and fails when either
 * committed file differs from the regenerated output — the same shape as
 * `verify-dist-fresh.mjs`: it never rewrites the committed files (that would mask
 * a bad edit), it fails with exit 1 and names the stale file, and the fix is a
 * loud `npm run build:hooklog`.
 *
 * Usage (from app/):
 *   node scripts/verify-hook-log-path.mjs
 *
 * Exit code: 0 iff both committed files byte-match the generator's current
 * output; 1 otherwise (stale file named).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const GENERATOR = join(ROOT, 'scripts', 'write-hook-log-path.mjs');
const COMMITTED = [
  { rel: 'src/hookLogPath.generated.ts' },
  { rel: 'plugin/scripts/hook-log-path.sh' },
];

function fail(msg) {
  console.error(`verify:hook-log-path: ${msg}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'ca-hook-log-path-'));
try {
  const regen = spawnSync(process.execPath, [GENERATOR, '--out-dir', tmp], {
    encoding: 'utf-8',
  });
  if (regen.status !== 0) {
    fail(`generator exited ${regen.status}: ${(regen.stderr || regen.stdout).trim()}`);
  }

  const stale = [];
  for (const { rel } of COMMITTED) {
    const committed = readFileSync(join(ROOT, rel), 'utf8');
    const regenerated = readFileSync(join(tmp, rel), 'utf8');
    if (committed !== regenerated) stale.push(rel);
  }

  if (stale.length > 0) {
    fail(
      `stale generated file(s) — ${stale.join(', ')} differ(s) from the ` +
        `single source (scripts/write-hook-log-path.mjs). Run \`npm run build:hooklog\` ` +
        `and re-run verify:close.`,
    );
  }

  console.log(
    `verify:hook-log-path: ${COMMITTED.length} generated file(s) match the single source.`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
