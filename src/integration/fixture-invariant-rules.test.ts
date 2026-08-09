/**
 * Integration test for the invariant-rules fixture.
 *
 * Runs a cold audit against the fixture and asserts exact baseline counts.
 * The fixture has 5 rule kinds, but call-constraint and style-mechanism/no-raw-values
 * require indexed function data (not available on cold audit — needs index sync first).
 * Their assertions are recorded as TODO until the fixture adds index-sync support.
 *
 * Baseline established 2026-08-09 from cold run:
 *   rm -rf .code-index && node dist/cli.js audit --path <fixture> -f json -o <out>
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runCli } from '../cli-integration.spec';

describe('invariant-rules fixture', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-inv-'));
    const fixtureDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'invariant-rules');
    execSync(`cp -r "${fixtureDir}/." "${testDir}/"`, { encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('produces expected violations on cold audit', () => {
    const runResult = runCli(
      `audit --path "${testDir}" -f json -o "${testDir}"`,
      testDir
    );
    expect(runResult.exitCode).toBe(0);

    const reportPath = join(testDir, 'audit-report.json');
    const reportRaw = execSync(`cat "${reportPath}"`, { encoding: 'utf-8' });
    const report = JSON.parse(reportRaw);

    const invariants = report?.analyzerResults?.invariants;
    expect(invariants, 'invariants analyzer must have results').toBeDefined();

    const violations = invariants.violations;
    expect(Array.isArray(violations), 'violations must be an array').toBe(true);

    // Total: 6 violations (cold run baseline 2026-08-09)
    expect(violations.length).toBe(6);

    // ── Per-rule breakdown ──────────────────────────────────────────────

    // import-ban: 1 violation — debug-lib import in index.ts
    const importBanViolations = violations.filter((v: any) => v.rule === 'ban-debug-import');
    expect(importBanViolations.length, 'ban-debug-import count').toBe(1);
    expect(importBanViolations[0].file).toBe('src/index.ts');
    expect(importBanViolations[0].severity).toBe('critical');

    // module-boundary: 1 violation — src/ui/component.ts imports from src/services/api.ts
    const boundaryViolations = violations.filter((v: any) => v.rule === 'no-services-from-ui');
    expect(boundaryViolations.length, 'no-services-from-ui count').toBe(1);
    expect(boundaryViolations[0].file).toBe('src/ui/component.ts');
    expect(boundaryViolations[0].severity).toBe('warning');

    // naming: 4 violations — exports starting with lowercase
    // (notCapital, runApp, fetchData, helperFunc — all lowercase-starting exports)
    const namingViolations = violations.filter((v: any) => v.rule === 'capital-export-naming');
    expect(namingViolations.length, 'capital-export-naming count').toBe(4);
    const namingSymbols = namingViolations.map((v: any) => v.symbol).sort();
    expect(namingSymbols).toEqual(['fetchData', 'helperFunc', 'notCapital', 'runApp']);

    // call-constraint: 0 violations (requires index sync — function_calls table is empty on cold audit)
    const callViolations = violations.filter((v: any) => v.rule === 'api-call-constraint');
    expect(callViolations.length, 'api-call-constraint count — needs index sync').toBe(0);

    // style-mechanism: 0 violations (requires index sync)
    const styleMechViolations = violations.filter((v: any) => v.rule === 'style-mechanism-check');
    expect(styleMechViolations.length, 'style-mechanism-check count — needs index sync').toBe(0);

    // no-raw-values: 0 violations (requires index sync)
    const rawValuesViolations = violations.filter((v: any) => v.rule === 'no-raw-values-check');
    expect(rawValuesViolations.length, 'no-raw-values-check count — needs index sync').toBe(0);
  });
});
