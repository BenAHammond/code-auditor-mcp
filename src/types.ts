/**
 * Type definitions for the code auditor
 * Generic types that work with any TypeScript/JavaScript project
 */

export type Severity = 'critical' | 'warning' | 'suggestion' | 'off';

export type ReportFormat = 'html' | 'json' | 'csv' | 'sarif';

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

/**
 * Spec 37 R1 — the structured next action a gating finding carries.
 *
 * A resolution is not prose appended to the message: consumers route on
 * `action`, and every field it names (symbols/files/lines) is something the
 * analyzer already computed. Where an analyzer cannot produce one for a given
 * occurrence, it emits the finding non-blocking (Spec 36 R6) and records the
 * gap rather than inventing a plan.
 */
export interface Resolution {
  /** Machine-actionable verb the consumer routes on (e.g. `split-class`, `parameterize`). */
  action: string;
  /** One-sentence specific next step naming concrete symbols/files/lines. */
  summary: string;
  /** Concrete symbols the analyzer identified. */
  symbols?: string[];
  /** Concrete files the analyzer identified. */
  files?: string[];
  /** Concrete lines the analyzer identified. */
  lines?: number[];
}

/**
 * Audit scope applied to a result.
 * - `full` – a complete audit (scope was `all`)
 * - `scoped` – audit was scoped to a subset of files; the result does NOT
 *   replace the most recent full-audit result in storage.
 */
export type AuditResultScope = 'full' | 'scoped';

export interface Violation {
  file: string;
  /** The canonical rule ID this violation represents (one emitter per ID — see ruleRegistry). */
  rule: string;
  line?: number;
  column?: number;
  severity: Severity;
  message: string;
  details?: string | Record<string, any>;
  snippet?: string;
  suggestion?: string;
  /** Path profile that matched this file (last matching profile wins). */
  profile?: string;
  /** Hotspot score [0,1] — churn percentile × complexity percentile. */
  hotspot?: number;

  // ── Transitional fields (previously leaked via [key: string]: any) ──────
  /** @deprecated Read from AnalyzerResult.analyzerName instead. */
  analyzer?: string;
  /** @deprecated Use `rule` instead — rule-identity field. */
  type?: string;
  /** Symbol resolution — set by analyzers for symbol-level attribution. */
  functionName?: string;
  componentName?: string;
  name?: string;
  methodName?: string;
  hookName?: string;
  interfaceName?: string;
  enclosingSymbol?: string;
  /** Alternate suggestion field — prefer `suggestion`. */
  recommendation?: string;
  /** Scratch flag for diff/new detection. */
  new?: boolean;
  /**
   * Spec 36 R4 — true when the file matched a path profile that excludes it
   * from the blocking gate. The finding still appears in reports at its real
   * severity; it is simply never blocking. This replaces the removed
   * `severityCap` soften-in-place mechanism.
   */
  gateExcluded?: boolean;
  violationType?: string;
  symbol?: string;
  principle?: string;
  /** Estimated effort to fix (e.g. "5min", "1h"). */
  estimatedEffort?: string;
  /** Cross-domain: coverage basis (measured, static-reach, etc.). */
  basis?: string;
  /** Invariant rule: banned import specifier. */
  importSpecifier?: string;
  /** Class name for SOLID violations (also used via base Violation in symbols.ts). */
  className?: string;
  /** Schema violation type (also on SchemaViolation, read via base in SARIF). */
  schemaType?: string;
  /** Violation category (e.g. "security", "architecture", "style"). */
  category?: string;
  /** Source format for migration/compat violations. */
  sourceFormat?: string;
  /** Callee function/symbol name for call-graph violations. */
  callee?: string;
  /** Caller function/symbol name for call-constraint violations. */
  caller?: string;
  /** Suggested fix — either a string description or a structured {oldText, newText} patch. */
  fix?: string | { oldText: string; newText: string };
  /**
   * Spec 37 R1 — structured next action for gating findings. Present on every
   * gating finding; absent on non-gating findings.
   */
  resolution?: Resolution;
  /**
   * Spec 36 R7 — true when an inline `code-audit-disable-*` directive with a
   * required reason suppressed this finding. Suppressed findings never block
   * (the directive is the block-removal mechanism); they still appear in
   * reports with the reason attached.
   */
  suppressed?: boolean;
  /** The required reason from the directive that suppressed this finding. */
  suppressionReason?: string;
  /** Which directive form (`disable-line` / `disable-next-line`) suppressed it. */
  suppressionKind?: 'disable-line' | 'disable-next-line';
}

/**
 * Per-rule coverage classification — emitted on every audit.
 * @see buildCoverageReport() in pipeline.ts
 */
export type RuleCoverageState = 'fired' | 'clean' | 'notApplicable' | 'unassessed';

export interface RuleCoverage {
  ruleId: string;
  analyzer: string;
  state: RuleCoverageState;
  /** Violation count for this rule (0 for notApplicable/unassessed/clean). */
  count: number;
  /** For notApplicable: what input was missing. For unassessed: why applicability couldn't be confirmed. */
  reason?: string;
}

/**
 * Spec 33 Item 14 — per-rule input presence, computed once per pipeline run.
 *
 * A rule's `input` (see {@link RuleRegistryEntry.input}) names one or more input
 * sources: the literal `'files'` (the analyzer ran on ≥1 parsed source file), a
 * fact-key (a visitor/reducer name whose per-file facts were non-empty this run),
 * or an index table (a table that held ≥1 row when coverage was built).
 *
 * `buildCoverageReport` uses this to promote a zero-violation rule from
 * `unassessed` to `clean` (input present) or `notApplicable` (all inputs absent).
 */
