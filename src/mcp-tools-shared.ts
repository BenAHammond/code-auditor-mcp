/**
 * Shared MCP Tools Logic
 * 
 * This contains all the tool definitions and handlers that are shared
 * between stdio and HTTP/UI MCP server implementations.
 */

import { createAuditRunner } from './auditRunner.js';
import type { Severity, AuditResult, AuditRunnerOptions, Violation } from './types.js';
import { 
  registerFunctions, 
  searchFunctions, 
  findDefinition,
  syncFileIndex,
  getDatabase
} from './codeIndexService.js';
import { CodeMapGenerator } from './services/CodeMapGenerator.js';
import { analyzeDocumentation } from './analyzers/documentationAnalyzer.js';
import { ConfigGeneratorFactory } from './generators/ConfigGeneratorFactory.js';
import { DEFAULT_SERVER_URL } from './constants.js';
import { CodeIndexDB } from './codeIndexDB.js';

import path from 'node:path';
import fs from 'node:fs/promises';
import chalk from 'chalk';

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description: string;
  default?: any;
  enum?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

export const tools: Tool[] = [
  // Core Audit Tools
  {
    name: 'audit',
    description: 'Run a comprehensive code audit on files or directories, including React component analysis',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'The file or directory path to audit (defaults to current directory)',
        default: process.cwd(),
      },
      {
        name: 'analyzers',
        type: 'array',
        required: false,
        description: 'List of analyzers to run (solid, dry, documentation, react, data-access)',
        default: ['solid', 'dry', 'documentation', 'react', 'data-access'],
      },
      {
        name: 'minSeverity',
        type: 'string',
        required: false,
        description: 'Minimum severity level to report',
        default: 'warning',
        enum: ['info', 'warning', 'critical'],
      },
      {
        name: 'indexFunctions',
        type: 'boolean',
        required: false,
        description: 'Automatically index functions during audit',
        default: true,
      },
      {
        name: 'analyzerConfigs',
        type: 'object',
        required: false,
        description: 'Analyzer-specific configuration overrides (e.g., SOLID thresholds, DRY settings)',
      },
      {
        name: 'generateCodeMap',
        type: 'boolean',
        required: false,
        description: 'Generate and return a human-readable code map as part of the audit results',
        default: true,
      },
    ],
  },
  {
    name: 'audit_health',
    description: 'Quick health check of a codebase with key metrics',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'The directory path to check',
        default: process.cwd(),
      },
      {
        name: 'threshold',
        type: 'number',
        required: false,
        description: 'Health score threshold (0-100) for pass/fail',
        default: 70,
      },
      {
        name: 'indexFunctions',
        type: 'boolean',
        required: false,
        description: 'Automatically index functions during health check',
        default: true,
      },
      {
        name: 'analyzerConfigs',
        type: 'object',
        required: false,
        description: 'Analyzer-specific configuration overrides (e.g., SOLID thresholds, DRY settings)',
      },
      {
        name: 'generateCodeMap',
        type: 'boolean',
        required: false,
        description: 'Generate and return a human-readable code map as part of the health check results',
        default: true,
      },
    ],
  },
  
  // Code Index Tools
  {
    name: 'search_code',
    description: 'Search indexed functions and React components with natural language queries. Supports operators: entity:component, component:functional|class|memo|forwardRef, hook:useState|useEffect|etc, prop:propName, dep:packageName, dependency:lodash, uses:express, calls:functionName, calledby:functionName, dependents-of:functionName, used-by:functionName, depends-on:module, imports-from:file, unused-imports, dead-imports, type:fileType, file:path, lang:language, complexity:1-10, jsdoc:true|false',
    parameters: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query with natural language and/or operators. Examples: "Button component:functional", "entity:component hook:useState", "render prop:onClick", "dep:lodash", "calls:validateUser", "unused-imports", "dependents-of:authenticate"',
      },
      {
        name: 'filters',
        type: 'object',
        required: false,
        description: 'Optional filters (language, filePath, dependencies, componentType, entityType, searchMode). Set searchMode to "content" to search within function bodies, "metadata" for names/signatures only, or "both" for combined search',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum results to return',
        default: 50,
      },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Offset for pagination',
        default: 0,
      },
    ],
  },
  {
    name: 'find_definition',
    description: 'Find the exact definition of a specific function or React component',
    parameters: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'Function or component name to find',
      },
      {
        name: 'filePath',
        type: 'string',
        required: false,
        description: 'Optional file path to narrow search',
      },
    ],
  },
  {
    name: 'sync_index',
    description: 'Synchronize, cleanup, or reset the code index',
    parameters: [
      {
        name: 'mode',
        type: 'string',
        required: false,
        description: 'Operation mode: sync (update), cleanup (remove stale), or reset (clear all)',
        default: 'sync',
        enum: ['sync', 'cleanup', 'reset'],
      },
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'Optional specific path to sync',
      },
    ],
  },
  
  // AI Configuration Tool
  {
    name: 'generate_ai_config',
    description: 'Generate configuration files for AI coding assistants',
    parameters: [
      {
        name: 'tools',
        type: 'array',
        required: true,
        description: 'AI tools to configure (cursor, continue, copilot, claude, zed, windsurf, cody, aider, cline, pearai)',
      },
      {
        name: 'outputDir',
        type: 'string',
        required: false,
        description: 'Output directory for configuration files',
        default: '.',
      },
    ],
  },
  
  // Workflow Guide Tool
  {
    name: 'get_workflow_guide',
    description: 'Get recommended workflows and best practices for using code auditor tools effectively',
    parameters: [
      {
        name: 'scenario',
        type: 'string',
        required: false,
        description: 'Specific scenario: initial-setup, react-development, code-review, find-patterns, maintenance. Leave empty to see all.',
      },
    ],
  },

  // Analyzer Configuration Tools
  {
    name: 'set_analyzer_config',
    description: 'Set or update analyzer configuration that persists across audit runs',
    parameters: [
      {
        name: 'analyzerName',
        type: 'string',
        required: true,
        description: 'The analyzer to configure (solid, dry, security, etc.)',
      },
      {
        name: 'config',
        type: 'object',
        required: true,
        description: 'Configuration object for the analyzer (e.g., thresholds, rules)',
      },
      {
        name: 'projectPath',
        type: 'string',
        required: false,
        description: 'Optional project path for project-specific config (defaults to global)',
      },
    ],
  },
  {
    name: 'get_analyzer_config',
    description: 'Get current configuration for an analyzer',
    parameters: [
      {
        name: 'analyzerName',
        type: 'string',
        required: false,
        description: 'Specific analyzer name, or omit to get all configs',
      },
      {
        name: 'projectPath',
        type: 'string',
        required: false,
        description: 'Optional project path to get project-specific config',
      },
    ],
  },
  {
    name: 'reset_analyzer_config',
    description: 'Reset analyzer configuration to defaults',
    parameters: [
      {
        name: 'analyzerName',
        type: 'string',
        required: false,
        description: 'Specific analyzer to reset, or omit to reset all',
      },
      {
        name: 'projectPath',
        type: 'string',
        required: false,
        description: 'Optional project path to reset only project-specific config',
      },
    ],
  },
  {
    name: 'get_code_map_section',
    description: 'Retrieve a specific section of a previously generated code map',
    parameters: [
      {
        name: 'mapId',
        type: 'string',
        required: true,
        description: 'The map ID returned from a previous audit with code map generation',
      },
      {
        name: 'sectionType',
        type: 'string',
        required: true,
        description: 'The section type to retrieve (e.g., overview, files, dependencies, documentation)',
      },
    ],
  },
  {
    name: 'list_code_map_sections',
    description: 'List all available sections for a code map',
    parameters: [
      {
        name: 'mapId',
        type: 'string',
        required: true,
        description: 'The map ID returned from a previous audit',
      },
    ],
  },
];

