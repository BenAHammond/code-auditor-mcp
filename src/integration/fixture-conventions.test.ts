/**
 * Integration test for the conventions fixture.
 *
 * Tests export-shape and naming conventions. The conventions analyzer is
 * a Stage 3 pipeline reducer — it requires an index sync and convention
 * mining to run. A cold audit with `enabledAnalyzers: ["conventions"]`
 * triggers the full pipeline (discovery → index → mine → detect).
 *
 * Fixture directories:
 *   src/named-majority/ — 20 named + 1 default export (named convention)
 *   src/all-named/      — 20 named exports (no convention violations)
 *
 * Baseline established 2026-08-09 from cold run:
 *   rm -rf node_modules/.cache/code-auditor && node dist/cli.js audit --path <fixture> -f json -o <out>
 *
 * Total conventions violations: 2
 *   - conventions/export-shape: 1 (outlier.tsx:8, default export in named-majority dir)
 *   - conventions/naming:       1 (outlier.tsx:8, PascalCase in camelCase dir)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runCli } from '../cli-integration.spec';

describe('conventions fixture', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-conv-'));
    const fixtureDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'conventions');
    execSync(`cp -r "${fixtureDir}/." "${testDir}/"`, { encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Run audit and return conventions violations normalized to relative paths.
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
    const violations = report?.analyzerResults?.conventions?.violations ?? [];
    // Normalize absolute paths to be relative to testDir
    return violations.map((v: any) => ({
      ...v,
      file: v.file.replace(testDir + '/', ''),
    }));
  }

  it('total conventions violations match baseline', () => {
    const violations = runAndGetViolations(testDir);
    expect(violations.length).toBe(2);
  });

  describe('export-shape convention', () => {
    it('true positive: default export in named-majority directory triggers conventions/export-shape', () => {
      const violations = runAndGetViolations(testDir);
      const exportShape = violations.filter(
        (v: any) => v.rule === 'conventions/export-shape',
      );
      expect(exportShape.length).toBe(1);
      expect(exportShape[0].file).toBe('src/named-majority/outlier.tsx');
      expect(exportShape[0].line).toBe(8);
      expect(exportShape[0].severity).toBe('suggestion');
      expect(exportShape[0].functionName).toBe('OutlierComponent');
    });

    it('near-miss negative: all-named directory has no export-shape violations', () => {
      const violations = runAndGetViolations(testDir);
      const exportShape = violations.filter(
        (v: any) =>
          v.rule === 'conventions/export-shape' &&
          v.file.includes('all-named'),
      );
      expect(exportShape.length).toBe(0);
    });
  });

  describe('naming convention', () => {
    it('true positive: PascalCase function in camelCase directory triggers conventions/naming', () => {
      const violations = runAndGetViolations(testDir);
      const naming = violations.filter(
        (v: any) => v.rule === 'conventions/naming',
      );
      expect(naming.length).toBe(1);
      expect(naming[0].file).toBe('src/named-majority/outlier.tsx');
      expect(naming[0].line).toBe(8);
      expect(naming[0].severity).toBe('suggestion');
      expect(naming[0].functionName).toBe('OutlierComponent');
    });

    it('near-miss negative: all-named directory has no naming violations', () => {
      const violations = runAndGetViolations(testDir);
      const naming = violations.filter(
        (v: any) =>
          v.rule === 'conventions/naming' &&
          v.file.includes('all-named'),
      );
      expect(naming.length).toBe(0);
    });
  });

  describe('violations are suggestion severity', () => {
    it('all conventions violations are suggestions', () => {
      const violations = runAndGetViolations(testDir);
      for (const v of violations) {
        expect(v.severity).toBe('suggestion');
      }
    });
  });
});
