/**
 * Spec 38 R3 — gate speed budget (Spec 43 R2/R3: warm-then-measure).
 *
 * The blocking gate (`code-audit changed`) must complete in under `BUDGET_MS`
 * (a CPU-time budget, re-baselined from Spec 38 R3's 300 ms wall-clock figure —
 * see the justification next to the constant below) on a single changed file.
 * This is the machine-checked assertion: it runs the real diff-scoped `changed`
 * command against a representative gating-heavy source file and asserts the
 * reported gate CPU time stays under budget.
 *
 * The reported "gate cpu-time" is `auditCpuMs` (process.cpuUsage user+system)
 * — the diff-scoped audit's processor time, excluding the one-time WASM grammar
 * load. That is the number Spec 38 R3 is about: a slow *rule* burns CPU, and a
 * slow WASM load is a different (fixed, once-per-process) cost that R2/R3 are
 * not scoped to. CPU time is used rather than wall clock because the budget
 * measures rule cost, not machine load: a co-tenant-heavy run (e.g. the
 * integration suite) inflates wall clock without touching the rule, and a
 * load-independent figure removes that failure mode.
 *
 * Spec 43 R2/R3 — the first invocation is a COLD run (page cache, tree-sitter,
 * and index all still cold); its timing is reported but NOT asserted. The
 * second invocation is the WARM run the budget asserts on. A slow rule makes
 * the warm run slow, and that is what Spec 38 R3 exists to catch — there isn't
 * one, so the warm figure is the honest signal. The cold figure is still
 * printed because a cold number that climbs past a second is a finding worth
 * seeing rather than one the warm-up conceals.
 *
 * Usage (from app/):
 *   npm run build && npm run verify:gate-budget
 *
 * Exit code: 0 iff the warm gate is under budget; 1 otherwise (with the
 * measured figures and the per-rule breakdown so the dominant rule is visible).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI = resolve(process.cwd(), 'dist/cli.js');
const REPRESENTATIVE_FILE = 'src/analyzers/universal/UniversalSOLIDAnalyzer.ts';
// The budget is a CPU-time budget, and the number is MEASURED, not carried over
// from Spec 38 R3's 300 ms wall-clock figure. The metric moved from wall clock
// to `process.cpuUsage()` (user+system), which sums across threads and so runs
// above wall clock for this audit: on the representative file, warm wall clock
// is ~295 ms but warm CPU time is 305–317 ms, and 325 ms when measured in the
// verify:close chain right after the bench. Re-measured with:
//   CODE_AUDIT_RULE_TIMING=1 node dist/cli.js changed \
//     src/analyzers/universal/UniversalSOLIDAnalyzer.ts --json 2>&1 >/dev/null
// (9 warm runs: 305.5–317.1 ms, median ~312 ms; the 325 ms figure is the same
// file measured warm inside verify:close after the bench + integration suite).
//
// BUDGET_MS = 400: ~23% headroom over the loaded 325 ms baseline. That is a
// real margin. The wall-clock 300 ms budget sat 5 ms under a ~295 ms run —
// 1.7%, the knife-edge that machine load tripped; the 350 ms re-baseline left
// only 7% over the same baseline, the same knife-edge under a different
// metric. 400 ms preserves Spec 38 R3's intent (a genuinely slow rule adds
// hundreds of ms: baseline + ~100 ms → >400 ms and trips the gate) while
// normal CPU-time jitter (±6 ms across the 9 runs) cannot reach it. The metric
// switch was authorized; this re-baseline is the consequence of that switch,
// not a silent widening. Still overridable via env so the gate-liveness test
// can force a violation (`VERIFY_GATE_BUDGET_MS=0` → fail) without waiting on a
// genuinely slow rule — the same env-knob pattern as verify-disk-space's
// `VERIFY_MIN_FREE_BYTES`.
const BUDGET_MS = Number(process.env.VERIFY_GATE_BUDGET_MS ?? 400);

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
      env: { ...process.env, CODE_AUDIT_RULE_TIMING: '1' },
    },
  );
  if (result.error) {
    return { gateMs: null, stderr: '', error: result.error.message };
  }
  const stderr = result.stderr ?? '';
  const gateMatch = stderr.match(/gate cpu-time:\s*([\d.]+)\s*ms/);
  return { gateMs: gateMatch ? parseFloat(gateMatch[1]) : null, stderr, error: null };
}

function reportParseFailure(label, stderr) {
  console.error(`verify:gate-budget: could not parse "gate cpu-time" from CLI output (${label} run).`);
  console.error('--- captured stderr ---');
  console.error(stderr);
  process.exit(1);
}

// Cold run — warms the page cache and index; reported, never asserted (Spec 43 R3).
const cold = runGate();
if (cold.error) {
  console.error(`verify:gate-budget: failed to launch CLI (cold run): ${cold.error}`);
  process.exit(1);
}
if (cold.gateMs === null) reportParseFailure('cold', cold.stderr);

// Warm run — the figure the budget asserts on (Spec 43 R2).
const warm = runGate();
if (warm.error) {
  console.error(`verify:gate-budget: failed to launch CLI (warm run): ${warm.error}`);
  process.exit(1);
}
if (warm.gateMs === null) reportParseFailure('warm', warm.stderr);

console.log(`cold gate cpu-time: ${cold.gateMs.toFixed(1)} ms (unasserted — page-cache cold)`);
console.log(`warm gate cpu-time: ${warm.gateMs.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);

// Re-emit the per-rule breakdown (slowest first) from the warm run so a slow
// rule is visible.
const ruleLines = warm.stderr.split('\n').filter((l) => /^\s{2}\S+\s+[\d.]+ ms/.test(l));
if (ruleLines.length > 0) {
  console.log('per-rule timing (warm, slowest first):');
  for (const line of ruleLines) console.log(line);
}

if (!Number.isFinite(warm.gateMs)) {
  console.error('verify:gate-budget: unparseable warm gate cpu-time.');
  process.exit(1);
}

if (warm.gateMs >= BUDGET_MS) {
  console.error(
    `FAIL: warm gate ${warm.gateMs.toFixed(1)} ms exceeds budget ${BUDGET_MS} ms. ` +
      'Do not quietly widen the budget — see Spec 38 R3.',
  );
  process.exit(1);
}

console.log(`PASS: warm gate ${warm.gateMs.toFixed(1)} ms is under budget ${BUDGET_MS} ms.`);
process.exit(0);