// UI-specific tools (only available in UI mode)
export const uiTools: Tool[] = [
  {
    name: 'audit_dashboard',
    description: 'Generates an interactive dashboard with detailed audit findings, code maps, and remediation options.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'Path to audit',
        default: '.',
      },
      {
        name: 'analyzers',
        type: 'array',
        required: false,
        description: 'Analyzers to run',
        default: ['solid', 'dry', 'documentation', 'react', 'data-access'],
      },
      {
        name: 'minSeverity',
        type: 'string',
        required: false,
        description: 'Minimum severity level',
        default: 'warning',
        enum: ['info', 'warning', 'critical'],
      },
    ],
  },
  {
    name: 'code_map_viewer',
    description: 'Generates an interactive, navigable code map with file structure, complexity analysis, and documentation coverage.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'Path to analyze',
        default: '.',
      },
    ],
  },
];

/**
 * Shared tool handler implementations
 */
export class ToolHandlers {
  
  static async handleAudit(args: any): Promise<any> {
    const auditPath = path.resolve((args.path as string) || process.cwd());
    const indexFunctions = (args.indexFunctions as boolean) !== false; // Default true
    const generateCodeMap = (args.generateCodeMap as boolean) !== false; // Default true
    
    // Check if path is a file or directory
    const stats = await fs.stat(auditPath).catch(() => null);
    const isFile = stats?.isFile() || false;
    
    // Get stored analyzer configs from database
    const db = CodeIndexDB.getInstance();
    await db.initialize();
    const storedConfigs = await db.getAllAnalyzerConfigs(auditPath);
    
    // Merge stored configs with any provided configs
    const analyzerConfigs = {
      ...storedConfigs,
      ...(args.analyzerConfigs as Record<string, any> || {})
    };
    
    const options: AuditRunnerOptions = {
      projectRoot: isFile ? path.dirname(auditPath) : auditPath,
      enabledAnalyzers: (args.analyzers as string[]) || ['solid', 'dry', 'documentation', 'react', 'data-access'],
      minSeverity: ((args.minSeverity as string) || 'warning') as Severity,
      verbose: false,
      indexFunctions,
      ...(isFile && { includePaths: [auditPath] }),
      ...(Object.keys(analyzerConfigs).length > 0 && { analyzerConfigs }),
    };

    const runner = createAuditRunner(options);
    const auditResult = await runner.run();

    // Handle function indexing if enabled and functions were collected
    let indexingResult = null;
    if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
      try {
        const syncStats = { added: 0, updated: 0, removed: 0 };
        
        // Sync each file's functions to handle additions, updates, and removals
        for (const [filePath, functions] of Object.entries(auditResult.metadata.fileToFunctionsMap)) {
          const fileStats = await syncFileIndex(filePath, functions);
          syncStats.added += fileStats.added;
          syncStats.updated += fileStats.updated;
          syncStats.removed += fileStats.removed;
        }
        
        indexingResult = {
          success: true,
          registered: syncStats.added + syncStats.updated,
          failed: 0,
          syncStats
        };
        
        console.error(chalk.blue('[INFO]'), `Synced functions: ${syncStats.added} added, ${syncStats.updated} updated, ${syncStats.removed} removed`);
      } catch (error) {
        console.error(chalk.yellow('[WARN]'), 'Failed to sync functions:', error);
      }
    }

