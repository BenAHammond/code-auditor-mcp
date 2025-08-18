/**
 * Code Auditor
 * Main entry point for the code quality audit library
 * 
 * Exports all public APIs for programmatic use
 */

// Main audit runner
export { createAuditRunner, runAudit, AuditProgress } from './auditRunner.js';

// Import for default export
import { createAuditRunner as _createAuditRunner, runAudit as _runAudit } from './auditRunner.js';

// Configuration
export { 
  AuditConfig, 
  loadConfig,
  validateConfig
} from './config/configLoader.js';

export { 
  getDefaultConfig,
  getProjectTypeDefaults,
  getEnvironmentDefaults,
  DEFAULT_ANALYZER_CONFIGS
} from './config/defaults.js';

// Types
export {
  // Core types
  AuditOptions,
  AuditRunnerOptions,
  AuditResult,
  AuditSummary,
  AuditMetadata,
  ReportFormat,
  SeverityLevel,
  
  // Violation types
  Violation,
  SOLIDViolation,
  DRYViolation,
  AuthPatternIssue,
  
  // Analysis types
  PageAnalysis,
  RouteAnalysis,
  DataAccessPattern,
  QueryInfo,
  
  // Analyzer types
  AnalyzerResult,
  BaseAnalyzerOptions,
  
  // Recommendation types
  Recommendation,
  RecommendationPriority,
  
  // File info types
  FileInfo,
  ImportInfo,
  ExportInfo
} from './types.js';

// Analyzers
export { solidAnalyzer } from './analyzers/solidAnalyzer.js';
export { dryAnalyzer } from './analyzers/dryAnalyzer.js';
// export { securityAnalyzer } from './analyzers/securityAnalyzer.js';
// export { componentAnalyzer } from './analyzers/componentAnalyzer.js';
export { dataAccessAnalyzer } from './analyzers/dataAccessAnalyzer.js';

// Analyzer utilities
export * from './analyzers/analyzerUtils.js';

// Report Generators
export { 
  generateReport,
  createReportGenerator,
  ReportGenerator 
} from './reporting/reportGenerator.js';
export { 
  generateHTMLReport,
  HTMLReportGenerator, 
  HTMLReportConfig 
} from './reporting/htmlReportGenerator.js';
export { 
  generateJSONReport,
  generateCompactJSONReport,
  JSONReportGenerator, 
  JSONReportConfig 
} from './reporting/jsonReportGenerator.js';
export { 
  generateCSVReport,
  generateSummaryCSVReport,
  generatePivotCSVReport,
  CSVReportGenerator, 
  CSVReportConfig 
} from './reporting/csvReportGenerator.js';

// Utilities
export { 
  getImports,
  getExports,
  findFunctions,
  findClasses,
  calculateComplexity,
  getASTNode
} from './utils/astUtils.js';

export {
  discoverFiles,
  FileDiscoveryOptions,
  DEFAULT_EXCLUDED_DIRS,
  TYPESCRIPT_EXTENSIONS,
  JAVASCRIPT_EXTENSIONS,
  ALL_EXTENSIONS
} from './utils/fileDiscovery.js';

// Version
export const version = '0.1.0';

/**
 * Create a pre-configured audit runner for specific project types
 */
export async function createProjectAuditRunner(
  projectType: 'nextjs' | 'react' | 'vue' | 'angular' | 'node' | 'generic',
  options?: any
): Promise<any> {
  const { createAuditRunner } = await import('./auditRunner.js');
  const { getProjectTypeDefaults } = await import('./config/defaults.js');
  const projectDefaults = getProjectTypeDefaults(projectType);
  const mergedOptions = {
    ...projectDefaults,
    ...options
  };
  
  return createAuditRunner(mergedOptions);
}

/**
 * List available analyzers
 */
export function getAvailableAnalyzers(): string[] {
  return ['solid', 'dry', 'security', 'component', 'data-access'];
}

/**
 * List available report formats
 */
export function getAvailableFormats(): string[] {
  return ['html', 'json', 'csv'];
}

// Default export for convenience
export default {
  runAudit: _runAudit,
  createAuditRunner: _createAuditRunner,
  createProjectAuditRunner,
  getAvailableAnalyzers,
  getAvailableFormats,
  version
};

