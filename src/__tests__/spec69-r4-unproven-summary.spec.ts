/**
 * Spec 69 §10 R4 — `summary.byAnalyzer` carries a per-analyzer unproven-site
 * count.
 *
 * The site-level `cannot-fire` surface (query-shaped call sites whose DB
 * receiver could not be resolved to a handle or a provable non-handle) was
 * previously visible only as `metadata.diagnostics` entries, never in the
 * summary. R4 threads the count into `summary.byAnalyzer[].unprovenSites`,
 * keyed by the analyzer that owns the receiver-resolution instrument
 * (`schema`), so a consumer reading the summary JSON sees the gap beside the
 * finding counts rather than having to cross-reference diagnostics.
 *
 * The pin: the owning analyzer carries its count, every other analyzer reads
 * zero (never absent), and the pre-existing fields (violations, filesProcessed,
 * fatalErrors) are undisturbed by the new field.
 */

import { describe, it, expect } from 'vitest';
import { generateSummary } from '../auditRunner.js';
import type { AnalyzerResult, Violation } from '../types.js';

function emptyResult(analyzerName: string, filesProcessed = 3): AnalyzerResult {
  return {
    analyzerName,
    executionTime: 0,
    violations: [],
    status: { status: 'visitor-ran', filesProcessed },
  };
}

describe('Spec 69 §10 R4 — summary.byAnalyzer unproven-site count', () => {
  it('carries the count on the owning analyzer and zero elsewhere', () => {
    const analyzerResults: Record<string, AnalyzerResult> = {
      schema: emptyResult('schema'),
      conventions: emptyResult('conventions'),
    };
    const unprovenSitesByAnalyzer = new Map<string, number>([['schema', 5]]);
    const summary = generateSummary(analyzerResults, 10, unprovenSitesByAnalyzer);

    expect(summary.byAnalyzer.schema.unprovenSites).toBe(5);
    expect(summary.byAnalyzer.conventions.unprovenSites).toBe(0);
  });

  it('defaults every analyzer to zero when no unproven map is passed', () => {
    const analyzerResults: Record<string, AnalyzerResult> = {
      schema: emptyResult('schema'),
    };
    const summary = generateSummary(analyzerResults, 1);

    expect(summary.byAnalyzer.schema.unprovenSites).toBe(0);
  });

  it('preserves the pre-existing fields beside the new count', () => {
    const violation: Violation = {
      file: '/a.ts',
      rule: 'sql-injection-risk',
      severity: 'critical',
      message: 'm',
      line: 1,
      column: 1,
    };
    const analyzerResults: Record<string, AnalyzerResult> = {
      schema: {
        analyzerName: 'schema',
        executionTime: 0,
        violations: [violation],
        status: { status: 'visitor-ran', filesProcessed: 7 },
        errors: [{ file: '/a.ts', error: 'boom' }],
      },
    };
    const summary = generateSummary(analyzerResults, 9, new Map([['schema', 2]]));

    expect(summary.byAnalyzer.schema).toEqual({
      violations: 1,
      filesProcessed: 7,
      fatalErrors: 1,
      unprovenSites: 2,
    });
  });
});

describe('Spec 69 §10 R4 follow-up — headline coverage totals', () => {
  it('sums the per-analyzer unproven-site counts into a top-level total', () => {
    const analyzerResults: Record<string, AnalyzerResult> = {
      schema: emptyResult('schema'),
      conventions: emptyResult('conventions'),
    };
    const summary = generateSummary(
      analyzerResults,
      10,
      new Map([['schema', 5], ['conventions', 2]]),
    );
    expect(summary.unprovenSites).toBe(7);
  });

  it('defaults the top-level unproven total to 0 when no map is passed', () => {
    const summary = generateSummary({ schema: emptyResult('schema') }, 1);
    expect(summary.unprovenSites).toBe(0);
  });

  it('counts gate-excluded violations as heldOut without subtracting them from the total', () => {
    const heldOutViolation: Violation = {
      file: '/a.ts', rule: 'x', severity: 'high', message: 'm', line: 1, column: 1, gateExcluded: true,
    };
    const plainViolation: Violation = {
      file: '/b.ts', rule: 'x', severity: 'high', message: 'm', line: 1, column: 1,
    };
    const analyzerResults: Record<string, AnalyzerResult> = {
      schema: {
        analyzerName: 'schema',
        executionTime: 0,
        violations: [heldOutViolation, plainViolation],
        status: { status: 'visitor-ran', filesProcessed: 2 },
      },
    };
    const summary = generateSummary(analyzerResults, 2);
    // Held-out readings are named "held out by profile" in the headline; they
    // still count in totalViolations — exclusion never subtracts from the total.
    expect(summary.heldOut).toBe(1);
    expect(summary.totalViolations).toBe(2);
  });
});
