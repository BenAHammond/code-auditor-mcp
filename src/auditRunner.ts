/**
 * Audit Runner (Functional)
 * Main orchestrator for running code audits
 */

import { promises as fs } from 'fs';
import { statSync, readFileSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  AuditResult,
  AuditRunnerOptions,
  AnalyzerDefinition,
  AnalyzerResult,
  Violation,
  AuditProgress,
  FunctionMetadata,
  AuditResultScope,
  AuditAbortedError,
  AuditHandoffError,
} from './types.js';
import { discoverFiles } from './utils/fileDiscovery.js';
import { loadConfig } from './config/configLoader.js';
import { generateReport } from './reporting/reportGenerator.js';
import { extractFunctionsFromFile } from './functionScanner.js';
import { isMcpDebugEnabled, logMcpDebug, logMcpInfo } from './mcpDiagnostics.js';

// Import universal analyzers
import { initializeLanguages } from './languages/index.js';
import { UniversalSOLIDAnalyzer } from './analyzers/universal/UniversalSOLIDAnalyzer.js';
import { UniversalDRYAnalyzer } from './analyzers/universal/UniversalDRYAnalyzer.js';
import { UniversalDataAccessAnalyzer } from './analyzers/universal/UniversalDataAccessAnalyzer.js';
import { UniversalDocumentationAnalyzer } from './analyzers/universal/UniversalDocumentationAnalyzer.js';
import { UniversalSchemaAnalyzer } from './analyzers/universal/UniversalSchemaAnalyzer.js';
import { reactAnalyzer } from './analyzers/reactAnalyzer.js';
import { invariantsAnalyzer } from './analyzers/invariantsAnalyzer.js';
import { hasRules } from './invariants/ruleEngine.js';
import { CodeIndexDB } from './codeIndexDB.js';

// Initialize the canonical language system once
initializeLanguages();

/**
 * Shared progress callback adapter: translates universal analyzer's (number) into
 * the object-based callback that auditRunner passes downstream.
 */
function createProgressAdapter(
  analyzerName: string,
  progressCallback?: import('./types.js').ProgressCallback
): ((progress: number) => void) | undefined {
  if (!progressCallback) return undefined;
  return (progress: number) => {
    progressCallback({
      current: Math.floor(progress * 100),
      total: 100,
      analyzer: analyzerName,
      phase: 'analyzing',
    });
  };
}

/**
 * Default analyzer registry
 */
