#!/usr/bin/env node

import './applyDataDirEnv.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAuditRunner } from './auditRunner.js';
import type { AuditRunnerOptions, AuditResult, Violation, Severity, FunctionMetadata } from './types.js';
import { 
  registerFunctions, 
  syncFileIndex, 
  searchFunctions, 
  findDefinition,
  clearIndex
} from './codeIndexService.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { ConfigGeneratorFactory } from './generators/ConfigGeneratorFactory.js';
import { DEFAULT_SERVER_URL, IS_DEV_MODE, PACKAGE_VERSION } from './constants.js';
import { scanFunctionsInDirectory } from './functionScanner.js';
import path from 'node:path';
import chalk from 'chalk';
import { assertAuditPathExists, formatMcpToolErrorPayload } from './mcpToolErrors.js';
import { logMcpInfo, mcpDebugStderr } from './mcpDiagnostics.js';
import { createWriteStream } from 'node:fs';

// Set up file logging (only in development mode)
let logStream: any = null;
if (IS_DEV_MODE) {
  const logFilePath = path.join(process.cwd(), 'mcp-server.log');
  logStream = createWriteStream(logFilePath, { flags: 'a' });
  console.error(chalk.blue('[INFO]'), `Development mode: Logging to file: ${logFilePath}`);
}

// Save original console methods
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Override console.log (with conditional file logging)
console.log = (...args: any[]) => {
  if (logStream) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] [LOG] ${message}\n`);
  }
  originalConsoleLog.apply(console, args);
};

// Override console.error (with conditional file logging)
console.error = (...args: any[]) => {
  if (logStream) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] [ERROR] ${message}\n`);
  }
  originalConsoleError.apply(console, args);
};

interface Tool {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    default?: any;
    enum?: string[];
  }>;
}

