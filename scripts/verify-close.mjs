#!/usr/bin/env node
/**
 * verify-close.mjs — the `verify:close` release gate, run-all.
 *
 * The old chain was a single `&&` conjunction in package.json:
 *
 *   verify:disk-space && verify:types && verify:dist-fresh && test && …
 *
 * A `&&` chain short-circuits: the first gate to exit non-zero aborts the run
 * and every gate *after* it is silently skipped. That is the recurring
 * "a gate passes by not running" failure this project already documents
 * (CHANGELOG: the broken-compiler-that-sat-green and the stale-`missing-org-filter`
 * false clean). It bit here concretely: `verify:dist-fresh` has failed since
 * Spec 69 R1/R2 (dist stale), so the `&&` chain short-circuited at `dist-fresh`
 * and `verify:oracle-shortfalls` — the gate that pins the Spec 69 completeness
 * residuals — was never reached in that window. No drift was masked or concealed:
 * the run aborted before it got that far.
 *
 * This runner fixes the *shape*, not the instance: it runs every gate, records
 * every outcome, and reports the full set, so no gate is ever skipped by an
 * earlier failure. The one remaining skip is deliberate and loud: the gates that
 * consume `dist/cli.js` (test, test:integration, gate-budget, self, dist) are
 * `SKIPPED (dist stale)` when `verify:dist-fresh` fails — they would otherwise
 * validate a compiled CLI that is not the source, the exact trap `verify:dist-fresh`
 * exists to prevent. The drift gates (bench, recall-value-drift,
 * extraction-completeness, oracle-shortfalls) are `tsx` over `src/` and do NOT
 * depend on dist, so they always run and their drift is surfaced alongside the
 * dist failure instead of being skipped by the short-circuit.
 *
 * Exit code: 0 iff every gate ran and passed; 1 otherwise (any FAIL or CRASH).
 * A SKIP is reported but is not itself a failure — the stale dist that caused
 * the skip already failed `verify:dist-fresh`.
 *
 * Usage (from app/):
 *   node scripts/verify-close.mjs
 */

import { spawnSync } from 'node:child_process';

/**
 * The ordered gate list. `dist: true` marks a gate that consumes `dist/cli.js`
 * and therefore must not run against a stale build; `dist: false` gates run over
 * `src/` (tsx/vitest) or the environment and are independent of the compiled CLI.
 */
export const GATES = [
  { name: 'verify:disk-space', dist: false },
  { name: 'verify:types', dist: false },
  { name: 'verify:dist-fresh', dist: false },
  { name: 'test', dist: true },
  { name: 'test:integration', dist: true },
  { name: 'bench', dist: false },
  { name: 'verify:recall-value-drift', dist: false },
  { name: 'verify:extraction-completeness', dist: false },
  { name: 'verify:oracle-shortfalls', dist: false },
  { name: 'verify:gate-budget', dist: true },
  { name: 'verify:clean-install', dist: false },
  { name: 'verify:dist', dist: true },
  { name: 'verify:self', dist: true },
  { name: 'verify:daemon-smoke', dist: true },
];

/**
 * Pure planning half — decide, for each gate, whether it runs or is skipped
 * given whether `verify:dist-fresh` already failed. Extracted so a
 * gate-liveness test can assert the skip/run decision without executing the
 * (slow) full chain.
 *
 * @param {{name: string, dist: boolean}[]} gates
 * @param {boolean} distFreshFailed
 * @returns {{name: string, action: 'run' | 'skip', reason?: string}[]}
 */
export function planRun(gates, distFreshFailed) {
  return gates.map((g) => {
    if (g.name === 'verify:dist-fresh') return { name: g.name, action: 'run' };
    if (g.dist && distFreshFailed) {
      return { name: g.name, action: 'skip', reason: 'dist stale' };
    }
    return { name: g.name, action: 'run' };
  });
}

