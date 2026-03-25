#!/usr/bin/env node

// MCP servers use stdio: stdout for protocol messages, stderr for logging
// All log messages must go to stderr to avoid interfering with MCP protocol

import chalk from 'chalk';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createAuditRunner } from './auditRunner.js';
import type { Severity, AuditResult, AuditRunnerOptions, Violation, FunctionMetadata } from './types.js';

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
import { DEFAULT_SERVER_URL, IS_DEV_MODE, PACKAGE_VERSION } from './constants.js';
import { getAuditJobStatus, getAuditResultsPage, startAuditJob } from './mcpAuditJobs.js';

import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { CodeIndexDB } from './codeIndexDB.js';
import { logMcpDebug, logMcpInfo, mcpDebugStderr, mcpTraceStderr } from './mcpDiagnostics.js';
import { assertAuditPathExists, formatMcpToolErrorPayload } from './mcpToolErrors.js';

// Set up file logging (only in development mode)
let logStream: any = null;
if (IS_DEV_MODE) {
  const logFilePath = path.join(process.cwd(), 'mcp-server.log');
  logStream = createWriteStream(logFilePath, { flags: 'a' });
  console.error(chalk.blue('[INFO]'), `Development mode: Logging to file: ${logFilePath}`);
}

// Save original console.error (log is redirected to stderr; see below)
const originalConsoleError = console.error;

