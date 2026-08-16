/**
 * Spec 36 R2 — the edit-boundary gate compares against the file's prior state
 * (git HEAD), not a stored baseline. These tests exercise the pure diff-gate
 * primitives in isolation (hunk parsing + introduced-by-diff classification)
 * and `computeDiffGatingDecision`'s integration with the binary gate.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDiffHunkLines, isIntroducedByDiff, computeDiffGate, type DiffGate } from './diffGate.js';
import { computeDiffGatingDecision } from './gate.js';
import type { Violation } from '../types.js';

function v(partial: Partial<Violation> & { analyzer: string; rule: string }): Violation {
  return {
    file: 'src/a.ts',
    severity: 'critical',
    message: 'm',
    ...partial,
  } as Violation;
}

const GATING = { analyzer: 'solid', rule: 'solid/class-size' };
const RES = { action: 'extract-methods', summary: 'split it', symbols: ['Big'] };

describe('parseDiffHunkLines — Spec 36 R2', () => {
  it('extracts added-line ranges from unified=0 hunk headers', () => {
    const diff = [
      '+++ b/src/a.ts',
      '@@ -10,0 +11,3 @@',
      '+++ b/src/b.ts',
      '@@ -1 +2,2 @@',
    ].join('\n');
    const lines = parseDiffHunkLines(diff);
    expect([...lines.get('src/a.ts')!].sort()).toEqual([11, 12, 13]);
    expect([...lines.get('src/b.ts')!].sort()).toEqual([2, 3]);
  });

  it('treats a count-less hunk as a single line', () => {
    const lines = parseDiffHunkLines('+++ b/f.ts\n@@ -4 +5 @@\n');
    expect([...lines.get('f.ts')!]).toEqual([5]);
  });
});

describe('isIntroducedByDiff — Spec 36 R2', () => {
  const gate: DiffGate = {
    touchedLines: new Map([['src/a.ts', new Set([11, 12])]]),
    newFiles: new Set(['src/new.ts']),
    deletedFiles: new Set(['src/gone.ts']),
  };

  it('blocks a finding at a touched line', () => {
    expect(isIntroducedByDiff({ file: 'src/a.ts', line: 11 }, gate)).toBe(true);
  });

  it('does not block a finding at an untouched line of a tracked file', () => {
    expect(isIntroducedByDiff({ file: 'src/a.ts', line: 99 }, gate)).toBe(false);
  });

  it('blocks any finding in a new (untracked) file', () => {
    expect(isIntroducedByDiff({ file: 'src/new.ts', line: 3 }, gate)).toBe(true);
  });

  it('never blocks a finding in a deleted file', () => {
    expect(isIntroducedByDiff({ file: 'src/gone.ts', line: 1 }, gate)).toBe(false);
  });

  it('does not block when the file has no hunk', () => {
    expect(isIntroducedByDiff({ file: 'src/other.ts', line: 1 }, gate)).toBe(false);
  });
});

describe('computeDiffGatingDecision — Spec 36 R2 + R4/R6', () => {
  const gate: DiffGate = {
    touchedLines: new Map([['src/a.ts', new Set([11])]]),
    newFiles: new Set(['src/new.ts']),
    deletedFiles: new Set(),
  };

  it('blocks a gating finding the edit introduced, with a resolution', () => {
    const decision = computeDiffGatingDecision(
      [v({ ...GATING, line: 11, resolution: RES })],
      gate,
    );
    expect(decision.blocking).toHaveLength(1);
  });

  it('does not block a gating finding at an untouched line', () => {
    const decision = computeDiffGatingDecision(
      [v({ ...GATING, line: 99, resolution: RES })],
      gate,
    );
    expect(decision.blocking).toHaveLength(0);
  });

  it('blocks a finding anywhere in a new file', () => {
    const decision = computeDiffGatingDecision(
      [v({ ...GATING, file: 'src/new.ts', line: 1, resolution: RES })],
      gate,
    );
    expect(decision.blocking).toHaveLength(1);
  });

  it('records a resolution gap only for introduced gating findings', () => {
    const decision = computeDiffGatingDecision(
      [v({ ...GATING, line: 99 })],
      gate,
    );
    expect(decision.blocking).toHaveLength(0);
    expect(decision.resolutionGaps).toHaveLength(0);
  });
});

describe('computeDiffGate — real git worktree', () => {
  it('marks an untracked file new and a tracked+modified file touched', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'diffgate-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root });

    // Modify a tracked file: append two lines at 4-5.
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n');
    // Add a brand-new untracked file.
    writeFileSync(path.join(root, 'b.ts'), 'hello\n');

    const gate = computeDiffGate(root, [path.join(root, 'a.ts'), path.join(root, 'b.ts')]);
    expect(gate.newFiles.has(path.join(root, 'b.ts'))).toBe(true);
    expect(gate.touchedLines.get(path.join(root, 'a.ts'))).toContain(4);
    expect(gate.touchedLines.get(path.join(root, 'a.ts'))).toContain(5);
    expect(gate.touchedLines.get(path.join(root, 'a.ts'))).not.toContain(1);
  });
});
