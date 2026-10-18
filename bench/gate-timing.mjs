/**
 * Gate timing measurement (Spec 38 R3, moved here by Directive J).
 *
 * The blocking gate (`code-audit changed`) used to be *budgeted* in CPU time in
 * `scripts/verify-gate-budget.mjs`. CPU time is load-dependent, so that gate
 * jittered under verify:close's own load and needed an "idle placement"
 * workaround. Directive J re-expressed the *gate* over a deterministic quantity
 * (receiver-resolution count — see scripts/verify-gate-budget.mjs), and moved the
 * time measurement here: this script measures wall-clock and CPU time for the
 * representative gating file but never asserts on them.
 *
 * The point of the measurement surviving is diagnostic: if someone wants to know
 * whether the gate got slower, they run this instead of reading a gate that no
 * longer prints a budget. It keeps the cold-then-warm methodology (Spec 43
 * R2/R3): the first run warms the page cache, tree-sitter, and index and is
 * reported but not the headline figure; the second (warm) run is the number that
 * matters. The receiver-resolution count is printed too, so the deterministic
 * gate metric and the jittery time metric are visible side by side.
 *
 * Exit code: always 0 (measurement, not a gate). A launch failure is reported to
 * stderr and still exits 0 — this script must never block a release on a number
 * it is not allowed to assert.
 *
 * Usage (from app/, after `npm run build`):
 *   npm run bench:gate-timing
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI = resolve(process.cwd(), 'dist/cli.js');
const REPRESENTATIVE_FILE = 'src/analyzers/universal/UniversalSOLIDAnalyzer.ts';

if (!existsSync(CLI)) {
  console.error('bench:gate-timing: dist/cli.js not found — run `npm run build` first.');
  process.exit(0);
}

function run() {
  const result = spawnSync(
    'node',
    [CLI, 'changed', REPRESENTATIVE_FILE, '--json'],
    {
      encoding: 'utf-8',
      env: { ...process.env, CODE_AUDITOR_RULE_TIMING: '1' },
    },
  );
  if (result.error) return { error: result.error.message };
  const stderr = result.stderr ?? '';
  return {
    work: (stderr.match(/gate work:\s*(\d+)/) ?? [])[1] ?? null,
    wallMs: (stderr.match(/gate wall-clock:\s*([\d.]+)\s*ms/) ?? [])[1] ?? null,
    cpuMs: (stderr.match(/gate cpu-time:\s*([\d.]+)\s*ms/) ?? [])[1] ?? null,
    stderr,
    error: null,
  };
}

const cold = run();
if (cold.error) {
  console.error(`bench:gate-timing: cold run failed to launch: ${cold.error}`);
  process.exit(0);
}

const warm = run();
if (warm.error) {
  console.error(`bench:gate-timing: warm run failed to launch: ${warm.error}`);
  process.exit(0);
}

const fmt = (v) => (v === null ? 'n/a' : `${parseFloat(v).toFixed(1)} ms`);
console.log('bench:gate-timing — representative file:', REPRESENTATIVE_FILE);
console.log(`  cold wall-clock: ${fmt(cold.wallMs)}, cpu-time: ${fmt(cold.cpuMs)} (page-cache cold)`);
console.log(`  warm wall-clock: ${fmt(warm.wallMs)}, cpu-time: ${fmt(warm.cpuMs)} (the figure to watch)`);
console.log(`  warm receiver resolutions: ${warm.work ?? 'n/a'} (deterministic gate metric)`);
process.exit(0);
