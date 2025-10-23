/**
 * Language Orchestrator
 * Coordinates multiple language analyzers and merges results
 */

import { RuntimeManager, AnalysisResult, AnalysisMetrics } from './RuntimeManager.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { discoverFiles } from '../utils/fileDiscovery.js';
import { Violation } from '../types.js';
import * as path from 'path';

export interface PolyglotAnalysisOptions {
  // Language selection
  languages?: string[];
  autoDetect?: boolean;
  
  // Analysis options
  analyzers?: string[];
  minSeverity?: 'info' | 'warning' | 'critical';
  
  // Cross-language features
  enableCrossLanguageAnalysis?: boolean;
  buildCrossReferences?: boolean;
  validateAPIContracts?: boolean;
  
  // Performance options
  maxConcurrency?: number;
  timeout?: number;
  
  // Indexing options
  updateIndex?: boolean;
  indexFunctions?: boolean;
  
  // Reporting options
  includeMetrics?: boolean;
  generateDependencyGraph?: boolean;
}

export interface PolyglotAnalysisResult {
  // Core results
  violations: Violation[];
  errors: any[];
  
  // Cross-language analysis
  crossLanguageViolations: CrossLanguageViolation[];
  dependencyGraph?: DependencyGraph;
  apiContracts?: APIContractAnalysis[];
  
  // Metrics and statistics
  metrics: PolyglotMetrics;
  languageStats: Map<string, LanguageStats>;
  
  // Index updates
  indexEntries?: any[];
  crossReferences?: CrossReference[];
}

export interface CrossLanguageViolation extends Violation {
  crossLanguageType: 'api-mismatch' | 'type-mismatch' | 'contract-violation' | 'unused-export';
  relatedFiles: string[];
  relatedLanguages: string[];
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  cycles?: DependencyCycle[];
  metrics?: DependencyMetrics;
}

export interface DependencyNode {
  id: string;
  name: string;
  language: string;
  type: string; // Changed to string to match cross-language types
  file: string;
  weight?: number;
  cluster?: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: string; // Changed to string to match cross-language types
  protocol?: string;
  weight?: number;
}

export interface DependencyCycle {
  nodes: string[];
  severity: 'warning' | 'critical';
  suggestion?: string;
}

export interface DependencyMetrics {
  totalNodes: number;
  totalEdges: number;
  cycleCount: number;
  averageDepth: number;
  maxDepth: number;
  stronglyConnectedComponents: number;
}

export interface APIContractAnalysis {
  endpoint: string;
  method: string;
  frontendUsage: any[];
  backendImplementation: any;
  mismatches: string[];
}

export interface PolyglotMetrics {
  totalFiles: number;
  totalViolations: number;
  languagesAnalyzed: string[];
  executionTime: number;
  crossLanguageReferences: number;
  apiContractsChecked: number;
}

export interface LanguageStats {
  filesAnalyzed: number;
  violations: number;
  functions: number;
  classes: number;
  interfaces: number;
  executionTime: number;
}

export interface CrossReference {
  sourceId: string;
  targetId: string;
  type: 'calls' | 'implements' | 'api-call';
  sourceLanguage: string;
  targetLanguage: string;
  confidence: number;
}

export class LanguageOrchestrator {
  constructor(
    private runtimeManager: RuntimeManager,
    private codeIndex: CodeIndexDB
  ) {}

