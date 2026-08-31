/**
 * Integration test for the sql-subquery-alias fixture.
 *
 * PARSER REGRESSION GUARD: subquery aliases (e.g., "stats" in
 * `FROM (SELECT ...) AS stats`) must NOT be mistaken for real table
 * names, and tables inside subqueries must be correctly extracted.
 *
 * Baseline established 2026-08-09 from cold run:
 *   rm -rf node_modules/.cache/code-auditor && node dist/cli.js audit --path <fixture> -f json -o <out>
 *
 * Expected violations (unknown-table):
 *   - users: table referenced in outer FROM clause
 *   - orders: table referenced inside subquery
 *
 * Must NOT appear:
 *   - stats: subquery alias (FROM (...) AS stats), not a real table
 *   - u: table alias (FROM users u)
 *   - cnt: column alias (COUNT(*) AS cnt), length 3 near-miss guard check
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runCli } from '../cli-integration.spec';

describe('sql-subquery-alias fixture', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-subq-'));
    const fixtureDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'sql-subquery-alias');
    execSync(`cp -r "${fixtureDir}/." "${testDir}/"`, { encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('detects real tables (users, orders) referenced inside and outside subquery', () => {
    const runResult = runCli(
      `audit --path "${testDir}" -f json -o "${testDir}"`,
      testDir
    );
    expect(runResult.exitCode).toBe(0);

    const reportPath = join(testDir, 'audit-report.json');
    const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
    const report = JSON.parse(reportRaw);

    const schemaResult = report?.analyzerResults?.schema;
    expect(schemaResult, 'schema analyzer must have results').toBeDefined();

    const violations = schemaResult.violations ?? [];
    expect(violations.length).toBe(2);

    const tableNames = violations.map((v: any) => v.symbol);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('orders');
  });

  it('subquery alias "stats" is NOT in any violation', () => {
    const runResult = runCli(
      `audit --path "${testDir}" -f json -o "${testDir}"`,
      testDir
    );
    expect(runResult.exitCode).toBe(0);

    const reportPath = join(testDir, 'audit-report.json');
    const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
    const report = JSON.parse(reportRaw);

    const violations = report?.analyzerResults?.schema?.violations ?? [];
    const tableNames = violations.map((v: any) => v.symbol?.toLowerCase());
    expect(tableNames).not.toContain('stats');
  });

  it('table alias "u" is NOT in any violation', () => {
    const runResult = runCli(
      `audit --path "${testDir}" -f json -o "${testDir}"`,
      testDir
    );
    expect(runResult.exitCode).toBe(0);

    const reportPath = join(testDir, 'audit-report.json');
    const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
    const report = JSON.parse(reportRaw);

    const violations = report?.analyzerResults?.schema?.violations ?? [];
    const tableNames = violations.map((v: any) => v.symbol?.toLowerCase());
    expect(tableNames).not.toContain('u');
  });

  it('column alias "cnt" is NOT in any violation (3-char near-miss guard)', () => {
    const runResult = runCli(
      `audit --path "${testDir}" -f json -o "${testDir}"`,
      testDir
    );
    expect(runResult.exitCode).toBe(0);

    const reportPath = join(testDir, 'audit-report.json');
    const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
    const report = JSON.parse(reportRaw);

    const violations = report?.analyzerResults?.schema?.violations ?? [];
    const tableNames = violations.map((v: any) => v.symbol?.toLowerCase());
    expect(tableNames).not.toContain('cnt');
  });
});
