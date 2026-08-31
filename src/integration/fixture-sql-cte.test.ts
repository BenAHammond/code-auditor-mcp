/**
 * Integration test for the sql-cte fixture.
 *
 * PARSER REGRESSION GUARD: CTE names (WITH RecentOrders AS) must NOT be
 * mistaken for real table names, and tables inside CTE bodies must be
 * correctly extracted.
 *
 * Baseline established 2026-08-09 from cold run:
 *   rm -rf node_modules/.cache/code-auditor && node dist/cli.js audit --path <fixture> -f json -o <out>
 *
 * Expected violations (unknown-table):
 *   - orders: table referenced inside CTE body (SELECT * FROM orders)
 *   - customers: table referenced in outer query JOIN
 *
 * Must NOT appear:
 *   - RecentOrders: CTE name, not a real table
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runCli } from '../cli-integration.spec';

describe('sql-cte fixture', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-cte-'));
    const fixtureDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'sql-cte');
    execSync(`cp -r "${fixtureDir}/." "${testDir}/"`, { encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('detects real tables (orders, customers) referenced inside and outside CTE', () => {
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

    // Extract the table names (symbol field) from violations
    const tableNames = violations.map((v: any) => v.symbol);
    expect(tableNames).toContain('orders');
    expect(tableNames).toContain('customers');
  });

  it('CTE name RecentOrders is NOT in any violation', () => {
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
    expect(tableNames).not.toContain('recentorders');
  });

  it('table alias "ro" is NOT in any violation', () => {
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
    expect(tableNames).not.toContain('ro');
  });
});