// Override console.log — MCP uses stdout only for JSON-RPC; log() must never touch stdout.
console.log = (...args: any[]) => {
  if (logStream) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] [LOG] ${message}\n`);
  }
  originalConsoleError.apply(console, args);
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

interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description: string;
  default?: any;
  enum?: string[];
}

interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

const tools: Tool[] = [
  // Core Audit Tools
  {
    name: 'audit',
    description:
      'Fetch paginated results for a completed audit by resultId (or auditId alias). This tool never starts a new audit.',
    parameters: [
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum number of violations to return per page (default: 50, max: 100)',
        default: 50,
      },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Violation offset for pagination (default: 0).',
        default: 0,
      },
      {
        name: 'resultId',
        type: 'string',
        required: false,
        description: 'Result ID returned by audit_status when the background audit job completes.',
      },
      {
        name: 'auditId',
        type: 'string',
        required: false,
        description: 'Backward-compatible alias for resultId.',
      },
    ],
  },
  {
    name: 'start_audit',
    description:
      'Start a background audit job. Returns immediately with a jobId. Poll audit_status until completed, then fetch pages with audit or audit_results.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'File or directory path to audit (defaults to current directory).',
        default: process.cwd(),
      },
      {
        name: 'analyzers',
        type: 'array',
        required: false,
        description: 'Analyzers to run (default: solid, dry, documentation, react, data-access).',
        default: ['solid', 'dry', 'documentation', 'react', 'data-access'],
      },
      {
        name: 'minSeverity',
        type: 'string',
        required: false,
        description: 'Minimum severity level to report.',
        default: 'warning',
        enum: ['info', 'warning', 'critical'],
      },
      {
        name: 'indexFunctions',
        type: 'boolean',
        required: false,
        description: 'Index functions during audit (default: true).',
        default: true,
      },
      {
        name: 'analyzerConfigs',
        type: 'object',
        required: false,
        description: 'Analyzer-specific configuration overrides.',
      },
      {
        name: 'analyzerConcurrency',
        type: 'number',
        required: false,
        description: 'Max analyzers to run in parallel (default: 1).',
        default: 1,
      },
      {
        name: 'partitionStrategy',
        type: 'string',
        required: false,
        description: 'Partition mode: none | auto | top-level. auto shards when large source trees are detected.',
        default: 'auto',
        enum: ['none', 'auto', 'top-level'],
      },
      {
        name: 'maxPartitions',
        type: 'number',
        required: false,
        description: 'Maximum number of folder partitions for sharded audits (default: 4).',
        default: 4,
      },
      {
        name: 'partitionThresholdFiles',
        type: 'number',
        required: false,
        description: 'Minimum discovered files before auto partitioning is enabled (default: 250).',
        default: 250,
      },
      {
        name: 'workerCount',
        type: 'number',
        required: false,
        description: 'Number of worker processes for shard execution (default: min(4, CPU-1)).',
      },
      {
        name: 'maxRetries',
        type: 'number',
        required: false,
        description: 'Retry attempts per shard for retryable failures (default: 1).',
        default: 1,
      },
      {
        name: 'shardTimeoutMs',
        type: 'number',
        required: false,
        description: 'Per-shard timeout in milliseconds (default: 180000).',
        default: 180000,
      },
      {
        name: 'retryBackoffMs',
        type: 'number',
        required: false,
        description: 'Base retry backoff in milliseconds (default: 500).',
        default: 500,
      },
      {
        name: 'jobTimeoutMs',
        type: 'number',
        required: false,
        description:
          'Maximum wall time for the entire audit job (default 30m, env CODE_AUDITOR_JOB_TIMEOUT_MS, cap 4h). Aborts workers cooperatively then tears down.',
      },
      {
        name: 'maxFilesPerRun',
        type: 'number',
        required: false,
        description:
          'Per worker chunk: if more files match than this, the worker finishes one chunk and the parent queues the rest on another worker (optional).',
      },
      {
        name: 'shardSoftBudgetMs',
        type: 'number',
        required: false,
        description:
          'Per worker soft wall-clock budget; aborts in-process analysis cooperatively via AbortSignal so the parent can assign the next chunk to a fresh worker.',
      },
      {
        name: 'generateCodeMap',
        type: 'boolean',
        required: false,
        description: 'Generate code map artifacts during audit (default: false).',
        default: false,
      },
    ],
  },
  {
    name: 'audit_status',
    description:
      'Get current status for a previously started background audit job. Returns resultId when completed.',
    parameters: [
      {
        name: 'jobId',
        type: 'string',
        required: true,
        description: 'Job ID returned by start_audit.',
      },
    ],
  },
  {
    name: 'audit_results',
    description: 'Fetch paginated violations for a completed audit result by resultId.',
    parameters: [
      {
        name: 'resultId',
        type: 'string',
        required: true,
        description: 'Result ID returned by audit_status when status is completed.',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum number of violations to return per page (default: 50, max: 100).',
        default: 50,
      },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Violation offset for pagination (default: 0).',
        default: 0,
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
    description:
      'Synchronize, cleanup, or reset analysis-derived data (indexed functions, FlexSearch, cached audits, code maps, schema overlays). Project tasks, analyzer configs, and whitelist entries are preserved on reset.',
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
  {
    name: 'project_tasks',
    description:
      'Manage a persistent per-project task queue. Tasks and analyzer configs survive sync_index reset; reset clears function index, cached audits, code maps, and schema overlays (no ghost code references). Use delete to remove a task.',
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
          'Project root (resolved). Omit to use the MCP server working directory (same default idea as audit path); response includes projectPathDefaulted when omitted.',
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

async function startMcpServer() {
  logMcpInfo('startup', `code-auditor-mcp ${PACKAGE_VERSION} (stdio)`, {
    pid: process.pid,
    cwd: process.cwd(),
    dataDir: process.env.CODE_AUDITOR_DATA_DIR ?? '(default)',
    debug: process.env.CODE_AUDITOR_DEBUG ?? '0',
    logFile: process.env.CODE_AUDITOR_LOG_FILE ?? '(none)'
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
    mcpTraceStderr(chalk.blue('[DEBUG]'), 'ListTools', JSON.stringify(request, null, 2));
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
    mcpTraceStderr(chalk.blue('[DEBUG]'), `ListTools → ${response.tools.length} tools`);
    return response;
  });

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    mcpTraceStderr(chalk.blue('[DEBUG]'), 'initialize', JSON.stringify(request, null, 2));
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
    mcpTraceStderr(chalk.blue('[DEBUG]'), 'initialize response', JSON.stringify(response, null, 2));
    return response;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    mcpTraceStderr(chalk.blue('[DEBUG]'), 'CallTool raw', JSON.stringify(request, null, 2));
    const { name, arguments: args } = request.params;
    mcpTraceStderr(chalk.blue('[DEBUG]'), `CallTool ${name}`, JSON.stringify(args, null, 2));

    const toolStartedAt = Date.now();
    try {
      if (name !== 'audit_status') {
        logMcpDebug('tool', `call ${name}`, {
          argKeys: args && typeof args === 'object' ? Object.keys(args as object) : [],
          pathArg: (args as { path?: string })?.path,
          cwd: process.cwd()
        });
      }
      let result: any;

      switch (name) {
        case 'start_audit': {
          result = await startAuditJob(args, {
            defaultAnalyzers: ['solid', 'dry', 'documentation', 'react', 'data-access'],
            defaultMinSeverity: 'warning',
            defaultGenerateCodeMap: false,
          });
          break;
        }

        case 'audit_status': {
          const jobId = args.jobId as string | undefined;
          if (!jobId) {
            throw new Error('audit_status requires jobId');
          }
          result = getAuditJobStatus(jobId);
          break;
        }

        case 'audit_results': {
          result = await getAuditResultsPage(args);
          break;
        }

        case 'audit': {
          result = await getAuditResultsPage(args);
          break;
        }


        case 'audit_health': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          await assertAuditPathExists(auditPath);
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
            indexFunctions, // Pass the flag to the runner
            ...(Object.keys(analyzerConfigs).length > 0 && { analyzerConfigs }),
            progressCallback: (p) => {
              if (
                p.phase === 'function-indexing' &&
                typeof p.current === 'number' &&
                typeof p.total === 'number' &&
                p.total > 0 &&
                p.current % 50 !== 0 &&
                p.current !== p.total
              ) {
                return;
              }
              logMcpDebug('audit_health', p.message ?? p.phase ?? 'progress', {
                phase: p.phase,
                analyzer: p.analyzer,
                current: p.current,
                total: p.total
              });
            }
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
                // Use existing file discovery from audit result
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
              
              mcpDebugStderr(
                chalk.blue('[INFO]'),
                `Generated paginated code map: ${paginatedResult.summary.stats.totalFiles} files, ${paginatedResult.summary.totalSections} sections`
              );
            } catch (error) {
              console.error(chalk.yellow('[WARN]'), 'Failed to generate code map:', error);
              codeMapResult = {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to generate code map'
              };
            }
          }

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
            recommendation: getHealthRecommendation(healthScore, auditResult),
            ...(indexingResult && { functionIndexing: indexingResult }),
            ...(codeMapResult && { codeMap: codeMapResult }),
          };
          break;
        }


        
        case 'search_code': {
          const query = args.query as string;
          const filters = args.filters as any;
          const limit = (args.limit as number) || 50;
          const offset = (args.offset as number) || 0;
          
          // Allow empty query to return all results
          if (query !== undefined && typeof query !== 'string') {
            throw new Error('query must be a string');
          }
          
          result = await searchFunctions({
            query,
            filters,
            limit,
            offset
          });
          break;
        }
        
        
        case 'find_definition': {
          const name = args.name as string;
          const filePath = args.filePath as string;
          
          if (!name || typeof name !== 'string') {
            throw new Error('name must be a non-empty string');
          }
          
          const definition = await findDefinition(name, filePath);
          result = definition || { error: 'Function not found' };
          break;
        }
        

        case 'generate_ai_config': {
          const tools = args.tools as string[];
          const serverUrl = (args.serverUrl as string) || DEFAULT_SERVER_URL;
          const outputDir = (args.outputDir as string) || '.';
          const overwrite = (args.overwrite as boolean) || false;
          
          if (!Array.isArray(tools) || tools.length === 0) {
            throw new Error('tools parameter must be a non-empty array');
          }
          
          const factory = new ConfigGeneratorFactory(serverUrl);
          const generatedFiles: string[] = [];
          const errors: string[] = [];
          
          for (const tool of tools) {
            try {
              const generator = factory.createGenerator(tool);
              if (!generator) {
                errors.push(`Unknown tool: ${tool}`);
                continue;
              }
              
              const config = generator.generateConfig();
              const outputPath = path.resolve(outputDir, config.filename);
              
              // Check if file exists
              let fileExists = false;
              try {
                await fs.access(outputPath);
                fileExists = true;
              } catch {
                // File doesn't exist
              }
              
              if (fileExists && !overwrite) {
                errors.push(`File already exists: ${config.filename} (use overwrite: true to replace)`);
                continue;
              }
              
              // Ensure directory exists
              await fs.mkdir(path.dirname(outputPath), { recursive: true });
              
              // Write main config file
              await fs.writeFile(outputPath, config.content);
              generatedFiles.push(config.filename);
              
              // Write additional files if any
              if (config.additionalFiles) {
                for (const additionalFile of config.additionalFiles) {
                  const additionalPath = path.resolve(outputDir, additionalFile.filename);
                  await fs.mkdir(path.dirname(additionalPath), { recursive: true });
                  await fs.writeFile(additionalPath, additionalFile.content);
                  generatedFiles.push(additionalFile.filename);
                }
              }
              
            } catch (error) {
              errors.push(`Failed to generate config for ${tool}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }
          
          result = {
            success: errors.length === 0,
            generatedFiles,
            errors: errors.length > 0 ? errors : undefined,
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

        
        case 'sync_index': {
          const mode = (args.mode as string) || 'sync';
          const targetPath = args.path as string;
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          
          switch (mode) {
            case 'cleanup': {
              const cleanupResult = await db.bulkCleanup();
              result = {
                mode: 'cleanup',
                success: true,
                scannedFiles: cleanupResult.scannedCount,
                removedEntries: cleanupResult.removedCount,
                removedFiles: cleanupResult.removedFiles,
                errors: cleanupResult.errors,
                message: `Cleaned up ${cleanupResult.removedCount} entries from ${cleanupResult.removedFiles.length} deleted files`
              };
              break;
            }
            
            case 'reset': {
              await db.clearIndex();
              result = {
                mode: 'reset',
                success: true,
                message:
                  'Analysis-derived data cleared (functions, search index, cached audits, code maps, schemas). Project tasks, whitelist, and analyzer configs were preserved.'
              };
              break;
            }
            
            case 'sync':
            default: {
              if (targetPath) {
                // Sync specific file
                const syncResult = await db.synchronizeFile(path.resolve(targetPath));
                result = {
                  mode: 'sync',
                  success: true,
                  path: targetPath,
                  ...(syncResult || { message: 'File not found' })
                };
              } else {
                // Deep sync all files
                const syncResult = await db.deepSync();
                result = {
                  mode: 'sync',
                  success: true,
                  syncedFiles: syncResult.syncedFiles,
                  addedFunctions: syncResult.addedFunctions,
                  updatedFunctions: syncResult.updatedFunctions,
                  removedFunctions: syncResult.removedFunctions,
                  errors: syncResult.errors,
                  message: `Synced ${syncResult.syncedFiles} files: ${syncResult.addedFunctions} added, ${syncResult.updatedFunctions} updated, ${syncResult.removedFunctions} removed`
                };
              }
              break;
            }
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

        case 'get_code_map_section': {
          const mapId = args.mapId as string;
          const sectionType = args.sectionType as string;
          
          if (!mapId || !sectionType) {
            result = {
              success: false,
              error: 'Both mapId and sectionType are required'
            };
            break;
          }
          
          try {
            const db = await getDatabase();
            const section = await db.getCodeMapSection(mapId, sectionType);
            
            if (section) {
              result = {
                success: true,
                mapId,
                sectionType,
                content: section.content,
                metadata: section.metadata
              };
            } else {
              result = {
                success: false,
                error: `Section '${sectionType}' not found for map '${mapId}'`
              };
            }
          } catch (error) {
            result = {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to retrieve code map section'
            };
          }
          break;
        }

        case 'list_code_map_sections': {
          const mapId = args.mapId as string;
          
          if (!mapId) {
            result = {
              success: false,
              error: 'mapId is required'
            };
            break;
          }
          
          try {
            const db = await getDatabase();
            const sections = await db.listCodeMapSections(mapId);
            
            result = {
              success: true,
              mapId,
              sections,
              totalSections: sections.length
            };
          } catch (error) {
            result = {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to list code map sections'
            };
          }
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
      mcpTraceStderr(
        chalk.blue('[DEBUG]'),
        `Tool ${name} ok`,
        JSON.stringify(response, null, 2).substring(0, 500) + '...'
      );
      return response;
    } catch (error) {
      console.error(chalk.red('[ERROR]'), `Tool ${name} execution failed:`, error);
      console.error(chalk.red('[ERROR]'), 'Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      if (name !== 'audit_status') {
        logMcpDebug('tool', `call ${name} failed`, {
          ms: Date.now() - toolStartedAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatMcpToolErrorPayload(name, error), null, 2),
          },
        ],
        isError: true,
      };
    } finally {
      if (name !== 'audit_status') {
        logMcpDebug('tool', `call ${name} finished`, { ms: Date.now() - toolStartedAt });
      }
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

  console.error(chalk.green('✓ Code Auditor MCP Server started'));
  console.error(chalk.gray(`Listening on stdio · ${tools.length} tools · ${PACKAGE_VERSION}`));
  mcpDebugStderr(chalk.blue('[DEBUG]'), 'Server ready', {
    name: 'code-auditor',
    transport: 'stdio',
    toolCount: tools.length
  });
}

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

function generateRecommendations(result: AuditResult): any[] {
  const recommendations = [];
  
  if (result.summary.criticalIssues > 0) {
    recommendations.push({
      priority: 'high',
      title: 'Fix critical violations immediately',
      description: `${result.summary.criticalIssues} critical issues require immediate attention`,
    });
  }
  
  // Add more recommendation logic based on patterns
  
  return recommendations;
}

function getHealthRecommendation(score: number, result: AuditResult): string {
  if (score >= 90) return 'Excellent code health!';
  if (score >= 70) return 'Good code health with room for improvement';
  if (result.summary.criticalIssues > 0) {
    return `Fix ${result.summary.criticalIssues} critical violations first`;
  }
  return 'Code health needs attention - run detailed audit';
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