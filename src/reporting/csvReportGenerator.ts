/**
 * CSV Report Generator (Functional)
 * Generates CSV formatted audit reports
 */

import { AuditResult, Violation } from '../types.js';

export interface CSVReportConfig {
  delimiter?: string;
  includeHeaders?: boolean;
  columns?: string[];
  customColumns?: Record<string, (violation: Violation & { analyzer: string }) => string>;
}

/**
 * Default columns for CSV export
 */
const DEFAULT_COLUMNS = [
  'analyzer',
  'file',
  'line',
  'column',
  'severity',
  'type',
  'message',
  'recommendation',
  'estimatedEffort'
];

/**
 * Generate a CSV report from audit results
 */
export function generateCSVReport(
  result: AuditResult,
  config?: CSVReportConfig
): string {
  const delimiter = config?.delimiter || ',';
  const includeHeaders = config?.includeHeaders ?? true;
  const columns = config?.columns || DEFAULT_COLUMNS;
  
  // Collect all violations with analyzer info
  const allViolations = collectAllViolations(result);
  
  // Generate CSV lines
  const lines: string[] = [];
  
  if (includeHeaders) {
    lines.push(generateHeaderRow(columns, delimiter));
  }
  
  for (const violation of allViolations) {
    lines.push(generateDataRow(violation, columns, delimiter, config?.customColumns));
  }
  
  return lines.join('\n');
}

/**
 * Generate a summary CSV report
 */
export function generateSummaryCSVReport(
  result: AuditResult,
  config?: CSVReportConfig
): string {
  const delimiter = config?.delimiter || ',';
  const lines: string[] = [];
  
  // Summary section
  lines.push('Summary');
  lines.push(`Total Violations${delimiter}${result.summary.totalViolations}`);
  lines.push(`Critical Issues${delimiter}${result.summary.criticalIssues}`);
  lines.push(`Warnings${delimiter}${result.summary.warnings}`);
  lines.push(`Suggestions${delimiter}${result.summary.suggestions}`);
  lines.push('');
  
  // Violations by category
  lines.push('Violations by Category');
  lines.push(`Category${delimiter}Count`);
  for (const [category, count] of Object.entries(result.summary.violationsByCategory)) {
    lines.push(`${escapeCSVValue(category, delimiter)}${delimiter}${count}`);
  }
  lines.push('');
  
  // Analyzer summary
  lines.push('Analyzer Summary');
  lines.push(`Analyzer${delimiter}Violations${delimiter}Files Processed${delimiter}Execution Time (ms)`);
  for (const [analyzer, data] of Object.entries(result.analyzerResults)) {
    lines.push([
      escapeCSVValue(analyzer, delimiter),
      data.violations.length,
      data.filesProcessed,
      data.executionTime
    ].join(delimiter));
  }
  
  return lines.join('\n');
}

/**
 * Collect all violations from analyzer results
 */
function collectAllViolations(result: AuditResult): Array<Violation & { analyzer: string }> {
  const violations: Array<Violation & { analyzer: string }> = [];
  
  for (const [analyzer, analyzerResult] of Object.entries(result.analyzerResults)) {
    for (const violation of analyzerResult.violations) {
      violations.push({
        ...violation,
        analyzer
      });
    }
  }
  
  // Sort by severity and file
  return violations.sort((a, b) => {
    const severityOrder = { critical: 3, warning: 2, suggestion: 1 };
    const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
    if (severityDiff !== 0) return severityDiff;
    return a.file.localeCompare(b.file);
  });
}

/**
 * Generate CSV header row
 */
function generateHeaderRow(columns: string[], delimiter: string): string {
  return columns.map(col => escapeCSVValue(col, delimiter)).join(delimiter);
}

/**
 * Generate CSV data row
 */
function generateDataRow(
  violation: Violation & { analyzer: string },
  columns: string[],
  delimiter: string,
  customColumns?: Record<string, (violation: Violation & { analyzer: string }) => string>
): string {
  return columns.map(column => {
    // Check for custom column handler
    if (customColumns && customColumns[column]) {
      return escapeCSVValue(customColumns[column](violation), delimiter);
    }
    
    // Default column handlers
    let value = '';
    switch (column) {
      case 'analyzer':
        value = violation.analyzer;
        break;
      case 'file':
        value = violation.file;
        break;
      case 'line':
        value = violation.line?.toString() || '';
        break;
      case 'column':
        value = violation.column?.toString() || '';
        break;
      case 'severity':
        value = violation.severity;
        break;
      case 'type':
        value = violation.type || '';
        break;
      case 'message':
        value = violation.message;
        break;
      case 'recommendation':
        value = violation.recommendation || '';
        break;
      case 'estimatedEffort':
        value = violation.estimatedEffort || '';
        break;
      default:
        // Try to access custom property
        value = (violation as any)[column]?.toString() || '';
    }
    
    return escapeCSVValue(value, delimiter);
  }).join(delimiter);
}

/**
 * Escape CSV value to handle special characters
 */
function escapeCSVValue(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    // Escape quotes by doubling them
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Generate a pivot table style CSV report
 */
export function generatePivotCSVReport(result: AuditResult): string {
  const pivot: Record<string, Record<string, number>> = {};
  
  // Build pivot data: file -> severity -> count
  for (const [, analyzerResult] of Object.entries(result.analyzerResults)) {
    for (const violation of analyzerResult.violations) {
      if (!pivot[violation.file]) {
        pivot[violation.file] = { critical: 0, warning: 0, suggestion: 0 };
      }
      pivot[violation.file][violation.severity]++;
    }
  }
  
  // Generate CSV
  const lines: string[] = ['File,Critical,Warning,Suggestion,Total'];
  
  for (const [file, severities] of Object.entries(pivot)) {
    const total = severities.critical + severities.warning + severities.suggestion;
    lines.push(`${escapeCSVValue(file, ',')},${severities.critical},${severities.warning},${severities.suggestion},${total}`);
  }
  
  return lines.join('\n');
}

// Backwards compatibility export
export const CSVReportGenerator = {
  generate: generateCSVReport
};