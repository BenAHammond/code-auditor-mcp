/**
 * Type definitions for the code auditor
 * Generic types that work with any TypeScript/JavaScript project
 */

export type Severity = 'critical' | 'warning' | 'suggestion';

export type ReportFormat = 'html' | 'json' | 'csv';

export type RenderType = 'client' | 'server' | 'unknown';

export type DataFetchingMethod = 'server' | 'client' | 'none';

export interface QueryInfo {
  type: string;
  tables: string[];
  line: number;
  hasJoins?: boolean;
  complexity?: 'simple' | 'moderate' | 'complex';
  hasOrganizationFilter?: boolean;
}

export interface SecurityViolation extends Violation {
  type: 'security';
  category: string;
}

export interface ArchitectureViolation extends Violation {
  type: 'architecture';
  category: string;
}

export interface Violation {
  file: string;
  line?: number;
  column?: number;
  severity: Severity;
  message: string;
  details?: string | Record<string, any>;
  snippet?: string;
  suggestion?: string;
  [key: string]: any; // Allow analyzer-specific properties
}

export interface AnalyzerResult {
  violations: Violation[];
  filesProcessed: number;
  executionTime: number;
  errors?: Array<{ file: string; error: string }>;
  analyzerName?: string;
  // Analyzer-specific data can be added by extending this interface
  [key: string]: any;
}

export interface AuditOptions {
  includePaths?: string[];
  excludePaths?: string[];
  minSeverity?: Severity;
  enabledAnalyzers?: string[];
  outputFormats?: ReportFormat[];
  outputDir?: string;
  failOnCritical?: boolean;
  duplicateThreshold?: number;
  verbose?: boolean;
  configFile?: string;
  thresholds?: {
    maxCritical?: number;
    maxWarnings?: number;
    maxSuggestions?: number;
    minHealthScore?: number;
  };
}

export interface ProgressCallback {
  (progress: {
    current: number;
    total: number;
    analyzer: string;
    file?: string;
    phase?: string;
  }): void;
}

// Pure functional analyzer type
export type AnalyzerFunction = (
  files: string[],
  config: any,
  options?: AuditOptions,
  progressCallback?: ProgressCallback
) => Promise<AnalyzerResult>;

// Analyzer registry entry
export interface AnalyzerDefinition {
  name: string;
  analyze: AnalyzerFunction;
  defaultConfig: any;
}

export interface AuditSummary {
  totalFiles: number;
  totalViolations: number;
  criticalIssues: number;
  warnings: number;
  suggestions: number;
  violationsByCategory: Record<string, number>;
  topIssues: Array<{ type: string; count: number }>;
}

export interface AuditResult {
  timestamp: Date;
  summary: AuditSummary;
  analyzerResults: Record<string, AnalyzerResult>;
  recommendations: Recommendation[];
  metadata: {
    auditDuration: number;
    filesAnalyzed: number;
    analyzersRun: string[];
    configUsed?: AuditOptions;
  };
}

export interface ComponentAnalysis {
  filePath: string;
  renderType: RenderType;
  hasErrorBoundary: boolean;
  dataFetchingMethod?: DataFetchingMethod;
  violations: Violation[];
  suggestions: string[];
  imports: string[];
  exports: string[];
  hasAppShell?: boolean;
  hasPageHeader?: boolean;
}

export interface SecurityAnalysis {
  filePath: string;
  httpMethods: string[];
  authPattern?: string;
  authWrapper?: string;
  rateLimiting?: boolean;
  hasErrorHandling: boolean;
  usesStandardResponses?: boolean;
  organizationFiltering?: boolean;
  violations: Violation[];
}

export interface SOLIDViolation extends Violation {
  principle: 'single-responsibility' | 'open-closed' | 'liskov-substitution' | 'interface-segregation' | 'dependency-inversion';
  className?: string;
  methodName?: string;
}

export interface DRYViolation extends Violation {
  type: 'exact-duplicate' | 'pattern-duplication' | 'similar-logic';
  similarity?: number;
  locations?: Array<{ file: string; line: number }>;
  metrics?: {
    duplicateLines: number;
    totalLines: number;
  };
}

export interface DataAccessPattern {
  source: 'component' | 'api' | 'service';
  filePath: string;
  database?: string;
  databaseType?: string;
  tables: string[];
  queries: QueryInfo[];
  performanceRisk: 'low' | 'medium' | 'high';
  hasOrganizationFilter?: boolean;
  hasSqlInjectionRisk?: boolean;
}

export interface DataAccessViolation extends Violation {
  pattern: 'raw-sql' | 'missing-validation' | 'no-pooling' | 'performance-issue';
  query?: string;
  risk?: 'sql-injection' | 'performance' | 'security' | 'data-leak';
}

export interface SecurityPatternIssue extends Violation {
  pattern: 'missing-auth' | 'inconsistent-auth' | 'missing-validation' | 'security-bypass';
  expectedPattern?: string;
}

export interface ReportGenerator {
  generate(result: AuditResult, format: ReportFormat): string;
}

export interface Recommendation {
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  effort: 'small' | 'medium' | 'large';
  category: string;
  affectedFiles: string[];
  exampleImplementation?: string;
}