  /**
   * Analyze a polyglot project
   */
  async analyzePolyglotProject(
    projectPath: string, 
    options: PolyglotAnalysisOptions = {}
  ): Promise<PolyglotAnalysisResult> {
    console.error(`[LanguageOrchestrator] Starting polyglot analysis of: ${projectPath}`);
    const startTime = Date.now();

    // Initialize runtime manager if needed
    if (!this.runtimeManager.getAvailableRuntimes().length) {
      console.error(`[LanguageOrchestrator] Runtime manager not initialized, initializing...`);
      await this.runtimeManager.initialize();
    }

    // 1. Discover and group files by language
    console.error(`[LanguageOrchestrator] Discovering files in: ${projectPath}`);
    const filesByLanguage = await this.discoverAndGroupFiles(projectPath, options);
    console.error(`[LanguageOrchestrator] Discovered files:`, 
      Object.fromEntries(
        Object.entries(filesByLanguage).map(([lang, files]) => [lang, files.length])
      )
    );

    // 2. Determine which languages to analyze
    const languagesToAnalyze = this.selectLanguages(filesByLanguage, options);
    console.log(`[LanguageOrchestrator] Languages to analyze:`, languagesToAnalyze);
    
    // 2.5. Validate runtime compatibility for selected languages
    for (const language of languagesToAnalyze) {
      if (!this.runtimeManager.hasRuntime(language)) {
        console.warn(`[LanguageOrchestrator] No runtime available for ${language}, skipping...`);
      }
    }

    // 3. Run language-specific analyses in parallel
    const analysisPromises = languagesToAnalyze.map(language => 
      this.analyzeLanguage(language, filesByLanguage[language] || [], options)
    );

    const analysisResults = await Promise.all(analysisPromises);
    console.log(`[LanguageOrchestrator] Completed ${analysisResults.length} language analyses`);

    // 4. Merge results
    const mergedResult = this.mergeLanguageResults(analysisResults, languagesToAnalyze);

    // 5. Build cross-references if enabled
    if (options.buildCrossReferences) {
      mergedResult.crossReferences = await this.buildCrossReferences(analysisResults);
      console.log(`[LanguageOrchestrator] Built ${mergedResult.crossReferences.length} cross-references`);
    }

    // 6. Detect cross-language violations
    if (options.enableCrossLanguageAnalysis) {
      mergedResult.crossLanguageViolations = await this.detectCrossLanguageViolations(
        analysisResults, 
        mergedResult.crossReferences || []
      );
      console.log(`[LanguageOrchestrator] Found ${mergedResult.crossLanguageViolations.length} cross-language violations`);
    }

    // 7. Validate API contracts
    if (options.validateAPIContracts) {
      mergedResult.apiContracts = await this.validateAPIContracts(analysisResults);
      console.log(`[LanguageOrchestrator] Validated ${mergedResult.apiContracts?.length || 0} API contracts`);
    }

    // 8. Generate dependency graph
    if (options.generateDependencyGraph) {
      mergedResult.dependencyGraph = await this.generateDependencyGraph(
        analysisResults,
        mergedResult.crossReferences || []
      );
      console.log(`[LanguageOrchestrator] Generated dependency graph with ${mergedResult.dependencyGraph.nodes.length} nodes`);
    }

    // 9. Update index if requested
    if (options.updateIndex && mergedResult.indexEntries) {
      await this.updateCodeIndex(mergedResult.indexEntries, mergedResult.crossReferences || []);
      console.log(`[LanguageOrchestrator] Updated index with ${mergedResult.indexEntries.length} entries`);
    }

    // 10. Final metrics
    mergedResult.metrics.executionTime = Date.now() - startTime;
    console.log(`[LanguageOrchestrator] Analysis complete in ${mergedResult.metrics.executionTime}ms`);

    return mergedResult;
  }

  /**
   * Discover files and group by language
   */
  private async discoverAndGroupFiles(
    projectPath: string, 
    options: PolyglotAnalysisOptions
  ): Promise<Record<string, string[]>> {
    const allFiles = await discoverFiles(projectPath);
    const filesByLanguage: Record<string, string[]> = {};

    for (const file of allFiles) {
      const language = this.detectLanguage(file);
      if (language) {
        if (!filesByLanguage[language]) {
          filesByLanguage[language] = [];
        }
        filesByLanguage[language].push(file);
      }
    }

    return filesByLanguage;
  }