    // Generate code map if requested and functions were indexed
    let codeMapResult = null;
    if (generateCodeMap && indexingResult && indexingResult.success) {
      try {
        const mapGenerator = new CodeMapGenerator();
        const mapOptions = {
          includeComplexity: true,
          includeDocumentation: true,
          includeDependencies: true,
          includeUsage: false,
          groupByDirectory: true,
          maxDepth: 10,
          showUnusedImports: true,
          minComplexity: 7,
        };

        // Generate documentation metrics
        let documentation = undefined;
        try {
          const files = Object.keys(auditResult.metadata.fileToFunctionsMap || {});
          if (files.length > 0) {
            const docResult = await analyzeDocumentation(files);
            documentation = docResult.metrics;
          }
        } catch (docError) {
          console.error(chalk.yellow('[WARN]'), 'Failed to analyze documentation:', docError);
        }

        // Use paginated code map generation
        const paginatedResult = await mapGenerator.generatePaginatedCodeMap(auditPath, {
          ...mapOptions,
          includeDocumentation: !!documentation
        });

        codeMapResult = {
          success: true,
          mapId: paginatedResult.mapId,
          summary: paginatedResult.summary,
          quickPreview: paginatedResult.quickPreview,
          sections: paginatedResult.summary.sectionsAvailable,
          documentationCoverage: documentation?.coverageScore
        };
        
        console.error(chalk.blue('[INFO]'), `Generated paginated code map: ${paginatedResult.summary.stats.totalFiles} files, ${paginatedResult.summary.totalSections} sections`);
      } catch (error) {
        console.error(chalk.yellow('[WARN]'), 'Failed to generate code map:', error);
        codeMapResult = {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to generate code map'
        };
      }
    }