const tools: Tool[] = [
  {
    name: 'audit',
    description: 'Run a comprehensive code audit on files or directories',
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
        description: 'List of analyzers to run (solid, dry, security, component, data-access)',
        default: ['solid', 'dry'],
      },
      {
        name: 'minSeverity',
        type: 'string',
        required: false,
        description: 'Minimum severity level to report',
        default: 'info',
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
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum number of violations to return (default: 50, max: 100)',
        default: 50,
      },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Number of violations to skip for pagination (default: 0)',
        default: 0,
      },
      {
        name: 'auditId',
        type: 'string',
        required: false,
        description: 'Existing audit ID to retrieve cached results',
      },
      {
        name: 'useCache',
        type: 'boolean',
        required: false,
        description: 'Store results in cache for pagination (default: true)',
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
    ],
  },
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
    description: 'Find the exact definition of a specific function',
    parameters: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'Function name to find',
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
    description:
      'Synchronize, cleanup, or reset analysis-derived data (indexed functions, cached audits, code maps, schema overlays). Project tasks, analyzer configs, and whitelist entries are preserved on reset.',
    parameters: [
      {
        name: 'mode',
        type: 'string',
        required: false,
        description:
          'sync: update index from files; cleanup: remove index rows for deleted files; reset: clear all analysis-derived data (not tasks/config/whitelist)',
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
    name: 'whitelist_get',
    description: 'Get current whitelist entries for dependency and class instantiation checks',
    parameters: [
      {
        name: 'type',
        type: 'string',
        required: false,
        description: 'Filter by type: platform-api, framework-class, project-dep, shared-library, node-builtin',
        enum: ['platform-api', 'framework-class', 'project-dep', 'shared-library', 'node-builtin'],
      },
      {
        name: 'status',
        type: 'string',
        required: false,
        description: 'Filter by status: active, pending, rejected, disabled',
        enum: ['active', 'pending', 'rejected', 'disabled'],
      },
    ],
  },
  {
    name: 'whitelist_add',
    description: 'Add a new entry to the whitelist',
    parameters: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'Class name or import path to whitelist',
      },
      {
        name: 'type',
        type: 'string',
        required: true,
        description: 'Type of whitelist entry',
        enum: ['platform-api', 'framework-class', 'project-dep', 'shared-library', 'node-builtin'],
      },
      {
        name: 'description',
        type: 'string',
        required: false,
        description: 'Explanation of why this is whitelisted',
      },
      {
        name: 'patterns',
        type: 'array',
        required: false,
        description: 'Additional patterns to match (e.g., ["fs/*", "node:fs"])',
      },
    ],
  },
  {
    name: 'whitelist_update_status',
    description: 'Update the status of a whitelist entry',
    parameters: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'Name of the whitelist entry to update',
      },
      {
        name: 'status',
        type: 'string',
        required: true,
        description: 'New status for the entry',
        enum: ['active', 'pending', 'rejected', 'disabled'],
      },
    ],
  },
  {
    name: 'whitelist_detect',
    description: 'Detect potential whitelist candidates from package.json and usage patterns',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'Project path to analyze (defaults to current directory)',
        default: process.cwd(),
      },
      {
        name: 'includePackageJson',
        type: 'boolean',
        required: false,
        description: 'Include dependencies from package.json',
        default: true,
      },
      {
        name: 'autoPopulate',
        type: 'boolean',
        required: false,
        description: 'Automatically add high-confidence entries (>95% confidence)',
        default: false,
      },
    ],
  },
  {
    name: 'project_tasks',
    description:
      'Manage a persistent per-project task queue. Tasks and analyzer configs survive sync_index reset; reset clears function index, cached audits, code maps, and schema overlays. Use delete to remove a task.',
    parameters: [
      {
        name: 'action',
        type: 'string',
        required: true,
        description:
          'list | create | get | update | delete. list/create use projectPath or default to process.cwd(); create also needs title; get/update/delete need taskId; update needs patch object.',
        enum: ['list', 'create', 'get', 'update', 'delete'],
      },
      {
        name: 'projectPath',
        type: 'string',
        required: false,
        description:
          'Project root (resolved). Omit to use the MCP server working directory; response includes projectPathDefaulted when omitted.',
      },
      {
        name: 'taskId',
        type: 'string',
        required: false,
        description: 'Stable task id (UUID). Required for get, update, delete.',
      },
      {
        name: 'title',
        type: 'string',
        required: false,
        description: 'Task title. Required for create.',
      },
      {
        name: 'description',
        type: 'string',
        required: false,
        description: 'Longer description / notes.',
      },
      {
        name: 'status',
        type: 'string',
        required: false,
        description:
          'pending | in_progress | blocked | done | cancelled. Filter for list; initial status for create; can be set via update patch.',
        enum: ['pending', 'in_progress', 'blocked', 'done', 'cancelled'],
      },
      {
        name: 'priority',
        type: 'string',
        required: false,
        description: 'Optional priority for create/update patch.',
        enum: ['low', 'medium', 'high'],
      },
      {
        name: 'labels',
        type: 'array',
        required: false,
        description: 'String tags (e.g. ["audit","refactor"]).',
      },
      {
        name: 'metadata',
        type: 'object',
        required: false,
        description:
          'Arbitrary JSON object: related file paths, links, audit IDs, etc.',
      },
      {
        name: 'parentTaskId',
        type: 'string',
        required: false,
        description: 'Optional parent task for subtasks.',
      },
      {
        name: 'source',
        type: 'string',
        required: false,
        description:
          'manual | audit | mcp. Filter for list; provenance for create; can be set via update patch.',
        enum: ['manual', 'audit', 'mcp'],
      },
      {
        name: 'blockedBy',
        type: 'array',
        required: false,
        description: 'Task IDs this item is blocked by (waiting-on).',
      },
      {
        name: 'dueAt',
        type: 'string',
        required: false,
        description: 'ISO 8601 due datetime for create; omit or null in patch to clear.',
      },
      {
        name: 'sortOrder',
        type: 'number',
        required: false,
        description: 'Lower numbers sort first within a project (default 0).',
      },
      {
        name: 'relatedFiles',
        type: 'array',
        required: false,
        description: 'Repo-relative or absolute file paths tied to the task.',
      },
      {
        name: 'relatedSymbols',
        type: 'array',
        required: false,
        description: 'Function, class, or component names for cross-linking.',
      },
      {
        name: 'patch',
        type: 'object',
        required: false,
        description:
          'For update: partial fields (title, description, status, priority, labels, metadata, parentTaskId, source, blockedBy, dueAt, sortOrder, relatedFiles, relatedSymbols).',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Max tasks to return for list (default 500, max 1000).',
      },
    ],
  },
];

