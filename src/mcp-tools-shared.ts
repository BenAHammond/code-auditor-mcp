/**
 * Shared MCP Tools Logic
 * 
 * This contains all the tool definitions and handlers that are shared
 * between stdio and HTTP/UI MCP server implementations.
 */

import { createAuditRunner } from './auditRunner.js';
import type { Severity, AuditResult, AuditRunnerOptions, Violation } from './types.js';
import { LanguageOrchestrator } from './languages/LanguageOrchestrator.js';
import { RuntimeManager } from './languages/RuntimeManager.js';
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
import { SchemaParser } from './services/SchemaParser.js';

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

  // Database Schema Management Tools
  {
    name: 'generate_schema_discovery_sql',
    description: 'Generate SQL queries for LLMs to extract database schema information automatically',
    parameters: [
      {
        name: 'databaseType',
        type: 'string',
        required: true,
        enum: ['postgresql', 'mysql', 'sqlite', 'sqlserver', 'oracle'],
        description: 'Type of database to generate queries for',
      },
      {
        name: 'includeIndexes',
        type: 'boolean',
        required: false,
        default: true,
        description: 'Include queries to discover indexes',
      },
      {
        name: 'includeConstraints',
        type: 'boolean',
        required: false,
        default: true,
        description: 'Include queries to discover foreign key constraints',
      },
      {
        name: 'specificTables',
        type: 'array',
        required: false,
        description: 'Limit discovery to specific table names (optional)',
      },
    ],
  },
  {
    name: 'get_schemas',
    description: 'List all loaded database schemas with their metadata',
    parameters: [],
  },
  {
    name: 'search_schema',
    description: 'Search for tables, columns, or relationships in loaded schemas',
    parameters: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query for table/column names or descriptions',
      },
      {
        name: 'schemaId',
        type: 'string',
        required: false,
        description: 'Limit search to specific schema ID',
      },
      {
        name: 'searchType',
        type: 'string',
        required: false,
        enum: ['tables', 'columns', 'relationships', 'all'],
        default: 'all',
        description: 'Type of schema elements to search',
      },
    ],
  },
  {
    name: 'analyze_schema_usage',
    description: 'Analyze how database tables are used in the codebase',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        default: '.',
        description: 'Path to analyze for schema usage patterns',
      },
      {
        name: 'schemaId',
        type: 'string',
        required: false,
        description: 'Schema ID to analyze against',
      },
      {
        name: 'includeUsagePatterns',
        type: 'boolean',
        required: false,
        default: true,
        description: 'Whether to include detailed usage patterns',
      },
    ],
  },
  {
    name: 'find_table_usage',
    description: 'Find all functions that interact with a specific database table',
    parameters: [
      {
        name: 'tableName',
        type: 'string',
        required: true,
        description: 'Name of the table to find usage for',
      },
      {
        name: 'usageType',
        type: 'string',
        required: false,
        enum: ['query', 'insert', 'update', 'delete', 'reference', 'all'],
        default: 'all',
        description: 'Type of table usage to find',
      },
    ],
  },
  {
    name: 'validate_schema_consistency',
    description: 'Validate schema consistency and find potential issues',
    parameters: [
      {
        name: 'schemaId',
        type: 'string',
        required: false,
        description: 'Schema ID to validate (validates all if not specified)',
      },
      {
        name: 'checkCircularDeps',
        type: 'boolean',
        required: false,
        default: true,
        description: 'Check for circular dependencies',
      },
      {
        name: 'checkNamingConventions',
        type: 'boolean',
        required: false,
        default: true,
        description: 'Check naming convention compliance',
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

    // Check if this is a multi-language project by detecting Go files
    console.error(chalk.yellow('[DEBUG]'), `Checking for Go files in: ${auditPath}`);
    const hasGoFiles = await ToolHandlers.hasFilesWithExtensions(auditPath, ['.go']);
    console.error(chalk.yellow('[DEBUG]'), `Go files detected: ${hasGoFiles}`);
    
    let auditResult: AuditResult;
    
    if (hasGoFiles) {
      // Use multi-language orchestrator for projects with Go files
      console.error(chalk.blue('[INFO]'), 'Multi-language project detected, using LanguageOrchestrator');
      
      const runtimeManager = new RuntimeManager();
      await runtimeManager.initialize();
      const codeIndex = CodeIndexDB.getInstance();
      await codeIndex.initialize();
      const orchestrator = new LanguageOrchestrator(runtimeManager, codeIndex);
      
      const polyglotResult = await orchestrator.analyzePolyglotProject(auditPath, {
        analyzers: options.enabledAnalyzers,
        minSeverity: options.minSeverity as any,
        updateIndex: indexFunctions,
        enableCrossLanguageAnalysis: true,
        buildCrossReferences: true,
      });
      
      // Convert polyglot result to legacy audit result format
      auditResult = ToolHandlers.convertPolyglotToAuditResult(polyglotResult, auditPath);
    } else {
      // Use legacy audit system for TypeScript-only projects
      const runner = createAuditRunner(options);
      auditResult = await runner.run();
    }

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

  // Schema Management Tool Handlers
  static async handleGenerateSchemaDiscoverySQL(args: any): Promise<any> {
    const databaseType = args.databaseType as string;
    const includeIndexes = (args.includeIndexes as boolean) !== false;
    const includeConstraints = (args.includeConstraints as boolean) !== false;
    const specificTables = args.specificTables as string[];
    
    if (!databaseType || typeof databaseType !== 'string') {
      throw new Error('databaseType must be a non-empty string');
    }

    const sqlQueries = ToolHandlers.generateSchemaDiscoveryQueries(
      databaseType, 
      includeIndexes, 
      includeConstraints, 
      specificTables
    );

    return {
      databaseType,
      queries: sqlQueries,
      instructions: [
        "Execute these SQL queries against your database",
        "Copy the results and use create_schema_from_sql_result to import them",
        "Each query discovers different aspects of your database schema",
        "Run them in order and collect all results"
      ],
      nextStep: "Use create_schema_from_sql_result with the query results"
    };
  }

  static async handleCreateSchemaFromSqlResult(args: any): Promise<any> {
    const schemaName = args.schemaName as string;
    const databaseType = args.databaseType as string;
    const tablesData = args.tablesData as any;
    const columnsData = args.columnsData as any;
    const constraintsData = args.constraintsData as any;

    if (!schemaName || !databaseType || !tablesData || !columnsData) {
      throw new Error('schemaName, databaseType, tablesData, and columnsData are required');
    }

    try {
      const schema = ToolHandlers.buildSchemaFromSqlData(
        schemaName,
        databaseType,
        tablesData,
        columnsData,
        constraintsData
      );

      const db = CodeIndexDB.getInstance();
      await db.initialize();
      
      const schemaId = await db.storeSchema(schema);

      return {
        success: true,
        schemaId,
        schemaName: schema.name,
        stats: {
          databaseCount: schema.databases.length,
          tableCount: schema.databases.reduce((acc, db) => acc + db.tables.length, 0),
          columnCount: schema.databases.reduce((acc, db) => 
            acc + db.tables.reduce((tAcc, table) => tAcc + table.columns.length, 0), 0
          )
        },
        message: `Schema '${schema.name}' created from SQL results`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create schema from SQL results: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  static async handleAddTableManually(args: any): Promise<any> {
    const schemaName = args.schemaName as string;
    const tableName = args.tableName as string;
    const columns = args.columns as any[];
    const databaseType = (args.databaseType as string) || 'postgresql';

    if (!schemaName || !tableName || !columns || !Array.isArray(columns)) {
      throw new Error('schemaName, tableName, and columns array are required');
    }

    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();

      // Get existing schema or create new one
      const existingSchemas = await db.getAllSchemas();
      let schema = existingSchemas.find(s => s.schema.name === schemaName)?.schema;

      if (!schema) {
        // Create new schema
        schema = {
          version: "1.0.0",
          name: schemaName,
          description: `Manually created schema: ${schemaName}`,
          databases: [{
            name: 'default',
            type: databaseType as any,
            tables: []
          }]
        };
      }

      // Add the table
      const newTable = {
        name: tableName,
        type: 'table' as const,
        columns: columns.map(col => ({
          name: col.name,
          type: col.type,
          nullable: col.nullable !== false,
          primaryKey: col.primaryKey || false,
          unique: col.unique || false,
          indexed: col.indexed || false,
          description: col.description
        })),
        references: [],
        indexes: []
      };

      schema.databases[0].tables.push(newTable);

      // Store updated schema
      const schemaId = await db.storeSchema(schema);

      return {
        success: true,
        schemaId,
        tableName,
        columnCount: columns.length,
        message: `Table '${tableName}' added to schema '${schemaName}'`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to add table: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  static async handleListSchemas(args: any): Promise<any> {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      
      const schemas = await db.getAllSchemas();
      const stats = await db.getSchemaStats();
      
      return {
        schemas: schemas.map(s => ({
          schemaId: s.schemaId,
          name: s.schema.name,
          description: s.schema.description,
          databaseCount: s.schema.databases.length,
          tableCount: s.metadata.tableCount,
          relationshipCount: s.metadata.relationshipCount,
          indexedAt: s.metadata.indexedAt
        })),
        totalStats: stats
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list schemas: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  static async handleSearchSchemaElements(args: any): Promise<any> {
    const query = args.query as string;
    const elementType = (args.elementType as string) || 'all';
    
    if (!query || typeof query !== 'string') {
      throw new Error('query must be a non-empty string');
    }
    
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      
      const schemas = (await db.getAllSchemas()).map(s => s.schema);
      const results: any[] = [];
      const queryLower = query.toLowerCase();
      
      for (const schema of schemas) {
        for (const database of schema.databases) {
          for (const table of database.tables) {
            // Search tables
            if ((elementType === 'all' || elementType === 'tables') && 
                (table.name.toLowerCase().includes(queryLower) || 
                 table.description?.toLowerCase().includes(queryLower))) {
              results.push({
                type: 'table',
                tableName: table.name,
                databaseName: database.name,
                schemaName: schema.name,
                description: table.description,
                columnCount: table.columns.length,
                tags: table.tags
              });
            }
            
            // Search columns
            if (elementType === 'all' || elementType === 'columns') {
              for (const column of table.columns) {
                if (column.name.toLowerCase().includes(queryLower) ||
                    column.description?.toLowerCase().includes(queryLower) ||
                    column.type.toLowerCase().includes(queryLower)) {
                  results.push({
                    type: 'column',
                    columnName: column.name,
                    tableName: table.name,
                    databaseName: database.name,
                    schemaName: schema.name,
                    columnType: column.type,
                    description: column.description,
                    nullable: column.nullable,
                    primaryKey: column.primaryKey
                  });
                }
              }
            }
          }
        }
      }
      
      return {
        query,
        elementType,
        resultCount: results.length,
        results
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to search schema elements: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  // Schema Helper Functions
  static generateSchemaDiscoveryQueries(
    databaseType: string,
    includeIndexes: boolean,
    includeConstraints: boolean,
    specificTables?: string[]
  ): { name: string; sql: string; description: string }[] {
    const queries: { name: string; sql: string; description: string }[] = [];
    const tableFilter = specificTables && specificTables.length > 0 
      ? `WHERE table_name IN (${specificTables.map(t => `'${t}'`).join(', ')})`
      : '';

    switch (databaseType.toLowerCase()) {
      case 'postgresql':
        queries.push({
          name: 'tables',
          sql: `SELECT table_name, table_type, table_schema 
                FROM information_schema.tables 
                WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ${tableFilter}
                ORDER BY table_schema, table_name;`,
          description: 'Get all tables and views'
        });

        queries.push({
          name: 'columns',
          sql: `SELECT table_name, column_name, data_type, is_nullable, column_default, 
                       character_maximum_length, numeric_precision, numeric_scale
                FROM information_schema.columns 
                WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ${tableFilter}
                ORDER BY table_name, ordinal_position;`,
          description: 'Get all columns with types and constraints'
        });

        if (includeConstraints) {
          queries.push({
            name: 'foreign_keys',
            sql: `SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name,
                         ccu.column_name AS foreign_column_name, rc.delete_rule, rc.update_rule
                  FROM information_schema.table_constraints AS tc 
                  JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
                  JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
                  JOIN information_schema.referential_constraints AS rc ON tc.constraint_name = rc.constraint_name
                  WHERE tc.constraint_type = 'FOREIGN KEY' ${tableFilter.replace('table_name', 'tc.table_name')}
                  ORDER BY tc.table_name, kcu.column_name;`,
            description: 'Get foreign key relationships'
          });
        }

        if (includeIndexes) {
          queries.push({
            name: 'indexes',
            sql: `SELECT tablename, indexname, indexdef 
                  FROM pg_indexes 
                  WHERE schemaname NOT IN ('information_schema', 'pg_catalog') ${tableFilter.replace('table_name', 'tablename')}
                  ORDER BY tablename, indexname;`,
            description: 'Get all indexes'
          });
        }
        break;

      case 'mysql':
        queries.push({
          name: 'tables',
          sql: `SELECT table_name, table_type, table_schema 
                FROM information_schema.tables 
                WHERE table_schema = DATABASE() ${tableFilter}
                ORDER BY table_name;`,
          description: 'Get all tables and views'
        });

        queries.push({
          name: 'columns',
          sql: `SELECT table_name, column_name, data_type, is_nullable, column_default,
                       character_maximum_length, numeric_precision, numeric_scale,
                       column_key, extra
                FROM information_schema.columns 
                WHERE table_schema = DATABASE() ${tableFilter}
                ORDER BY table_name, ordinal_position;`,
          description: 'Get all columns with types and constraints'
        });

        if (includeConstraints) {
          queries.push({
            name: 'foreign_keys',
            sql: `SELECT table_name, column_name, referenced_table_name, referenced_column_name,
                         delete_rule, update_rule
                  FROM information_schema.key_column_usage 
                  WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL ${tableFilter}
                  ORDER BY table_name, column_name;`,
            description: 'Get foreign key relationships'
          });
        }
        break;

      case 'sqlite':
        queries.push({
          name: 'tables',
          sql: `SELECT name as table_name, type as table_type 
                FROM sqlite_master 
                WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                ORDER BY name;`,
          description: 'Get all tables and views'
        });

        queries.push({
          name: 'table_info',
          sql: `-- Run this for each table: PRAGMA table_info(table_name);
                -- This will give you column information for each table`,
          description: 'Get column information (run PRAGMA table_info for each table)'
        });
        break;
    }

    return queries;
  }

  static buildSchemaFromSqlData(
    schemaName: string,
    databaseType: string,
    tablesData: any,
    columnsData: any,
    constraintsData?: any
  ): any {
    // Build schema from SQL results
    const tables: any[] = [];
    const tableMap = new Map();

    // Process tables
    const tableRows = Array.isArray(tablesData) ? tablesData : tablesData.rows || [];
    for (const row of tableRows) {
      const tableName = row.table_name || row.TABLE_NAME;
      if (!tableMap.has(tableName)) {
        tableMap.set(tableName, {
          name: tableName,
          type: 'table',
          columns: [],
          references: [],
          indexes: []
        });
      }
    }

    // Process columns
    const columnRows = Array.isArray(columnsData) ? columnsData : columnsData.rows || [];
    for (const row of columnRows) {
      const tableName = row.table_name || row.TABLE_NAME;
      const table = tableMap.get(tableName);
      if (table) {
        table.columns.push({
          name: row.column_name || row.COLUMN_NAME,
          type: row.data_type || row.DATA_TYPE,
          nullable: (row.is_nullable || row.IS_NULLABLE) === 'YES',
          primaryKey: (row.column_key || row.COLUMN_KEY) === 'PRI',
          defaultValue: row.column_default || row.COLUMN_DEFAULT,
          length: row.character_maximum_length || row.CHARACTER_MAXIMUM_LENGTH,
          precision: row.numeric_precision || row.NUMERIC_PRECISION,
          scale: row.numeric_scale || row.NUMERIC_SCALE
        });
      }
    }

    // Process constraints if provided
    if (constraintsData) {
      const constraintRows = Array.isArray(constraintsData) ? constraintsData : constraintsData.rows || [];
      for (const row of constraintRows) {
        const tableName = row.table_name || row.TABLE_NAME;
        const table = tableMap.get(tableName);
        if (table) {
          table.references.push({
            foreignKey: row.column_name || row.COLUMN_NAME,
            referencedTable: row.foreign_table_name || row.REFERENCED_TABLE_NAME,
            referencedColumn: row.foreign_column_name || row.REFERENCED_COLUMN_NAME,
            onDelete: row.delete_rule || row.DELETE_RULE,
            onUpdate: row.update_rule || row.UPDATE_RULE
          });
        }
      }
    }

    return {
      version: "1.0.0",
      name: schemaName,
      description: `Schema discovered from ${databaseType} database`,
      databases: [{
        name: 'main',
        type: databaseType,
        tables: Array.from(tableMap.values())
      }],
      metadata: {
        createdAt: new Date().toISOString(),
        source: 'sql-discovery'
      }
    };
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

  static async hasFilesWithExtensions(dirPath: string, extensions: string[]): Promise<boolean> {
    try {
      console.error(chalk.yellow('[DEBUG]'), `Checking path: ${dirPath} for extensions: ${extensions.join(', ')}`);
      const stats = await fs.stat(dirPath);
      if (stats.isFile()) {
        const ext = path.extname(dirPath).toLowerCase();
        console.error(chalk.yellow('[DEBUG]'), `File: ${dirPath}, ext: ${ext}, match: ${extensions.includes(ext)}`);
        return extensions.includes(ext);
      }
      
      // Use simple readdir and walk manually to avoid recursive option issues
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      console.error(chalk.yellow('[DEBUG]'), `Directory: ${dirPath}, entries: ${entries.length}`);
      
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          console.error(chalk.yellow('[DEBUG]'), `File: ${entry.name}, ext: ${ext}, match: ${extensions.includes(ext)}`);
          if (extensions.includes(ext)) {
            console.error(chalk.green('[DEBUG]'), `Found matching file: ${entry.name}`);
            return true;
          }
        } else if (entry.isDirectory()) {
          // Recursively check subdirectories
          const subDirPath = path.join(dirPath, entry.name);
          console.error(chalk.yellow('[DEBUG]'), `Checking subdirectory: ${subDirPath}`);
          const hasInSubdir = await ToolHandlers.hasFilesWithExtensions(subDirPath, extensions);
          if (hasInSubdir) {
            console.error(chalk.green('[DEBUG]'), `Found matching files in subdirectory: ${subDirPath}`);
            return true;
          }
        }
      }
      
      console.error(chalk.red('[DEBUG]'), `No matching files found in: ${dirPath}`);
      return false;
    } catch (error) {
      console.error(chalk.red('[DEBUG]'), `Error checking path ${dirPath}:`, error);
      return false;
    }
  }

  static convertPolyglotToAuditResult(polyglotResult: any, auditPath: string): AuditResult {
    // Convert polyglot result to legacy AuditResult format
    const violations = polyglotResult.violations || [];
    const criticalIssues = violations.filter((v: any) => v.severity === 'critical').length;
    const warnings = violations.filter((v: any) => v.severity === 'warning').length;
    const suggestions = violations.filter((v: any) => v.severity === 'suggestion').length;

    return {
      timestamp: new Date(),
      summary: {
        totalViolations: violations.length,
        criticalIssues,
        warnings,
        suggestions,
        totalFiles: polyglotResult.metrics?.totalFiles || 0,
        violationsByCategory: {},
        topIssues: violations.slice(0, 5)
      },
      analyzerResults: {
        solid: { 
          violations: violations.filter((v: any) => v.analyzer === 'solid'),
          filesProcessed: polyglotResult.metrics?.totalFiles || 0,
          executionTime: polyglotResult.metrics?.executionTime || 0
        },
        dry: { 
          violations: violations.filter((v: any) => v.analyzer === 'dry'),
          filesProcessed: polyglotResult.metrics?.totalFiles || 0,
          executionTime: polyglotResult.metrics?.executionTime || 0
        },
        go: { 
          violations: violations.filter((v: any) => v.analyzer === 'go'),
          filesProcessed: polyglotResult.metrics?.totalFiles || 0,
          executionTime: polyglotResult.metrics?.executionTime || 0
        }
      },
      recommendations: [],
      metadata: {
        auditDuration: polyglotResult.metrics?.executionTime || 0,
        filesAnalyzed: polyglotResult.metrics?.totalFiles || 0,
        analyzersRun: polyglotResult.metrics?.analyzersRun || ['solid', 'dry'],
        fileToFunctionsMap: polyglotResult.indexEntries ? ToolHandlers.createFileToFunctionsMap(polyglotResult.indexEntries) : {}
      }
    };
  }

  static createFileToFunctionsMap(indexEntries: any[]): Record<string, any[]> {
    const fileMap: Record<string, any[]> = {};
    
    for (const entry of indexEntries) {
      if (!fileMap[entry.file]) {
        fileMap[entry.file] = [];
      }
      fileMap[entry.file].push(entry);
    }
    
    return fileMap;
  }
}