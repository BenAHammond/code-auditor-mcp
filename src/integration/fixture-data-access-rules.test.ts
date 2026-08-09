/**
 * Integration test for the data-access-rules fixture.
 *
 * Each data-access rule gets a dedicated file with a true-positive function
 * (must trigger the rule) and a near-miss negative function (must NOT trigger
 * the rule). The test asserts exact per-file, per-rule counts to catch both
 * false negatives (lost detection) and false positives (over-eager matching).
 *
 * Baseline established 2026-08-09 from cold run:
 *   rm -rf .code-index && node dist/cli.js audit --path <fixture> -f json -o <out>
 *
 * Total violations: 12
 *   - complex-query: 1 (line 12 in complex-query.ts)
 *   - loop-query: 1 (line 16 in loop-query.ts)
 *   - missing-org-filter: 5 (across unfiltered-query, missing-org-filter, loop-query, complex-query files)
 *   - unfiltered-query: 5 (across unfiltered-query, missing-org-filter, loop-query, complex-query files)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runCli } from '../cli-integration.spec';

describe('data-access-rules fixture', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-da-'));
    const fixtureDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'data-access-rules');
    execSync(`cp -r "${fixtureDir}/." "${testDir}/"`, { encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Run audit and return violations keyed by `src/<file>` for easy lookup.
   */
  function runAndGetViolations(testDir: string): any[] {
    const runResult = runCli(
      `audit --path "${testDir}" -f json -o "${testDir}"`,
      testDir
    );
    expect(runResult.exitCode).toBe(0);
    const reportPath = join(testDir, 'audit-report.json');
    const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
    const report = JSON.parse(reportRaw);
    return report?.analyzerResults?.['data-access']?.violations ?? [];
  }

  /**
   * Filter violations for a specific source file (short name, e.g. 'unfiltered-query.ts').
   */
  function fileViolations(violations: any[], fileName: string): any[] {
    return violations.filter((v: any) => v.file.endsWith(`/${fileName}`));
  }

  /**
   * Count violations matching a specific rule within a file.
   */
  function ruleCount(violations: any[], fileName: string, rule: string): number {
    return fileViolations(violations, fileName).filter((v: any) => v.rule === rule).length;
  }

  it('total violations match baseline', () => {
    const violations = runAndGetViolations(testDir);
    expect(violations.length).toBe(12);
  });

  // ══════════════════════════════════════════════════════════════════
  // unfiltered-query rule
  // ══════════════════════════════════════════════════════════════════

  describe('unfiltered-query rule', () => {
    it('true positive: raw SELECT * with no WHERE/LIMIT triggers unfiltered-query', () => {
      const violations = runAndGetViolations(testDir);
      expect(ruleCount(violations, 'unfiltered-query.ts', 'unfiltered-query')).toBe(1);
    });

    it('near-miss negative: SELECT with org_id WHERE filter does NOT trigger unfiltered-query', () => {
      const violations = runAndGetViolations(testDir);
      // The near-miss function at line 18 uses `WHERE org_id = ?` on 'tags' table.
      // This satisfies the org-filter check, avoiding unfiltered-query.
      // All 3 unfiltered-query violations in this file are on the true-positive function.
      const fileV = fileViolations(violations, 'unfiltered-query.ts');
      const ufViolations = fileV.filter((v: any) => v.rule === 'unfiltered-query');
      // Only 1 unfiltered-query violation — from true positive, not near-miss
      expect(ufViolations.length).toBe(1);
      expect(ufViolations[0].line).toBe(12);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // missing-org-filter rule
  // ══════════════════════════════════════════════════════════════════

  describe('missing-org-filter rule', () => {
    it('true positive: SELECT on projects without org_id triggers missing-org-filter', () => {
      const violations = runAndGetViolations(testDir);
      expect(ruleCount(violations, 'missing-org-filter.ts', 'missing-org-filter')).toBe(1);
    });

    it('near-miss negative: SELECT on projects WITH org_id filter does NOT trigger missing-org-filter', () => {
      const violations = runAndGetViolations(testDir);
      const fileV = fileViolations(violations, 'missing-org-filter.ts');
      const mofViolations = fileV.filter((v: any) => v.rule === 'missing-org-filter');
      // Only 1 missing-org-filter violation — from true positive (line 12), not near-miss (line 18)
      expect(mofViolations.length).toBe(1);
      expect(mofViolations[0].line).toBe(12);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // loop-query rule
  // ══════════════════════════════════════════════════════════════════

  describe('loop-query rule', () => {
    it('true positive: db.prepare() inside for loop triggers loop-query', () => {
      const violations = runAndGetViolations(testDir);
      expect(ruleCount(violations, 'loop-query.ts', 'loop-query')).toBe(1);
    });

    it('near-miss negative: db.prepare() in helper function called from loop does NOT trigger loop-query', () => {
      const violations = runAndGetViolations(testDir);
      // The near-miss function (fetchUser) contains db.prepare() but is defined
      // outside the loop syntactically. The loop is in the caller queryUsersWithFunction.
      // The analyzer walks the AST parent chain from db.prepare() → fetchUser body.
      // Since fetchUser is NOT inside a loop, loop-query does not fire.
      const fileV = fileViolations(violations, 'loop-query.ts');
      const loopViolations = fileV.filter((v: any) => v.rule === 'loop-query');
      expect(loopViolations.length).toBe(1);
      // The single loop-query is on the true-positive function (db.prepare in for loop body)
      expect(loopViolations[0].line).toBe(16);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // complex-query rule
  // ══════════════════════════════════════════════════════════════════

  describe('complex-query rule', () => {
    it('true positive: query with 9 tables via JOINs/subqueries triggers complex-query', () => {
      const violations = runAndGetViolations(testDir);
      expect(ruleCount(violations, 'complex-query.ts', 'complex-query')).toBe(1);
    });

    it('near-miss negative: simple COUNT(*) query does NOT trigger complex-query', () => {
      const violations = runAndGetViolations(testDir);
      const fileV = fileViolations(violations, 'complex-query.ts');
      const complexViolations = fileV.filter((v: any) => v.rule === 'complex-query');
      // Only 1 complex-query violation — from true positive (line 12), not near-miss (line 32)
      expect(complexViolations.length).toBe(1);
      expect(complexViolations[0].line).toBe(12);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // non-db-receiver guard — pool.length array regression guard
  // ══════════════════════════════════════════════════════════════════
  //
  // Regression guard: variable named 'pool' that is NOT a database
  // connection pool must NOT be flagged as a DB operation.
  // pool.length, pool.push(), and pool.length = 0 are array operations
  // on `const pool: number[] = [1, 2, 3]` — not DB calls.

  describe('non-db-receiver guard', () => {
    it('pool.length array property access is NOT flagged as a data-access violation', () => {
      const violations = runAndGetViolations(testDir);
      const poolViolations = fileViolations(violations, 'non-db-receiver.ts');
      expect(poolViolations.length).toBe(0);
    });

    it('pool.push() array method is NOT flagged as a data-access violation', () => {
      const violations = runAndGetViolations(testDir);
      const poolViolations = fileViolations(violations, 'non-db-receiver.ts');
      expect(poolViolations.length).toBe(0);
    });

    it('pool.length = 0 array truncation is NOT flagged as a data-access violation', () => {
      const violations = runAndGetViolations(testDir);
      const poolViolations = fileViolations(violations, 'non-db-receiver.ts');
      expect(poolViolations.length).toBe(0);
    });

    it('baseline total is unchanged by non-db-receiver.ts (12 violations)', () => {
      const violations = runAndGetViolations(testDir);
      expect(violations.length).toBe(12);
    });
  });
});
