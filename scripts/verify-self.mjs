/**
 * Spec 33 Item 15 — verify:self.
 *
 * The self-audit gate: run the analyzer against its own production source
 * (`src/analyzers/**` and `src/languages/**`) and assert zero *blocking*
 * violations (severity `critical`, `severe`, or `high`).
 *
 * This is the ratchet that makes the Spec 33 board's "self-audit to zero"
 * target a hard, machine-checked invariant instead of a claim in an evidence
 * file. The assertion is live: any regression that reintroduces a blocking
 * finding fails this script, and it is wired into `verify:close`.
 *
 * Severity scoping (Spec 54 R3): the gate blocks every severity on the ladder —
 * `critical`, `severe`, and `high` — matching `BLOCKING_SEVERITIES` in
 * `src/types.ts`. There is no "informational" tier at the gate: Spec 54's
 * recalibration re-labelled the bottom tier `high`, it did not demote it to
 * non-blocking. The ratchet therefore asserts zero `critical` + `severe` +
 * `high` findings in scope. Findings that are correct-by-design are excluded
 * *by scope* (see `SCOPED_EXEMPTIONS` below) with a written rationale per
 * (file, rule) pair — never by relabelling their severity, which would make the
 * tier silently optional. `off` is a config state, never an emitted finding.
 *
 * The scoped filter mirrors the board's production scope exactly: only files
 * under `analyzers/` or `languages/`, excluding tests, specs, and fixtures.
 *
 * Usage (from app/):
 *   npm run build && npm run verify:self
 *
 * Exit code: 0 iff the scoped blocking-violation count is zero; 1 otherwise
 * (with a per-rule breakdown).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  inScope,
  isBlockingSeverity,
  isScopedExempt,
  scopedExemptionKey,
  scopedPath,
  staleExemptions,
} from './verify-self-core.mjs';

const CLI = resolve(process.cwd(), 'dist/cli.js');
if (!existsSync(CLI)) {
  console.error('verify:self: dist/cli.js not found — run `npm run build` first.');
  process.exit(1);
}

// --- Run the self-audit ------------------------------------------------------
const outDir = mkdtempSync(join(tmpdir(), 'ca-verify-self-'));
try {
  execFileSync('node', ['--expose-gc', CLI, 'audit', '--path', 'src', '-f', 'json', '-o', outDir], {
    stdio: 'inherit',
  });
} catch (err) {
  // The audit CLI may exit non-zero on violations; that is not a script error
  // here — we only care about the report it writes.
  if (!existsSync(join(outDir, 'audit-report.json'))) {
    console.error('verify:self: self-audit produced no report. Exit code:', err.status ?? err);
    process.exit(1);
  }
}

const reportPath = join(outDir, 'audit-report.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

// --- Collect scoped violations ----------------------------------------------
const byRule = new Map(); // rule -> count
const byAnalyzer = new Map(); // analyzer -> count
const matchedExemptions = new Set(); // (file, rule) keys an exemption actually absorbed
let total = 0;

for (const analyzerName of Object.keys(report.analyzerResults ?? {})) {
  const result = report.analyzerResults[analyzerName];
  const violations = result.violations ?? result.findings ?? [];
  for (const v of violations) {
    if (!inScope(v.file ?? '')) continue;
    if (!isBlockingSeverity(v)) continue;
    // One field, one meaning: every violation carries a canonical `rule` (the Go
    // subprocess now emits it, matching the TS pipeline). A finding without a
    // non-empty `rule` is a seam regression — fail loudly rather than key the
    // breakdown on a silent 'unknown'.
    if (!v.rule || typeof v.rule !== 'string') {
      throw new Error(`verify:self: violation missing canonical rule: ${JSON.stringify(v)}`);
    }
    const ruleName = v.rule;
    const rel = scopedPath(v.file ?? '');
    if (isScopedExempt(rel, ruleName)) {
      matchedExemptions.add(scopedExemptionKey(rel, ruleName));
      continue;
    }
    total++;
    byRule.set(ruleName, (byRule.get(ruleName) ?? 0) + 1);
    byAnalyzer.set(analyzerName, (byAnalyzer.get(analyzerName) ?? 0) + 1);
  }
}

// --- Report ------------------------------------------------------------------
console.log('');
console.log('verify:self — scoped blocking violations (analyzers/ + languages/, severity ≥ high)');
console.log(`  total: ${total}`);
console.log('');
console.log('  by analyzer:');
for (const [name, count] of [...byAnalyzer.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${name.padEnd(16)} ${count}`);
}
console.log('');
console.log('  by rule:');
for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${rule.padEnd(32)} ${count}`);
}
console.log('');

rmSync(outDir, { recursive: true, force: true });

// A scoped exemption is a decision about a finding, and a finding can stop
// existing. If any (file, rule) pair in SCOPED_EXEMPTIONS no longer fires, the
// exemption is dead and must be removed — the gate fails rather than let the
// suppression list silently accumulate (the SKIP_RULES failure mode).
const stale = staleExemptions(matchedExemptions);
if (stale.length > 0) {
  console.log(`FAIL — ${stale.length} stale scoped exemption(s): the (file, rule) pair no longer fires. Remove it from SCOPED_EXEMPTIONS in verify-self-core.mjs.`);
  for (const s of stale) console.log(`  ${s.file} :: ${s.rule}`);
  process.exit(1);
}

if (total === 0) {
  console.log('PASS — zero scoped blocking violations.');
  process.exit(0);
} else {
  console.log(`FAIL — ${total} scoped blocking violation(s) remaining. The zero-violations assertion is live: fix the above and re-run.`);
  process.exit(1);
}
