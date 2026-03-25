/**
 * Audit Runner (Functional)
 * Main orchestrator for running code audits
 */

import { promises as fs } from 'fs';
import path from 'path';
import { 
  AuditResult, 
  AuditRunnerOptions, 
  AnalyzerDefinition,
  AnalyzerResult,
  Violation,
  AuditProgress,
  FunctionMetadata,
  AuditAbortedError,
  AuditHandoffError,
} from './types.js';
import { discoverFiles } from './utils/fileDiscovery.js';
import { loadConfig } from './config/configLoader.js';
import { generateReport } from './reporting/reportGenerator.js';
import { extractFunctionsFromFile } from './functionScanner.js';
import { isMcpDebugEnabled, logMcpDebug, logMcpInfo } from './mcpDiagnostics.js';

// Import analyzer definitions
// Use compatibility layers for refactored analyzers
import { createSOLIDAnalyzer } from './adapters/solidAnalyzerCompat.js';
import { dryAnalyzer } from './analyzers/dryAnalyzerCompat.js';
// import { securityAnalyzer } from './analyzers/securityAnalyzer.js';
// import { componentAnalyzer } from './analyzers/componentAnalyzer.js';
import { dataAccessAnalyzer } from './analyzers/dataAccessAnalyzerCompat.js';
import { reactAnalyzer } from './analyzers/reactAnalyzer.js'; // Keep legacy React analyzer
import { documentationAnalyzer } from './analyzers/documentationAnalyzerCompat.js';
import { schemaAnalyzer } from './analyzers/schemaAnalyzerCompat.js';

/**
 * Default analyzer registry
 */
const DEFAULT_ANALYZERS: Record<string, AnalyzerDefinition> = {
  'solid': createSOLIDAnalyzer(),
  'dry': dryAnalyzer,
  // 'security': securityAnalyzer,
  // 'component': componentAnalyzer,
  'data-access': dataAccessAnalyzer,
  'react': reactAnalyzer,
  'documentation': documentationAnalyzer,
  'schema': schemaAnalyzer
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
    
    // Report progress
    reportProgress(mergedOptions, {
      phase: 'discovery',
      message: 'Discovering files...'
    });
    
    // Discover files
    let files = await discoverProjectFiles(mergedOptions);
    throwIfAborted(mergedOptions.abortSignal);

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
    
    // Run analyzers
    const analyzerResults: Record<string, AnalyzerResult> = {};
    const enabledAnalyzers = getEnabledAnalyzers(mergedOptions, analyzerRegistry);
    logMcpInfo('analysis', 'enabled analyzers', {
      names: enabledAnalyzers,
      fileCount: files.length
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

        logMcpInfo('analysis', `running ${analyzerName}`, { fileCount: files.length });
        try {
          const result = await analyzer.analyze(
            files,
            mergedOptions.analyzerConfigs?.[analyzerName] || {},
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
    const summary = generateSummary(orderedAnalyzerResults);
    
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
  return Object.keys(registry);
}

/**
 * Generate audit summary
 */
function generateSummary(analyzerResults: Record<string, AnalyzerResult>) {
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
  
  return {
    totalFiles: 0,
    totalViolations,
    criticalIssues,
    warnings,
    suggestions,
    violationsByCategory,
    topIssues: []
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