import { describe, it, expect } from 'vitest';
import { generateJSONReport } from './jsonReportGenerator.js';
import { makeVisitorStatus, makeReducerStatus } from '../pipeline.js';
import type { AuditResult, AnalyzerResult } from '../types.js';

// A reducer doesn't count files — it consumes facts. The JSON reporter must
// not emit `filesProcessed: 0` for one (that reads as "scanned nothing", a
// claim the reducer never made); it emits `factsConsumed` instead. This pins
// the presence/absence distinction so a future author can't silently re-flatten
// the two status kinds back into one summary field (Spec 63 R3 residual).

function makeResult(status: AnalyzerResult['status']): AuditResult {
  return {
    timestamp: new Date(0),
    summary: {
      totalFiles: 0,
      totalViolations: 0,
      criticalIssues: 0,
      severe: 0,
      high: 0,
      violationsByCategory: {},
      topIssues: [],
    },
    analyzerResults: {
      sample: {
        analyzerName: 'sample',
        violations: [],
        executionTime: 0,
        status,
      },
    },
    recommendations: [],
    metadata: { auditDuration: 0, filesAnalyzed: 0, analyzersRun: ['sample'] },
  };
}

describe('generateJSONReport — filesProcessed vs factsConsumed', () => {
  it('emits filesProcessed for a visitor and no factsConsumed', () => {
    const report = JSON.parse(generateJSONReport(makeResult(makeVisitorStatus(7))));
    const summary = report.analyzerResults.sample.summary;
    expect(summary.filesProcessed).toBe(7);
    expect('factsConsumed' in summary).toBe(false);
  });

  it('emits factsConsumed for a reducer and omits filesProcessed', () => {
    const report = JSON.parse(generateJSONReport(makeResult(makeReducerStatus(12))));
    const summary = report.analyzerResults.sample.summary;
    expect(summary.factsConsumed).toBe(12);
    expect('filesProcessed' in summary).toBe(false);
  });
});
