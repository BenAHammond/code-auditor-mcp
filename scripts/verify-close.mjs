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
 * earlier failure — under any condition. A stale `dist/cli.js` fails the chain
 * through `verify:dist-fresh`'s own exit 1, but it does not skip the gates that
 * follow it: every gate still runs and every result is still reported, so a
 * downstream failure is surfaced alongside the stale-dist failure instead of
 * being concealed behind a skip. The summary line names every FAIL/CRASH, and
 * the stale-dist failure is loud in the report rather than silently aborting it.
 *
 * Exit code: 0 iff every gate ran and exited 0; 1 otherwise (any FAIL or CRASH).
 *
 * Usage (from app/):
 *   node scripts/verify-close.mjs
 */

import { spawnSync } from 'node:child_process';

/**
 * The ordered gate list. `verify:gate-budget` runs before `verify:types` (tsc),
 * test, test:integration, and bench — its warm run must measure the gate in the
 * idle state the agent's hook actually executes in, not the chain-heated state.
 * `tsc --noEmit` is itself a sustained single-core load that heats the machine
 * enough to inflate the summed CPU time, so it must run after gate-budget too.
 * See the BUDGET_MS note in verify-gate-budget.mjs for why the prior post-bench
 * placement was dropped.
 */
export const GATES = [
  'verify:disk-space',
  'verify:node-types',
  'verify:dist-fresh',
  'verify:gate-budget',
  'verify:types',
  'test',
  'test:integration',
  'bench',
  'verify:recall-value-drift',
  'verify:extraction-completeness',
  'verify:oracle-shortfalls',
  'verify:clean-install',
  'verify:dist',
  'verify:self',
  'verify:daemon-smoke',
];

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
 * Aggregate a completed result list into a verdict. Every gate has run (there is
 * no skip path), so the verdict is pass iff every status is 0:
 *
 *   - `pass` — every gate ran and exited 0 (no fail, no crash).
 *   - `fail` — at least one gate failed or crashed.
 *
 * `failed` deliberately excludes `status === null` so a crash is not
 * double-counted in the summary line.
 *
 * @param {{name: string, status: number | null}[]} results
 * @returns {{failed: [], crashed: [], passed: [], verdict: 'pass' | 'fail'}}
 */
export function summarizeResults(results) {
  const failed = results.filter((r) => r.status !== null && r.status !== 0);
  const crashed = results.filter((r) => r.status === null);
  const passed = results.filter((r) => r.status === 0);
  const verdict = failed.length === 0 && crashed.length === 0 ? 'pass' : 'fail';
  return { failed, crashed, passed, verdict };
}

/**
 * Resolve the gate list for this run, returning `{ gates, omitted }` where
 * `omitted` is the number of `GATES` not in this run.
 *
 * The release path always runs `GATES` in full — a stale `dist/cli.js` fails the
 * chain through `verify:dist-fresh`'s own exit 1, but no gate is ever skipped,
 * and `omitted` is 0.
 *
 * `VERIFY_CLOSE_GATES` (a comma-separated list, e.g. `verify:dist-fresh`) narrows
 * the list for the liveness tests in `gate-liveness.test.ts` that prove a stale
 * dist *fails* the chain without paying the full 15-gate run. It is a test seam,
 * never a skip vector: it names real gates, throws on any unknown name (so it can
 * never silently drop a gate), and is unset in every release/CI path. A subset run
 * is *loud* about being a subset — the summary and verdict name the omitted count
 * and never print the release banner, so a subset can never read as a full pass.
 */
function resolveGates() {
  const override = process.env.VERIFY_CLOSE_GATES;
  if (!override) return { gates: GATES, omitted: 0 };
  const wanted = override
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set(GATES);
  const unknown = wanted.filter((g) => !known.has(g));
  if (unknown.length > 0) {
    throw new Error(`VERIFY_CLOSE_GATES names unknown gates: ${unknown.join(', ')}`);
  }
  return { gates: wanted, omitted: GATES.length - wanted.length };
}

function main() {
  const { gates, omitted } = resolveGates();
  const subset = omitted > 0;
  const results = [];
  for (const name of gates) {
    results.push({ name, status: runGate(name) });
  }

  const { failed, crashed, verdict } = summarizeResults(results);

  console.log('\n════════════════════════════════════════════');
  if (subset) {
    console.log(
      `verify:close — SUBSET run: ${gates.length} of ${GATES.length} gates ` +
        `(${omitted} omitted via VERIFY_CLOSE_GATES) — test seam, not a release check`,
    );
  } else {
    console.log('verify:close — full run summary (run-all, no skips)');
  }
  for (const r of results) {
    const mark = r.status === null ? 'CRASH' : r.status === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${mark.padEnd(16)} ${r.name}`);
  }
  console.log('════════════════════════════════════════════');

  if (verdict === 'fail') {
    const omittedNote = subset ? `; ${omitted} of ${GATES.length} gates omitted` : '';
    console.error(
      `verify:close FAILED${subset ? ' (subset)' : ''} — ${failed.length} failed, ${crashed.length} crashed${omittedNote}.`,
    );
    process.exit(1);
  }

  if (subset) {
    console.log(
      `verify:close PASSED (subset) — ${gates.length} of ${GATES.length} gates ran and passed; ${omitted} omitted.`,
    );
  } else {
    console.log('verify:close PASSED — every gate ran and passed.');
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
