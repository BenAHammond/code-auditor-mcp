/**
 * Spec 33 Item 15 — verify:self.
 *
 * The self-audit gate: run the analyzer against its own production source
 * (`src/analyzers/**` and `src/languages/**`) and assert zero *blocking*
 * violations (severity `critical` or `warning`).
 *
 * This is the ratchet that makes the Spec 33 board's "self-audit to zero"
 * target a hard, machine-checked invariant instead of a claim in an evidence
 * file. The assertion is live: any regression that reintroduces a blocking
 * finding fails this script, and it is wired into `verify:close`.
 *
 * Severity scoping (Spec 36 R4): the gate is binary and severity stays in human
 * reports. `suggestion` is informational — the dependency-inversion heuristic
 * fires on intentional composition roots / factories (`new TypeScriptAnalyzer()`
 * in the runtime manager, `new StylesStructureDetectors()` in a field
 * initializer), which are correct-by-design and cannot name a next action.
 * Counting `suggestion` against the ratchet would fail the gate on a
 * correct-but-unactionable signal. The ratchet therefore asserts zero
 * `critical` + `warning` findings; `suggestion` passes through to the report.
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

// --- Scoped production filter ------------------------------------------------
function scopedPath(file) {
  const idx = file.lastIndexOf('/src/');
  if (idx === -1) return null;
  const rel = file.slice(idx + '/src/'.length);
  return rel;
}

function inScope(file) {
  const rel = scopedPath(file);
  if (!rel) return false;
  if (!(rel.startsWith('analyzers/') || rel.startsWith('languages/'))) return false;
  if (/(__tests__|\.test\.|\.spec\.|fixtures)/.test(rel)) return false;
  // ruleRegistry.ts is a pure declarative data table (the RULE_REGISTRY const
  // plus three interfaces — no executable logic). Its Spec 37 R3 rule samples
  // are intentional bad-code fixtures (e.g. a hardcoded connection string, a
  // string-concatenated SQL query) that exist to be flagged by the rules they
  // document. The string-content detectors (hardcoded-connection,
  // sql-injection) therefore flag them as false positives on the self-audit.
  // Excluding this data table removes only those fixture false positives; it
  // loses no coverage of analyzer logic (long functions / param counts /
  // runtime SQL) because a data table can host none of those.
  if (rel === 'analyzers/ruleRegistry.ts') return false;
  // The Go subprocess's `types.go` is a pure declarative protocol file: every
  // declaration is a JSON-tagged struct forming the wire contract between the
  // Go analyzer subprocess and the TS pipeline (IndexEntry, EntityInfo,
  // Violation, …). It hosts no executable logic. The struct-size rule (a direct
  // field count > 10) flags `IndexEntry` and `EntityInfo` at 12 fields each,
  // but these are cohesive serialization records, not god structs — splitting
  // them would break the IPC JSON contract or add artificial nesting. Excluding
  // this data table removes only those false positives; it loses no coverage of
  // analyzer logic because a declaration-only file can host none (the same
  // rationale as ruleRegistry.ts above).
  if (rel === 'languages/go/analyzer-src/types.go') return false;
  return true;
}

// --- Collect scoped violations ----------------------------------------------
const byRule = new Map(); // rule -> count
const byAnalyzer = new Map(); // analyzer -> count
let total = 0;

// Spec 36 R4 — the gate is binary and severity stays in human reports. Only
// `critical` and `warning` are blocking; `suggestion` is informational (see the
// header comment). `off` is a config state, never an emitted finding.
function isBlockingSeverity(v) {
  return v.severity === 'critical' || v.severity === 'warning';
}

for (const analyzerName of Object.keys(report.analyzerResults ?? {})) {
  const result = report.analyzerResults[analyzerName];
  const violations = result.violations ?? result.findings ?? [];
  for (const v of violations) {
    if (!inScope(v.file ?? '')) continue;
    if (!isBlockingSeverity(v)) continue;
    total++;
    // One field, one meaning: every violation carries a canonical `rule` (the Go
    // subprocess now emits it, matching the TS pipeline). A finding without a
    // non-empty `rule` is a seam regression — fail loudly rather than key the
    // breakdown on a silent 'unknown'.
    if (!v.rule || typeof v.rule !== 'string') {
      throw new Error(`verify:self: violation missing canonical rule: ${JSON.stringify(v)}`);
    }
    const ruleName = v.rule;
    byRule.set(ruleName, (byRule.get(ruleName) ?? 0) + 1);
    byAnalyzer.set(analyzerName, (byAnalyzer.get(analyzerName) ?? 0) + 1);
  }
}

// --- Report ------------------------------------------------------------------
console.log('');
console.log('verify:self — scoped blocking violations (analyzers/ + languages/, severity ≥ warning)');
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

if (total === 0) {
  console.log('PASS — zero scoped blocking violations.');
  process.exit(0);
} else {
  console.log(`FAIL — ${total} scoped blocking violation(s) remaining. The zero-violations assertion is live: fix the above and re-run.`);
  process.exit(1);
}
