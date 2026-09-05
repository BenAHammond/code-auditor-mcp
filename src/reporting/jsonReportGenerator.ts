/**
 * JSON Report Generator (Functional)
 * Generates JSON formatted audit reports
 */

import { AuditResult } from '../types.js';
import { getFilesProcessed } from '../pipeline.js';

export interface JSONReportConfig {
  pretty?: boolean;
  includeMetadata?: boolean;
  includeRecommendations?: boolean;
  customFields?: Record<string, any>;
}

/**
 * Generate a JSON report from audit results
 */
export function generateJSONReport(
  result: AuditResult, 
  config?: JSONReportConfig
): string {
  const pretty = config?.pretty ?? true;
  const includeMetadata = config?.includeMetadata ?? true;
  const includeRecommendations = config?.includeRecommendations ?? true;
  
  const report = createReportObject(result, {
    includeMetadata,
    includeRecommendations,
    customFields: config?.customFields
  });
  
  return JSON.stringify(report, null, pretty ? 2 : 0);
}

/**
 * Create the report object structure
 */
function createReportObject(
  result: AuditResult,
  options: {
    includeMetadata: boolean;
    includeRecommendations: boolean;
    customFields?: Record<string, any>;
  }
): any {
  const report: any = {
    timestamp: result.timestamp,
    summary: result.summary,
    analyzerResults: transformAnalyzerResults(result.analyzerResults)
  };
  
  if (options.includeRecommendations && result.recommendations) {
    report.recommendations = result.recommendations;
  }
  
  if (options.includeMetadata && result.metadata) {
    report.metadata = result.metadata;
  }

  // Include baseline block when present (Spec 18 R2)
  if (result.metadata?.baseline) {
    report.baseline = result.metadata.baseline;
  }
  
  if (options.customFields) {
    Object.assign(report, options.customFields);
  }
  
  return report;
}

/**
 * Transform analyzer results for better JSON structure
 */
function transformAnalyzerResults(analyzerResults: AuditResult['analyzerResults']): any {
  const transformed: any = {};
  
  for (const [analyzer, result] of Object.entries(analyzerResults)) {
    transformed[analyzer] = {
      status: result.status,
      summary: {
        totalViolations: result.violations.length,
        bySeverity: countBySeverity(result.violations),
        filesProcessed: getFilesProcessed(result.status),
        executionTime: result.executionTime
      },
      violations: result.violations.map(violation => ({
        // Spread the violation verbatim: fields the reporter doesn't know
        // (the Go subprocess's `category`, `details`, `suggestion`) were
        // previously dropped by a TypeScript-only allowlist below. A seam that
        // silently discards what it doesn't recognize is the same defect as the
        // old `analyzerResults.go` bucket filtering on `v.analyzer === 'go'` —
        // which never matched the subprocess's real labels. Preserve everything;
        // only normalize the one field that needs it.
        ...violation,
        ...(violation.hotspot !== undefined && violation.hotspot > 0 && { hotspot: Math.round(violation.hotspot * 1000) / 1000 }),
      })),
      ...(result.errors && { errors: result.errors })
    };
  }
  
  return transformed;
}

/**
 * Count violations by severity
 */
function countBySeverity(violations: any[]): Record<string, number> {
  return violations.reduce((acc, violation) => {
    acc[violation.severity] = (acc[violation.severity] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

/**
 * Generate a compact JSON report (minimal size)
 */
export function generateCompactJSONReport(result: AuditResult): string {
  const compactReport = {
    t: result.timestamp,
    s: {
      tv: result.summary.totalViolations,
      c: result.summary.criticalIssues,
      w: result.summary.warnings,
      s: result.summary.suggestions
    },
    v: Object.entries(result.analyzerResults).flatMap(([analyzer, data]) =>
      data.violations.map(v => ({
        a: analyzer,
        f: v.file,
        l: v.line,
        s: v.severity.charAt(0), // c, w, s
        m: v.message,
        ...(v.profile ? { p: v.profile } : {})
      }))
    )
  };
  
  return JSON.stringify(compactReport);
}

// Backwards compatibility export
export const JSONReportGenerator = {
  generate: generateJSONReport
};