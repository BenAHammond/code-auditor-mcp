/**
 * Spec 11 R2 — Bench Harness Tests
 *
 * Verifies:
 *   1. All analyzer corpus fixtures achieve F1 ≥ 1.0 (no regressions from baseline)
 *   2. Baseline comparison detects regressions correctly
 *   3. Each analyzer fixture's expected.json is consistent with actual violations
 *   4. Blank-line guard prevents file-level comments from attaching to exports
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runBench } from '../scripts/runBench.js';
import type { BenchReport, AnalyzerMetrics } from '../scripts/runBench.js';

let report: BenchReport;

beforeAll(async () => {
  report = await runBench();
}, 120_000); // Bench runs take time — all corpus fixtures + language init

// ── Core quality bars ──────────────────────────────────────────────────

describe('Bench harness — regression gate', () => {
  it('all analyzers have F1 ≥ 1.0 (100%)', () => {
    const failures: string[] = [];
    for (const [name, metrics] of Object.entries(report.analyzers)) {
      if (metrics.f1 < 1.0) {
        failures.push(`${name}: F1=${metrics.f1.toFixed(4)} (P=${metrics.precision.toFixed(4)} R=${metrics.recall.toFixed(4)})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('all analyzers have precision = 1.0', () => {
    const failures: string[] = [];
    for (const [name, metrics] of Object.entries(report.analyzers)) {
      if (metrics.precision < 1.0) {
        failures.push(`${name}: precision=${metrics.precision.toFixed(4)} (FP=${metrics.falsePositives})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('all analyzers have recall = 1.0 (no missed expected violations)', () => {
    const failures: string[] = [];
    for (const [name, metrics] of Object.entries(report.analyzers)) {
      if (metrics.recall < 1.0) {
        failures.push(`${name}: recall=${metrics.recall.toFixed(4)} (FN=${metrics.falseNegatives})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('no analyzer regressed from baseline', () => {
    // The baseline comparison is built into the bench report.
    // If there are regressions, they appear here.
    const regressions = report.baselineComparison?.regressions ?? [];
    expect(regressions).toEqual([]);
  });
});

// ── Per-analyzer fixture integrity ─────────────────────────────────────

describe('Fixture integrity', () => {
  it('covers all 10 analyzers', () => {
    const expectedAnalyzers = [
      'conventions',
      'data-access',
      'documentation',
      'dry',
      'invariants',
      'non-english',
      'react',
      'schema',
      'solid',
      'styles',
    ];
    const actualAnalyzers = Object.keys(report.analyzers).sort();
    expect(actualAnalyzers).toEqual(expectedAnalyzers.sort());
  });

  it('has zero false positives vs nearMissFiles', () => {
    for (const [name, metrics] of Object.entries(report.analyzers)) {
      // No near-miss file should produce violations
      const failures = (metrics.nearMissResults ?? [])
        .filter(nm => nm.violations > 0);
      expect(failures).toEqual([]);
    }
  });
});

// ── Documentation analyzer blank-line guard ────────────────────────────

describe('Documentation — blank-line guard', () => {
  it('does NOT attach file-level comment separated by blank line to export function', () => {
    const docMetrics = report.analyzers['documentation'];
    expect(docMetrics).toBeDefined();
    // undocumented.ts has a file-level comment followed by a blank line
    // and a bare export function without JSDoc. It must fire (TP).
    expect(docMetrics.truePositives).toBeGreaterThanOrEqual(1);
    // well-documented.ts has proper JSDoc — must not fire (zero FP).
    expect(docMetrics.falsePositives).toBe(0);
    // No expected violations missed
    expect(docMetrics.falseNegatives).toBe(0);
  });

  it('near-miss files with JSDoc below docsMinLines do NOT fire', () => {
    const docMetrics = report.analyzers['documentation'];
    const shortMiss = (docMetrics.nearMissResults ?? [])
      .find(nm => nm.file.includes('short-enough'));
    if (shortMiss) {
      expect(shortMiss.violations).toBe(0);
    }
  });
});

// ── Report structure ────────────────────────────────────────────────────

describe('Bench report structure', () => {
  it('has valid timestamp and summary fields', () => {
    expect(report.timestamp).toBeTruthy();
    expect(typeof report.summary.totalAnalyzers).toBe('number');
    expect(report.summary.totalAnalyzers).toBeGreaterThan(0);
    expect(typeof report.summary.passed).toBe('number');
    expect(typeof report.summary.failed).toBe('number');
    expect(typeof report.summary.microAvgPrecision).toBe('number');
    expect(typeof report.summary.microAvgRecall).toBe('number');
    expect(typeof report.summary.microAvgF1).toBe('number');
    expect(typeof report.summary.microAvgTrueRecall).toBe('number');
    expect(typeof report.summary.microAvgTrueF1).toBe('number');
  });

  it('each analyzer metrics have all required fields', () => {
    for (const [name, metrics] of Object.entries(report.analyzers)) {
      expect(metrics.truePositives, `${name}: truePositives`).toBeGreaterThanOrEqual(0);
      expect(metrics.falsePositives, `${name}: falsePositives`).toBeGreaterThanOrEqual(0);
      expect(typeof metrics.precision, `${name}: precision`).toBe('number');
      expect(typeof metrics.recall, `${name}: recall`).toBe('number');
      expect(typeof metrics.f1, `${name}: f1`).toBe('number');
      expect(typeof metrics.trueRecall, `${name}: trueRecall`).toBe('number');
      expect(typeof metrics.trueF1, `${name}: trueF1`).toBe('number');
    }
  });
});
