/**
 * Spec 33 Item 15 — verify:self.
 *
 * The self-audit gate: run the analyzer against its own production source
 * (`src/analyzers/**` and `src/languages/**`) and assert zero violations.
 *
 * This is the ratchet that makes the Spec 33 board's "self-audit to zero"
 * target a hard, machine-checked invariant instead of a claim in an evidence
 * file. The zero-violations assertion is live: any regression that reintroduces
 * a finding fails this script, and it is wired into `verify:close`.
 *
 * The scoped filter mirrors the board's production scope exactly: only files
 * under `analyzers/` or `languages/`, excluding tests, specs, and fixtures.
 *
 * Usage (from app/):
 *   npm run build && npm run verify:self
 *
 * Exit code: 0 iff the scoped violation count is zero; 1 otherwise (with a
 * per-rule breakdown).
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
  return true;
}

// --- Collect scoped violations ----------------------------------------------
const byRule = new Map(); // rule -> count
const byAnalyzer = new Map(); // analyzer -> count
let total = 0;

for (const analyzerName of Object.keys(report.analyzerResults ?? {})) {
  const result = report.analyzerResults[analyzerName];
  const violations = result.violations ?? result.findings ?? [];
  for (const v of violations) {
    if (!inScope(v.file ?? '')) continue;
    total++;
    byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
    byAnalyzer.set(analyzerName, (byAnalyzer.get(analyzerName) ?? 0) + 1);
  }
}

// --- Report ------------------------------------------------------------------
console.log('');
console.log('verify:self — scoped production violations (analyzers/ + languages/)');
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
  console.log('PASS — zero scoped violations.');
  process.exit(0);
} else {
  console.log(`FAIL — ${total} scoped violation(s) remaining. The zero-violations assertion is live: fix the above and re-run.`);
  process.exit(1);
}