const DEFAULT_ANALYZERS: Record<string, AnalyzerDefinition> = {
  'solid': {
    name: 'solid',
    description: 'Detects violations of SOLID principles',
    category: 'architecture',
    analyze: async (files, config, options, progressCallback) => {
      const analyzer = new UniversalSOLIDAnalyzer();
      const universalConfig: Record<string, unknown> = { skipTestFiles: true };
      if (config.maxMethodsPerClass !== undefined) universalConfig.maxMethodsPerClass = config.maxMethodsPerClass;
      if (config.maxLinesPerMethod !== undefined) universalConfig.maxLinesPerMethod = config.maxLinesPerMethod;
      if (config.maxParametersPerMethod !== undefined) universalConfig.maxParametersPerMethod = config.maxParametersPerMethod;
      if (config.maxClassComplexity !== undefined) universalConfig.maxClassComplexity = config.maxClassComplexity; // deprecated — use maxMethodComplexity
      // R5.1: Per-method cyclomatic complexity (true McCC)
      if (config.maxMethodComplexity !== undefined) universalConfig.maxMethodComplexity = config.maxMethodComplexity;
      // R5.2: Class-level aggregation thresholds
      if (config.classMethodsThreshold !== undefined) universalConfig.classMethodsThreshold = config.classMethodsThreshold;
      if (config.classAggregateComplexity !== undefined) universalConfig.classAggregateComplexity = config.classAggregateComplexity;
      if (config.maxInterfaceMembers !== undefined) universalConfig.maxInterfaceMembers = config.maxInterfaceMembers;
      if (config.checkDependencyInversion !== undefined) universalConfig.checkDependencyInversion = config.checkDependencyInversion;
      if (config.checkInterfaceSegregation !== undefined) universalConfig.checkInterfaceSegregation = config.checkInterfaceSegregation;
      if (config.checkLiskovSubstitution !== undefined) universalConfig.checkLiskovSubstitution = config.checkLiskovSubstitution;
      const result = await analyzer.analyze(files, universalConfig, {
        progressCallback: createProgressAdapter('solid', progressCallback),
        ...options as Record<string, unknown>,
      });
      return {
        ...result,
        violations: result.violations.map(v => ({
          ...v,
          principle: v.rule,
          analyzer: 'solid',
        })),
      };
    },
  },
  'dry': {
    name: 'dry',
    description: 'Detects code duplication across the codebase',
    category: 'maintainability',
    analyze: async (files, config, options, progressCallback) => {
      const analyzer = new UniversalDRYAnalyzer();
      return analyzer.analyze(files, config, {
        progressCallback: createProgressAdapter('dry', progressCallback),
        ...options as Record<string, unknown>,
      });
    },
  },
  'data-access': {
    name: 'data-access',
    description: 'Analyzes database access patterns and data layer interactions',
    category: 'security',
    analyze: async (files, config, options, progressCallback) => {
      const analyzer = new UniversalDataAccessAnalyzer();
      const universalConfig: Record<string, unknown> = {};
      if (config.databases !== undefined) universalConfig.databases = config.databases;
      if (config.organizationPatterns !== undefined) universalConfig.organizationPatterns = config.organizationPatterns;
      if (config.tablePatterns !== undefined) universalConfig.tablePatterns = config.tablePatterns;
      if (config.performanceThresholds !== undefined) universalConfig.performanceThresholds = config.performanceThresholds;
      if (config.securityPatterns !== undefined) universalConfig.securityPatterns = config.securityPatterns;
      if (config.checkOrgFilters !== undefined) universalConfig.checkOrgFilters = config.checkOrgFilters;
      if (config.checkSQLInjection !== undefined) universalConfig.checkSQLInjection = config.checkSQLInjection;
      if (config.checkPerformance !== undefined) universalConfig.checkPerformance = config.checkPerformance;
      // R4.3: directAccess — "flag" (default) or "allow"
      if (config.directAccess !== undefined) universalConfig.directAccess = config.directAccess;
      return analyzer.analyze(files, universalConfig, {
        progressCallback: createProgressAdapter('data-access', progressCallback),
        ...options as Record<string, unknown>,
      });
    },
  },
  'react': reactAnalyzer,
  'documentation': {
    name: 'documentation',
    description: 'Analyzes documentation quality across the codebase',
    category: 'documentation',
    analyze: async (files, config, options, progressCallback) => {
      const analyzer = new UniversalDocumentationAnalyzer();
      const universalConfig = {
        requireFunctionDocs: config.requireFunctionDocs ?? true,
        requireClassDocs: config.requireComponentDocs ?? true,
        // requireFileDocs is DEPRECATED — use fileHeaders instead (default false per R1.5)
        requireFileDocs: config.requireFileDocs ?? true, // kept for back-compat
        requireParamDocs: config.requireParamDocs ?? true,
        requireReturnDocs: config.requireReturnDocs ?? true,
        minDescriptionLength: config.minDescriptionLength ?? 10,
        // checkExportedOnly is DEPRECATED — use scope instead
        checkExportedOnly: config.checkExportedOnly ?? false,
        exemptPatterns: config.exemptPatterns ?? ['test', 'spec', '\\.d\\.ts$', 'mock', 'fixture'],
        // Spec-17 additions
        scope: config.scope ?? 'public',                                    // R1.2, R1.4
        docsMinLines: config.docsMinLines ?? 5,                             // R1.3
        fileHeaders: config.fileHeaders ?? config.requireFileDocs ?? false,  // R1.5
        headerSkipGlobs: config.headerSkipGlobs,                            // R1.5 (undefined → analyzer default)
      };
      return analyzer.analyze(files, universalConfig, {
        progressCallback: createProgressAdapter('documentation', progressCallback),
        ...options as Record<string, unknown>,
      });
    },
  },
  'invariants': invariantsAnalyzer,
  'schema': {
    name: 'schema',
    description: 'Analyzes code against database schemas',
    category: 'database',
    analyze: async (files, config, options, progressCallback) => {
      const analyzer = new UniversalSchemaAnalyzer();
      let schemas: unknown[] = [];
      try {
        const db = CodeIndexDB.getInstance();
        await db.initialize();
        const loadedSchemas = await db.getAllSchemas();
        schemas = loadedSchemas.map((loaded) => {
          const schema = loaded.schema as { name: string; databases: Array<{ tables: Array<{ name: string; columns?: unknown[] }> }> };
          return {
            name: schema.name,
            tables: schema.databases.flatMap((database) =>
              database.tables.map((table) => ({
                name: table.name,
                columns: table.columns || [],
              }))
            ),
          };
        });
      } catch {
        // If database isn't available, continue without schemas
      }
      const universalConfig = {
        enableTableUsageTracking: config.enableTableUsageTracking ?? true,
        checkMissingReferences: config.checkMissingReferences ?? true,
        checkNamingConventions: config.checkNamingConventions ?? true,
        detectUnusedTables: config.detectUnusedTables ?? false,
        validateQueryPatterns: config.validateQueryPatterns ?? true,
        maxQueriesPerFunction: config.maxQueriesPerFunction ?? 5,
        requiredSchemas: config.requiredSchemas ?? [],
        schemas,
        // Spec-17 R2 additions — AST-based SQL context detection
        sqlTagNames: config.sqlTagNames ?? ['sql', 'db'],                 // R2.1
        dbReceiverNames: config.dbReceiverNames,                           // R2.2 (let analyzer use defaults)
        dbCallMethods: config.dbCallMethods,                               // R2.2
        dbBindingNames: config.dbBindingNames ?? ['env.DB'],               // R2.2
        fileGateGlobs: config.fileGateGlobs,                               // R2.2 (let analyzer use defaults)
      };
      const result = await analyzer.analyze(files, universalConfig);
      return {
        ...result,
        violations: result.violations.map(v => ({
          ...v,
          schemaType: v.rule,
          details: v.message,
          analyzer: 'schema',
        })),
      };
    },
  },
};