/** Run one gate via `npm run <name>`, streaming its output, returning its status. */
function runGate(name) {
  console.log(`\n═══ ${name} ═══`);
  const res = spawnSync('npm', ['run', name], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  // A spawn error (signal, ENOENT) yields status === null.
  return res.status;
}

/**
 * Pure aggregation half — map a completed result list to a verdict. Extracted
 * from `main` so a gate-liveness test can assert the invariant the old runner
 * left implicit: **a skipped gate can never read `pass`**. The verdict is:
 *
 *   - `pass` — every gate ran and exited 0 (no fail, no crash, no skip).
 *   - `fail` — at least one gate failed or crashed (a skip may also be present).
 *   - `inconsistent` — at least one gate was skipped but none failed/crashed: a
 *     planning bug (a skip is only ever expected to follow a `verify:dist-fresh`
 *     failure, which is itself a failure).
 *
 * `failed` deliberately excludes `status === null` so a crash is not
 * double-counted in the summary line (the old filter `status !== 0` also matched
 * `null`).
 *
 * @param {{name: string, action: 'run' | 'skip', status: number | null, reason?: string}[]} results
 * @returns {{failed: [], crashed: [], skipped: [], passed: [], verdict: 'pass' | 'fail' | 'inconsistent'}}
 */
export function summarizeResults(results) {
  const failed = results.filter((r) => r.action === 'run' && r.status !== null && r.status !== 0);
  const crashed = results.filter((r) => r.action === 'run' && r.status === null);
  const skipped = results.filter((r) => r.action === 'skip');
  const passed = results.filter((r) => r.action === 'run' && r.status === 0);
  let verdict;
  if (failed.length === 0 && crashed.length === 0 && skipped.length === 0) {
    verdict = 'pass';
  } else if (skipped.length > 0 && failed.length === 0 && crashed.length === 0) {
    verdict = 'inconsistent';
  } else {
    verdict = 'fail';
  }
  return { failed, crashed, skipped, passed, verdict };
}

function main() {
  const results = [];
  let distFreshFailed = false;

  for (const gate of GATES) {
    if (gate.name === 'verify:dist-fresh') {
      const status = runGate(gate.name);
      distFreshFailed = status !== 0;
      results.push({ name: gate.name, action: 'run', status });
      continue;
    }
    const plan = planRun([gate], distFreshFailed)[0];
    if (plan.action === 'skip') {
      console.log(`\n═══ ${gate.name} — SKIPPED (${plan.reason}) ═══`);
      results.push({ name: gate.name, action: 'skip', status: null, reason: plan.reason });
      continue;
    }
    const status = runGate(gate.name);
    results.push({ name: gate.name, action: 'run', status });
  }

  const { failed, crashed, skipped, verdict } = summarizeResults(results);

  console.log('\n════════════════════════════════════════════');
  console.log('verify:close — full run summary (run-all, no silent skips)');
  for (const r of results) {
    const mark =
      r.action === 'skip'
        ? `SKIPPED (${r.reason})`
        : r.status === null
          ? 'CRASH'
          : r.status === 0
            ? 'PASS'
            : 'FAIL';
    console.log(`  ${mark.padEnd(16)} ${r.name}`);
  }
  console.log('════════════════════════════════════════════');

  if (verdict === 'fail') {
    console.error(
      `verify:close FAILED — ${failed.length} failed, ${crashed.length} crashed` +
        (skipped.length ? `, ${skipped.length} skipped (dist stale)` : '') +
        '.',
    );
    process.exit(1);
  }

  if (verdict === 'inconsistent') {
    // A skip without a failure is a planning bug (a skip is only expected to
    // follow a dist-fresh failure). It must not read as green.
    console.error(
      `verify:close inconsistent — ${skipped.length} gate(s) skipped but none failed.`,
    );
    process.exit(1);
  }

  console.log('verify:close PASSED — every gate ran and passed.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
