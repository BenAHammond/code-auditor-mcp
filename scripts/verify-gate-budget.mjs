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
// The budget is a CPU-time budget (process.cpuUsage user+system, summed across
// threads — runs above wall clock for this audit), MEASURED against the
// representative file, never carried over. It has been re-baselined twice, each
// time with the architectural reason the baseline moved recorded here so the
// widening is attributed, not quiet:
//
//   First (wall clock → CPU time): 300 ms wall → 400 ms CPU, ~23% headroom over
//   the loaded 325 ms baseline.
//
//   Second (this re-baseline, Spec 70 receiver resolution): Spec 70 (commits
//   8d49273..a2111a1) moved the data-access-calls work into the phase pipeline's
//   `data-access-calls` collapse, which re-derives each file's `dbProvenanced`
//   (`classifyBuildProvenance`) and re-folds `identifyHandle` over every
//   query-shaped candidate + R3 site. `identifyHandle` now does heritage
//   resolution (`this.<field>` from the base class / declared deps' .d.ts),
//   tsconfig-path bare-specifier resolution, and import-kind resolution on top
//   of the node-sql-parser SQL-argument parse it always did. Two perf fixes
//   already landed and are not re-done here: the B1 specifier-resolution
//   memoization (21aaaa8: 1374 ms → ~700 ms) and the identifyHandle-verdict
//   memoization across the five receiver consumers (5601ce3: only the first
//   consumer pays the SQL parse for a given candidate). The remaining cost is
//   genuine receiver resolution — a SQL parse + declaration resolution per
//   distinct query-shaped candidate/R3 site — on the representative file, a
//   681-line file with *no* DB calls (the cost is the resolution machinery
//   itself, not DB findings: `producer:data-access-calls` dominates the warm
//   breakdown at ~190 ms CPU). Re-measured with:
//     CODE_AUDIT_RULE_TIMING=1 node dist/cli.js changed \
//       src/analyzers/universal/UniversalSOLIDAnalyzer.ts --json 2>&1 >/dev/null
//   (10 warm runs: 642–712 ms CPU, median ~705 ms, mean ~688 ms).
//
// BUDGET_MS = 900: ~28% headroom over the ~705 ms isolated median. This gate is
// ordered FIRST among the dist-consuming gates in verify-close.mjs — right after
// verify:dist-fresh and before test/test:integration/bench — so the warm run
// measures the gate in the *idle* state the agent's hook actually executes in.
// The prior placement after bench + integration carried a "+~4% the verify:close
// chain adds" allowance forward from the first re-baseline; that allowance was
// never re-validated for the Spec-70 receiver-resolution gate, and measured now
// it is ~+40% (isolated ~705 ms → loaded ~1018 ms, higher on a second
// consecutive chain) purely from the chain's own sustained load — harness noise,
// not a slow rule, that decays within minutes. Measuring idle removes that noise
// without widening the budget, so the gate keeps its full sensitivity: an
// isolated +~195 ms regression still trips 900 ms (the same margin the two prior
// re-baselines held). The per-run jitter is wider than the old ±6 ms (~±35 ms,
// because receiver resolution touches node_modules/.d.ts through the page
// cache), so the budget needs the full headroom to stay off a knife-edge. The
// next lever for shrinking the receiver-resolution cost itself — ts.resolveModuleName
// / go list instead of the hand-rolled specifier + heritage walk — is recorded
// as future work, not this release. Still overridable via env so the
// gate-liveness test can force a violation (`VERIFY_GATE_BUDGET_MS=0` → fail)
// without waiting on a genuinely slow rule — the same env-knob pattern as
// verify-disk-space's `VERIFY_MIN_FREE_BYTES`.
const BUDGET_MS = Number(process.env.VERIFY_GATE_BUDGET_MS ?? 900);

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
    return { gateMs: null, gateWallMs: null, stderr: '', error: result.error.message };
  }
  const stderr = result.stderr ?? '';
  const gateMatch = stderr.match(/gate cpu-time:\s*([\d.]+)\s*ms/);
  const wallMatch = stderr.match(/gate wall-clock:\s*([\d.]+)\s*ms/);
  return {
    gateMs: gateMatch ? parseFloat(gateMatch[1]) : null,
    gateWallMs: wallMatch ? parseFloat(wallMatch[1]) : null,
    stderr,
    error: null,
  };
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

console.log(`cold gate wall-clock: ${cold.gateWallMs.toFixed(1)} ms, cpu-time: ${cold.gateMs.toFixed(1)} ms (unasserted — page-cache cold)`);
console.log(`warm gate wall-clock: ${warm.gateWallMs.toFixed(1)} ms, cpu-time: ${warm.gateMs.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);

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
