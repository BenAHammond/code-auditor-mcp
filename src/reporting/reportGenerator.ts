/**
 * Report Generator (Functional)
 * Orchestrates report generation in various formats
 */

import { AuditResult, ReportFormat } from '../types.js';
import { generateHTMLReport } from './htmlReportGenerator.js';
import { generateJSONReport } from './jsonReportGenerator.js';
import { generateCSVReport } from './csvReportGenerator.js';

/**
 * Generate a report in the specified format
 */
export function generateReport(result: AuditResult, format: ReportFormat): string {
  switch (format) {
    case 'html':
      return generateHTMLReport(result);
    case 'json':
      return generateJSONReport(result);
    case 'csv':
      return generateCSVReport(result);
    default:
      throw new Error(`Unknown report format: ${format}`);
  }
}

/**
 * Create a report generator with custom formatters
 */
export function createReportGenerator(customFormatters?: Record<string, (result: AuditResult) => string>) {
  const formatters = {
    html: generateHTMLReport,
    json: generateJSONReport,
    csv: generateCSVReport,
    ...customFormatters
  };
  
  return {
    generate(result: AuditResult, format: string): string {
      const formatter = formatters[format];
      if (!formatter) {
        throw new Error(`Unknown report format: ${format}`);
      }
      return formatter(result);
    },
    
    registerFormatter(format: string, formatter: (result: AuditResult) => string) {
      formatters[format] = formatter;
    },
    
    getAvailableFormats(): string[] {
      return Object.keys(formatters);
    }
  };
}

// For backwards compatibility - will be used by auditRunner
export const ReportGenerator = {
  generate: generateReport
};