/**
 * Measure which rules fire on files matched by the built-in `scripts-and-tests`
 * path profile, split into the test-file subset (rule-level excluded per
 * Spec 55 R3) and the script/fixture subset (still reported). This is the
 * enumeration half of "report every rule the removed path-profile severity
 * capping affected" — the capping used to soften these findings; `excludeFromGate`
 * now scopes them out of the blocking gate, and R3 additionally excludes the
 * query-shape rules from test files outright.
 *
 * Read-only: writes nothing into the target project (see
 * `measure-corpus-counts.ts` for the scratch-dir hygiene note).
 *
 * Usage:
 *   CODE_AUDITOR_DATA_DIR=/tmp/ca-profile-<name> \
 *     npx tsx scripts/measure-profile-findings.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../src/auditRouter.js';
import { BUILTIN_PATH_PROFILES } from '../src/config/defaults.js';
import { isTestOrSpecPath } from '../src/languages/testConventions.js';
import type { Violation } from '../src/types.js';
import picomatch from 'picomatch';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-profile-findings.ts <projectRoot>');
  process.exit(2);
}

async function main() {
  initializeLanguages();
  await initParsers();

  const result = await runAuditDispatch({ projectRoot } as any);
  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );
  const advisory = all.filter((v) => v.analyzer !== 'invariants');

  const profile = BUILTIN_PATH_PROFILES.find((p) => p.name === 'scripts-and-tests')!;
  const matchers = profile.paths.map((g) => picomatch(g));

  const matches = (file: string) => {
    const rel = path.relative(projectRoot, file);
    return matchers.some((m) => m(rel) || m(file.replace(/\\/g, '/')));
  };

  const inProfile = advisory.filter((v) => matches(v.file));
  const testFiles = inProfile.filter((v) => isTestOrSpecPath(v.file));
  const scriptFixtures = inProfile.filter((v) => !isTestOrSpecPath(v.file));

  const tally = (vs: Violation[]) => {
    const byRule = new Map<string, number>();
    for (const v of vs) {
      const rule = `${v.analyzer}::${(v as any).rule}`;
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    }
    return [...byRule.entries()].sort((a, b) => b[1] - a[1]);
  };

  console.log(`\n=== PROFILE-MATCHED FINDINGS: ${projectRoot} ===`);
  console.log(`advisory total: ${advisory.length}`);
  console.log(`scripts-and-tests profile matches: ${inProfile.length} findings`);
  console.log(`  test-file subset (R3 rule-level exclusion): ${testFiles.length}`);
  console.log(`  script/fixture subset (NOT excluded): ${scriptFixtures.length}`);
  console.log('\n--- test-file subset, per-rule ---');
  for (const [rule, count] of tally(testFiles)) console.log(`${count}\t${rule}`);
  console.log('\n--- script/fixture subset, per-rule ---');
  for (const [rule, count] of tally(scriptFixtures)) console.log(`${count}\t${rule}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
