/**
 * Spec 36 R5 — a threshold change requires a written rationale.
 *
 * The config-error path is exercised through the real `runAudit` entry point so
 * the guard is proven to fire where the CLI/programmatic API actually runs,
 * not only as an isolated unit.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAudit } from '../auditRunner.js';

const SRC = `export function documented(): string {
  // A small, documented function.
  return 'ok';
}
`;

describe('Spec 36 R5 — threshold rationale guard', () => {
  let testDir: string;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'ca-r5-'));
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await writeFile(path.join(testDir, 'src', 'mod.ts'), SRC, 'utf-8');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('rejects a threshold change without a rationale as a config error', async () => {
    await expect(
      runAudit({
        projectRoot: testDir,
        enabledAnalyzers: ['solid'],
        analyzerConfigs: { solid: { maxLinesPerMethod: 100 } },
        showProgress: false,
      }),
    ).rejects.toThrow(/rationale/i);
  });

  it('accepts a threshold change with a rationale and reports the delta', async () => {
    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['solid'],
      analyzerConfigs: { solid: { maxLinesPerMethod: 100 } },
      rationales: { 'solid.maxLinesPerMethod': 'Calibrated for the fixture corpus.' },
      showProgress: false,
    });

    expect(result.metadata.thresholdChanges).toEqual([
      { key: 'solid.maxLinesPerMethod', defaultValue: 50, effectiveValue: 100 },
    ]);
  });

  it('reads rationales from a committed .codeauditor.json', async () => {
    await writeFile(
      path.join(testDir, '.codeauditor.json'),
      JSON.stringify({
        analyzerConfigs: { solid: { maxLinesPerMethod: 100 } },
        rationales: { 'solid.maxLinesPerMethod': 'Committed calibration.' },
      }),
      'utf-8',
    );

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['solid'],
      showProgress: false,
    });

    expect(result.metadata.thresholdChanges).toEqual([
      { key: 'solid.maxLinesPerMethod', defaultValue: 50, effectiveValue: 100 },
    ]);
  });
});