export interface InputPresence {
  /** Fact-keys (visitor/reducer names) that emitted ≥1 non-empty per-file fact this run. */
  factKeys: string[];
  /** Index tables that contained ≥1 row at coverage-build time. */
  indexTables: string[];
}

/**
 * Discriminable status union for pipeline consumers.
 * `visitor-ran` → visitor result with filesProcessed.
 * `reducer-ran` → reducer/derived-reducer result with factsConsumed.
 * `notRun` → analyzer was skipped or errored.
 */
export interface AnalyzerVisitorStatus {
  status: 'visitor-ran';
  filesProcessed: number;
}

export interface AnalyzerReducerStatus {
  status: 'reducer-ran';
  factsConsumed: number;
}

export interface AnalyzerNotRunStatus {
  status: 'notRun';
  reason: string;
}

export type AnalyzerStatus = AnalyzerVisitorStatus | AnalyzerReducerStatus | AnalyzerNotRunStatus;

export interface AnalyzerResult {
  violations: Violation[];
  executionTime: number;
  status: AnalyzerStatus;
  analyzerName: string;
  errors?: Array<{ file: string; error: string }>;
  /** Number of files processed by the analyzer. */
  filesProcessed?: number;
  /** Arbitrary metrics bag — used by cross-domain, visualizations, etc. */
  metrics?: Record<string, unknown>;
  /** Legacy extra payload from pre-pipeline analyzers. */
  extras?: Record<string, unknown>;
}

/** A file with its parsed AST and language adapter — output of pipeline stage 1. */
/** A file that was successfully parsed into an AST by a LanguageAdapter. */
export interface ParsedFileASTTuple {
  kind: 'parsed';
  file: string;
  ast: unknown;
  adapter: unknown;
  sourceCode: string;
}

/** A file with no matching LanguageAdapter — included as raw source for visitors
 *  that declare support for its extension (e.g. .sql, .toml, .prisma, .json). */
export interface RawFileASTTuple {
  kind: 'raw';
  file: string;
  ast: null;
  adapter: null;
  sourceCode: string;
}

export type FileASTTuple = ParsedFileASTTuple | RawFileASTTuple;

/** Context passed to per-file visitors in stage 2. */
export interface VisitorContext {
  projectRoot: string;
  filePath: string;
  config: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

/** Context passed to reducers in stages 3 and 4. */
export interface ReducerContext {
  projectRoot: string;
  config: Record<string, unknown>;
  indexHandle?: IndexHandle;
  abortSignal?: AbortSignal;
  /** On-demand source reader — lets reducers pull file text lazily instead of
   *  retaining every file's full source as a fact through stage 4. */
  readSource?: (filePath: string) => string | undefined;
}

/** Return type from stage-2 visitor visit(). */
export interface VisitorResult {
  violations: Violation[];
  facts: Record<string, unknown>;
  indexFacts?: IndexFactsEntry[];
}

/** Return type from stage-3/4 reducer reduce(). */
export interface ReducerResult {
  violations: Violation[];
  facts: Record<string, unknown>;
  factsConsumed?: number;
  /** When set, the pipeline records this reducer as notRun with this reason
   *  instead of reducer-ran. Used for runtime auto-disable (e.g. invariants
   *  with no rules configured). */
  notRunReason?: string;
}

/** Per-file visitor — runs on every AST in stage 2. */
export interface Stage2Visitor {
  name: string;
  stage: 'visitor';
  /** File extensions this visitor consumes (e.g. ['.ts', '.tsx']).
   *  Undefined = backward-compat: receives all parsed tuples, skips raw tuples.
   *  Set to e.g. ['.sql'] to receive raw tuples for .sql files. */
  extensions?: string[];
  visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string): Promise<VisitorResult>;
  getRuleIds(): string[];
  defaultConfig: Record<string, unknown>;
  description: string;
  category: string;
}

/** Corpus reducer — accumulates facts in stage 3. Consumes only from stage 2 visitors. */
export interface Stage3Reducer {
  name: string;
  stage: 'reducer';
  reduce(allFacts: Readonly<Record<string, unknown>>, context: ReducerContext): Promise<ReducerResult>;
  getRuleIds(): string[];
  consumes: string[];
  defaultConfig: Record<string, unknown>;
  description: string;
  category: string;
}

/** Derived reducer — consumes from stage 3 reducers + stage 2 visitors in stage 4. */
export interface Stage4Reducer {
  name: string;
  stage: 'derivedReducer';
  reduce(allFacts: Record<string, unknown>, context: ReducerContext): Promise<ReducerResult>;
  getRuleIds(): string[];
  consumes: string[];
  defaultConfig: Record<string, unknown>;
  description: string;
  category: string;
}

/**
 * DB handle abstraction for reducers.
 * Reducers call query/count/tableHasRows instead of opening CodeIndexDB directly.
 */
export interface IndexHandle {
  query(sql: string, params?: unknown[]): unknown[];
  count(table: string, where?: string, params?: unknown[]): number;
  tableHasRows(table: string): boolean;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  exec(sql: string): void;
  getMeta(key: string): unknown;
  getUntestedTopDecile(decile: number): unknown[];
  rawDb?: unknown;
}

/** Deferred DB write record collected in stage 2, persisted post-pipeline. */
export interface IndexFactsEntry {
  table: string;
  data: Record<string, unknown>;
  conflictKey?: string;
}

