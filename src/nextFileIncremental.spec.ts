import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  diffFiles,
  assertNoStaleFiles,
  mergeFindings,
  splitFindings,
  summarizeViolations,
} from './nextFileIncremental.js';
import type { FileRecord } from './nextFileIncremental.js';
import type { Violation } from './types.js';

function rec(hash: string, mtimeMs = 1000): FileRecord {
  return { hash, mtimeMs };
}

function v(partial: Partial<Violation> & { file: string; severity: Violation['severity'] }): Violation {
  return { rule: 'test', message: 'm', analyzer: 'test', line: 1, ...partial } as Violation;
}

describe('diffFiles', () => {
  it('classifies added, changed, and deleted files', () => {
    const diff = diffFiles(
      { 'a.ts': rec('A'), 'b.ts': rec('B'), 'gone.ts': rec('G') },
      { 'a.ts': rec('A'), 'b.ts': rec('B2'), 'new.ts': rec('N') },
    );
    expect(diff.added).toEqual(['new.ts']);
    expect(diff.changed).toEqual(['b.ts']);
    expect(diff.deleted).toEqual(['gone.ts']);
  });

  it('returns empty lists when nothing changed', () => {
    const diff = diffFiles({ 'a.ts': rec('A') }, { 'a.ts': rec('A') });
    expect(diff).toEqual({ changed: [], added: [], deleted: [] });
  });
});

