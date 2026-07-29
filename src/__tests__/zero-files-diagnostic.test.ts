import { describe, it, expect } from 'vitest';
import { runZeroFilesDiagnostics } from '../auditRunner.js';
import type { AnalyzerResult, Violation } from '../types.js';

// Helper: construct a minimal AnalyzerResult
function makeResult(overrides: Partial<AnalyzerResult> = {}): AnalyzerResult {
  return {
    violations: [] as Violation[],
    filesProcessed: 42,
    executionTime: 0,
    ...overrides,
  };
}

describe('runZeroFilesDiagnostics', () => {
  it('returns empty when all enabled analyzers have results with filesProcessed > 0', () => {
    const warnings = runZeroFilesDiagnostics(
      ['solid', 'dry', 'react'],
      {
        solid: makeResult({ filesProcessed: 100 }),
        dry: makeResult({ filesProcessed: 50 }),
        react: makeResult({ filesProcessed: 200 }),
      }
    );
    expect(warnings).toHaveLength(0);
  });

  it('warns when an enabled analyzer has no result entry (kind: no-result)', () => {
    const warnings = runZeroFilesDiagnostics(
      ['solid', 'missing-analyzer', 'react'],
      {
        solid: makeResult({ filesProcessed: 100 }),
        react: makeResult({ filesProcessed: 200 }),
        // 'missing-analyzer' absent
      }
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      analyzerName: 'missing-analyzer',
      kind: 'no-result',
    });
    expect(warnings[0].message).toContain('enabled but produced no result');
  });

  it('warns when an analyzer has filesProcessed = 0 and no errors (kind: zero-files)', () => {
    const warnings = runZeroFilesDiagnostics(
      ['solid', 'empty-analyzer'],
      {
        solid: makeResult({ filesProcessed: 100 }),
        'empty-analyzer': makeResult({ filesProcessed: 0 }),
      }
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      analyzerName: 'empty-analyzer',
      kind: 'zero-files',
    });
    expect(warnings[0].message).toContain('filesProcessed = 0');
  });

  it('does NOT warn for filesProcessed = 0 when errors are present (legitimate failure)', () => {
    const warnings = runZeroFilesDiagnostics(
      ['errored-analyzer'],
      {
        'errored-analyzer': makeResult({
          filesProcessed: 0,
          errors: [{ file: 'some-file.ts', error: 'parse failure' }],
        }),
      }
    );

    expect(warnings).toHaveLength(0);
  });

  it('fires both warning kinds simultaneously', () => {
    // The user's explicit test case: an enabled analyzer with no result entry,
    // and a different enabled analyzer with zero files — both must warn.
    const warnings = runZeroFilesDiagnostics(
      ['solid', 'missing-analyzer', 'empty-analyzer'],
      {
        solid: makeResult({ filesProcessed: 100 }),
        'empty-analyzer': makeResult({ filesProcessed: 0 }),
      }
    );

    expect(warnings).toHaveLength(2);

    const noResult = warnings.find(w => w.kind === 'no-result');
    const zeroFiles = warnings.find(w => w.kind === 'zero-files');

    expect(noResult).toBeDefined();
    expect(noResult!.analyzerName).toBe('missing-analyzer');
    expect(noResult!.message).toContain('enabled but produced no result');

    expect(zeroFiles).toBeDefined();
    expect(zeroFiles!.analyzerName).toBe('empty-analyzer');
    expect(zeroFiles!.message).toContain('filesProcessed = 0');
  });

  it('warns for ALL missing analyzers, not just the first', () => {
    const warnings = runZeroFilesDiagnostics(
      ['a', 'b', 'c', 'd'],
      {
        a: makeResult({ filesProcessed: 10 }),
      }
    );

    expect(warnings).toHaveLength(3);
    const missing = warnings.map(w => w.analyzerName).sort();
    expect(missing).toEqual(['b', 'c', 'd']);
    for (const w of warnings) {
      expect(w.kind).toBe('no-result');
    }
  });

  it('warns for ALL zero-files analyzers, not just the first', () => {
    const warnings = runZeroFilesDiagnostics(
      ['a', 'b', 'c'],
      {
        a: makeResult({ filesProcessed: 0 }),
        b: makeResult({ filesProcessed: 0 }),
        c: makeResult({ filesProcessed: 99 }),
      }
    );

    const zeroFiles = warnings.filter(w => w.kind === 'zero-files');
    expect(zeroFiles).toHaveLength(2);
    expect(zeroFiles.map(w => w.analyzerName).sort()).toEqual(['a', 'b']);
  });

  it('does NOT warn for analyzers NOT in the enabled list (extra results)', () => {
    // If an analyzer somehow produces a result but wasn't enabled, Pass 1
    // (no-result) won't fire because it only checks enabledAnalyzers, and
    // Pass 2 (zero-files) iterates all results — but a legitimate result
    // with filesProcessed = 0 here would still warn. This test verifies
    // that the "extra" result with >0 files doesn't generate a warning.
    const warnings = runZeroFilesDiagnostics(
      ['solid'],
      {
        solid: makeResult({ filesProcessed: 100 }),
        'extra-analyzer': makeResult({ filesProcessed: 50 }),
      }
    );

    expect(warnings).toHaveLength(0);
  });

  it('empty enabled list and empty results returns no warnings', () => {
    const warnings = runZeroFilesDiagnostics([], {});
    expect(warnings).toHaveLength(0);
  });
});