/**
 * Create an audit runner with the given options
 */
export function createAuditRunner(options: AuditRunnerOptions = {}) {
  const analyzerRegistry = { ...DEFAULT_ANALYZERS };
  
  /**
   * Register a custom analyzer
   */
  function registerAnalyzer(analyzer: AnalyzerDefinition): void {
    analyzerRegistry[analyzer.name] = analyzer;
  }
  
  /**
   * Load configuration from file
   */
  async function loadConfiguration(configPath: string): Promise<AuditRunnerOptions> {
    const config = await loadConfig({ configPath });
    return { ...options, ...config };
  }
  
  /**
   * Run the audit
   */
  async function run(runOptions?: AuditRunnerOptions): Promise<AuditResult> {
    const mergedOptions = { ...options, ...runOptions };
    const startTime = Date.now();

    // ── Scope resolution ─────────────────────────────────────────────
    const scope = mergedOptions.scope ?? 'all';
    const isScoped = scope !== 'all';
    const scopeResultType: AuditResultScope = isScoped ? 'scoped' : 'full';

    reportProgress(mergedOptions, {
      phase: 'discovery',
      message: `Discovering files... (scope: ${scopeResultType})`
    });

    // Discover files based on scope
    let files: string[];
    let changedFunctions: FunctionMetadata[] | undefined;

    if (typeof scope === 'string' && scope.startsWith('git:')) {
      // git:<ref> scope
      const gitRef = scope.slice(4);
      files = resolveGitScopeFiles(mergedOptions, gitRef);
      logMcpInfo('discovery', 'git scope resolved', {
        ref: gitRef,
        fileCount: files.length
      });
    } else if (scope === 'changed') {
      // Changed scope: detect modified files
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const modifiedFiles = mergedOptions.explicitFiles?.length
        ? mergedOptions.explicitFiles
        : await db.detectModifiedFiles(
            path.resolve(mergedOptions.projectRoot || process.cwd())
          );
      files = [...new Set(modifiedFiles.map((f) => path.resolve(f)))].sort();
      logMcpInfo('discovery', 'changed scope resolved', {
        fileCount: files.length
      });
    } else if (Array.isArray(scope)) {
      // files scope: explicit file paths/globs
      files = await resolveFilesScope(mergedOptions, scope);
      logMcpInfo('discovery', 'files scope resolved', {
        fileCount: files.length
      });
    } else {
      // all scope: current behavior
      files = await discoverProjectFiles(mergedOptions);
    }

    throwIfAborted(mergedOptions.abortSignal);

    // Detect changed functions for non-all scopes
    if (isScoped && files.length > 0) {
      try {
        const db = CodeIndexDB.getInstance();
        await db.initialize();
        const detection = await db.detectChangedFunctions(files);
        changedFunctions = detection.changedFunctions;
        logMcpInfo('discovery', 'changed function detection', {
          changedFunctionCount: changedFunctions.length,
          deletedCount: detection.deletedFunctions.length,
          errors: detection.errors.length
        });
      } catch (err) {
        logMcpInfo('discovery', 'changed function detection failed (continuing)', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const handoffRemaining: string[] = [];
    const maxPerRun = mergedOptions.maxFilesPerRun;
    if (typeof maxPerRun === 'number' && maxPerRun > 0 && files.length > maxPerRun) {
      handoffRemaining.push(...files.slice(maxPerRun));
      files = files.slice(0, maxPerRun);
    }

    const root = mergedOptions.projectRoot || process.cwd();
    logMcpInfo('discovery', 'file discovery finished', {
      projectRoot: path.resolve(root),
      totalFiles: files.length,
      scope: scopeResultType,
      indexFunctions: !!mergedOptions.indexFunctions
    });

    // Collect functions if enabled
    let collectedFunctions: FunctionMetadata[] = [];
    const fileToFunctionsMap = new Map<string, FunctionMetadata[]>(); // Track functions per file for sync

    if (mergedOptions.indexFunctions) {
      reportProgress(mergedOptions, {
        phase: 'function-indexing',
        message: 'Collecting functions from files...'
      });

      // Collect functions from TypeScript/JavaScript files
      // Note: Go files will be indexed by the Universal SOLID analyzer directly
      const scriptFiles = files.filter(f =>
        f.endsWith('.ts') || f.endsWith('.tsx') ||
        f.endsWith('.js') || f.endsWith('.jsx')
      );

      logMcpInfo('function-indexing', 'extracting functions from script files', {
        scriptFileCount: scriptFiles.length
      });

      for (let i = 0; i < scriptFiles.length; i++) {
        try {
          if (i % 10 === 0) {
            throwIfAborted(mergedOptions.abortSignal);
          }
          if (i > 0 && i % 50 === 0) {
            logMcpInfo('function-indexing', 'progress', {
              current: i,
              total: scriptFiles.length
            });
          }
          const fileFunctions = await extractFunctionsFromFile(scriptFiles[i], {
            unusedImportsConfig: mergedOptions.unusedImportsConfig
          });
          collectedFunctions.push(...fileFunctions);
          fileToFunctionsMap.set(scriptFiles[i], fileFunctions); // Store for sync

          reportProgress(mergedOptions, {
            phase: 'function-indexing',
            current: i + 1,
            total: scriptFiles.length,
            message: `Collected ${fileFunctions.length} items from ${scriptFiles[i]}`
          });
          if (isMcpDebugEnabled()) {
            logMcpDebug('function-indexing', scriptFiles[i], {
              symbols: fileFunctions.length
            });
          }
        } catch (error) {
          logMcpInfo('function-indexing', 'extract failed (continuing)', {
            file: scriptFiles[i],
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    // ── Build full function index for scoped DRY ─────────────────────
    // When scope is not 'all', DRY must compare scoped functions against
    // the full index so new duplicates are caught (R2.2).
    let fullFunctionIndex: FunctionMetadata[] | undefined;
    if (isScoped) {
      try {
        const db = CodeIndexDB.getInstance();
        fullFunctionIndex = await db.getAllFunctions();
        logMcpInfo('analysis', 'loaded full function index for scoped DRY', {
          functionCount: fullFunctionIndex.length
        });
      } catch (err) {
        // Non-fatal: DRY will just run within scope
        logMcpInfo('analysis', 'failed to load full index for DRY (continuing)', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Run analyzers
    const analyzerResults: Record<string, AnalyzerResult> = {};
    const enabledAnalyzers = getEnabledAnalyzers(mergedOptions, analyzerRegistry);
    logMcpInfo('analysis', 'enabled analyzers', {
      names: enabledAnalyzers,
      fileCount: files.length,
      scope: scopeResultType
    });
    logMcpDebug('analysis', 'registry keys', { keys: Object.keys(analyzerRegistry) });

    const requestedConcurrency = Number(mergedOptions.analyzerConcurrency);
    const analyzerConcurrency =
      Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.min(Math.floor(requestedConcurrency), enabledAnalyzers.length || 1)
        : 1;
    logMcpInfo('analysis', 'analyzer concurrency', { analyzerConcurrency });

    let cursor = 0;
    const runAnalyzer = async (): Promise<void> => {
      while (true) {
        throwIfAborted(mergedOptions.abortSignal);
        const index = cursor++;
        if (index >= enabledAnalyzers.length) return;
        const analyzerName = enabledAnalyzers[index];
        const analyzer = analyzerRegistry[analyzerName];
        logMcpDebug('analysis', `starting analyzer ${analyzerName}`, { found: !!analyzer });
        if (!analyzer) {
          logMcpInfo('analysis', `unknown analyzer skipped: ${analyzerName}`, {});
          continue;
        }

        reportProgress(mergedOptions, {
          phase: 'analysis',
          analyzer: analyzerName,
          message: `Running ${analyzerName} analyzer...`
        });

        // Build analyzer config; inject full index for DRY on scoped runs
        const analyzerConfig = { ...(mergedOptions.analyzerConfigs?.[analyzerName] || {}) };
        if (analyzerName === 'dry' && isScoped && fullFunctionIndex) {
          analyzerConfig.fullFunctionIndex = fullFunctionIndex;
        }

        logMcpInfo('analysis', `running ${analyzerName}`, { fileCount: files.length });
        try {
          const result = await analyzer.analyze(
            files,
            analyzerConfig,
            mergedOptions,
            (progress) => {
              throwIfAborted(mergedOptions.abortSignal);
              reportProgress(mergedOptions, {
                phase: 'analysis',
                analyzer: analyzerName,
                current: progress.current,
                total: progress.total,
                message: `Analyzing ${progress.file}...`
              });
              if (isMcpDebugEnabled() && progress.current && progress.total) {
                if (progress.current % 100 === 0 || progress.current === progress.total) {
                  logMcpDebug('analysis', `${analyzerName} file progress`, {
                    current: progress.current,
                    total: progress.total,
                    file: progress.file
                  });
                }
              }
            }
          );
          logMcpDebug('analysis', `${analyzerName} completed`, {
            violations: result.violations?.length ?? 0
          });
          throwIfAborted(mergedOptions.abortSignal);
          analyzerResults[analyzerName] = result;
        } catch (error) {
          if (error instanceof AuditAbortedError || error instanceof AuditHandoffError) {
            throw error;
          }
          reportError(mergedOptions, error as Error, `${analyzerName} analyzer`);
          analyzerResults[analyzerName] = {
            violations: [],
            filesProcessed: 0,
            executionTime: 0,
            errors: [{ file: 'analyzer', error: (error as Error).message }]
          };
        }
      }
    };

    await Promise.all(Array.from({ length: analyzerConcurrency }, () => runAnalyzer()));

    const orderedAnalyzerResults: Record<string, AnalyzerResult> = {};
    for (const analyzerName of enabledAnalyzers) {
      if (analyzerResults[analyzerName]) {
        orderedAnalyzerResults[analyzerName] = analyzerResults[analyzerName];
      }
    }

    // Generate summary
    const summary = generateSummary(orderedAnalyzerResults, files.length);

    // Create result
    const result: AuditResult = {
      timestamp: new Date(),
      summary,
      analyzerResults: orderedAnalyzerResults,
      recommendations: [],
      metadata: {
        auditDuration: Date.now() - startTime,
        filesAnalyzed: files.length,
        analyzersRun: enabledAnalyzers,
        configUsed: mergedOptions,
        scope: scopeResultType,
        ...(collectedFunctions.length > 0 && {
          collectedFunctions,
          fileToFunctionsMap: Object.fromEntries(fileToFunctionsMap)
        })
      }
    };
    
    // Report completion
    reportProgress(mergedOptions, {
      phase: 'reporting',
      message: 'Generating reports...'
    });

    if (handoffRemaining.length > 0) {
      throw new AuditHandoffError(
        `${handoffRemaining.length} file(s) deferred to the next worker chunk`,
        result,
        handoffRemaining
      );
    }

    return result;
  }
  
  /**
   * Generate report in specified format
   */
  async function generateReportForResult(result: AuditResult, format: string): Promise<string> {
    return generateReport(result, format as any);
  }
  
  return {
    registerAnalyzer,
    loadConfiguration,
    run,
    generateReport: generateReportForResult
  };
}

/**
 * Discover files to analyze
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const r = signal.reason;
  if (r instanceof Error) {
    throw r;
  }
  throw new AuditAbortedError(String(r ?? 'Audit aborted'));
}

async function discoverProjectFiles(options: AuditRunnerOptions): Promise<string[]> {
  const rootDir = path.resolve(options.projectRoot || process.cwd());
  if (options.explicitFiles && options.explicitFiles.length > 0) {
    return [...new Set(options.explicitFiles.map((f) => path.resolve(f)))].sort();
  }
  return discoverFiles(rootDir, {
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
    extensions: options.fileExtensions, // Use override if provided
    excludeDirs: undefined // This will use DEFAULT_EXCLUDED_DIRS which includes node_modules
  });
}

/**
 * Resolve git:<ref> scope: get files from `git diff --name-only <ref>`
 * plus untracked files. Requires a git worktree.
 */
function resolveGitScopeFiles(options: AuditRunnerOptions, ref: string): string[] {
  const rootDir = path.resolve(options.projectRoot || process.cwd());

  // Verify git worktree
  try {
    execSync('git rev-parse --git-dir', { cwd: rootDir, stdio: 'pipe' });
  } catch {
    throw new Error(
      `git:<ref> scope requires a git worktree. "${rootDir}" is not a git repository.`
    );
  }

  const files = new Set<string>();

  // git diff --name-only <ref>
  try {
    const diffOutput = execSync(`git diff --name-only ${ref}`, {
      cwd: rootDir,
      stdio: 'pipe',
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });
    for (const line of diffOutput.trim().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(path.resolve(rootDir, trimmed));
    }
  } catch (err) {
    throw new Error(
      `Failed to run git diff --name-only ${ref}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Untracked files
  try {
    const untrackedOutput = execSync('git ls-files --others --exclude-standard', {
      cwd: rootDir,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    for (const line of untrackedOutput.trim().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(path.resolve(rootDir, trimmed));
    }
  } catch {
    // No untracked files or git error — non-fatal
  }

  return [...files].sort();
}

/**
 * Resolve files scope: paths can be file paths or globs.
 * Absolute paths are used directly; relative paths are resolved
 * against the project root; globs use discoverFiles.
 */
async function resolveFilesScope(
  options: AuditRunnerOptions,
  scopeFiles: string[]
): Promise<string[]> {
  const rootDir = path.resolve(options.projectRoot || process.cwd());
  const result = new Set<string>();

  for (const item of scopeFiles) {
    if (item.includes('*') || item.includes('?') || item.includes('[')) {
      // Glob pattern
      const matches = await discoverFiles(rootDir, {
        includePaths: [item],
        excludePaths: options.excludePaths,
        extensions: options.fileExtensions,
        excludeDirs: undefined
      });
      for (const m of matches) result.add(m);
    } else {
      // Direct file path
      const resolved = path.isAbsolute(item) ? item : path.resolve(rootDir, item);
      result.add(resolved);
    }
  }

  return [...result].sort();
}

/**
 * Check whether a .codeauditor.json at the given directory has invariant rules.
 */
function hasInvariantRules(projectDir: string): boolean {
  try {
    const rulesPath = path.join(projectDir, '.codeauditor.json');
    if (!statSync(rulesPath).isFile()) return false;
    const raw = readFileSync(rulesPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.rules) && parsed.rules.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get list of enabled analyzers
 */
function getEnabledAnalyzers(
  options: AuditRunnerOptions,
  registry: Record<string, AnalyzerDefinition>
): string[] {
  // Explicit array (including empty = run no analyzers, e.g. index-only harness)
  if (options.enabledAnalyzers !== undefined) {
    return options.enabledAnalyzers;
  }

  const allAnalyzers = Object.keys(registry);

  // Auto-disable invariants when no rules are configured (Spec 05 R3.1)
  const projectDir = options.projectRoot || process.cwd();
  if (!hasRules(options) && !hasInvariantRules(projectDir)) {
    return allAnalyzers.filter(a => a !== 'invariants');
  }

  return allAnalyzers;
}

/**
 * Generate audit summary
 */
function generateSummary(analyzerResults: Record<string, AnalyzerResult>, filesAnalyzed: number) {
  let totalViolations = 0;
  let criticalIssues = 0;
  let warnings = 0;
  let suggestions = 0;
  const violationsByCategory: Record<string, number> = {};

  for (const [analyzer, result] of Object.entries(analyzerResults)) {
    for (const violation of result.violations) {
      totalViolations++;

      switch (violation.severity) {
        case 'critical':
          criticalIssues++;
          break;
        case 'warning':
          warnings++;
          break;
        case 'suggestion':
          suggestions++;
          break;
      }

      const category = violation.type || analyzer;
      violationsByCategory[category] = (violationsByCategory[category] || 0) + 1;
    }
  }

  // Compute top issues from violationsByCategory
  const topIssues = Object.entries(violationsByCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  return {
    totalFiles: filesAnalyzed,
    totalViolations,
    criticalIssues,
    warnings,
    suggestions,
    violationsByCategory,
    topIssues
  };
}

/**
 * Report progress
 */
function reportProgress(options: AuditRunnerOptions, progress: Partial<AuditProgress>): void {
  if (options.progressCallback) {
    options.progressCallback({
      current: 0,
      total: 0,
      analyzer: '',
      ...progress
    } as AuditProgress);
  }
}

/**
 * Report error
 */
function reportError(options: AuditRunnerOptions, error: Error, context: string): void {
  if (options.errorCallback) {
    options.errorCallback(error, context);
  } else {
    console.error(`Error in ${context}:`, error);
  }
}

/**
 * Run audit with default runner (convenience function)
 */
export async function runAudit(options?: AuditRunnerOptions): Promise<AuditResult> {
  const runner = createAuditRunner(options);
  return runner.run();
}

export type { AuditProgress, AuditRunnerOptions } from './types.js';