/**
 * Uncomputable-diff guard — a bare `changed` scope against an index with no
 * baseline (an empty `functions` table) must report "cannot determine what
 * changed", never a false clean. `detectModifiedFiles` returns `[]` both when
 * nothing changed AND when there is no baseline; only the former is clean. The
 * runner threads the `undefined` (no baseline) into a `no-baseline` diagnostic
 * so the run's zero findings can never be read as "nothing changed".
 *
 * Both cases:
 *   (a) `changed` against an empty index does NOT report clean — it emits a
 *       `no-baseline` diagnostic naming the cause (never indexed, or a prior
 *       index was discarded).
 *   (b) `changed` against a populated index with no modifications STILL reports
 *       clean — zero findings and no `no-baseline` diagnostic.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAudit } from '../auditRunner.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { initializeLanguages, initParsers } from '../languages/index.js';

const scratchDirs: string[] = [];
const prevDataDir = process.env.CODE_AUDITOR_DATA_DIR;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

afterEach(async () => {
  CodeIndexDB.resetInstance();
  process.env.CODE_AUDITOR_DATA_DIR = prevDataDir;
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setupProject(): Promise<{ dir: string; file: string; dataDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ca-no-baseline-'));
  scratchDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  const file = join(dir, 'src', 'a.ts');
  await writeFile(file, 'export function greet(name: string): string { return `Hello, ${name}!`; }\n', 'utf-8');

  const dataDir = await mkdtemp(join(tmpdir(), 'ca-no-baseline-data-'));
  scratchDirs.push(dataDir);
  process.env.CODE_AUDITOR_DATA_DIR = dataDir;

  return { dir, file, dataDir };
}

describe('changed scope with no baseline is uncomputable, not clean', () => {
  it('(a) reports a no-baseline diagnostic against an empty index', async () => {
    const { dir } = await setupProject();

    // No index built yet → the `functions` table is empty → no baseline.
    CodeIndexDB.resetInstance();
    const result = await runAudit({
      projectRoot: dir,
      scope: 'changed',
      writeToLedger: false,
    });

    const diagnostics = result.metadata?.diagnostics ?? [];
    const noBaseline = diagnostics.find(
      (d) => d.kind === 'no-baseline' && d.analyzerName === 'code-index',
    );
    expect(noBaseline).toBeTruthy();
    expect(noBaseline!.message).toMatch(/cannot determine what changed/i);

    // The finding count is zero (nothing was diffed) — the diagnostic is what
    // prevents that zero from reading as "clean".
    expect(result.summary.totalViolations).toBe(0);
  });

  it('(b) still reports clean against a populated index with no modifications', async () => {
    const { dir, file } = await setupProject();

    // Build a baseline by indexing the file, then hand control to the runner.
    CodeIndexDB.resetInstance();
    const idx = CodeIndexDB.getInstance(undefined, dir);
    await idx.initialize();
    await idx.detectChangedFunctions([file]);
    await idx.close();

    CodeIndexDB.resetInstance();
    const result = await runAudit({
      projectRoot: dir,
      scope: 'changed',
      writeToLedger: false,
    });

    const diagnostics = result.metadata?.diagnostics ?? [];
    expect(diagnostics.find((d) => d.kind === 'no-baseline')).toBeUndefined();
    expect(result.summary.totalViolations).toBe(0);
  });
});
