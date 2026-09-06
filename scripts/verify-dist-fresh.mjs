#!/usr/bin/env node
/**
 * verify-dist-fresh — assert the compiled CLI reflects the current source.
 *
 * The CLI integration tests (`src/cli-integration.spec.ts`, `src/__tests__/baseline.test.ts`,
 * `verify:gate-budget`, `verify:dist`) execute `dist/cli.js`, not `src/`. If that
 * compiled artifact is older than the TypeScript it was built from, the tests
 * validate a stale CLI — a "green because nothing checked" result that can ship
 * regressions exactly like the Spec 45 warning-blocking change that a stale
 * dist masked.
 *
 * This gate fails when `dist/cli.js` is missing or older than any `tsc` input
 * (`src/**` *.ts/*.tsx and tsconfig files). It does not rebuild (rebuilding can
 * mask a build failure); it forces a loud `npm run build` first.
 *
 * Usage (from app/):
 *   node scripts/verify-dist-fresh.mjs
 *
 * Exit code: 0 iff dist/cli.js exists and is strictly newer than every source
 * input; 1 otherwise (stale files listed).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const SRC = join(ROOT, 'src');

function fail(msg) {
  console.error(`verify:dist-fresh: ${msg}`);
  process.exit(1);
}

if (!existsSync(DIST_CLI)) {
  fail('dist/cli.js not found — run `npm run build` first.');
}

const distMtime = statSync(DIST_CLI).mtimeMs;

/** Collect tsc inputs: *.ts / *.tsx under `dir`, and tsconfig files at ROOT. */
const inputs = [];
function collectTs(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTs(full);
    } else if (stat.isFile() && /\.(ts|tsx)$/.test(name)) {
      inputs.push(full);
    }
  }
}
if (existsSync(SRC)) collectTs(SRC);
for (const name of readdirSync(ROOT)) {
  if (name.startsWith('tsconfig') && name.endsWith('.json')) {
    inputs.push(join(ROOT, name));
  }
}

const stale = inputs.filter((f) => statSync(f).mtimeMs > distMtime);

if (stale.length > 0) {
  const shown = stale.slice(0, 10).map((f) => `  ${relative(ROOT, f)}`).join('\n');
  const extra = stale.length > 10 ? `\n  …and ${stale.length - 10} more` : '';
  console.error(
    `verify:dist-fresh: dist/cli.js is older than ${stale.length} source file(s) — ` +
      `the compiled CLI is stale and would validate code that is not what shipped.\n${shown}${extra}\n` +
      `Run \`npm run build\` and re-run verify:close.`
  );
  process.exit(1);
}

console.log(
  `verify:dist-fresh: dist/cli.js is newer than ${inputs.length} source input(s).`
);
