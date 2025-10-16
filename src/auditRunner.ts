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
  FunctionMetadata
} from './types.js';
import { discoverFiles } from './utils/fileDiscovery.js';
import { loadConfig } from './config/configLoader.js';
import { generateReport } from './reporting/reportGenerator.js';
import { extractFunctionsFromFile } from './functionScanner.js';

// Import analyzer definitions
import { solidAnalyzer } from './analyzers/solidAnalyzer.js';
import { dryAnalyzer } from './analyzers/dryAnalyzer.js';
// import { securityAnalyzer } from './analyzers/securityAnalyzer.js';
// import { componentAnalyzer } from './analyzers/componentAnalyzer.js';
import { dataAccessAnalyzer } from './analyzers/dataAccessAnalyzer.js';
import { reactAnalyzer } from './analyzers/reactAnalyzer.js';
import { documentationAnalyzer } from './analyzers/documentationAnalyzer.js';
import { schemaAnalyzer } from './analyzers/schemaAnalyzer.js';

/**
 * Default analyzer registry
 */
const DEFAULT_ANALYZERS: Record<string, AnalyzerDefinition> = {
  'solid': solidAnalyzer,
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
    const files = await discoverProjectFiles(mergedOptions);
    
    // Collect functions if enabled
    let collectedFunctions: FunctionMetadata[] = [];
    const fileToFunctionsMap = new Map<string, FunctionMetadata[]>(); // Track functions per file for sync
    
    if (mergedOptions.indexFunctions) {
      reportProgress(mergedOptions, {
        phase: 'function-indexing',
        message: 'Collecting functions from files...'
      });
      
      // Only collect functions from TypeScript/JavaScript files
      const scriptFiles = files.filter(f => 
        f.endsWith('.ts') || f.endsWith('.tsx') || 
        f.endsWith('.js') || f.endsWith('.jsx')
      );
      
      for (let i = 0; i < scriptFiles.length; i++) {
        try {
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
        } catch (error) {
          // Log error but continue with other files
          console.warn(`Failed to extract functions from ${scriptFiles[i]}:`, error);
        }
      }
    }
    
    // Run analyzers
    const analyzerResults: Record<string, AnalyzerResult> = {};
    const enabledAnalyzers = getEnabledAnalyzers(mergedOptions, analyzerRegistry);
    
    for (const analyzerName of enabledAnalyzers) {
      const analyzer = analyzerRegistry[analyzerName];
      if (!analyzer) {
        console.warn(`Unknown analyzer: ${analyzerName}`);
        continue;
      }
      
      reportProgress(mergedOptions, {
        phase: 'analysis',
        analyzer: analyzerName,
        message: `Running ${analyzerName} analyzer...`
      });
      
      try {
        const result = await analyzer.analyze(
          files, 
          mergedOptions.analyzerConfigs?.[analyzerName] || {},
          mergedOptions,
          (progress) => {
            reportProgress(mergedOptions, {
              phase: 'analysis',
              analyzer: analyzerName,
              current: progress.current,
              total: progress.total,
              message: `Analyzing ${progress.file}...`
            });
          }
        );
        analyzerResults[analyzerName] = result;
      } catch (error) {
        reportError(mergedOptions, error as Error, `${analyzerName} analyzer`);
        analyzerResults[analyzerName] = {
          violations: [],
          filesProcessed: 0,
          executionTime: 0,
          errors: [{ file: 'analyzer', error: (error as Error).message }]
        };
      }
    }
    
    // Generate summary
    const summary = generateSummary(analyzerResults);
    
    // Create result
    const result: AuditResult = {
      timestamp: new Date(),
      summary,
      analyzerResults,
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
async function discoverProjectFiles(options: AuditRunnerOptions): Promise<string[]> {
  const rootDir = options.projectRoot || process.cwd();
  return discoverFiles(rootDir, {
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
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
  if (options.enabledAnalyzers && options.enabledAnalyzers.length > 0) {
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

export { AuditProgress, AuditRunnerOptions } from './types.js';