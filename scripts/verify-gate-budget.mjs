/**
 * Spec 38 R3 — gate speed budget.
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
 * Usage (from app/):
 *   npm run build && npm run verify:gate-budget
 *
 * Exit code: 0 iff the gate is under budget; 1 otherwise (with the measured
 * figure and the per-rule breakdown so the dominant rule is visible).
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

const result = spawnSync(
  'node',
  [CLI, 'changed', REPRESENTATIVE_FILE, '--json'],
  {
    encoding: 'utf-8',
    env: { ...process.env, CODE_AUDIT_RULE_TIMING: '1' },
  },
);

if (result.error) {
  console.error(`verify:gate-budget: failed to launch CLI: ${result.error.message}`);
  process.exit(1);
}

const stderr = result.stderr ?? '';
const gateMatch = stderr.match(/gate wall-clock:\s*([\d.]+)\s*ms/);
if (!gateMatch) {
  console.error('verify:gate-budget: could not parse "gate wall-clock" from CLI output.');
  console.error('--- captured stderr ---');
  console.error(stderr);
  process.exit(1);
}

const gateMs = parseFloat(gateMatch[1]);
console.log(`gate wall-clock: ${gateMs.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);

// Re-emit the per-rule breakdown (slowest first) so a slow rule is visible.
const ruleLines = stderr.split('\n').filter((l) => /^\s{2}\S+\s+[\d.]+ ms/.test(l));
if (ruleLines.length > 0) {
  console.log('per-rule timing (slowest first):');
  for (const line of ruleLines) console.log(line);
}

if (!Number.isFinite(gateMs)) {
  console.error(`verify:gate-budget: unparseable gate wall-clock: ${gateMatch[1]}`);
  process.exit(1);
}

if (gateMs >= BUDGET_MS) {
  console.error(
    `FAIL: gate ${gateMs.toFixed(1)} ms exceeds budget ${BUDGET_MS} ms. ` +
      'Do not quietly widen the budget — see Spec 38 R3.',
  );
  process.exit(1);
}

console.log(`PASS: gate ${gateMs.toFixed(1)} ms is under budget ${BUDGET_MS} ms.`);
process.exit(0);