  /**
   * Detect programming language from file extension
   */
  private detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript', 
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.go': 'go',
      '.py': 'python',
      '.rs': 'rust',
      '.java': 'java',
      '.kt': 'kotlin',
      '.cs': 'csharp',
      '.cpp': 'cpp',
      '.c': 'c',
      '.h': 'c',
      '.hpp': 'cpp'
    };

    return languageMap[ext] || null;
  }

  /**
   * Select which languages to analyze based on options and availability
   */
  private selectLanguages(
    filesByLanguage: Record<string, string[]>, 
    options: PolyglotAnalysisOptions
  ): string[] {
    const discoveredLanguages = Object.keys(filesByLanguage);
    
    // Map discovered languages to runtime names
    const languageToRuntime = this.mapLanguageToRuntime();
    
    // If specific languages requested, filter to those
    if (options.languages && options.languages.length > 0) {
      return options.languages.filter(lang => {
        const runtimeName = languageToRuntime[lang] || lang;
        return discoveredLanguages.includes(lang) && 
               this.runtimeManager.hasRuntime(runtimeName);
      });
    }

    // Otherwise, analyze all discovered languages that have available runtimes
    return discoveredLanguages.filter(lang => {
      const runtimeName = languageToRuntime[lang] || lang;
      return this.runtimeManager.hasRuntime(runtimeName);
    });
  }

  /**
   * Map language names to runtime names
   */
  private mapLanguageToRuntime(): Record<string, string> {
    return {
      'typescript': 'node',
      'javascript': 'node',
      'go': 'go',
      'python': 'python',
      'rust': 'rust'
    };
  }

  /**
   * Analyze files for a specific language
   */
  private async analyzeLanguage(
    language: string, 
    files: string[], 
    options: PolyglotAnalysisOptions
  ): Promise<{ language: string; result: AnalysisResult }> {
    console.log(`[LanguageOrchestrator] Analyzing ${files.length} ${language} files`);
    
    // Map language to runtime name
    const languageToRuntime = this.mapLanguageToRuntime();
    const runtimeName = languageToRuntime[language] || language;
    
    // Use the mapped runtime name for analysis
    const result = await this.runtimeManager.spawnAnalyzer(runtimeName, files, {
      analyzers: options.analyzers,
      minSeverity: options.minSeverity,
      timeout: options.timeout,
      language: language // Pass original language for context
    });

    return {
      language,
      result: result || {
        violations: [],
        indexEntries: [],
        metrics: { filesAnalyzed: 0, executionTime: 0 },
        errors: [`No analyzer available for ${language} (runtime: ${runtimeName})`]
      }
    };
  }

  /**
   * Merge results from multiple language analyses
   */
  private mergeLanguageResults(
    results: Array<{ language: string; result: AnalysisResult }>,
    languages: string[]
  ): PolyglotAnalysisResult {
    const merged: PolyglotAnalysisResult = {
      violations: [],
      errors: [],
      crossLanguageViolations: [],
      metrics: {
        totalFiles: 0,
        totalViolations: 0,
        languagesAnalyzed: languages,
        executionTime: 0,
        crossLanguageReferences: 0,
        apiContractsChecked: 0
      },
      languageStats: new Map(),
      indexEntries: []
    };

    for (const { language, result } of results) {
      // Merge violations
      merged.violations.push(...result.violations);
      
      // Merge errors
      if (result.errors) {
        merged.errors.push(...result.errors);
      }
      
      // Merge index entries
      if (result.indexEntries) {
        merged.indexEntries!.push(...result.indexEntries);
      }

      // Calculate language stats
      merged.languageStats.set(language, {
        filesAnalyzed: result.metrics.filesAnalyzed,
        violations: result.violations.length,
        functions: result.indexEntries?.filter(e => e.type === 'function').length || 0,
        classes: result.indexEntries?.filter(e => e.type === 'class').length || 0,
        interfaces: result.indexEntries?.filter(e => e.type === 'interface').length || 0,
        executionTime: result.metrics.executionTime
      });

      // Update totals
      merged.metrics.totalFiles += result.metrics.filesAnalyzed;
      merged.metrics.totalViolations += result.violations.length;
    }

    return merged;
  }

  /**
   * Build cross-references between languages
   */
  private async buildCrossReferences(
    results: Array<{ language: string; result: AnalysisResult }>
  ): Promise<CrossReference[]> {
    // This is a placeholder for cross-reference building logic
    // In future phases, this will analyze:
    // - Function calls across language boundaries
    // - API endpoints and their consumers
    // - Shared type definitions
    // - Import/export relationships
    
    console.log('[LanguageOrchestrator] Building cross-references (placeholder)');
    return [];
  }

  /**
   * Detect violations that span multiple languages
   */
  private async detectCrossLanguageViolations(
    results: Array<{ language: string; result: AnalysisResult }>,
    crossReferences: CrossReference[]
  ): Promise<CrossLanguageViolation[]> {
    console.log('[LanguageOrchestrator] Detecting cross-language violations...');
    
    const violations: CrossLanguageViolation[] = [];
    
    // Collect all entities from results
    const allEntities: any[] = [];
    for (const { result } of results) {
      if (result.indexEntries) {
        allEntities.push(...result.indexEntries);
      }
    }
    
    // Import and run API contract analysis
    try {
      const { APIContractAnalyzer } = await import('../analyzers/cross-language/APIContractAnalyzer.js');
      
      const endpoints = APIContractAnalyzer.extractEndpoints(allEntities);
      const apiCalls = APIContractAnalyzer.extractAPICalls(allEntities);
      
      if (endpoints.length > 0 || apiCalls.length > 0) {
        const contractAnalyzer = new APIContractAnalyzer();
        const contractViolations = await contractAnalyzer.analyzeContracts(endpoints, apiCalls);
        
        // Convert to CrossLanguageViolation format
        for (const violation of contractViolations) {
          violations.push({
            ...violation,
            crossLanguageType: 'api-mismatch',
            relatedFiles: [violation.file, ...(violation.endpoint ? [violation.endpoint.file] : [])],
            relatedLanguages: [
              violation.call?.language || 'unknown',
              violation.endpoint?.language || 'unknown'
            ].filter(lang => lang !== 'unknown')
          });
        }
      }
    } catch (error) {
      console.warn('[LanguageOrchestrator] Failed to run API contract analysis:', error);
    }
    
    // Import and run schema validation
    try {
      const { SchemaValidator } = await import('../analyzers/cross-language/SchemaValidator.js');
      
      const schemas = SchemaValidator.extractSchemas(allEntities);
      
      if (schemas.length > 0) {
        const schemaValidator = new SchemaValidator();
        const schemaViolations = await schemaValidator.validateSchemas(schemas);
        
        // Convert to CrossLanguageViolation format
        for (const violation of schemaViolations) {
          violations.push({
            ...violation,
            crossLanguageType: 'type-mismatch',
            relatedFiles: violation.schemas.map(s => s.file),
            relatedLanguages: violation.schemas.map(s => s.language)
          });
        }
      }
    } catch (error) {
      console.warn('[LanguageOrchestrator] Failed to run schema validation:', error);
    }
    
    console.log(`[LanguageOrchestrator] Found ${violations.length} cross-language violations`);
    return violations;
  }

  /**
   * Validate API contracts between frontend and backend
   */
  private async validateAPIContracts(
    results: Array<{ language: string; result: AnalysisResult }>
  ): Promise<APIContractAnalysis[]> {
    // Placeholder for API contract validation
    console.log('[LanguageOrchestrator] Validating API contracts (placeholder)');
    return [];
  }

  /**
   * Generate dependency graph across languages
   */
  private async generateDependencyGraph(
    results: Array<{ language: string; result: AnalysisResult }>,
    crossReferences: CrossReference[]
  ): Promise<DependencyGraph> {
    console.log('[LanguageOrchestrator] Generating cross-language dependency graph...');
    
    try {
      const { DependencyGraphBuilder } = await import('../analyzers/cross-language/DependencyGraphBuilder.js');
      
      // Collect all entities
      const allEntities: any[] = [];
      for (const { result } of results) {
        if (result.indexEntries) {
          allEntities.push(...result.indexEntries);
        }
      }
      
      // Build the dependency graph
      const graphBuilder = new DependencyGraphBuilder({
        includeInternalDependencies: true,
        includeExternalDependencies: true,
        includeTestFiles: false,
        clusterByPackage: true
      });
      
      const graph = await graphBuilder.buildGraph(allEntities, crossReferences);
      
      console.log(`[LanguageOrchestrator] Generated dependency graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`);
      return graph;
      
    } catch (error) {
      console.warn('[LanguageOrchestrator] Failed to generate dependency graph:', error);
      return {
        nodes: [],
        edges: [],
        cycles: [],
        metrics: {
          totalNodes: 0,
          totalEdges: 0,
          cycleCount: 0,
          averageDepth: 0,
          maxDepth: 0,
          stronglyConnectedComponents: 0
        }
      };
    }
  }

  /**
   * Update the unified code index
   */
  private async updateCodeIndex(
    indexEntries: any[],
    crossReferences: CrossReference[]
  ): Promise<void> {
    // Placeholder for index updates
    console.log('[LanguageOrchestrator] Updating code index (placeholder)');
  }

  /**
   * Get orchestrator statistics
   */
  getStats() {
    const runtimeStats = this.runtimeManager.getStats();
    
    return {
      runtimes: runtimeStats,
      capabilities: {
        crossLanguageAnalysis: true,
        apiContractValidation: true,
        dependencyGraphGeneration: true,
        unifiedIndexing: true
      }
    };
  }
}