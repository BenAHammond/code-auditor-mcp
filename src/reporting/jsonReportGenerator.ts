/**
 * JSON Report Generator (Functional)
 * Generates JSON formatted audit reports
 */

import { AuditResult } from '../types.js';

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
      summary: {
        totalViolations: result.violations.length,
        bySeverity: countBySeverity(result.violations),
        filesProcessed: result.filesProcessed,
        executionTime: result.executionTime
      },
      violations: result.violations.map(violation => ({
        file: violation.file,
        line: violation.line,
        column: violation.column,
        severity: violation.severity,
        message: violation.message,
        type: violation.type,
        ...(violation.recommendation && { recommendation: violation.recommendation }),
        ...(violation.estimatedEffort && { estimatedEffort: violation.estimatedEffort }),
        ...(violation.snippet && { snippet: violation.snippet })
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
        m: v.message
      }))
    )
  };
  
  return JSON.stringify(compactReport);
}

// Backwards compatibility export
export const JSONReportGenerator = {
  generate: generateJSONReport
};