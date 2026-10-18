/**
 * Spec 38 R3 — gate work budget, re-expressed over deterministic work (Directive J).
 *
 * The blocking gate (`code-audit changed`) used to be budgeted in CPU time
 * (`auditCpuMs` < 900 ms). CPU time is load-dependent: a co-tenant-heavy machine
 * inflates the figure without touching the rule, so the gate jittered under
 * verify:close's own sustained load and needed an "idle placement" workaround.
 * Directive J re-expresses the budget over a deterministic quantity instead —
 * the number of distinct receiver resolutions the phase pipeline performed
 * (`receiverResolutions`, the `handleVerdictCache` size after the pass). A fixed
 * file folds `identifyHandle` a fixed number of times regardless of machine
 * load, so a regression that re-derives provenance or widens the candidate set
 * moves this count deterministically, where CPU time only jittered.
 *
 * This script runs the real diff-scoped `changed` command against the
 * representative gating file and asserts the reported work count stays under
 * the budget. The budget is NOT re-declared here — it is read from the CLI's
 * `gate work: … (budget N)` line, so `src/config/defaults.ts` (via the CLI) is the
 * single source and this verifier can never drift from it.
 *
 * The time measurement (wall-clock + CPU) did not vanish — it moved to
 * `bench/gate-timing.ts` (measurement, not a gate assertion). This script still
 * prints the times if the CLI emits them, for the human reading the gate log,
 * but it never asserts on them.
 *
 * Usage (from app/):
 *   npm run build && npm run verify:gate-budget
 *
 * Exit code: 0 iff the reported work is under budget; 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI = resolve(process.cwd(), 'dist/cli.js');
const REPRESENTATIVE_FILE = 'src/analyzers/universal/UniversalSOLIDAnalyzer.ts';

if (!existsSync(CLI)) {
  console.error('verify:gate-budget: dist/cli.js not found — run `npm run build` first.');
  process.exit(1);
}

function runGate() {
  const result = spawnSync(
    'node',
    [CLI, 'changed', REPRESENTATIVE_FILE, '--json'],
    {
      encoding: 'utf-8',
      env: { ...process.env, CODE_AUDITOR_RULE_TIMING: '1' },
    },
  );
  if (result.error) {
    return { work: null, budget: null, stderr: '', error: result.error.message };
  }
  const stderr = result.stderr ?? '';
  const workMatch = stderr.match(/gate work:\s*(\d+)\s+receiver resolutions\s*\(budget\s*(\d+)\)/);
  const wallMatch = stderr.match(/gate wall-clock:\s*([\d.]+)\s*ms/);
  const cpuMatch = stderr.match(/gate cpu-time:\s*([\d.]+)\s*ms/);
  return {
    work: workMatch ? parseInt(workMatch[1], 10) : null,
    budget: workMatch ? parseInt(workMatch[2], 10) : null,
    wallMs: wallMatch ? parseFloat(wallMatch[1]) : null,
    cpuMs: cpuMatch ? parseFloat(cpuMatch[1]) : null,
    stderr,
    error: null,
  };
}

const run = runGate();
if (run.error) {
  console.error(`verify:gate-budget: failed to launch CLI: ${run.error}`);
  process.exit(1);
}
if (run.work === null || run.budget === null) {
  console.error('verify:gate-budget: could not parse "gate work: … (budget N)" from CLI output.');
  console.error('--- captured stderr ---');
  console.error(run.stderr);
  process.exit(1);
}

console.log(
  `gate work: ${run.work} receiver resolutions (budget ${run.budget})` +
    (run.wallMs !== null ? `, wall-clock: ${run.wallMs.toFixed(1)} ms` : '') +
    (run.cpuMs !== null ? `, cpu-time: ${run.cpuMs.toFixed(1)} ms` : ''),
);

if (!Number.isInteger(run.work) || !Number.isInteger(run.budget)) {
  console.error('verify:gate-budget: unparseable gate work count or budget.');
  process.exit(1);
}

if (run.work >= run.budget) {
  console.error(
    `FAIL: gate work ${run.work} receiver resolutions is at or over budget ${run.budget}. ` +
      'Do not quietly widen the budget — see src/config/defaults.ts.',
  );
  process.exit(1);
}

console.log(`PASS: gate work ${run.work} receiver resolutions is under budget ${run.budget}.`);
process.exit(0);
