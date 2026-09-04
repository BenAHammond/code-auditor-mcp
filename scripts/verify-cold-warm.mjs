/**
 * Cold==warm determinism, per-rule.
 *
 * The audit must produce identical findings whether the code index is cold
 * (fresh, empty) or warm (populated by prior runs). A per-ANALYZER comparison
 * can hide a per-rule skew: two rules moving in opposite directions inside one
 * analyzer net to zero. That is exactly how the styles 92↔41 non-determinism
 * stayed invisible behind a stable analyzer total. This script compares
 * per-rule and fails on any rule whose finding count differs between the two
 * runs.
 *
 * Usage (from app/):
 *   npm run build && node scripts/verify-cold-warm.mjs <projectRoot>
 *
 * The warm run uses the normal index location; the cold run points
 * CODE_AUDITOR_DATA_DIR at a fresh temp dir so the index starts empty. Writes
 * nothing into the project — only into /tmp report dirs.
 *
 * Exit code: 0 iff every rule's count is identical warm vs cold; 1 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('verify:cold-warm: missing <projectRoot> argument.');
  process.exit(1);
}

const CLI = resolve(process.cwd(), 'dist/cli.js');
if (!existsSync(CLI)) {
  console.error('verify:cold-warm: dist/cli.js not found — run `npm run build` first.');
  process.exit(1);
}

/** Run an audit and return per-rule finding counts keyed `analyzer::rule`. */
function runAudit(label, extraEnv) {
  const outDir = mkdtempSync(join(tmpdir(), `ca-cold-warm-${label}-`));
  const reportPath = join(outDir, 'audit-report.json');
  try {
    execFileSync(
      'node',
      [CLI, 'audit', '--path', projectRoot, '-f', 'json', '-o', outDir],
      { env: { ...process.env, ...extraEnv }, stdio: 'pipe' },
    );
  } catch (err) {
    // The audit CLI may exit non-zero on violations; that is not a script error
    // here — we only care about the report it writes.
    if (!existsSync(reportPath)) {
      console.error(`verify:cold-warm: ${label} run produced no report. Exit code: ${err.status ?? err}`);
      process.exit(1);
    }
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const byRule = new Map();
  for (const analyzerName of Object.keys(report.analyzerResults ?? {})) {
    const result = report.analyzerResults[analyzerName];
    for (const v of result.violations ?? result.findings ?? []) {
      const key = `${analyzerName}::${v.rule ?? ''}`;
      byRule.set(key, (byRule.get(key) ?? 0) + 1);
    }
  }
  rmSync(outDir, { recursive: true, force: true });
  return byRule;
}

console.log(`verify:cold-warm: ${projectRoot}`);
console.log('  running warm audit (normal index)...');
const warm = runAudit('warm', {});

console.log('  running cold audit (fresh CODE_AUDITOR_DATA_DIR)...');
const coldDir = mkdtempSync(join(tmpdir(), 'ca-cold-warm-cold-'));
const cold = runAudit('cold', { CODE_AUDITOR_DATA_DIR: coldDir });
rmSync(coldDir, { recursive: true, force: true });

// Diff per-rule.
const allKeys = new Set([...warm.keys(), ...cold.keys()]);
const divergences = [];
for (const key of [...allKeys].sort()) {
  const w = warm.get(key) ?? 0;
  const c = cold.get(key) ?? 0;
  if (w !== c) divergences.push({ key, warm: w, cold: c });
}

const warmTotal = [...warm.values()].reduce((a, b) => a + b, 0);
const coldTotal = [...cold.values()].reduce((a, b) => a + b, 0);

console.log('');
console.log(`  warm total: ${warmTotal}  cold total: ${coldTotal}  (${allKeys.size} distinct analyzer::rule)`);
console.log('');
if (divergences.length === 0) {
  console.log('PASS — every rule identical warm vs cold.');
  process.exit(0);
} else {
  console.log('FAIL — per-rule divergence (warm → cold):');
  for (const d of divergences) {
    console.log(`  ${d.key.padEnd(48)} ${d.warm} → ${d.cold}  (Δ ${d.cold - d.warm})`);
  }
  process.exit(1);
}