/** Pipeline configuration passed to runPipeline(). */
export interface PipelineConfig {
  projectRoot: string;
  visitors?: Stage2Visitor[];
  reducers?: Stage3Reducer[];
  derivedReducers?: Stage4Reducer[];
  explicitFiles?: string[];
  /**
   * Namespaced analyzer configs.
   * Each key is an analyzer name, value is its config bag.
   * The `_infra` key holds shared infrastructure config (projectRoot, severityOverrides,
   * pathProfiles, _provenanceTiming) that every visitor/reducer receives alongside its
   * own namespace.
   */
  config?: Record<string, Record<string, unknown>>;
  /**
   * Optional hook that fires after Stage 2 visitors complete and before Stage 3
   * reducers run. Used for DB setup that depends on Stage 2 output (e.g.
   * rebuilding function_calls from the functions table, mining conventions).
   */
  onStage2Complete?: (ctx: { allFacts: Map<string, Record<string, unknown>> }) => Promise<void>;
  abortSignal?: AbortSignal;
  progressCallback?: (progress: AuditProgress) => void;
  isScoped?: boolean;
}

/**
 * Spec 31 — orphan files (no language adapter, e.g. `.sql` data dumps) larger
 * than this are not materialized into a `sourceCode` string during stage 1.
 * The consuming visitor streams them on demand instead, avoiding OOM on e.g. a
 * 257 MB `snapshots/data.sql`. Real migrations/schemas are orders of magnitude
 * below this; only data dumps cross it.
 */
export const MAX_ORPHAN_SOURCE_BYTES = 8 * 1024 * 1024; // 8 MB

/** Pipeline output — merged results from all four stages. */
export interface PipelineResult {
  analyzerResults: Record<string, AnalyzerResult>;
  metadata: {
    auditDuration: number;
    filesAnalyzed: number;
    stageTiming: Record<string, number>;
    scoped?: boolean;
    diagnostics?: Array<{ analyzerName: string; kind: string; message: string }>;
    coverage?: RuleCoverage[];
    /** Spec 29: Per-table provenance catalog from schema reducer */
    tableCatalog?: Array<{ table: string; sources: Array<{ table: string; tier: string; sourceFile?: string; description?: string }> }>;
    /** Spec 31: oversized orphan files skipped by stage-1 streaming. Surfaced in
     *  metadata (not violations) so baseline counts are preserved. */
    skippedFiles?: Array<{ filePath: string; bytes: number; reason: string }>;
    /** Spec 32: files that failed to parse (or to be read) during stage 1, with
     *  the reason. A non-empty list means the audit was incomplete — consumers
     *  must surface it and exit non-zero rather than report a plausible-but-wrong
     *  result. */
    unparsedFiles?: Array<{ filePath: string; reason: string }>;
    /** Spec 33 Item 14: per-rule input presence snapshot consumed by
     *  buildCoverageReport to promote zero-violation rules from `unassessed` to
     *  `clean` (input present) or `notApplicable` (all inputs absent). */
    inputPresence?: InputPresence;
    /** Spec 38 R2: per-rule wall-clock timing, slowest first, gating path only.
     *  Present only when CODE_AUDIT_RULE_TIMING=1. */
    ruleTiming?: Array<{ ruleId: string; totalMs: number; calls: number }>;
    /** Spec 39: per-rule derived applicability evaluated over the pipeline's
     *  computed inputs. Consumed by buildCoverageReport to report inapplicable
     *  rules as `notApplicable` with a reason. */
    ruleApplicability?: Array<{ ruleId: string; applicable: boolean; reason?: string }>;
  };
  indexFacts?: IndexFactsEntry[];
}

export interface AuditOptions {
  includePaths?: string[];
  excludePaths?: string[];
  fileExtensions?: string[]; // Override file extensions to analyze
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
  unusedImportsConfig?: {
    checkLevel?: 'function' | 'file';
    includeTypeOnlyImports?: boolean;
    ignorePatterns?: string[];
  };
  /** Per-rule severity overrides applied globally (before per-file path profile caps). */
  severityOverrides?: Record<string, Severity>;
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
    /** Absolute paths of every file this run analyzed. Populated for scoped
     *  runs; the `changed` command feeds it to the diff gate (Spec 36 R2). */
    analyzedFiles?: string[];
    configUsed?: AuditOptions;
    collectedFunctions?: FunctionMetadata[]; // Functions collected during audit
    fileToFunctionsMap?: Record<string, FunctionMetadata[]>; // Functions per file for sync
    scope?: AuditResultScope; // Whether this was a full or scoped audit
    /** Milliseconds spent inside buildProvenanceContext() across all files (Spec 21 — hook-latency measurement). */
    provenanceResolutionMs?: number;
    /** Blast radius impact for changed functions (Spec 14 R6 — scoped audits only). */
    blastRadius?: BlastRadiusImpact;
    /** Zero-files or missing-result diagnostics (v3.4.8 — verify:dist gate hardening). */
    diagnostics?: Array<{analyzerName: string; kind: string; message: string}>;
    baseline?: {
      present: boolean;
      hash?: string;
      newCount: number;
      fixedCount: number;
      knownCount: number;
      previousKnownCount?: number;
    };
    coverage?: RuleCoverage[];
    /** Spec 29: Per-table provenance catalog from schema reducer */
    tableCatalog?: Array<{ table: string; sources: Array<{ table: string; tier: string; sourceFile?: string; description?: string }> }>;
    /** Spec 31: oversized orphan files skipped by stage-1 streaming. */
    skippedFiles?: Array<{ filePath: string; bytes: number; reason: string }>;
    /** Spec 32: files that failed to parse (or to be read) during stage 1, with
     *  the reason. Non-empty means the audit was incomplete. */
    unparsedFiles?: Array<{ filePath: string; reason: string }>;
    /** Spec 33 Item 14: per-rule input presence snapshot consumed by
     *  buildCoverageReport to promote zero-violation rules from `unassessed` to
     *  `clean` (input present) or `notApplicable` (all inputs absent). */
    inputPresence?: InputPresence;
    /** Spec 36 R7 — suppression triage: how many directives, how many findings
     *  they suppressed, and which directives were unnecessary or reasonless
     *  (both are errors). */
    suppressions?: {
      total: number;
      suppressed: number;
      unnecessary: Array<{ file: string; line: number; rule: string }>;
      reasonless: Array<{ file: string; line: number; rule: string }>;
    };
  };
}