export interface AuditConfig {
  includePaths?: string[];
  excludePaths?: string[];
  enabledAnalyzers?: string[];
  outputFormats?: ReportFormat[];
  outputDir?: string;
  outputDirectory?: string;
  minSeverity?: Severity;
  failOnCritical?: boolean;
  showProgress?: boolean;
  parallel?: boolean;
  thresholds?: {
    maxCritical?: number;
    maxWarnings?: number;
    maxSuggestions?: number;
    minHealthScore?: number;
  };
  // Analyzer-specific configurations
  analyzerOptions?: Record<string, any>;
}

// Legacy type aliases for backward compatibility
export type PageAnalysis = ComponentAnalysis;
export type RouteAnalysis = SecurityAnalysis;
export type AuthWrapper = string;
export type AuthPatternIssue = SecurityPatternIssue;
export type DatabaseType = string;

// Additional types
export type SeverityLevel = Severity;
export type RecommendationPriority = 'high' | 'medium' | 'low';

export interface AuditMetadata {
  auditDuration: number;
  filesAnalyzed: number;
  analyzersRun: string[];
  configUsed?: AuditOptions;
  reports?: string[];
}

export interface BaseAnalyzerOptions {
  verbose?: boolean;
  configFile?: string;
}

export interface FileInfo {
  path: string;
  size: number;
  lastModified: Date;
}

export interface ImportInfo {
  moduleSpecifier: string;
  importedNames: string[];
  isTypeOnly: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  isTypeOnly: boolean;
  line: number;
}

export interface AuditProgress {
  current: number;
  total: number;
  analyzer: string;
  file?: string;
  phase?: string;
  message?: string;
}

export interface AuditRunnerOptions extends AuditOptions {
  progressCallback?: (progress: AuditProgress) => void;
  errorCallback?: (error: Error, context: string) => void;
  outputDirectory?: string;
  configName?: string;
  projectRoot?: string;
  analyzerConfigs?: Record<string, any>;
}

// Code Index Types
export interface FunctionMetadata {
  name: string;
  filePath: string;
  lineNumber?: number;
  startLine?: number;
  endLine?: number;
  language?: string;
  dependencies: string[];
  purpose: string;
  context: string;
  metadata?: Record<string, any>;
}

// Enhanced function metadata with additional searchable fields
export interface EnhancedFunctionMetadata extends FunctionMetadata {
  signature: string;
  parameters: Array<{
    name: string;
    type?: string;
    description?: string;
    optional?: boolean;
    defaultValue?: string;
  }>;
  returnType?: string;
  jsDoc?: {
    description?: string;
    examples?: string[];
    tags?: Record<string, string[]>;
  };
  typeInfo?: {
    generics?: string[];
    interfaces?: string[];
    types?: string[];
  };
  complexity?: number;
  tokens?: string[];
  tokenizedName?: string;
  lastModified?: Date;
}

// Parsed search query structure
export interface ParsedQuery {
  terms: string[];
  originalTerms?: string[]; // Original terms before synonym expansion
  phrases: string[];
  excludedTerms: string[];
  filters: {
    filePath?: string;
    fileType?: string;
    language?: string;
    hasJsDoc?: boolean;
    complexity?: {
      min?: number;
      max?: number;
    };
    dateRange?: {
      start?: Date;
      end?: Date;
    };
  };
  searchFields?: Array<'name' | 'signature' | 'jsDoc' | 'parameters' | 'returnType' | 'purpose' | 'context'>;
  fuzzy?: boolean;
  stemming?: boolean;
}

export interface SearchOptions {
  query?: string;
  parsedQuery?: ParsedQuery;
  filters?: {
    language?: string;
    filePath?: string;
    hasAnyDependency?: string[];
    fileType?: string;
    hasJsDoc?: boolean;
    complexity?: {
      min?: number;
      max?: number;
    };
    dateRange?: {
      start?: Date;
      end?: Date;
    };
  };
  searchStrategy?: 'exact' | 'fuzzy' | 'semantic';
  searchFields?: Array<'name' | 'signature' | 'jsDoc' | 'parameters' | 'returnType' | 'purpose' | 'context'>;
  scoringWeights?: {
    nameMatch?: number;
    signatureMatch?: number;
    jsDocMatch?: number;
    parameterMatch?: number;
    purposeMatch?: number;
    contextMatch?: number;
  };
  limit?: number;
  offset?: number;
  includeSnippets?: boolean;
  highlightMatches?: boolean;
}

export interface RegisterResult {
  success: boolean;
  registered: number;
  failed: number;
  errors?: Array<{ function: string; error: string }>;
}

export interface SearchResult {
  functions: Array<EnhancedFunctionMetadata & {
    score: number;  // Required for relevance ranking
    highlights?: {
      name?: string[];
      signature?: string[];
      jsDoc?: string[];
      parameters?: string[];
      purpose?: string[];
      context?: string[];
    };
    matchedFields?: string[];
  }>;
  totalCount: number;
  query?: string;
  parsedQuery?: ParsedQuery;
  executionTime: number;
  facets?: {
    languages?: Record<string, number>;
    fileTypes?: Record<string, number>;
    complexityRanges?: Record<string, number>;
  };
  suggestions?: string[];
}

export interface IndexStats {
  totalFunctions: number;
  languages: Record<string, number>;
  topDependencies: Array<{ name: string; count: number }>;
  filesIndexed: number;
  lastUpdated: Date;
}