/**
 * Integration test for the sql-fp-guards fixture.
 *
 * Each guard mechanism in the SQL injection analyzer gets a dedicated source file.
 * The test asserts exact `sql-injection-risk` counts per file to catch regressions
 * if a guard is accidentally weakened.
 *
 * Assertion asymmetry (per plan):
 *   - Safe patterns: `toBe(0)` — guard is working, must stay zero
 *   - True positive: `toBe(1)` — must not lose detection
 *   - Acknowledged FPs: `toBeLessThanOrEqual(0)` — improvement passes, regression fails
 *
 * Baseline established 2026-08-09 from cold run:
 *   rm -rf .code-index && node dist/cli.js audit --path <fixture> -f json -o <out>
 *
 * Total sql-injection-risk: 1 (real-injection.ts only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runCli } from '../cli-integration.spec';

describe('sql-fp-guards fixture', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-sql-'));
    const fixtureDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'sql-fp-guards');
    execSync(`cp -r "${fixtureDir}/." "${testDir}/"`, { encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function getSqlInjectionCounts(report: any): Map<string, number> {
    const daResult = report?.analyzerResults?.['data-access'];
    const violations: any[] = daResult?.violations ?? [];
    const sqlViolations = violations.filter((v: any) => v.rule === 'sql-injection-risk');

    const counts = new Map<string, number>();
    for (const v of sqlViolations) {
      const file = v.file.replace(/^.*\/src\//, 'src/');
      counts.set(file, (counts.get(file) || 0) + 1);
    }
    return counts;
  }

  it('produces exactly 1 sql-injection-risk violation total (cold audit)', () => {
    const runResult = runCli(
      `audit --path "${testDir}" -f json -o "${testDir}"`,
      testDir
    );
    expect(runResult.exitCode).toBe(0);

    const reportPath = join(testDir, 'audit-report.json');
    const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
    const report = JSON.parse(reportRaw);

    const counts = getSqlInjectionCounts(report);
    const total = [...counts.values()].reduce((sum, c) => sum + c, 0);
    expect(total).toBe(1);
  });

  describe('safe patterns — guard is working', () => {
    let counts: Map<string, number>;

    beforeEach(() => {
      const runResult = runCli(
        `audit --path "${testDir}" -f json -o "${testDir}"`,
        testDir
      );
      expect(runResult.exitCode).toBe(0);
      const reportPath = join(testDir, 'audit-report.json');
      const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
      const report = JSON.parse(reportRaw);
      counts = getSqlInjectionCounts(report);
    });

    // ── prepare-bind chain guards ──────────────────────────────────────

    it('prepare-bind-direct.ts: isInPrepareBindChain guard (direct chain)', () => {
      // db.prepare(sql).bind(val).all() — direct chain on one statement
      expect(counts.get('src/prepare-bind-direct.ts') || 0).toBe(0);
    });

    it('prepare-bind-twostmt.ts: isPrepareAssignedToVariable guard (two-statement)', () => {
      // const stmt = db.prepare(sql); stmt.bind(val).all() — two statements
      expect(counts.get('src/prepare-bind-twostmt.ts') || 0).toBe(0);
    });

    // ── sanitizer guard ────────────────────────────────────────────────

    it('escapeSql-sanitizer.ts: sanitizerNames guard (escapeSql wrapping)', () => {
      // escapeSql(x) in template literal — sanitizerNames excludes it
      expect(counts.get('src/escapeSql-sanitizer.ts') || 0).toBe(0);
    });

    // ── wrapper bind-params guard ──────────────────────────────────────

    it('wrapper-bind-params.ts: isWrapperFunctionWithBindParams guard (d1Query with 2+ args)', () => {
      // d1Query(sql, param1, param2) — wrapper with bind params
      expect(counts.get('src/wrapper-bind-params.ts') || 0).toBe(0);
    });

    // ── resolveLocalConstant for-of guard ──────────────────────────────

    it('for-of-resolved.ts: resolveLocalConstant for-of fix', () => {
      // for (const table of TABLES) — loop variable resolved as constant
      expect(counts.get('src/for-of-resolved.ts') || 0).toBe(0);
    });
  });

  describe('true positive — must detect real injection', () => {
    it('real-injection.ts: unsanitized user input in SQL template', () => {
      const runResult = runCli(
        `audit --path "${testDir}" -f json -o "${testDir}"`,
        testDir
      );
      expect(runResult.exitCode).toBe(0);

      const reportPath = join(testDir, 'audit-report.json');
      const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
      const report = JSON.parse(reportRaw);
      const counts = getSqlInjectionCounts(report);

      // Exactly 1 sql-injection-risk from real-injection.ts — must not lose detection
      expect(counts.get('src/real-injection.ts')).toBe(1);
    });
  });

  describe('acknowledged false positives — allow improvement, prevent regression', () => {
    // Each acknowledged FP currently produces 0 sql-injection-risk violations.
    // As the analyzer improves, these may drop further (impossible from 0).
    // If a guard regression causes a false spike, toBeLessThanOrEqual catches it.

    let counts: Map<string, number>;

    beforeEach(() => {
      const runResult = runCli(
        `audit --path "${testDir}" -f json -o "${testDir}"`,
        testDir
      );
      expect(runResult.exitCode).toBe(0);
      const reportPath = join(testDir, 'audit-report.json');
      const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
      const report = JSON.parse(reportRaw);
      counts = getSqlInjectionCounts(report);
    });

    // @see docs/sql-injection-fp-defect.md mechanism #1
    it('string-concat.ts: mechanism #1 — string concatenation via +', () => {
      expect(counts.get('src/string-concat.ts') || 0).toBeLessThanOrEqual(0);
    });

    // @see docs/sql-injection-fp-defect.md mechanism #2
    it('cli-input-escape.ts: mechanism #2 — .replace() SQL escaping', () => {
      expect(counts.get('src/cli-input-escape.ts') || 0).toBeLessThanOrEqual(0);
    });

    // @see docs/sql-injection-fp-defect.md mechanism #3
    it('conditional-literal.ts: mechanism #3 — ternary of static string constants', () => {
      expect(counts.get('src/conditional-literal.ts') || 0).toBeLessThanOrEqual(0);
    });

    // @see docs/sql-injection-fp-defect.md mechanism #5
    it('fn-param-template.ts: mechanism #5 — function parameter in SQL template', () => {
      expect(counts.get('src/fn-param-template.ts') || 0).toBeLessThanOrEqual(0);
    });

    // @see docs/sql-injection-fp-defect.md mechanism #6
    it('static-array-method.ts: mechanism #6 — static array .map().join() in template', () => {
      expect(counts.get('src/static-array-method.ts') || 0).toBeLessThanOrEqual(0);
    });
  });
});