describe('assertNoStaleFiles', () => {
  it('flags a content change with a preserved mtime as staleness', () => {
    const stale = assertNoStaleFiles(
      { 'a.ts': rec('A', 1000) },
      { 'a.ts': rec('A2', 1000) },
      '/root',
    );
    expect(stale).toEqual([{ file: 'a.ts', reason: 'mtime-preserved-content-change' }]);
  });

  it('does not flag a normal content change whose mtime advanced', () => {
    const stale = assertNoStaleFiles(
      { 'a.ts': rec('A', 1000) },
      { 'a.ts': rec('A2', 2000) },
      '/root',
    );
    expect(stale).toEqual([]);
  });

  it('does not flag a legitimately deleted file (gone from disk)', () => {
    const stale = assertNoStaleFiles(
      { 'a.ts': rec('A', 1000) },
      {},
      '/definitely/not/on/disk',
    );
    expect(stale).toEqual([]);
  });

  it('flags a file that left the set but still exists on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nextfile-stale-'));
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'x');
    try {
      const stale = assertNoStaleFiles({ 'a.ts': rec('A', 1000) }, {}, dir);
      expect(stale).toEqual([{ file: 'a.ts', reason: 'missing-on-disk' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeFindings', () => {
  it('keeps unchanged files, overwrites changed, drops deleted', () => {
    const merged = mergeFindings({
      cachedVisitor: {
        'keep.ts': [v({ file: 'keep.ts', severity: 'severe' })],
        'fix.ts': [v({ file: 'fix.ts', severity: 'critical' })],
        'del.ts': [v({ file: 'del.ts', severity: 'severe' })],
      },
      freshVisitor: { 'fix.ts': [] }, // fixed → must become empty, not fall back
      cachedCorpus: [],
      freshCorpus: [v({ file: 'any.ts', severity: 'severe', analyzer: 'styles' })],
      freshSchema: [v({ file: 'q.ts', severity: 'high', analyzer: 'schema' })],
      changed: ['fix.ts'],
      added: [],
      deleted: ['del.ts'],
    });
    expect(Object.keys(merged.visitorFindings).sort()).toEqual(['fix.ts', 'keep.ts']);
    expect(merged.visitorFindings['fix.ts']).toEqual([]);
    expect(merged.visitorFindings['keep.ts']).toHaveLength(1);
    expect(merged.corpusFindings).toHaveLength(1);
    expect(merged.schemaFindings).toHaveLength(1);
    expect(merged.all).toHaveLength(3);
  });

  it('adds fresh findings for added files', () => {
    const merged = mergeFindings({
      cachedVisitor: {},
      freshVisitor: { 'new.ts': [v({ file: 'new.ts', severity: 'severe' })] },
      cachedCorpus: [],
      freshCorpus: [],
      freshSchema: [],
      changed: [],
      added: ['new.ts'],
      deleted: [],
    });
    expect(merged.visitorFindings['new.ts']).toHaveLength(1);
  });

  it('preserves full-corpus-only findings that a scoped run cannot recompute', () => {
    // On a warm re-audit the dependency-graph / api-contract / schema-validator
    // reducers short-circuit (isScoped) and emit nothing, so `freshCorpus` lacks
    // them. Their cached findings must survive, or every warm call silently drops
    // unreferenced-module / circular-dependency / api-contract violations.
    const cachedDependencyGraph = v({ file: 'a.ts', severity: 'severe', analyzer: 'dependency-graph' });
    const cachedApiContract = v({ file: 'x.ts', severity: 'severe', analyzer: 'api-contract' });
    const cachedCrossDomain = v({ file: 'c.ts', severity: 'high', analyzer: 'cross-domain' });
    const merged = mergeFindings({
      cachedVisitor: {},
      freshVisitor: {},
      cachedCorpus: [cachedDependencyGraph, cachedApiContract, cachedCrossDomain],
      // A scoped run recomputes DB-backed corpus (styles/conventions/cross-domain)
      // but returns nothing for full-corpus-only reducers.
      freshCorpus: [v({ file: 'd.ts', severity: 'severe', analyzer: 'styles' })],
      freshSchema: [],
      changed: ['a.ts'],
      added: [],
      deleted: [],
    });
    expect(merged.corpusFindings.map((x) => x.analyzer).sort()).toEqual(
      ['dependency-graph', 'api-contract', 'styles'].sort(),
    );
    // The full-corpus-only cached findings are preserved; the DB-backed cross-domain
    // finding is *replaced* by the scoped run's fresh output (it did not re-emit).
    expect(merged.corpusFindings).toContain(cachedDependencyGraph);
    expect(merged.corpusFindings).toContain(cachedApiContract);
    expect(merged.corpusFindings).not.toContain(cachedCrossDomain);
  });
});

describe('splitFindings', () => {
  it('buckets file-local, corpus-DB, and schema findings', () => {
    const split = splitFindings(
      {
        solid: { violations: [v({ file: '/r/a.ts', severity: 'severe', analyzer: 'solid' })] },
        invariants: { violations: [v({ file: '/r/b.ts', severity: 'critical', analyzer: 'invariants' })] },
        styles: { violations: [v({ file: '/r/c.ts', severity: 'severe', analyzer: 'styles' })] },
        schema: { violations: [v({ file: '/r/q.ts', severity: 'high', analyzer: 'schema' })] },
      },
      '/r',
    );
    expect(Object.keys(split.visitorFindings).sort()).toEqual(['a.ts', 'b.ts']);
    expect(split.corpusFindings.map((x) => x.analyzer)).toEqual(['styles']);
    expect(split.schemaFindings.map((x) => x.analyzer)).toEqual(['schema']);
  });

  it('treats unknown analyzers as corpus-DB (never cache unproven-local)', () => {
    const split = splitFindings(
      { mystery: { violations: [v({ file: '/r/x.ts', severity: 'severe', analyzer: 'mystery' })] } },
      '/r',
    );
    expect(split.corpusFindings).toHaveLength(1);
    expect(Object.keys(split.visitorFindings)).toEqual([]);
    expect(split.schemaFindings).toEqual([]);
  });
});

describe('summarizeViolations', () => {
  it('counts severities and buckets categories', () => {
    const s = summarizeViolations([
      v({ file: 'a.ts', severity: 'critical', analyzer: 'solid' }),
      v({ file: 'b.ts', severity: 'severe', analyzer: 'solid' }),
      v({ file: 'c.ts', severity: 'high', analyzer: 'docs' }),
    ]);
    expect(s.totalViolations).toBe(3);
    expect(s.criticalIssues).toBe(1);
    expect(s.severe).toBe(1);
    expect(s.high).toBe(1);
    expect(s.violationsByCategory['solid']).toBe(2);
    expect(s.topIssues[0]).toEqual({ type: 'solid', count: 2 });
  });
});