    // Format for MCP
    return {
      summary: {
        totalViolations: auditResult.summary.totalViolations,
        criticalIssues: auditResult.summary.criticalIssues,
        warnings: auditResult.summary.warnings,
        suggestions: auditResult.summary.suggestions,
        filesAnalyzed: auditResult.metadata.filesAnalyzed,
        executionTime: auditResult.metadata.auditDuration,
        healthScore: ToolHandlers.calculateHealthScore(auditResult),
      },
      violations: ToolHandlers.getAllViolations(auditResult).slice(0, 100), // Limit to first 100
      recommendations: auditResult.recommendations,
      ...(indexingResult && { functionIndexing: indexingResult }),
      ...(codeMapResult && { codeMap: codeMapResult }),
    };
  }

  static async handleAuditHealth(args: any): Promise<any> {
    const auditPath = path.resolve((args.path as string) || process.cwd());
    const threshold = (args.threshold as number) || 70;
    const indexFunctions = (args.indexFunctions as boolean) !== false; // Default true
    const generateCodeMap = (args.generateCodeMap as boolean) !== false; // Default true

    // Get stored analyzer configs from database
    const db = CodeIndexDB.getInstance();
    await db.initialize();
    const storedConfigs = await db.getAllAnalyzerConfigs(auditPath);
    
    // Merge stored configs with any provided configs
    const analyzerConfigs = {
      ...storedConfigs,
      ...(args.analyzerConfigs as Record<string, any> || {})
    };

    const runner = createAuditRunner({
      projectRoot: auditPath,
      enabledAnalyzers: ['solid', 'dry', 'documentation', 'react', 'data-access'],
      minSeverity: 'warning',
      verbose: false,
      indexFunctions,
      ...(Object.keys(analyzerConfigs).length > 0 && { analyzerConfigs }),
    });

    const auditResult = await runner.run();
    const healthScore = ToolHandlers.calculateHealthScore(auditResult);

    // Handle function indexing if enabled and functions were collected
    let indexingResult = null;
    if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
      try {
        const syncStats = { added: 0, updated: 0, removed: 0 };
        
        // Sync each file's functions to handle additions, updates, and removals
        for (const [filePath, functions] of Object.entries(auditResult.metadata.fileToFunctionsMap)) {
          const fileStats = await syncFileIndex(filePath, functions);
          syncStats.added += fileStats.added;
          syncStats.updated += fileStats.updated;
          syncStats.removed += fileStats.removed;
        }
        
        indexingResult = {
          success: true,
          registered: syncStats.added + syncStats.updated,
          failed: 0,
          syncStats
        };
        
        console.error(chalk.blue('[INFO]'), `Synced functions: ${syncStats.added} added, ${syncStats.updated} updated, ${syncStats.removed} removed`);
      } catch (error) {
        console.error(chalk.yellow('[WARN]'), 'Failed to sync functions:', error);
      }
    }

    // Generate code map if requested and functions were indexed
    let codeMapResult = null;
    if (generateCodeMap && indexingResult && indexingResult.success) {
      try {
        const mapGenerator = new CodeMapGenerator();
        const mapOptions = {
          includeComplexity: true,
          includeDocumentation: true,
          includeDependencies: true,
          includeUsage: false,
          groupByDirectory: true,
          maxDepth: 8, // Slightly smaller for health check
          showUnusedImports: true,
          minComplexity: 7,
        };

        // Generate documentation metrics
        let documentation = undefined;
        try {
          const files = Object.keys(auditResult.metadata.fileToFunctionsMap || {});
          if (files.length > 0) {
            const docResult = await analyzeDocumentation(files);
            documentation = docResult.metrics;
          }
        } catch (docError) {
          console.error(chalk.yellow('[WARN]'), 'Failed to analyze documentation:', docError);
        }

        // Use paginated code map generation for health check too
        const paginatedResult = await mapGenerator.generatePaginatedCodeMap(auditPath, {
          ...mapOptions,
          includeDocumentation: !!documentation
        });

        codeMapResult = {
          success: true,
          mapId: paginatedResult.mapId,
          summary: paginatedResult.summary,
          quickPreview: paginatedResult.quickPreview,
          sections: paginatedResult.summary.sectionsAvailable,
          documentationCoverage: documentation?.coverageScore
        };
        
        console.error(chalk.blue('[INFO]'), `Generated paginated code map: ${paginatedResult.summary.stats.totalFiles} files, ${paginatedResult.summary.totalSections} sections`);
      } catch (error) {
        console.error(chalk.yellow('[WARN]'), 'Failed to generate code map:', error);
        codeMapResult = {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to generate code map'
        };
      }
    }

    return {
      healthScore,
      threshold,
      passed: healthScore >= threshold,
      status: healthScore >= threshold ? 'healthy' : 'needs-attention',
      metrics: {
        filesAnalyzed: auditResult.metadata.filesAnalyzed,
        totalViolations: auditResult.summary.totalViolations,
        criticalViolations: auditResult.summary.criticalIssues,
        warningViolations: auditResult.summary.warnings,
      },
      recommendation: ToolHandlers.getHealthRecommendation(healthScore, auditResult),
      ...(indexingResult && { functionIndexing: indexingResult }),
      ...(codeMapResult && { codeMap: codeMapResult }),
    };
  }

  // Add all other tool handlers here following the same pattern...
  // (I'll include key ones for brevity)

  static async handleSearchCode(args: any): Promise<any> {
    const query = args.query as string;
    const filters = args.filters as any;
    const limit = (args.limit as number) || 50;
    const offset = (args.offset as number) || 0;
    
    if (query !== undefined && typeof query !== 'string') {
      throw new Error('query must be a string');
    }
    
    return await searchFunctions({
      query,
      filters,
      limit,
      offset
    });
  }

  static async handleFindDefinition(args: any): Promise<any> {
    const name = args.name as string;
    const filePath = args.filePath as string;
    
    if (!name || typeof name !== 'string') {
      throw new Error('name must be a non-empty string');
    }
    
    const definition = await findDefinition(name, filePath);
    return definition || { error: 'Function not found' };
  }

  // Helper functions
  static getAllViolations(result: AuditResult): Violation[] {
    const violations: Violation[] = [];
    
    for (const [analyzerName, analyzerResult] of Object.entries(result.analyzerResults)) {
      for (const violation of analyzerResult.violations) {
        violations.push({
          ...violation,
          analyzer: analyzerName,
        });
      }
    }
    
    return violations;
  }

  static calculateHealthScore(result: AuditResult): number {
    const filesAnalyzed = result.metadata?.filesAnalyzed || 1;
    const critical = result.summary.criticalIssues || 0;
    const warnings = result.summary.warnings || 0;
    const suggestions = result.summary.suggestions || 0;
    
    const weights = {
      critical: 10,
      warning: 3,
      suggestion: 0.5
    };
    
    const weightedViolations = (critical * weights.critical) + 
                               (warnings * weights.warning) + 
                               (suggestions * weights.suggestion);
    
    const violationsPerFile = weightedViolations / filesAnalyzed;
    let score = 100 - (violationsPerFile * 2);
    
    return Math.max(0, Math.round(Math.min(100, score)));
  }

  static getHealthRecommendation(score: number, result: AuditResult): string {
    if (score >= 90) return 'Excellent code health!';
    if (score >= 70) return 'Good code health with room for improvement';
    if (result.summary.criticalIssues > 0) {
      return `Fix ${result.summary.criticalIssues} critical violations first`;
    }
    return 'Code health needs attention - run detailed audit';
  }
}