function getAllViolations(result: AuditResult): Violation[] {
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

function calculateHealthScore(result: AuditResult): number {
  const filesAnalyzed = result.metadata?.filesAnalyzed || 1;
  const critical = result.summary.criticalIssues || 0;
  const warnings = result.summary.warnings || 0;
  const suggestions = result.summary.suggestions || 0;
  
  // Weight factors for different severity levels
  const weights = {
    critical: 10,
    warning: 3,
    suggestion: 0.5
  };
  
  // Calculate weighted violations per file
  const weightedViolations = (critical * weights.critical) + 
                             (warnings * weights.warning) + 
                             (suggestions * weights.suggestion);
  
  const violationsPerFile = weightedViolations / filesAnalyzed;
  
  // Score calculation: 100 points minus deductions
  // Each weighted violation per file reduces score
  // Critical-heavy codebases drop faster than suggestion-heavy ones
  let score = 100 - (violationsPerFile * 2);
  
  return Math.max(0, Math.round(Math.min(100, score)));
}

async function startMcpServer() {
  logMcpInfo('startup', `code-auditor-mcp ${PACKAGE_VERSION} (standalone stdio)`, {
    pid: process.pid,
    cwd: process.cwd(),
    dataDir: process.env.CODE_AUDITOR_DATA_DIR ?? '(default)'
  });
  mcpDebugStderr(
    chalk.blue('[DEBUG]'),
    `Node ${process.version} · cwd ${process.cwd()}`
  );

  const server = new Server(
    {
      name: 'code-auditor',
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Add error handler
  server.onerror = (error) => {
    console.error(chalk.red('[ERROR]'), 'Server error occurred:', error);
    console.error(chalk.red('[ERROR]'), 'Error stack:', error.stack);
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    mcpDebugStderr(chalk.blue('[DEBUG]'), 'ListTools', JSON.stringify(request, null, 2));
    const response = {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: tool.parameters.reduce((acc, param) => {
            acc[param.name] = {
              type: param.type,
              description: param.description,
              ...(param.default !== undefined && { default: param.default }),
              ...(param.enum && { enum: param.enum }),
            };
            return acc;
          }, {} as Record<string, any>),
          required: tool.parameters.filter(p => p.required).map(p => p.name),
        },
      })),
    };
    mcpDebugStderr(chalk.blue('[DEBUG]'), `ListTools → ${response.tools.length} tools`);
    return response;
  });

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    mcpDebugStderr(chalk.blue('[DEBUG]'), 'initialize', JSON.stringify(request, null, 2));
    const response = {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'code-auditor',
        version: PACKAGE_VERSION,
      },
    };
    mcpDebugStderr(chalk.blue('[DEBUG]'), 'initialize response', JSON.stringify(response, null, 2));
    return response;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    mcpDebugStderr(chalk.blue('[DEBUG]'), 'CallTool raw', JSON.stringify(request, null, 2));
    const { name, arguments: args } = request.params;
    mcpDebugStderr(chalk.blue('[DEBUG]'), `CallTool ${name}`, JSON.stringify(args, null, 2));

    try {
      let result: any;

      switch (name) {
        case 'audit': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          const indexFunctions = (args.indexFunctions as boolean) !== false; // Default true
          const analyzers = (args.analyzers as string[]) || ['solid', 'dry'];
          const minSeverity = (args.minSeverity as string) as Severity;
          const limit = Math.min(Math.max(0, Number(args.limit)) || 50, 100); // Max 100
          const offset = Math.max(0, Number(args.offset) || 0);
          const useCache = (args.useCache as boolean) !== false; // Default true
          const providedAuditId = args.auditId as string | undefined;
          
          let auditResult: any;
          let auditId: string | undefined = providedAuditId;

          const db = CodeIndexDB.getInstance();
          await db.initialize();
          
          // Check if we should use cached results
          if (providedAuditId) {
            const cachedResult = await db.getAuditResults(providedAuditId);
            
            if (cachedResult) {
              auditResult = cachedResult;
              mcpDebugStderr(chalk.blue('[INFO]'), `Using cached audit results: ${providedAuditId}`);
            } else {
              console.error(chalk.yellow('[WARN]'), `Cached audit not found: ${providedAuditId}, running new audit`);
            }
          }
          
          // Run new audit if no cached result
          if (!auditResult) {
            await assertAuditPathExists(auditPath);
            // Get stored analyzer configs from database
            const storedConfigs = await db.getAllAnalyzerConfigs(auditPath);
            
            // Merge stored configs with any provided configs
            const analyzerConfigs = {
              ...storedConfigs,
              ...(args.analyzerConfigs as Record<string, any> || {})
            };
            
            const options: AuditRunnerOptions = {
              projectRoot: auditPath,
              enabledAnalyzers: analyzers,
              minSeverity,
              verbose: false,
              indexFunctions,
              ...(Object.keys(analyzerConfigs).length > 0 && { analyzerConfigs }),
            };

            const runner = createAuditRunner(options);
            const runResult = await runner.run();
            
            // Store in cache if requested
            if (useCache) {
              auditId = await db.storeAuditResults(runResult, auditPath);
              mcpDebugStderr(chalk.blue('[INFO]'), `Stored audit results with ID: ${auditId}`);
            }
            
            auditResult = runResult;
          }

          // Handle function indexing if enabled and functions were collected
          let indexingResult = null;
          if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
            try {
              const syncStats = { added: 0, updated: 0, removed: 0 };
              
              // Sync each file's functions to handle additions, updates, and removals
              for (const [filePath, functions] of Object.entries(auditResult.metadata.fileToFunctionsMap)) {
                const fileStats = await syncFileIndex(filePath, functions as FunctionMetadata[]);
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
              
              mcpDebugStderr(
                chalk.blue('[INFO]'),
                `Synced functions: ${syncStats.added} added, ${syncStats.updated} updated, ${syncStats.removed} removed`
              );
              
              // Auto-detect and populate whitelist entries after indexing
              try {
                const { WhitelistService } = await import('./services/whitelistService.js');
                const whitelistService = WhitelistService.getInstance();
                const whitelistResult = await whitelistService.whitelistAllDependencies(auditPath);
                
                if (whitelistResult.added > 0) {
                  mcpDebugStderr(chalk.blue('[INFO]'), `Auto-added ${whitelistResult.added} whitelist entries`);
                }
              } catch (error) {
                // Don't fail audit if whitelist detection fails
                console.warn('Whitelist auto-detection failed:', error);
              }
            } catch (error) {
              console.error(chalk.yellow('[WARN]'), 'Failed to sync functions:', error);
            }
          }

          // Get all violations and apply pagination
          const allViolations = auditResult.violations || getAllViolations(auditResult);
          const paginatedViolations = allViolations.slice(offset, offset + limit);
          
          // Format for MCP
          result = {
            summary: {
              totalViolations: auditResult.summary.totalViolations,
              criticalIssues: auditResult.summary.criticalIssues,
              warnings: auditResult.summary.warnings,
              suggestions: auditResult.summary.suggestions,
              filesAnalyzed: auditResult.metadata?.filesAnalyzed || 0,
              executionTime: auditResult.metadata?.auditDuration || 0,
              healthScore: auditResult.summary.healthScore || calculateHealthScore(auditResult),
            },
            violations: paginatedViolations,
            pagination: {
              total: allViolations.length,
              limit,
              offset,
              hasMore: offset + limit < allViolations.length,
              nextOffset: offset + limit < allViolations.length ? offset + limit : null,
              auditId: auditId, // Include audit ID for subsequent requests
            },
            recommendations: auditResult.recommendations || [],
            ...(indexingResult && { functionIndexing: indexingResult }),
          };
          break;
        }

        case 'audit_health': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          await assertAuditPathExists(auditPath);
          const indexFunctions = (args.indexFunctions as boolean) !== false; // Default true
          
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
            enabledAnalyzers: ['solid', 'dry'],
            minSeverity: 'warning',
            verbose: false,
            indexFunctions, // Pass the flag to the runner
            ...(Object.keys(analyzerConfigs).length > 0 && { analyzerConfigs }),
          });

          const auditResult = await runner.run();
          const healthScore = calculateHealthScore(auditResult);

          // Handle function indexing if enabled and functions were collected
          let indexingResult = null;
          if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
            try {
              const syncStats = { added: 0, updated: 0, removed: 0 };
              
              // Sync each file's functions to handle additions, updates, and removals
              for (const [filePath, functions] of Object.entries(auditResult.metadata.fileToFunctionsMap)) {
                const fileStats = await syncFileIndex(filePath, functions as FunctionMetadata[]);
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
              mcpDebugStderr(
                chalk.blue('[INFO]'),
                `Synced functions: ${syncStats.added} added, ${syncStats.updated} updated, ${syncStats.removed} removed`
              );
            } catch (error) {
              console.error(chalk.yellow('[WARN]'), 'Failed to index functions:', error);
            }
          }

          const threshold = (args.threshold as number) || 70;
          
          result = {
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
            recommendation: healthScore >= 90 ? 'Excellent code health!' :
                          healthScore >= 70 ? 'Good code health with room for improvement' :
                          'Code health needs attention - run detailed audit',
            ...(indexingResult && { functionIndexing: indexingResult }),
          };
          break;
        }

        case 'search_code': {
          const query = args.query as string;
          const filters = args.filters as any;
          const limit = (args.limit as number) || 50;
          const offset = (args.offset as number) || 0;
          
          // Extract searchMode from filters if present
          let searchMode: 'metadata' | 'content' | 'both' | undefined;
          if (filters && filters.searchMode) {
            searchMode = filters.searchMode;
            // Remove searchMode from filters as it's a top-level option
            const { searchMode: _, ...cleanFilters } = filters;
            result = await searchFunctions({ query, filters: cleanFilters, limit, offset, searchMode });
          } else {
            result = await searchFunctions({ query, filters, limit, offset });
          }
          break;
        }
        
        case 'find_definition': {
          const name = args.name as string;
          const filePath = args.filePath as string;
          
          const definition = await findDefinition(name, filePath);
          result = definition || { error: 'Function not found' };
          break;
        }
        
        case 'sync_index': {
          const mode = (args.mode as string) || 'sync';
          const targetPath = args.path as string;
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          
          switch (mode) {
            case 'cleanup': {
              const cleanupResult = await db.bulkCleanup();
              result = {
                success: true,
                mode: 'cleanup',
                filesProcessed: cleanupResult.scannedCount,
                functionsRemoved: cleanupResult.removedCount,
                message: `Removed ${cleanupResult.removedCount} functions from ${cleanupResult.removedFiles.length} deleted files`
              };
              break;
            }
            
            case 'sync': {
              let syncResult;
              if (targetPath) {
                const functions = await scanFunctionsInDirectory(targetPath);
                syncResult = await syncFileIndex(targetPath, functions);
                result = {
                  success: true,
                  mode: 'sync',
                  path: targetPath,
                  ...syncResult
                };
              } else {
                syncResult = await db.deepSync();
                result = {
                  success: true,
                  mode: 'sync',
                  filesProcessed: syncResult.syncedFiles,
                  functionsAdded: syncResult.addedFunctions,
                  functionsUpdated: syncResult.updatedFunctions,
                  functionsRemoved: syncResult.removedFunctions
                };
              }
              
              // Auto-detect and populate whitelist entries
              try {
                const { WhitelistService } = await import('./services/whitelistService.js');
                const whitelistService = WhitelistService.getInstance();
                const whitelistResult = await whitelistService.whitelistAllDependencies(
                  targetPath || process.cwd()
                );
                
                if (whitelistResult.added > 0) {
                  result.whitelistAdded = whitelistResult.added;
                  result.whitelistMessage = `Auto-added ${whitelistResult.added} whitelist entries`;
                }
              } catch (error) {
                // Don't fail sync if whitelist detection fails
                console.warn('Whitelist auto-detection failed:', error);
              }
              
              break;
            }
            
            case 'reset': {
              await clearIndex();
              result = {
                success: true,
                mode: 'reset',
                message:
                  'Analysis-derived data cleared (functions, search index, cached audits, code maps, schemas). Project tasks, whitelist, and analyzer configs were preserved.'
              };
              break;
            }
            
            default:
              throw new Error(`Unknown sync mode: ${mode}`);
          }
          break;
        }
        
        case 'generate_ai_config': {
          const tools = args.tools as string[];
          const outputDir = (args.outputDir as string) || '.';
          
          if (!Array.isArray(tools) || tools.length === 0) {
            throw new Error('tools parameter is required and must be a non-empty array');
          }
          
          const factory = new ConfigGeneratorFactory();
          const generatedFiles: string[] = [];
          const errors: string[] = [];
          
          for (const toolName of tools) {
            try {
              const generator = factory.createGenerator(toolName);
              if (!generator) {
                errors.push(`Unknown tool: ${toolName}`);
                continue;
              }
              
              const config = generator.generateConfig();
              const outputPath = path.join(outputDir, config.filename);
              
              // Check if file exists
              const fs = await import('fs/promises');
              try {
                await fs.access(outputPath);
                errors.push(`File already exists: ${config.filename} (use overwrite: true to replace)`);
                continue;
              } catch {
                // File doesn't exist, proceed
              }
              
              await fs.writeFile(outputPath, config.content, 'utf8');
              generatedFiles.push(config.filename);
            } catch (error) {
              errors.push(`Failed to generate config for ${toolName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }
          
          result = {
            success: errors.length === 0,
            generatedFiles,
            ...(errors.length > 0 && { errors }),
            totalRequested: tools.length,
            totalGenerated: generatedFiles.length
          };
          break;
        }
        
        case 'get_workflow_guide': {
          const scenario = args.scenario as string | undefined;
          const { getWorkflowGuide, getWorkflowTips } = await import('./mcp-tools/workflowGuide.js');
          
          try {
            const workflows = getWorkflowGuide(scenario);
            const tips = getWorkflowTips();
            
            result = {
              success: true,
              ...(scenario ? { workflow: workflows } : { workflows }),
              tips
            };
          } catch (error) {
            result = {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              availableScenarios: ['initial-setup', 'react-development', 'code-review', 'find-patterns', 'maintenance', 'analyzer-configuration']
            };
          }
          break;
        }
        
        case 'set_analyzer_config': {
          const analyzerName = args.analyzerName as string;
          const config = args.config as Record<string, any>;
          const projectPath = args.projectPath as string | undefined;
          
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          
          try {
            await db.storeAnalyzerConfig(analyzerName, config, {
              projectPath,
              isGlobal: !projectPath
            });
            
            result = {
              success: true,
              message: `Configuration for ${analyzerName} analyzer has been saved${projectPath ? ` for project ${projectPath}` : ' globally'}`,
              analyzer: analyzerName,
              scope: projectPath ? 'project' : 'global',
              config
            };
          } catch (error) {
            result = {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to save configuration'
            };
          }
          break;
        }
        
        case 'get_analyzer_config': {
          const analyzerName = args.analyzerName as string | undefined;
          const projectPath = args.projectPath as string | undefined;
          
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          
          try {
            if (analyzerName) {
              const config = await db.getAnalyzerConfig(analyzerName, projectPath);
              result = {
                success: true,
                analyzer: analyzerName,
                config: config || null,
                scope: projectPath ? 'project' : 'global',
                message: config ? 'Configuration found' : 'No custom configuration found, using defaults'
              };
            } else {
              const configs = await db.getAllAnalyzerConfigs(projectPath);
              result = {
                success: true,
                configs,
                scope: projectPath ? 'project' : 'global',
                message: `Found ${Object.keys(configs).length} analyzer configurations`
              };
            }
          } catch (error) {
            result = {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to get configuration'
            };
          }
          break;
        }
        
        case 'reset_analyzer_config': {
          const analyzerName = args.analyzerName as string | undefined;
          const projectPath = args.projectPath as string | undefined;
          
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          
          try {
            if (analyzerName) {
              const deleted = await db.deleteAnalyzerConfig(analyzerName, {
                projectPath,
                isGlobal: !projectPath
              });
              result = {
                success: deleted,
                message: deleted 
                  ? `Configuration for ${analyzerName} analyzer has been reset${projectPath ? ` for project ${projectPath}` : ' globally'}`
                  : `No configuration found for ${analyzerName} analyzer`,
                analyzer: analyzerName,
                scope: projectPath ? 'project' : 'global'
              };
            } else {
              await db.resetAnalyzerConfigs(projectPath);
              result = {
                success: true,
                message: projectPath 
                  ? `All project-specific configurations for ${projectPath} have been reset`
                  : 'All analyzer configurations have been reset to defaults',
                scope: projectPath ? 'project' : 'global'
              };
            }
          } catch (error) {
            result = {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to reset configuration'
            };
          }
          break;
        }

        case 'whitelist_get': {
          const { handleWhitelistGet } = await import('./mcp-tools/whitelistTools.js');
          result = await handleWhitelistGet(args);
          break;
        }

        case 'whitelist_add': {
          const { handleWhitelistAdd } = await import('./mcp-tools/whitelistTools.js');
          result = await handleWhitelistAdd(args);
          break;
        }

        case 'whitelist_update_status': {
          const { handleWhitelistUpdateStatus } = await import('./mcp-tools/whitelistTools.js');
          result = await handleWhitelistUpdateStatus(args);
          break;
        }

        case 'whitelist_detect': {
          const { handleWhitelistDetect } = await import('./mcp-tools/whitelistTools.js');
          result = await handleWhitelistDetect(args);
          break;
        }

        case 'project_tasks': {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          result = await handleProjectTasks((args || {}) as Record<string, unknown>);
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      const response = {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
      mcpDebugStderr(
        chalk.blue('[DEBUG]'),
        `Tool ${name} ok`,
        JSON.stringify(response, null, 2).substring(0, 500) + '...'
      );
      return response;
    } catch (error) {
      console.error(chalk.red('[ERROR]'), `Tool ${name} execution failed:`, error);
      console.error(chalk.red('[ERROR]'), 'Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatMcpToolErrorPayload(name, error), null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();

  // Add transport event handlers if available
  if (transport.onclose) {
    transport.onclose = () => {
      console.error(chalk.yellow('[WARN]'), 'Transport closed');
    };
  }
  
  if (transport.onerror) {
    transport.onerror = (error) => {
      console.error(chalk.red('[ERROR]'), 'Transport error:', error);
    };
  }
  
  await server.connect(transport);

  console.error(chalk.green('✓ Code Auditor MCP Server started (standalone mode)'));
  console.error(chalk.gray(`Listening on stdio · ${tools.length} tools · ${PACKAGE_VERSION}`));
  mcpDebugStderr(chalk.blue('[DEBUG]'), 'Server ready', {
    name: 'code-auditor',
    transport: 'stdio',
    toolCount: tools.length
  });
}

// Error handlers
process.on('uncaughtException', (error) => {
  console.error(chalk.red('[ERROR]'), 'Uncaught exception:', error);
  console.error(chalk.red('[ERROR]'), 'Stack:', error.stack);
  console.error(chalk.red('[ERROR]'), 'Error details:', JSON.stringify(error, null, 2));
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('[ERROR]'), 'Unhandled rejection at:', promise);
  console.error(chalk.red('[ERROR]'), 'Reason:', reason);
  console.error(chalk.red('[ERROR]'), 'Rejection details:', JSON.stringify(reason, null, 2));
  process.exit(1);
});

// Add SIGTERM and SIGINT handlers
process.on('SIGTERM', () => {
  console.error(chalk.yellow('[WARN]'), 'Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.error(chalk.yellow('[WARN]'), 'Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Log when stdin/stdout events occur
process.stdin.on('error', (error) => {
  console.error(chalk.red('[ERROR]'), 'stdin error:', error);
});

process.stdout.on('error', (error) => {
  console.error(chalk.red('[ERROR]'), 'stdout error:', error);
});

startMcpServer().catch(error => {
  console.error(chalk.red('[ERROR]'), 'Failed to start MCP server:', error);
  console.error(chalk.red('[ERROR]'), 'Stack:', error.stack);
  process.exit(1);
});