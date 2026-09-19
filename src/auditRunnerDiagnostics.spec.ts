/**
 * Defect #50 — `runZeroFilesDiagnostics` must not warn for the `go` analyzer
 * when the corpus is TypeScript-only. The `go` analyzer is a polyglot subprocess
 * reached via `runAuditDispatch` only when `.go` files exist; on a corpus with
 * zero `.go` files it is legitimately notApplicable, not a dropped analyzer.
 */

import { describe, it, expect } from 'vitest';
import { runZeroFilesDiagnostics } from './auditRunner.js';
import { makeVisitorStatus } from './pipeline.js';
import type { AnalyzerResult } from './types.js';

function result(filesProcessed: number): AnalyzerResult {
  return {
    violations: [],
    executionTime: 0,
    status: makeVisitorStatus(filesProcessed),
    analyzerName: 'x',
  };
}

describe('runZeroFilesDiagnostics — go analyzer language gating', () => {
  it('does not warn "no-result" for go when no .go files exist (TS-only repo)', () => {
    const warnings = runZeroFilesDiagnostics(
      ['go', 'solid'],
      { solid: result(12) }, // go absent from results
      12,
      false, // hasGoFiles
    );
    expect(warnings.filter((w) => w.analyzerName === 'go')).toEqual([]);
  });

  it('still warns "no-result" for go when .go files exist but it produced no result', () => {
    const warnings = runZeroFilesDiagnostics(
      ['go'],
      {}, // go enabled but absent
      5,
      true, // hasGoFiles
    );
    const goWarnings = warnings.filter((w) => w.analyzerName === 'go');
    expect(goWarnings).toHaveLength(1);
    expect(goWarnings[0].kind).toBe('no-result');
  });

  it('does not warn "zero-files" for go when no .go files exist', () => {
    const warnings = runZeroFilesDiagnostics(
      ['go'],
      { go: result(0) }, // visitor-ran + 0 files
      10,
      false,
    );
    expect(warnings.filter((w) => w.analyzerName === 'go')).toEqual([]);
  });

  it('still warns "zero-files" for a real dark analyzer (non-go) with 0 files', () => {
    const warnings = runZeroFilesDiagnostics(
      ['solid'],
      { solid: result(0) },
      10,
      false,
    );
    expect(warnings.filter((w) => w.analyzerName === 'solid')).toHaveLength(1);
  });
});