/** Thrown when an in-process audit is stopped via AbortSignal (parent cancel or soft budget). */
export class AuditAbortedError extends Error {
  override readonly name = 'AuditAbortedError';
  constructor(message = 'Audit aborted') {
    super(message);
  }
}

/**
 * Thrown when a shard processed a file chunk and more files remain.
 * Parent should queue a new worker task (e.g. with explicitFiles) to continue.
 */
export class AuditHandoffError extends Error {
  override readonly name = 'AuditHandoffError';
  readonly partialResult: AuditResult;
  readonly remainingFiles: string[];
  constructor(message: string, partialResult: AuditResult, remainingFiles: string[]) {
    super(message);
    this.partialResult = partialResult;
    this.remainingFiles = remainingFiles;
  }
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

export interface PathProfile {
  /** Unique name for this profile (used in attribution and built-in replacement). */
  name: string;
  /** Glob patterns matching file paths relative to project root. */
  paths: string[];
  /** Analyzer config overrides applied to files matching this profile. */
  overrides: Record<string, unknown>;
  /** Set to false to replace a built-in profile of the same name. */
  builtin?: boolean;
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
  /** Per-directory config overrides. Ordered array — later matching profiles win on merge. */
  pathProfiles?: PathProfile[];
  /** Set to false to disable all built-in profiles. */
  builtin?: boolean;
  /** Per-rule severity overrides applied globally (before per-file path profile caps). */
  severityOverrides?: Record<string, Severity>;
  /** Spec 13 — Churn extraction config. */
  churn?: ChurnConfig;
  /** Spec 13 — Diverging-clone detection config. */
  divergence?: DivergenceConfig;
  /** Spec 15 — Cross-domain analysis config. */
  crossDomain?: CrossDomainConfig;
  // Analyzer-specific configurations
  analyzerOptions?: Record<string, any>;
  /** Per-analyzer config overrides keyed by analyzer namespace (e.g. `solid.maxLinesPerMethod`). */
  analyzerConfigs?: Record<string, any>;
  /** Spec 36 R5 — written justifications for each non-default threshold, keyed `"<analyzer>.<key>"`. */
  rationales?: Record<string, string>;
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
  /** Spec 29: Per-table provenance catalog from the schema reducer */
  tableCatalog?: Array<{ table: string; sources: Array<{ table: string; tier: string; sourceFile?: string; description?: string }> }>;
  /** Spec 30: Per-stage wall-clock timing for the streaming pipeline */
  stageTiming?: Record<string, number>;
  /** Spec 36 R5 — thresholds the run changed from default, with the delta. */
  thresholdChanges?: Array<{ key: string; defaultValue: unknown; effectiveValue: unknown }>;
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

export interface AnalyzerConfigDocument {
  $loki?: number;
  meta?: any;
  analyzerName: string;              // e.g., 'solid', 'dry', 'security'
  projectPath?: string | null;       // Optional project-specific config
  config: Record<string, any>;       // The actual configuration
  isGlobal: boolean;                 // true for global, false for project-specific
  version?: string;                  // Config version for migration
  createdAt: Date;
  updatedAt: Date;
  createdBy: 'system' | 'user';
  metadata?: {
    description?: string;
    category?: string;
    dependencies?: string[];        // Other analyzers this depends on
  };
}

/**
 * Audit scope — controls which files are analyzed.
 *
 * - `all`       – default; discover and analyze everything
 * - `changed`   – re-parse indexed files and only analyze functions whose
 *                 content_hash differs from stored, plus new/deleted functions
 * - `git:<ref>` – git diff --name-only <ref> (plus untracked), then
 *                 function-level narrowing as in `changed`
 * - `string[]`  – explicit list of file paths/globs (the `files` scope)
 */
export type AuditScope = 'all' | 'changed' | `git:${string}` | string[];

export interface AuditRunnerOptions extends AuditOptions {
  progressCallback?: (progress: AuditProgress) => void;
  errorCallback?: (error: Error, context: string) => void;
  outputDirectory?: string;
  configName?: string;
  projectRoot?: string;
  analyzerConfigs?: Record<string, any>;
  /** Spec 36 R5 — written justifications for non-default thresholds, keyed `"<analyzer>.<key>"`. */
  rationales?: Record<string, string>;
  /** Shareable presets to apply (Spec 38 R4) — resolved by id via `getPreset`. */
  presets?: string[];
  indexFunctions?: boolean; // Whether to index functions during audit
  analyzerConcurrency?: number; // Number of analyzers to run in parallel
  /** Cooperative cancel (MCP parent or worker soft budget). Checked between analyzers and on progress. */
  abortSignal?: AbortSignal;
  /** Skip glob discovery; analyze exactly these absolute paths. */
  explicitFiles?: string[];
  /**
   * If more files match than this limit, the runner completes one chunk and throws AuditHandoffError
   * with partialResult and remainingFiles so another worker can continue.
   */
  maxFilesPerRun?: number;
  /** Worker IPC only: soft wall-clock budget for a forked shard (not used by in-process runs). */
  shardSoftBudgetMs?: number;
  /** Audit scope: controls which files are analyzed. Default: 'all'. */
  scope?: AuditScope;
  /** Path profiles from config (Spec-20). */
  pathProfiles?: PathProfile[];
  /**
   * Write the run to the findings ledger on completion (Spec 41). Defaults to
   * true. Forked shard workers set this false: the parent run is the single
   * ledger writer — a worker writing the ledger concurrently contends with the
   * parent's `syncFileIndex` (SQLITE_BUSY) and pollutes `listRuns` with stray
   * `completed` rows.
   */
  writeToLedger?: boolean;
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
  body?: string;  // Actual function body content for content search
  content_hash?: string;  // SHA-256 of normalized body + signature for incremental re-audit
  metadata?: {
    // Existing metadata fields
    entityType?: 'function' | 'component';
    componentType?: 'functional' | 'class' | 'memo' | 'forwardRef';
    hooks?: HookUsage[];
    props?: PropDefinition[];
    
    // New dependency fields
    functionCalls?: string[];        // Functions this calls
    calledBy?: string[];            // Functions that call this
    usedImports?: string[];         // Actually used imports
    unusedImports?: string[];       // Imported but not used
    importUsage?: ImportUsageInfo[];
    dependencyDepth?: number;       // Max depth in call chain
    body?: string;                  // Function body content
    
    // Content search fields
    contentMatches?: Array<{ term: string; line: number; column: number }>;  // Matches found during content search
    matchContexts?: Array<{  // Context around matches
      match: { term: string; line: number; column: number };
      context: { before: string[]; line: string; after: string[] };
    }>;
  };
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
    isExported?: boolean;
    complexity?: {
      min?: number;
      max?: number;
    };
    dateRange?: {
      start?: Date;
      end?: Date;
    };
    metadata?: {
      entityType?: string;
      componentType?: string;
      hasHook?: string;
      hasProp?: string;
      // New dependency filters
      usesDependency?: string;
      callsFunction?: string;
      calledByFunction?: string;
      dependsOnModule?: string;
      hasUnusedImports?: boolean;
      // Style intelligence operators (Spec 10)
      cssProperty?: string;
      cssValue?: string;
      styleMechanism?: string;
      styleToken?: string;
    };
  };
  fuzzy?: boolean;
  stemming?: boolean;
  searchFields?: string[];
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
    isExported?: boolean;
    complexity?: {
      min?: number;
      max?: number;
    };
    dateRange?: {
      start?: Date;
      end?: Date;
    };
    metadata?: {
      entityType?: string;
      componentType?: string;
      hasHook?: string;
      hasProp?: string;
      // New dependency filters
      usesDependency?: string;
      callsFunction?: string;
      calledByFunction?: string;
      dependsOnModule?: string;
      hasUnusedImports?: boolean;
    };
  };
  searchStrategy?: 'exact' | 'fuzzy' | 'semantic';
  searchFields?: Array<'name' | 'signature' | 'jsDoc' | 'parameters' | 'returnType' | 'purpose' | 'context'>;
  searchMode?: 'metadata' | 'content' | 'both';  // New field for content search
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
    // Content search results
    contentMatches?: Array<{ term: string; line: number; column: number }>;
    matchContexts?: Array<{
      match: { term: string; line: number; column: number };
      context: { before: string[]; line: string; after: string[] };
    }>;
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

// React Component Types
export interface ComponentMetadata extends FunctionMetadata {
  entityType: 'component';  // Distinguishes from 'function'
  componentType: 'functional' | 'class' | 'memo' | 'forwardRef';
  props?: PropDefinition[];
  hooks?: HookUsage[];
  jsxElements?: string[];  // Direct child elements used
  imports?: ComponentImport[];  // Component dependencies
  hasErrorBoundary?: boolean;
  complexity?: number;
  isExported: boolean;
}

export interface PropDefinition {
  name: string;
  type?: string;
  required: boolean;
  hasDefault: boolean;
}

export interface HookUsage {
  name: string;
  line: number;
  customHook: boolean;
}

export interface ComponentImport {
  name: string;
  path: string;
  isDefault: boolean;
}

// Component Responsibility Types for SRP Detection
export enum ResponsibilityType {
  DataFetching = 'data-fetching',
  FormHandling = 'form-handling',
  UIState = 'ui-state',
  BusinessLogic = 'business-logic',
  SideEffects = 'side-effects',
  EventHandling = 'event-handling',
  Routing = 'routing',
  Authentication = 'authentication',
  Layout = 'layout-styling',
  DataTransformation = 'data-transformation',
  Subscriptions = 'subscriptions',
  ErrorHandling = 'error-handling',
  StateManagement = 'state-management'
}

export interface ComponentResponsibility {
  type: ResponsibilityType;
  indicators: string[];
  severity: 'related' | 'unrelated' | 'mixed';
  line?: number;
  column?: number;
  details?: string;
}

export interface ComponentPattern {
  name: string;
  indicators: PatternIndicator[];
  allowedResponsibilities: ResponsibilityType[];
  relatedResponsibilities?: ResponsibilityType[][];
  complexityMultiplier: number;
  description: string;
}

export interface PatternIndicator {
  type: 'name' | 'path' | 'hooks' | 'props' | 'imports';
  pattern: RegExp | string;
  weight?: number;
}

export interface ComponentPatternConfig {
  patterns: ComponentPattern[];
  customPatterns?: ComponentPattern[];
  enablePatternDetection: boolean;
}

export interface RefactoringSuggestion {
  pattern: 'extract-hook' | 'split-component' | 'container-presenter' | 'compose-components' | 'extract-service';
  description: string;
  example?: string;
  relatedResponsibilities: ResponsibilityType[];
}

export interface ComponentRelationship {
  parentComponent: string;
  childComponent: string;
  usageCount: number;
  importPath: string;
}

export interface ReactViolation extends Violation {
  componentName?: string;
  violationType: 'missing-props' | 'hooks-naming' | 'no-error-boundary' |
                 'complexity' | 'performance' | 'accessibility' | 'raw-element';
}

export interface ReactAnalyzerConfig {
  // Component Detection
  detectFunctionalComponents: boolean;
  detectClassComponents: boolean;
  detectMemoComponents: boolean;
  
