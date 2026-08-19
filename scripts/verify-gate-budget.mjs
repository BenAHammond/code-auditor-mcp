/**
 * Spec 38 R3 — gate speed budget (Spec 43 R2/R3: warm-then-measure).
 *
 * The blocking gate (`code-audit changed`) must complete in under 300 ms on a
 * single changed file. This is the machine-checked assertion: it runs the real
 * diff-scoped `changed` command against a representative gating-heavy source
 * file and asserts the reported gate wall-clock stays under budget.
 *
 * The reported "gate wall-clock" is `auditDuration` — the diff-scoped audit
 * itself, excluding the one-time WASM grammar load. That is the number Spec 38
 * R3 is about: a slow *rule* makes the audit slow, and a slow WASM load is a
 * different (fixed, once-per-process) cost that R2/R3 are not scoped to.
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
const BUDGET_MS = 300;

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
  const gateMatch = stderr.match(/gate wall-clock:\s*([\d.]+)\s*ms/);
  return { gateMs: gateMatch ? parseFloat(gateMatch[1]) : null, stderr, error: null };
}

function reportParseFailure(label, stderr) {
  console.error(`verify:gate-budget: could not parse "gate wall-clock" from CLI output (${label} run).`);
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

console.log(`cold gate wall-clock: ${cold.gateMs.toFixed(1)} ms (unasserted — page-cache cold)`);
console.log(`warm gate wall-clock: ${warm.gateMs.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);

// Re-emit the per-rule breakdown (slowest first) from the warm run so a slow
// rule is visible.
const ruleLines = warm.stderr.split('\n').filter((l) => /^\s{2}\S+\s+[\d.]+ ms/.test(l));
if (ruleLines.length > 0) {
  console.log('per-rule timing (warm, slowest first):');
  for (const line of ruleLines) console.log(line);
}

if (!Number.isFinite(warm.gateMs)) {
  console.error('verify:gate-budget: unparseable warm gate wall-clock.');
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
