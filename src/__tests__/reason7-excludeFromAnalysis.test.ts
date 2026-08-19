/**
 * Spec 44 R1 reason 7 — `path profile excluded`.
 *
 * `excludeFromAnalysis` is the analysis-time sibling of `excludeFromGate`.
 * No built-in profile sets it (Spec 36 R4's scripts-and-tests only marks
 * violations gate-excluded), so reason 7 has no live site on the four corpora —
 * it ships "written but never run" unless this fixture exercises it. This test
 * is the sole live exercise of the branch: a user path profile opts a matching
 * file out of analysis entirely, and the file is recorded `path profile
 * excluded` rather than analyzed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAudit } from '../auditRunner.js';

const EXPORTED_FN_SRC = `
export function undocumentedFn(items: number[]): number {
  let total = 0;
  for (const item of items) {
    total += item * 1.1;
  }
  return total;
}
`;

describe('reason 7 — excludeFromAnalysis path profile', () => {
  let testDir: string;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'ca-reason7-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('drops a matching file as `path profile excluded` and runs no visitors', async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await writeFile(path.join(testDir, 'src', 'module.ts'), EXPORTED_FN_SRC, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      severityOverrides: { 'function-documentation': 'critical' as const },
      pathProfiles: [
        { name: 'opt-out', paths: ['src/**'], overrides: { excludeFromAnalysis: true } },
      ],
      showProgress: false,
    });

    const accounting = result.metadata?.fileAccounting;
    expect(accounting, 'fileAccounting metadata missing').toBeDefined();

    // The file is dropped, not analyzed.
    expect(accounting!.touched).toBe(1);
    expect(accounting!.analyzed).toBe(0);
    expect(accounting!.dropped).toBe(1);
    expect(accounting!.analyzed + accounting!.dropped).toBe(accounting!.touched);

    const reason7 = accounting!.reasons['path profile excluded'];
    expect(reason7, 'no `path profile excluded` reason recorded').toBeDefined();
    expect(reason7!.count).toBe(1);
    expect(reason7!.files).toHaveLength(1);
    expect(reason7!.files[0].profile).toBe('opt-out');
    expect(reason7!.files[0].filePath).toContain('src/module.ts');

    // No visitors ran, so the file produces zero violations.
    const allViolations = Object.values(result.analyzerResults)
      .flatMap((r: any) => r.violations || []);
    expect(allViolations).toHaveLength(0);
  });

  it('does not drop files when no profile opts out (control)', async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await writeFile(path.join(testDir, 'src', 'module.ts'), EXPORTED_FN_SRC, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      severityOverrides: { 'function-documentation': 'critical' as const },
      showProgress: false,
    });

    const accounting = result.metadata?.fileAccounting;
    expect(accounting).toBeDefined();
    expect(accounting!.analyzed).toBe(1);
    expect(accounting!.dropped).toBe(0);
    expect(accounting!.reasons['path profile excluded']).toBeUndefined();
  });
});