  // Quality Checks
  requirePropTypes: boolean;
  requireErrorBoundaries: boolean;
  checkHooksRules: boolean;
  maxComponentComplexity: number;
  
  // Performance
  checkUnnecessaryRerenders: boolean;
  requireMemoization: boolean;
  
  // Best Practices
  checkAccessibility: boolean;
  preventDirectDOMAccess: boolean;
  requireKeyProps: boolean;

  // Raw Element Detection (Spec 10 R4)
  rawElementCheck?: boolean;
  /** Mapping of intrinsic element names to wrapper component names (e.g. {"button": "Button"}). */
  componentMap?: Record<string, string>;
  /** Minimum call sites before a raw-element usage becomes a finding. Default 5. */
  wrapperMinUsages?: number;
  /** Intrinsic elements that trigger raw-element detection. Default ['button', 'input', 'select', 'textarea', 'table']. */
  rawElementWatchList?: string[];
}

// Component Scanner Types
export interface ComponentScanResult {
  filePath: string;
  components: ComponentMetadata[];
  imports: ComponentImport[];
  fileHash?: string;
  parseErrors?: string[];
}

// Dependency Tracking Types
export interface FunctionCall {
  callee: string;           // Function being called
  callType: 'direct' | 'method' | 'dynamic';
  line: number;
  column: number;
  arguments?: number;       // Argument count
}

export interface ImportMapping {
  localName: string;        // Name used in code
  importedName: string;     // Original export name
  modulePath: string;       // Module/file path
  importType: 'named' | 'default' | 'namespace';
  isTypeOnly: boolean;
}

export interface DependencyInfo {
  imports: ImportMapping[];
  functionCalls: FunctionCall[];
  identifierUsage: Map<string, UsageInfo>;
}

export interface UsageInfo {
  usageType: 'direct' | 'type' | 'reexport';
  usageCount: number;
  lineNumbers: number[];
}

export interface ImportUsageInfo {
  importPath: string;
  usageType: 'direct' | 'type' | 'reexport';
  usageCount: number;
  lineNumbers: number[];
}

// Database Schema Types
export interface SchemaColumn {
  name: string;
  type: string;
  nullable?: boolean;
  primaryKey?: boolean;
  defaultValue?: string | number | boolean | null;
  unique?: boolean;
  indexed?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  description?: string;
  enum?: string[];
}

export interface SchemaReference {
  foreignKey: string;           // Column name in this table
  referencedTable: string;      // Target table name
  referencedColumn: string;     // Target column name
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  description?: string;
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: 'btree' | 'hash' | 'gin' | 'gist' | 'text' | 'compound';
  description?: string;
}

export interface SchemaTable {
  name: string;
  type: 'table' | 'collection' | 'view';
  database?: string;
  schema?: string;              // For SQL databases (public, private, etc.)
  columns: SchemaColumn[];
  references: SchemaReference[];
  indexes?: SchemaIndex[];
  constraints?: string[];       // Additional constraints
  description?: string;
  tags?: string[];             // Categories like 'user-data', 'audit', 'cache'
  estimatedRows?: number;
  isTemporary?: boolean;
  partitionKey?: string;       // For NoSQL/distributed databases
}

export interface DatabaseSchema {
  name: string;
  type: 'postgresql' | 'mysql' | 'mongodb' | 'sqlite' | 'redis' | 'dynamodb' | 'other';
  version?: string;
  host?: string;
  port?: number;
  database?: string;
  schemas?: string[];          // Schema namespaces for SQL databases
  tables: SchemaTable[];
  relationships?: SchemaRelationship[];
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
  metadata?: {
    environment?: 'development' | 'staging' | 'production';
    migrations?: string[];
    seeds?: string[];
    backupFrequency?: string;
  };
}

export interface SchemaRelationship {
  id: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  fromTable: string;
  toTable: string;
  fromColumn: string;
  toColumn: string;
  description?: string;
  bidirectional?: boolean;
}

export interface SchemaDefinition {
  version: string;
  name: string;
  description?: string;
  databases: DatabaseSchema[];
  globalReferences?: SchemaReference[];
  metadata?: {
    author?: string;
    createdAt?: Date;
    updatedAt?: Date;
    tags?: string[];
    environment?: string;
  };
}

// Schema Analysis Types
export interface SchemaViolation extends Violation {
  schemaType: 'missing-reference' | 'orphaned-table' | 'table-naming-convention' | 'missing-index' | 'circular-dependency';
  tableName?: string;
  columnName?: string;
  expectedSchema?: string;
  actualSchema?: string;
}

export interface SchemaPattern {
  pattern: 'entity-table' | 'junction-table' | 'audit-table' | 'lookup-table' | 'temporal-table';
  tableNames: string[];
  confidence: number;
  description: string;
}

export interface SchemaUsage {
  tableName: string;
  filePath: string;
  functionName: string;
  usageType: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'reference';
  line: number;
  column?: number;
  rawQuery?: string;
  parameters?: string[];
}

export interface SchemaIndexMetadata {
  schemaId: string;
  schemaName: string;
  indexedAt: Date;
  tableCount: number;
  relationshipCount: number;
  usagePatterns: SchemaUsage[];
  discoveredPatterns: SchemaPattern[];
  violations: SchemaViolation[];
  lastAnalyzed?: Date;
}

// Enhanced function metadata to include schema usage
export interface SchemaAwareFunctionMetadata extends EnhancedFunctionMetadata {
  schemaUsage?: SchemaUsage[];
  affectedTables?: string[];
  schemaPatterns?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// Spec 10 — Style Intelligence Analyzer Config
// ═══════════════════════════════════════════════════════════════════════════

export interface StylesAnalyzerConfig {
  /** Minimum declarations per property before histogram analysis runs. Default 20. */
  minCorpus: number;
  /** Delta-E threshold for color drift detection. Default 2.0. */
  colorDeltaE: number;
  /** Maximum share for outlier values before flagging. Default 0.05. */
  outlierMaxShare: number;
  /** Minimum count for modal value before outliers are flagged. Default 10. */
  modeMinCount: number;
  /** Properties that take scale-family values (margin, padding, gap, font-size). */
  scaleProperties: string[];
  /** Maximum distinct z-index values before flagging. Default 6. */
  zIndexMaxDistinct: number;
  /** Minimum number of mechanisms before fragmentation is flagged. Default 3. */
  mechanismFragmentationMinMechanisms: number;
  /** Minimum declarations in a rule block for similarity analysis. Default 5. */
  declarationSetMinDeclarations: number;
  /** Jaccard similarity threshold for declaration-set matching. Default 0.9. */
  declarationSetSimilarityThreshold: number;
  /** CSS properties excluded from value-drift detection (categorical domains). Spec 22 R3. */
  categoricalPropertyExclusions?: string[];
  /** Known Tailwind utility class names for the undefined-class detector.
   *  When provided, these seed the expander's validation cache, bypassing
   *  the compile-probe (useful in test environments without tailwindcss
   *  installed). In production, the compile-probe is always preferred. */
  tailwindClasses?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Spec 12 — Convention Mining Types
// ═══════════════════════════════════════════════════════════════════════════

/** A mined convention stored in the conventions table. */
export interface Convention {
  id?: number;
  domain: 'usage-pair' | 'import-form' | 'error-handling' | 'export-shape' | 'naming';
  rule_id: string;
  antecedent: string | null;
  consequent: string | null;
  pattern: string | null;
  directory: string | null;
  file_path: string | null;
  line: number | null;
  support: number;
  total_cases: number;
  confidence: number;
  exemplar_file: string | null;
  exemplar_line: number | null;
  /** For naming conventions: the sub-population (react-component, hook, function). */
  export_kind?: string | null;
  hash: string | null;
  created_at?: string;
}

/** Thresholds for the convention miner. */
export interface ConventionMiningConfig {
  /** Minimum cases for a convention to be established. Default 20. */
  minCorpus: number;
  /** Usage-pair co-occurrence confidence threshold. Default 0.9. */
  pairConfidence: number;
  /** Minimum share for a mode to be considered dominant. Default 0.8. */
  modeShare: number;
  /** Cap to avoid unbounded output per domain. Default 200. */
  maxConventionsPerDomain: number;
}

/** Config for the UniversalConventionsAnalyzer (mirrors mining config). */
export interface ConventionsAnalyzerConfig {
  minCorpus: number;
  pairConfidence: number;
  modeShare: number;
  maxConventionsPerDomain: number;
}

// Spec 13 — Hotspots & Temporal Analysis
// ═══════════════════════════════════════════════════════════════════════════

/** Config for git churn extraction. */
export interface ChurnConfig {
  /** Lookback window for git history in months. Default 12. */
  churnWindowMonths: number;
}

/** A single hotspot entry — file or function with its churn×complexity score. */
export interface HotspotEntry {
  /** File path (repo-relative) or function identifier. */
  target: string;
  /** Type discriminator: 'file' or 'function'. */
  type: 'file' | 'function';
  /** Hotspot score [0,1] — product of churn and complexity percentiles. */
  score: number;
  /** File churn percentile [0,1]. */
  churnPercentile: number;
  /** Complexity percentile [0,1]. */
  complexityPercentile: number;
  /** Number of commits touching this target. */
  commitCount: number;
  /** Number of distinct authors. */
  distinctAuthors: number;
  /** Author with the most commits. */
  dominantAuthor: string;
  /** Share of commits by the dominant author [0,1]. */
  dominantAuthorShare: number;
  /** Bus-factor risk: true if dominant_author_share ≥ 0.9. */
  busFactorRisk: boolean;
  /** Complexity value (raw, not percentile). */
  complexity: number;
}

/** Summary of trend changes between two full-audit runs of the same target. */
export interface TrendSummary {
  /** The target directory these trends are for. */
  target: string;
  /** Time range covered — [earliest run timestamp, latest run timestamp]. */
  range: [string, string];
  /** Run IDs used for comparison (ordered oldest→newest). */
  comparedRunIds: string[];
  /** Per-rule trend counts. */
  rules: Record<string, {
    /** Findings present in run N but absent in run N-1. */
    newCount: number;
    /** Findings absent in run N but present in run N-1. */
    fixedCount: number;
    /** fixedCount - newCount. Negative means net increase. */
    net: number;
  }>;
}

/** Config for diverging-clone detection (R5). */
export interface DivergenceConfig {
  /** Minimum similarity drop to flag divergence. Default 0.05. */
  divergenceThreshold: number;
  /** Number of consecutive declining runs before flagging. Default 2. */
  divergenceRuns: number;
  /** Minimum Jaccard similarity to seed a pair for tracking. Default 0.5. */
  minPairSimilarity: number;
}

// Spec 21 — Language-Neutral Detection / Provenance
// ═══════════════════════════════════════════════════════════════════════════

/** Detection mode for DB/validator receiver identification (Spec 21 R3). */
export type DetectionMode = 'hybrid' | 'provenance' | 'names';

/** Shared detection config consumed by provenance module, schema, and data-access analyzers. */
export interface DetectionConfig {
  mode: DetectionMode;
}

// Spec 14 — Graph & Architecture Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** Per-function risk ranking entry (Spec 14 R2). */
export interface RiskEntry {
  functionName: string;
  filePath: string;
  pageRankPercentile: number;
  betweennessPercentile: number;
  complexityPercentile: number;
  untested: boolean;
  riskScore: number;
}

/** Directory-level community purity (Spec 14 R3). */
export interface DirectoryPurity {
  directory: string;
  totalFiles: number;
  pluralityCommunity: number;
  pluralityCount: number;
  purity: number;
}

/** Martin metrics per directory/package (Spec 14 R4). */
export interface MartinEntry {
  directory: string;
  ce: number;
  ca: number;
  instability: number;
  abstractness: number;
  distanceFromMain: number;
}

/** Blast-radius impact estimate for hook path (Spec 14 R6). */
export interface BlastRadiusImpact {
  editedFunctionCount: number;
  transitiveCallers: number;
  reachableExports: number;
  depthReached: number;
  latencyMs: number;
}

/** Summarized graph statistics (Spec 14 R1). */
export interface GraphStats {
  callNodes: number;
  callEdges: number;
  unresolvedCalls: number;
  unresolvedShare: number;
  importNodes: number;
  importEdges: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Spec 15 — Cross-Domain Join Types
// ═══════════════════════════════════════════════════════════════════════════

/** Extracted table reference from ORM adapter (feeds schema_usage). */
export interface OrmTableReference {
  tableName: string;
  usageType: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'reference';
  filePath: string;
  functionName?: string;
  line: number;
  column?: number;
  rawQuery?: string;
  parameters?: string[];
}

/** ORM adapter contract — same shape as LanguageAdapter registry. */
export interface OrmAdapter {
  /** Unique adapter name (e.g. "drizzle", "prisma"). */
  readonly name: string;
  /** File globs this adapter handles. */
  readonly filePatterns: string[];
  /** Extract table references from source code (query-builder patterns). */
  extractTableReferences(source: string, filePath: string): OrmTableReference[];
  /** Extract schema definitions from source code (schema/model declarations). */
  extractSchemaDefinitions(source: string, filePath: string): SchemaTable[];
}

/** Config for schema lifecycle detectors (R1). */
export interface SchemaLifecycleConfig {
  /** Enable written-never-read detection. Default true. */
  enableWrittenNeverRead: boolean;
  /** Enable read-never-written detection. Default true. */
  enableReadNeverWritten: boolean;
  /** Enable transaction-boundary risk detection. Default true. */
  enableTransactionBoundaryRisk: boolean;
  /** Max distinct tables a function can write before flagging txn-boundary risk. Default 4. */
  txnTableMax: number;
}

/** Config for validation-bypass detection (R3). */
export interface ValidatorBypassConfig {
  /** User-configured validator function names or "path#name". */
  validators: string[];
  /** Minimum share of peer writers that must reach a validator. Default 0.8. */
  modeShare: number;
  /** Minimum directory corpus size before detection activates. Default 20. */
  minCorpus: number;
  /** BFS depth limit in call graph for validator reach. Default 3. */
  depth: number;
}

/** Config for coverage-by-importance (R4). */
export interface CoverageConfig {
  /** Glob patterns identifying test files. Default ['**\/*.test.*', '**\/*.spec.*', '**\/__tests__/**']. */
  testGlobs: string[];
  /** BFS depth from test files for static-reach coverage. Default 2. */
  staticReachDepth: number;
  /** Fraction of top-risk functions to flag when untested. Default 0.1. */
  topRiskDecile: number;
}

/** Aggregate config for the cross-domain analyzer (R1+R3+R4). */
export interface CrossDomainConfig {
  schemaLifecycle: SchemaLifecycleConfig;
  validatorBypass: ValidatorBypassConfig;
  coverage: CoverageConfig;
}

/** A row in the coverage_data table. */
export interface CoverageEntry {
  functionName: string;
  filePath: string;
  lineNumber: number;
  /** Which coverage basis was used. */
  basis: 'static-reach' | 'measured';
  /** Whether this function is covered. */
  covered: boolean;
  /** For measured coverage: source file path (lcov .info or istanbul JSON). */
  source?: string;
  /** When this entry was imported (measured basis only). */
  importedAt?: string;
}

/** Coverage report returned by coverage --by-risk (R4). */
export interface CoverageReport {
  totalFunctions: number;
  coveredFunctions: number;
  coverageRate: number;
  byRiskDecile: Array<{
    decile: number;
    covered: number;
    total: number;
    rate: number;
  }>;
  untestedTopDecile: Array<{
    functionName: string;
    filePath: string;
    riskScore: number;
    basis: 'static-reach' | 'measured';
  }>;
  /** Whether imported coverage data is stale (older than last full sync). */
  staleImport: boolean;
}

/** Validator set entry for config inspectability (R3). */
export interface ValidatorEntry {
  /** Function name or "file#name". */
  name: string;
  /** How this validator was discovered. */
  basis: 'user-config' | 'provenance' | 'heuristic-match';
  /** For provenance basis: the package that sourced it (e.g. "zod"). */
  source?: string;
  /** For heuristic-match basis: confidence is "downgraded". */
  confidence?: 'high' | 'downgraded';
  /** File path where this validator is defined. */
  filePath?: string;
}

// Re-export whitelist types
export * from './types/whitelist.js';