/**
 * Integration test for the cross-domain fixture.
 *
 * Tests the cross-domain analyzer's schema-lifecycle detectors:
 *   - written-never-read: tables written but never SELECTed
 *   - transaction-boundary: functions writing to ≥ txnTableMax tables
 *
 * The cross-domain analyzer is a Stage 4 derived reducer — it requires the
 * schema analyzer to populate schema_usage during Stage 2. A cold audit
 * with `enabledAnalyzers: ["cross-domain", "schema"]` triggers the full
 * pipeline (discovery → schema visitors → cross-domain reducer).
 *
 * The config sets txnTableMax: 2 so any function writing to 2+ distinct
 * tables triggers transaction-boundary (default is 4).
 *
 * Fixture structure:
 *   src/db.ts          — shared mock DB (db.exec, db.prepare().bind().run()/get())
 *   src/transfer.ts    — writes to users + audit_log (TP: transaction-boundary)
 *   src/events.ts      — writes to + reads from events (TN: no violations)
 *   src/audit-log.ts   — INSERT into audit_log (TP: written-never-read)
 *   src/query-users.ts — SELECT from users (establishes read, prevents WNR on users)
 *
 * Baseline established 2026-08-09 from cold run:
 *   rm -rf node_modules/.cache/code-auditor && node dist/cli.js audit --path <fixture> -f json -o <out>
 *
 * Total cross-domain violations: 2
 *   - cross-domain/written-never-read: 1 (audit_log table)
 *   - cross-domain/multi-table-write: 1 (transferCredits writes to 2 tables)
 *
 * Disabled: read-never-written (via enableReadNeverWritten: false) to keep
 * the fixture focused on the two primary detectors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runCli } from '../cli-integration.spec';

describe('cross-domain fixture', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-xdomain-'));
    const fixtureDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'cross-domain');
    execSync(`cp -r "${fixtureDir}/." "${testDir}/"`, { encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Run audit and return cross-domain violations normalized to relative paths.
   */
  function runAndGetViolations(testDir: string): any[] {
    const runResult = runCli(
      `audit --path "${testDir}" -f json -o "${testDir}"`,
      testDir,
    );
    expect(runResult.exitCode).toBe(0);
    const reportPath = join(testDir, 'audit-report.json');
    const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
    const report = JSON.parse(reportRaw);
    const violations = report?.analyzerResults?.['cross-domain']?.violations ?? [];
    // Normalize absolute paths to be relative to testDir
    return violations.map((v: any) => ({
      ...v,
      file: v.file.replace(testDir + '/', ''),
    }));
  }

  it('total cross-domain violations match baseline', () => {
    const violations = runAndGetViolations(testDir);
    expect(violations.length).toBe(2);
  });

  describe('written-never-read', () => {
    it('true positive: INSERT-only audit_log table triggers written-never-read', () => {
      const violations = runAndGetViolations(testDir);
      const wnr = violations.filter(
        (v: any) => v.rule === 'cross-domain/written-never-read',
      );
      expect(wnr.length).toBe(1);
      expect(wnr[0].file).toBe('src/audit-log.ts');
      expect(wnr[0].severity).toBe('suggestion');
      expect(wnr[0].message).toContain("Table 'audit_log' is written");
      expect(wnr[0].message).toContain('never read (SELECT)');
      // Should reference the audit_log table, not any other table
      expect(wnr[0].message).toContain('audit_log');
    });

    it('near-miss negative: events table has both write and read — no written-never-read', () => {
      const violations = runAndGetViolations(testDir);
      const wnr = violations.filter(
        (v: any) =>
          v.rule === 'cross-domain/written-never-read' &&
          v.message.includes("Table 'events'"),
      );
      expect(wnr.length).toBe(0);
    });

    it('near-miss negative: users table has both write and read — no written-never-read', () => {
      const violations = runAndGetViolations(testDir);
      const wnr = violations.filter(
        (v: any) =>
          v.rule === 'cross-domain/written-never-read' &&
          v.message.includes("Table 'users'"),
      );
      expect(wnr.length).toBe(0);
    });
  });

  describe('transaction-boundary', () => {
    it('true positive: transferCredits writes to 2 tables triggers transaction-boundary', () => {
      const violations = runAndGetViolations(testDir);
      const txn = violations.filter(
        (v: any) => v.rule === 'cross-domain/multi-table-write',
      );
      expect(txn.length).toBe(1);
      expect(txn[0].file).toBe('src/transfer.ts');
      expect(txn[0].severity).toBe('suggestion');
      expect(txn[0].message).toContain('writes to 2 distinct tables');
      expect(txn[0].message).toContain('transaction-boundary risk');
      // Should mention both tables
      expect(txn[0].message).toContain('audit_log');
      expect(txn[0].message).toContain('users');
    });

    it('near-miss negative: logEvent writes to only 1 table — no transaction-boundary', () => {
      const violations = runAndGetViolations(testDir);
      const txn = violations.filter(
        (v: any) =>
          v.rule === 'cross-domain/multi-table-write' &&
          v.file === 'src/events.ts',
      );
      expect(txn.length).toBe(0);
    });
  });

  describe('audit_log INSERT-write assertion', () => {
    it('schema_usage registers INSERT into audit_log from prepare-bind pattern', () => {
      // This test validates that the schema analyzer's table extraction (used
      // by cross-domain, different from data-access tablePatterns) properly
      // registers writes from db.prepare().bind().run() patterns. The
      // written-never-read violation above is the proof — if schema_usage
      // didn't register the INSERT, this detector wouldn't fire.
      const violations = runAndGetViolations(testDir);
      const wnr = violations.filter(
        (v: any) => v.rule === 'cross-domain/written-never-read',
      );
      expect(wnr.length).toBe(1);
      // The violation anchors to the audit-log.ts file, confirming the
      // schema analyzer's extractTables picks up INSERT from prepare-bind chains
      expect(wnr[0].file).toBe('src/audit-log.ts');
    });
  });

  describe('violations are suggestion severity', () => {
    it('all cross-domain violations are suggestions', () => {
      const violations = runAndGetViolations(testDir);
      expect(violations.length).toBeGreaterThan(0);
      for (const v of violations) {
        expect(v.severity).toBe('suggestion');
      }
    });
  });
});
