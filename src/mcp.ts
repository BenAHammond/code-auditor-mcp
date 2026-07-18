#!/usr/bin/env node

// MUST be first import: sets NAPI_RS_NATIVE_LIBRARY_PATH before @ast-grep/napi loads
import './native-bootstrap.js';

// ── Bootstrap: parse --data-dir before any module loads CodeIndexDB ──────────
import path from 'node:path';

let autoIndexPath: string | undefined;
let uiMode = false;
let stdioMode = false;
let showHelp = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--data-dir' || a === '--dataDir') {
    const val = argv[i + 1];
    if (val && !val.startsWith('-')) {
      process.env.CODE_AUDITOR_DATA_DIR = path.resolve(val);
    } else {
      console.error(
        '[code-auditor] --data-dir requires a directory path (next argv). Using CODE_AUDITOR_DATA_DIR env or default.',
      );
    }
  } else if (a === '--auto-index') {
    const val = argv[i + 1];
    if (val && !val.startsWith('-')) {
      autoIndexPath = path.resolve(val);
    } else {
      autoIndexPath = process.cwd();
    }
  } else if (a === '--ui') {
    uiMode = true;
  } else if (a === '--stdio') {
    stdioMode = true;
  } else if (a === '--help' || a === '-h') {
    showHelp = true;
  }
}

if (showHelp) {
  console.error(`code-auditor-mcp v0.0.0
Usage: code-auditor-mcp [--stdio] [--ui] [--auto-index <path>] [--data-dir <dir>]

  --stdio        Start MCP stdio server (default mode)
  --ui           Start the HTTP UI server on port 3001 (or MCP_UI_PORT)
  --auto-index   Sync the index from <path> and exit
  --data-dir     Directory for persistent data (index.db, tasks, configs)
  --help, -h     Show this message
`);
  process.exit(0);
}

// ── Imports ──────────────────────────────────────────────────────────────────
import chalk from 'chalk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';

import { createAuditRunner } from './auditRunner.js';
import type { AuditResult, AuditScope, FunctionMetadata, Severity } from './types.js';
import { searchFunctions, findDefinition, syncFileIndex, getDatabase } from './codeIndexService.js';
import { CodeMapGenerator } from './services/CodeMapGenerator.js';
import { analyzeDocumentation } from './analyzers/documentationAnalyzer.js';
import { ConfigGeneratorFactory } from './generators/ConfigGeneratorFactory.js';
import { DEFAULT_SERVER_URL, IS_DEV_MODE, PACKAGE_VERSION } from './constants.js';
import { getAuditJobStatus, getAuditResultsPage, getAuditResultsAsSarif, startAuditJob } from './mcpAuditJobs.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { logMcpDebug, logMcpInfo, mcpDebugStderr, mcpTraceStderr } from './mcpDiagnostics.js';
import { assertAuditPathExists, formatMcpToolErrorPayload } from './mcpToolErrors.js';
import { ToolRegistry } from './tool-registry.js';
import type { ActionDefinition, ToolDefinition } from './tool-registry.js';
import { initParsers } from './languages/index.js';

// ── Console / logging setup ──────────────────────────────────────────────────
const originalConsoleError = console.error;

let logStream: any = null;
if (IS_DEV_MODE) {
  const logFilePath = path.join(process.cwd(), 'mcp-server.log');
  logStream = createWriteStream(logFilePath, { flags: 'a' });
  console.error(chalk.blue('[INFO]'), `Development mode: Logging to file: ${logFilePath}`);
}

console.log = (...args: any[]) => {
  if (logStream) {
    const message = args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ');
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] [LOG] ${message}\n`);
  }
  originalConsoleError.apply(console, args);
};

console.error = (...args: any[]) => {
  if (logStream) {
    const message = args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ');
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] [ERROR] ${message}\n`);
  }
  originalConsoleError.apply(console, args);
};

// ── Helpers ──────────────────────────────────────────────────────────────────

class RequestAbortedError extends Error {
  constructor(message = 'MCP request aborted') {
    super(message);
    this.name = 'RequestAbortedError';
  }
}

function throwIfRequestAborted(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted) {
    throw new RequestAbortedError(`Request aborted${phase ? ` during ${phase}` : ''}`);
  }
}

async function withAbortSignal<T>(
  signal: AbortSignal | undefined,
  phase: string,
  op: () => Promise<T>,
): Promise<T> {
  throwIfRequestAborted(signal, phase);
  if (!signal) return op();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new RequestAbortedError(`Request aborted during ${phase}`));
    signal.addEventListener('abort', onAbort, { once: true });
    void op()
      .then(resolve)
      .catch(reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function serializeForMcp(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: `Failed to serialize MCP response: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function calculateHealthScore(result: AuditResult): number {
  const filesAnalyzed = result.metadata?.filesAnalyzed || 1;
  const critical = result.summary.criticalIssues || 0;
  const warnings = result.summary.warnings || 0;
  const suggestions = result.summary.suggestions || 0;
  const weights = { critical: 10, warning: 3, suggestion: 0.5 };
  const weightedViolations = critical * weights.critical + warnings * weights.warning + suggestions * weights.suggestion;
  const violationsPerFile = weightedViolations / filesAnalyzed;
  const score = 100 - violationsPerFile * 2;
  return Math.max(0, Math.round(Math.min(100, score)));
}

function getHealthRecommendation(score: number, result: AuditResult): string {
  if (score >= 90) return 'Excellent code health!';
  if (score >= 70) return 'Good code health with room for improvement';
  if (result.summary.criticalIssues > 0)
    return `Fix ${result.summary.criticalIssues} critical violations first`;
  return 'Code health needs attention - run detailed audit';
}

function registerProcessReliabilityHandlers(): void {
  const g = globalThis as {
    __codeAuditorUncaughtExceptionHandlerInstalled?: boolean;
    __codeAuditorUnhandledRejectionHandlerInstalled?: boolean;
  };
  const exitOnFatal =
    process.env.CODE_AUDITOR_EXIT_ON_FATAL === '1' ||
    process.env.CODE_AUDITOR_EXIT_ON_FATAL === 'true';

  if (!g.__codeAuditorUncaughtExceptionHandlerInstalled) {
    process.on('uncaughtException', (error) => {
      console.error(chalk.red('[ERROR]'), 'Uncaught exception:', error);
      console.error(chalk.red('[ERROR]'), 'Stack:', error.stack);
      console.error(chalk.red('[ERROR]'), 'Error details:', safeJson(error));
      if (exitOnFatal) process.exit(1);
    });
    g.__codeAuditorUncaughtExceptionHandlerInstalled = true;
  }

  if (!g.__codeAuditorUnhandledRejectionHandlerInstalled) {
    process.on('unhandledRejection', (reason, promise) => {
      console.error(chalk.red('[ERROR]'), 'Unhandled rejection at:', promise);
      console.error(chalk.red('[ERROR]'), 'Reason:', reason);
      console.error(chalk.red('[ERROR]'), 'Rejection details:', safeJson(reason));
      if (exitOnFatal) process.exit(1);
    });
    g.__codeAuditorUnhandledRejectionHandlerInstalled = true;
  }
}

// ── Tool registration ────────────────────────────────────────────────────────

const DEFAULT_ANALYZERS = ['solid', 'dry', 'documentation', 'react', 'data-access'];

function registerAllTools(registry: ToolRegistry): void {
  // ── audit ──────────────────────────────────────────────────────────────────
  const auditActions: ActionDefinition[] = [
    {
      name: 'run',
      description: 'Run a synchronous audit on the specified path. Returns a full audit result with violations.',
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
          description: `Analyzers to run (default: ${DEFAULT_ANALYZERS.join(', ')}).`,
          default: DEFAULT_ANALYZERS,
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
          name: 'scope',
          type: 'string',
          required: false,
          description: 'Audit scope: "all" (default), "changed" (files differing from index), "git:<ref>" (diff against a git ref), or a comma-separated list of file paths.',
          default: 'all',
        },
      ],
      handler: async (args, signal) => {
        return withAbortSignal(signal, 'audit.run', async () => {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          await assertAuditPathExists(auditPath);
          const analyzers = (args.analyzers as string[]) ?? DEFAULT_ANALYZERS;
          const minSeverity = ((args.minSeverity as string) || 'warning') as Severity;
          const indexFunctions = (args.indexFunctions as boolean) !== false;

          const db = CodeIndexDB.getInstance();
          await db.initialize();
          const storedConfigs = await db.getAllAnalyzerConfigs(auditPath);
          const analyzerConfigs = {
            ...storedConfigs,
            ...((args.analyzerConfigs as Record<string, any>) || {}),
          };

          const scope = (args.scope as string) || 'all';
          const runner = createAuditRunner({
            projectRoot: auditPath,
            enabledAnalyzers: analyzers,
            minSeverity,
            verbose: false,
            indexFunctions,
            scope: scope !== 'all' ? (scope as AuditScope) : undefined,
            ...(Object.keys(analyzerConfigs).length > 0 && { analyzerConfigs }),
          });

          const auditResult = await runner.run();

          if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
            try {
              for (const [filePath, functions] of Object.entries(
                auditResult.metadata.fileToFunctionsMap,
              )) {
                await syncFileIndex(filePath, functions as FunctionMetadata[]);
              }
            } catch {
              // indexing is best-effort for sync audit
            }
          }

          return {
            success: true,
            summary: auditResult.summary,
            violations: auditResult.analyzerResults,
            metadata: auditResult.metadata,
          };
        });
      },
    },
    {
      name: 'start',
      description:
        'Start a background audit job. Returns immediately with a jobId. Poll `audit.status` until completed, then fetch pages with `audit.results`.',
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
          description: `Analyzers to run (default: ${DEFAULT_ANALYZERS.join(', ')}).`,
          default: DEFAULT_ANALYZERS,
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
          name: 'scope',
          type: 'string',
          required: false,
          description: 'Audit scope: "all" (default), "changed" (files differing from index), "git:<ref>" (diff against a git ref), or a comma-separated list of file paths.',
          default: 'all',
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
          description: 'Partition mode: none | auto | top-level.',
          default: 'auto',
          enum: ['none', 'auto', 'top-level'],
        },
        {
          name: 'maxPartitions',
          type: 'number',
          required: false,
          description: 'Maximum number of folder partitions (default: 4).',
          default: 4,
        },
        {
          name: 'partitionThresholdFiles',
          type: 'number',
          required: false,
          description: 'Minimum files before auto partitioning (default: 250).',
          default: 250,
        },
        {
          name: 'workerCount',
          type: 'number',
          required: false,
          description: 'Number of worker processes (default: min(4, CPU-1)).',
        },
        {
          name: 'maxRetries',
          type: 'number',
          required: false,
          description: 'Retry attempts per shard (default: 1).',
          default: 1,
        },
        {
          name: 'shardTimeoutMs',
          type: 'number',
          required: false,
          description: 'Per-shard timeout in ms (default: 180000).',
          default: 180000,
        },
        {
          name: 'retryBackoffMs',
          type: 'number',
          required: false,
          description: 'Base retry backoff in ms (default: 500).',
          default: 500,
        },
        {
          name: 'jobTimeoutMs',
          type: 'number',
          required: false,
          description: 'Max wall time for the audit job (default 30m, cap 4h).',
        },
        {
          name: 'maxFilesPerRun',
          type: 'number',
          required: false,
          description: 'Per worker chunk size for file processing.',
        },
        {
          name: 'shardSoftBudgetMs',
          type: 'number',
          required: false,
          description: 'Per worker soft wall-clock budget.',
        },
        {
          name: 'generateCodeMap',
          type: 'boolean',
          required: false,
          description: 'Generate code map artifacts during audit (default: false).',
          default: false,
        },
      ],
      handler: async (args, signal) => {
        return withAbortSignal(signal, 'audit.start', () =>
          startAuditJob(args, {
            defaultAnalyzers: DEFAULT_ANALYZERS,
            defaultMinSeverity: 'warning',
            defaultGenerateCodeMap: false,
          }),
        );
      },
    },
    {
      name: 'status',
      description: 'Get current status for a previously started background audit job.',
      parameters: [
        {
          name: 'jobId',
          type: 'string',
          required: true,
          description: 'Job ID returned by `audit start`.',
        },
      ],
      handler: async (args) => {
        const jobId = args.jobId as string | undefined;
        if (!jobId) throw new Error('audit.status requires jobId');
        return getAuditJobStatus(jobId);
      },
    },
    {
      name: 'results',
      description: 'Fetch paginated violations for a completed audit result by resultId.',
      parameters: [
        {
          name: 'resultId',
          type: 'string',
          required: false,
          description: 'Result ID returned by `audit status` when completed. Also accepts legacy `auditId`.',
        },
        {
          name: 'auditId',
          type: 'string',
          required: false,
          description: 'Backward-compatible alias for resultId.',
        },
        {
          name: 'limit',
          type: 'number',
          required: false,
          description: 'Maximum violations per page (default: 50, max: 100).',
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
          name: 'format',
          type: 'string',
          required: false,
          description: 'Output format. "json" (default, structured data) or "sarif" (SARIF 2.1.0 JSON string).',
        },
      ],
      handler: async (args, signal) => {
        const format = (args.format as string) || 'json';
        if (format === 'sarif') {
          return withAbortSignal(signal, 'audit.results', () => getAuditResultsAsSarif(args));
        }
        return withAbortSignal(signal, 'audit.results', () => getAuditResultsPage(args));
      },
    },
    {
      name: 'health',
      description: 'Quick health check of a codebase with key metrics and optional code map generation.',
      parameters: [
        {
          name: 'path',
          type: 'string',
          required: false,
          description: 'The directory path to check.',
          default: process.cwd(),
        },
        {
          name: 'threshold',
          type: 'number',
          required: false,
          description: 'Health score threshold (0-100) for pass/fail.',
          default: 70,
        },
        {
          name: 'indexFunctions',
          type: 'boolean',
          required: false,
          description: 'Automatically index functions during health check.',
          default: true,
        },
        {
          name: 'analyzerConfigs',
          type: 'object',
          required: false,
          description: 'Analyzer-specific configuration overrides.',
        },
        {
          name: 'generateCodeMap',
          type: 'boolean',
          required: false,
          description: 'Generate and return a human-readable code map.',
          default: true,
        },
      ],
      handler: async (args) => {
        const auditPath = path.resolve((args.path as string) || process.cwd());
        await assertAuditPathExists(auditPath);
        const threshold = (args.threshold as number) || 70;
        const indexFunctions = (args.indexFunctions as boolean) !== false;
        const generateCodeMap = (args.generateCodeMap as boolean) !== false;

        const db = CodeIndexDB.getInstance();
        await db.initialize();
        const storedConfigs = await db.getAllAnalyzerConfigs(auditPath);
        const analyzerConfigs = {
          ...storedConfigs,
          ...((args.analyzerConfigs as Record<string, any>) || {}),
        };

        const runner = createAuditRunner({
          projectRoot: auditPath,
          enabledAnalyzers: DEFAULT_ANALYZERS,
          minSeverity: 'warning' as Severity,
          verbose: false,
          indexFunctions,
          ...(Object.keys(analyzerConfigs).length > 0 && { analyzerConfigs }),
          progressCallback: (p) => {
            if (
              p.phase === 'function-indexing' &&
              typeof p.current === 'number' &&
              typeof p.total === 'number' &&
              p.total > 0 &&
              p.current % 50 !== 0 &&
              p.current !== p.total
            )
              return;
            logMcpDebug('audit.health', p.message ?? p.phase ?? 'progress', {
              phase: p.phase,
              analyzer: p.analyzer,
              current: p.current,
              total: p.total,
            });
          },
        });

        const auditResult = await runner.run();
        const healthScore = calculateHealthScore(auditResult);

        let indexingResult: any = null;
        if (indexFunctions && auditResult.metadata.fileToFunctionsMap) {
          try {
            const syncStats = { added: 0, updated: 0, removed: 0 };
            for (const [filePath, functions] of Object.entries(
              auditResult.metadata.fileToFunctionsMap,
            )) {
              const fileStats = await syncFileIndex(filePath, functions as FunctionMetadata[]);
              syncStats.added += fileStats.added;
              syncStats.updated += fileStats.updated;
              syncStats.removed += fileStats.removed;
            }
            indexingResult = {
              success: true,
              registered: syncStats.added + syncStats.updated,
              failed: 0,
              syncStats,
            };
          } catch {
            // best-effort
          }
        }

        let codeMapResult: any = null;
        if (generateCodeMap && indexingResult && indexingResult.success) {
          try {
            const mapGenerator = new CodeMapGenerator();
            const mapOptions = {
              includeComplexity: true,
              includeDocumentation: true,
              includeDependencies: true,
              includeUsage: false,
              groupByDirectory: true,
              maxDepth: 8,
              showUnusedImports: true,
              minComplexity: 7,
            };
            let documentation: any;
            try {
              const files = Object.keys(auditResult.metadata.fileToFunctionsMap || {});
              if (files.length > 0) {
                const docResult = await analyzeDocumentation(files);
                documentation = docResult.metrics;
              }
            } catch {
              // best-effort
            }
            const paginatedResult = await mapGenerator.generatePaginatedCodeMap(auditPath, {
              ...mapOptions,
              includeDocumentation: !!documentation,
            });
            codeMapResult = {
              success: true,
              mapId: paginatedResult.mapId,
              summary: paginatedResult.summary,
              quickPreview: paginatedResult.quickPreview,
              sections: paginatedResult.summary.sectionsAvailable,
              documentationCoverage: documentation?.coverageScore,
            };
          } catch (error) {
            codeMapResult = {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to generate code map',
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
          recommendation: getHealthRecommendation(healthScore, auditResult),
          ...(indexingResult && { functionIndexing: indexingResult }),
          ...(codeMapResult && { codeMap: codeMapResult }),
        };
      },
    },
  ];

  registry.register({
    name: 'audit',
    description:
      'Run code quality audits (synchronous or background), check status, fetch paginated results, and get health checks. Actions: run (sync audit, returns full results), start (background job), status (poll a job), results (paginated violations), health (score + code map).',
    actions: auditActions,
  });

  // ── search ─────────────────────────────────────────────────────────────────
  registry.register({
    name: 'search',
    description:
      'Search indexed functions and components. Actions: query (natural language + operators like entity:, component:, hook:, dep:, calls:, lang:, complexity:, exported:, jsdoc:, file:, unused-imports, name:), definition (exact function/component lookup).',
    actions: [
      {
        name: 'query',
        description: 'Search indexed functions with natural language queries and filter operators.',
        parameters: [
          {
            name: 'query',
            type: 'string',
            required: true,
            description:
              'Search query with natural language and/or operators. Examples: "Button component:functional", "calls:validateUser", "unused-imports".',
          },
          {
            name: 'filters',
            type: 'object',
            required: false,
            description: 'Optional filters (language, filePath, dependencies, componentType, entityType, searchMode).',
          },
          {
            name: 'limit',
            type: 'number',
            required: false,
            description: 'Maximum results to return.',
            default: 50,
          },
          {
            name: 'offset',
            type: 'number',
            required: false,
            description: 'Offset for pagination.',
            default: 0,
          },
        ],
        handler: async (args) => {
          const query = args.query as string;
          const filters = args.filters as any;
          const limit = (args.limit as number) || 50;
          const offset = (args.offset as number) || 0;
          if (query !== undefined && typeof query !== 'string')
            throw new Error('query must be a string');
          return searchFunctions({ query, filters, limit, offset });
        },
      },
      {
        name: 'definition',
        description: 'Find the exact definition of a specific function or React component.',
        parameters: [
          {
            name: 'name',
            type: 'string',
            required: true,
            description: 'Function or component name to find.',
          },
          {
            name: 'filePath',
            type: 'string',
            required: false,
            description: 'Optional file path to narrow search.',
          },
        ],
        handler: async (args) => {
          const name = args.name as string;
          const filePath = args.filePath as string;
          if (!name || typeof name !== 'string') throw new Error('name must be a non-empty string');
          const definition = await findDefinition(name, filePath);
          return definition || { error: 'Function not found' };
        },
      },
    ],
  });

  // ── index ──────────────────────────────────────────────────────────────────
  registry.register({
    name: 'index',
    description:
      'Manage the code index. Actions: sync (update from files with optional auto-whitelist), cleanup (remove deleted files), reset (clear analysis data, preserve tasks/config/whitelist), status (index statistics).',
    actions: [
      {
        name: 'sync',
        description: 'Synchronize index from filesystem. Discovers TypeScript/JavaScript functions and updates the index.',
        parameters: [
          {
            name: 'path',
            type: 'string',
            required: false,
            description: 'Optional specific path to sync. Omit for full deep sync.',
          },
        ],
        handler: async (args) => {
          const targetPath = args.path as string | undefined;
          const db = CodeIndexDB.getInstance();
          await db.initialize();

          if (targetPath) {
            const syncResult = await db.synchronizeFile(path.resolve(targetPath));
            return {
              mode: 'sync',
              success: true,
              path: targetPath,
              ...(syncResult || { message: 'File not found' }),
            };
          }

          const syncResult = await db.deepSync();
          const result: any = {
            mode: 'sync',
            success: true,
            syncedFiles: syncResult.syncedFiles,
            addedFunctions: syncResult.addedFunctions,
            updatedFunctions: syncResult.updatedFunctions,
            removedFunctions: syncResult.removedFunctions,
            errors: syncResult.errors,
            message: `Synced ${syncResult.syncedFiles} files: ${syncResult.addedFunctions} added, ${syncResult.updatedFunctions} updated, ${syncResult.removedFunctions} removed`,
          };

          // Auto-detect and populate whitelist entries (from standalone)
          try {
            const { WhitelistService } = await import('./services/whitelistService.js');
            const whitelistService = WhitelistService.getInstance();
            const whitelistResult = await whitelistService.whitelistAllDependencies(
              targetPath || process.cwd(),
            );
            if (whitelistResult.added > 0) {
              result.whitelistAdded = whitelistResult.added;
              result.whitelistMessage = `Auto-added ${whitelistResult.added} whitelist entries`;
            }
          } catch {
            // whitelist detection is best-effort
          }

          return result;
        },
      },
      {
        name: 'cleanup',
        description: 'Remove index entries for files that no longer exist on disk.',
        parameters: [],
        handler: async () => {
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          const cleanupResult = await db.bulkCleanup();
          return {
            mode: 'cleanup',
            success: true,
            scannedFiles: cleanupResult.scannedCount,
            removedEntries: cleanupResult.removedCount,
            removedFiles: cleanupResult.removedFiles,
            errors: cleanupResult.errors,
            message: `Cleaned up ${cleanupResult.removedCount} entries from ${cleanupResult.removedFiles.length} deleted files`,
          };
        },
      },
      {
        name: 'reset',
        description: 'Clear all analysis-derived data (functions, search index, cached audits, code maps, schemas). Project tasks, whitelist, and analyzer configs are preserved.',
        parameters: [],
        handler: async () => {
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          await db.clearIndex();
          return {
            mode: 'reset',
            success: true,
            message:
              'Analysis-derived data cleared (functions, search index, cached audits, code maps, schemas). Project tasks, whitelist, and analyzer configs were preserved.',
          };
        },
      },
      {
        name: 'status',
        description: 'Get index statistics (function count, file count, last sync time).',
        parameters: [],
        handler: async () => {
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          const funcs = await db.getAllFunctions();
          return {
            success: true,
            functionCount: Array.isArray(funcs) ? funcs.length : 0,
          };
        },
      },
    ],
  });

  // ── config ─────────────────────────────────────────────────────────────────
  registry.register({
    name: 'config',
    description:
      'Manage analyzer configurations, generate AI tool configs, manage whitelists, and manage invariant rules. Actions: get, set, reset (analyzer configs), generate (AI tool config files), whitelist_list, whitelist_add, whitelist_update, whitelist_detect, rules_list, rules_check.',
    actions: [
      {
        name: 'get',
        description: 'Get current configuration for an analyzer (or all).',
        parameters: [
          {
            name: 'analyzerName',
            type: 'string',
            required: false,
            description: 'Specific analyzer name, or omit to get all configs.',
          },
          {
            name: 'projectPath',
            type: 'string',
            required: false,
            description: 'Optional project path for project-specific config.',
          },
        ],
        handler: async (args) => {
          const analyzerName = args.analyzerName as string | undefined;
          const projectPath = args.projectPath as string | undefined;
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          if (analyzerName) {
            const config = await db.getAnalyzerConfig(analyzerName, projectPath);
            return {
              success: true,
              analyzer: analyzerName,
              config: config || null,
              scope: projectPath ? 'project' : 'global',
              message: config ? 'Configuration found' : 'No custom configuration found, using defaults',
            };
          }
          const configs = await db.getAllAnalyzerConfigs(projectPath);
          return {
            success: true,
            configs,
            scope: projectPath ? 'project' : 'global',
            message: `Found ${Object.keys(configs).length} analyzer configurations`,
          };
        },
      },
      {
        name: 'set',
        description: 'Set or update analyzer configuration that persists across audit runs.',
        parameters: [
          {
            name: 'analyzerName',
            type: 'string',
            required: true,
            description: 'The analyzer to configure (solid, dry, security, etc.).',
          },
          {
            name: 'config',
            type: 'object',
            required: true,
            description: 'Configuration object for the analyzer (e.g., thresholds, rules).',
          },
          {
            name: 'projectPath',
            type: 'string',
            required: false,
            description: 'Optional project path for project-specific config.',
          },
        ],
        handler: async (args) => {
          const analyzerName = args.analyzerName as string;
          const config = args.config as Record<string, any>;
          const projectPath = args.projectPath as string | undefined;
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          await db.storeAnalyzerConfig(analyzerName, config, {
            projectPath,
            isGlobal: !projectPath,
          });
          return {
            success: true,
            message: `Configuration for ${analyzerName} analyzer has been saved${projectPath ? ` for project ${projectPath}` : ' globally'}`,
            analyzer: analyzerName,
            scope: projectPath ? 'project' : 'global',
            config,
          };
        },
      },
      {
        name: 'reset',
        description: 'Reset analyzer configuration to defaults.',
        parameters: [
          {
            name: 'analyzerName',
            type: 'string',
            required: false,
            description: 'Specific analyzer to reset, or omit to reset all.',
          },
          {
            name: 'projectPath',
            type: 'string',
            required: false,
            description: 'Optional project path to reset only project-specific config.',
          },
        ],
        handler: async (args) => {
          const analyzerName = args.analyzerName as string | undefined;
          const projectPath = args.projectPath as string | undefined;
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          if (analyzerName) {
            const deleted = await db.deleteAnalyzerConfig(analyzerName, {
              projectPath,
              isGlobal: !projectPath,
            });
            return {
              success: deleted,
              message: deleted
                ? `Configuration for ${analyzerName} analyzer has been reset${projectPath ? ` for project ${projectPath}` : ' globally'}`
                : `No configuration found for ${analyzerName} analyzer`,
              analyzer: analyzerName,
              scope: projectPath ? 'project' : 'global',
            };
          }
          await db.resetAnalyzerConfigs(projectPath);
          return {
            success: true,
            message: projectPath
              ? `All project-specific configurations for ${projectPath} have been reset`
              : 'All analyzer configurations have been reset to defaults',
            scope: projectPath ? 'project' : 'global',
          };
        },
      },
      {
        name: 'generate',
        description: 'Generate configuration files for AI coding assistants (Cursor, Claude, Copilot, etc.).',
        parameters: [
          {
            name: 'tools',
            type: 'array',
            required: true,
            description: 'AI tools to configure (cursor, continue, copilot, claude, zed, windsurf, cody, aider, cline, pearai).',
          },
          {
            name: 'outputDir',
            type: 'string',
            required: false,
            description: 'Output directory for configuration files.',
            default: '.',
          },
          {
            name: 'serverUrl',
            type: 'string',
            required: false,
            description: 'MCP server URL (default: auto-detected).',
            default: DEFAULT_SERVER_URL,
          },
          {
            name: 'overwrite',
            type: 'boolean',
            required: false,
            description: 'Overwrite existing files (default: false).',
            default: false,
          },
        ],
        handler: async (args) => {
          const tools = args.tools as string[];
          const serverUrl = (args.serverUrl as string) || DEFAULT_SERVER_URL;
          const outputDir = (args.outputDir as string) || '.';
          const overwrite = (args.overwrite as boolean) || false;

          if (!Array.isArray(tools) || tools.length === 0)
            throw new Error('tools parameter must be a non-empty array');

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

              let fileExists = false;
              try {
                await fs.access(outputPath);
                fileExists = true;
              } catch {
                // doesn't exist
              }
              if (fileExists && !overwrite) {
                errors.push(`File already exists: ${config.filename} (use overwrite: true to replace)`);
                continue;
              }
              await fs.mkdir(path.dirname(outputPath), { recursive: true });
              await fs.writeFile(outputPath, config.content);
              generatedFiles.push(config.filename);

              if (config.additionalFiles) {
                for (const additionalFile of config.additionalFiles) {
                  const additionalPath = path.resolve(outputDir, additionalFile.filename);
                  await fs.mkdir(path.dirname(additionalPath), { recursive: true });
                  await fs.writeFile(additionalPath, additionalFile.content);
                  generatedFiles.push(additionalFile.filename);
                }
              }
            } catch (error) {
              errors.push(
                `Failed to generate config for ${tool}: ${error instanceof Error ? error.message : 'Unknown error'}`,
              );
            }
          }

          return {
            success: errors.length === 0,
            generatedFiles,
            errors: errors.length > 0 ? errors : undefined,
            totalRequested: tools.length,
            totalGenerated: generatedFiles.length,
          };
        },
      },
      {
        name: 'whitelist_list',
        description: 'Get current whitelist entries for dependency and class instantiation checks.',
        parameters: [
          {
            name: 'type',
            type: 'string',
            required: false,
            description: 'Filter by type: platform-api, framework-class, project-dep, shared-library, node-builtin.',
            enum: ['platform-api', 'framework-class', 'project-dep', 'shared-library', 'node-builtin'],
          },
          {
            name: 'status',
            type: 'string',
            required: false,
            description: 'Filter by status: active, pending, rejected, disabled.',
            enum: ['active', 'pending', 'rejected', 'disabled'],
          },
        ],
        handler: async (args) => {
          const { handleWhitelistGet } = await import('./mcp-tools/whitelistTools.js');
          return handleWhitelistGet(args);
        },
      },
      {
        name: 'whitelist_add',
        description: 'Add a new entry to the whitelist.',
        parameters: [
          {
            name: 'name',
            type: 'string',
            required: true,
            description: 'Class name or import path to whitelist.',
          },
          {
            name: 'type',
            type: 'string',
            required: true,
            description: 'Type of whitelist entry.',
            enum: ['platform-api', 'framework-class', 'project-dep', 'shared-library', 'node-builtin'],
          },
          {
            name: 'description',
            type: 'string',
            required: false,
            description: 'Explanation of why this is whitelisted.',
          },
          {
            name: 'patterns',
            type: 'array',
            required: false,
            description: 'Additional patterns to match (e.g., ["fs/*", "node:fs"]).',
          },
        ],
        handler: async (args) => {
          const { handleWhitelistAdd } = await import('./mcp-tools/whitelistTools.js');
          return handleWhitelistAdd(args);
        },
      },
      {
        name: 'whitelist_update',
        description: 'Update the status of a whitelist entry.',
        parameters: [
          {
            name: 'name',
            type: 'string',
            required: true,
            description: 'Name of the whitelist entry to update.',
          },
          {
            name: 'status',
            type: 'string',
            required: true,
            description: 'New status for the entry.',
            enum: ['active', 'pending', 'rejected', 'disabled'],
          },
        ],
        handler: async (args) => {
          const { handleWhitelistUpdateStatus } = await import('./mcp-tools/whitelistTools.js');
          return handleWhitelistUpdateStatus(args);
        },
      },
      {
        name: 'whitelist_detect',
        description: 'Detect potential whitelist candidates from package.json and usage patterns.',
        parameters: [
          {
            name: 'path',
            type: 'string',
            required: false,
            description: 'Project path to analyze (defaults to current directory).',
            default: process.cwd(),
          },
          {
            name: 'includePackageJson',
            type: 'boolean',
            required: false,
            description: 'Include dependencies from package.json.',
            default: true,
          },
          {
            name: 'autoPopulate',
            type: 'boolean',
            required: false,
            description: 'Automatically add high-confidence entries.',
            default: false,
          },
        ],
        handler: async (args) => {
          const { handleWhitelistDetect } = await import('./mcp-tools/whitelistTools.js');
          return handleWhitelistDetect(args);
        },
      },
      {
        name: 'rules_list',
        description: 'List all configured invariant rules from .codeauditor.json. Shows rule IDs, kinds, severity, and messages.',
        parameters: [
          {
            name: 'configPath',
            type: 'string',
            required: false,
            description: 'Path to .codeauditor.json (defaults to auto-detect in current working tree).',
          },
        ],
        handler: async (args) => {
          const { readFileSync } = await import('fs');
          const path = await import('path');
          const configPath = (args.configPath as string) ||
            path.join(process.cwd(), '.codeauditor.json');
          try {
            const raw = readFileSync(configPath, 'utf-8');
            const config = JSON.parse(raw);
            const rules = config?.rules ?? [];
            return {
              rules: rules.map((r: any) => ({
                id: r.id,
                kind: r.kind,
                severity: r.severity,
                message: r.message || null,
              })),
              count: rules.length,
              configPath,
            };
          } catch (err: any) {
            return {
              error: `Failed to read rules: ${err.message}`,
              configPath,
              rules: [],
              count: 0,
            };
          }
        },
      },
      {
        name: 'rules_check',
        description: 'Validate the current .codeauditor.json rules (schema, duplicate IDs, valid globs/regex, mutual exclusivity). Returns any config errors.',
        parameters: [
          {
            name: 'configPath',
            type: 'string',
            required: false,
            description: 'Path to .codeauditor.json (defaults to auto-detect in current working tree).',
          },
        ],
        handler: async (args) => {
          const { validateRulesConfig } = await import('./invariants/ruleValidator.js');
          const { readFileSync } = await import('fs');
          const path = await import('path');
          const configPath = (args.configPath as string) ||
            path.join(process.cwd(), '.codeauditor.json');
          try {
            const raw = readFileSync(configPath, 'utf-8');
            const config = JSON.parse(raw);
            const rulesArray = config?.rules;
            const errors = validateRulesConfig({ rules: rulesArray ?? [] });
            return {
              valid: errors.length === 0,
              errors: errors.map(e => ({ ruleId: e.ruleId || null, message: e.message })),
              configPath,
            };
          } catch (err: any) {
            return {
              valid: false,
              errors: [{ message: `Failed to read/parse config: ${err.message}` }],
              configPath,
            };
          }
        },
      },
    ],
  });

  // ── code_map ───────────────────────────────────────────────────────────────
  registry.register({
    name: 'code_map',
    description:
      'Retrieve sections of previously generated code maps. Actions: get (retrieve a specific section), list (list all available sections for a map).',
    actions: [
      {
        name: 'get',
        description: 'Retrieve a specific section of a previously generated code map.',
        parameters: [
          {
            name: 'mapId',
            type: 'string',
            required: true,
            description: 'The map ID returned from a previous audit with code map generation.',
          },
          {
            name: 'sectionType',
            type: 'string',
            required: true,
            description: 'The section type to retrieve (e.g., overview, files, dependencies, documentation).',
          },
        ],
        handler: async (args) => {
          const mapId = args.mapId as string;
          const sectionType = args.sectionType as string;
          if (!mapId || !sectionType)
            return { success: false, error: 'Both mapId and sectionType are required' };
          const db = await getDatabase();
          const section = await db.getCodeMapSection(mapId, sectionType);
          if (section) {
            return { success: true, mapId, sectionType, content: section.content, metadata: section.metadata };
          }
          return { success: false, error: `Section '${sectionType}' not found for map '${mapId}'` };
        },
      },
      {
        name: 'list',
        description: 'List all available sections for a code map.',
        parameters: [
          {
            name: 'mapId',
            type: 'string',
            required: true,
            description: 'The map ID returned from a previous audit.',
          },
        ],
        handler: async (args) => {
          const mapId = args.mapId as string;
          if (!mapId) return { success: false, error: 'mapId is required' };
          const db = await getDatabase();
          const sections = await db.listCodeMapSections(mapId);
          return { success: true, mapId, sections, totalSections: sections.length };
        },
      },
    ],
  });

  // ── tasks ──────────────────────────────────────────────────────────────────
  registry.register({
    name: 'tasks',
    description:
      'Manage a persistent per-project task queue. Tasks survive index resets. Actions: create, list, list_tree, get, update, complete, delete, from_audit (create tasks from audit violations with deduplication).',
    actions: [
      {
        name: 'create',
        description: 'Create a new task.',
        parameters: [
          { name: 'projectPath', type: 'string', required: false, description: 'Project root.' },
          { name: 'title', type: 'string', required: true, description: 'Task title.' },
          { name: 'description', type: 'string', required: false, description: 'Longer description.' },
          { name: 'status', type: 'string', required: false, description: 'Initial status.', enum: ['pending', 'in_progress', 'blocked', 'done', 'cancelled'] },
          { name: 'priority', type: 'string', required: false, description: 'Priority.', enum: ['low', 'medium', 'high'] },
          { name: 'labels', type: 'array', required: false, description: 'String tags.' },
          { name: 'metadata', type: 'object', required: false, description: 'Arbitrary JSON.' },
          { name: 'parentTaskId', type: 'string', required: false, description: 'Optional parent.' },
          { name: 'source', type: 'string', required: false, description: 'Provenance.', enum: ['manual', 'audit', 'mcp'] },
          { name: 'blockedBy', type: 'array', required: false, description: 'Blocking task IDs.' },
          { name: 'dueAt', type: 'string', required: false, description: 'ISO 8601 due datetime.' },
          { name: 'sortOrder', type: 'number', required: false, description: 'Sort position (default 0).' },
          { name: 'relatedFiles', type: 'array', required: false, description: 'File paths.' },
          { name: 'relatedSymbols', type: 'array', required: false, description: 'Symbol names.' },
        ],
        handler: async (args, signal) => {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          return handleProjectTasks({ ...args, action: 'create' }, { signal });
        },
      },
      {
        name: 'list',
        description: 'List tasks (flat). Supports filtering by status, priority, labels, source, query text search.',
        parameters: [
          { name: 'projectPath', type: 'string', required: false, description: 'Project root.' },
          { name: 'status', type: 'string', required: false, description: 'Filter by status.', enum: ['pending', 'in_progress', 'blocked', 'done', 'cancelled'] },
          { name: 'priority', type: 'string', required: false, description: 'Filter by priority.', enum: ['low', 'medium', 'high'] },
          { name: 'label', type: 'string', required: false, description: 'Filter by label.' },
          { name: 'source', type: 'string', required: false, description: 'Filter by source.', enum: ['manual', 'audit', 'mcp'] },
          { name: 'query', type: 'string', required: false, description: 'Text search across title/description.' },
          { name: 'hasChildren', type: 'boolean', required: false, description: 'Filter by subtask presence.' },
          { name: 'overdueOnly', type: 'boolean', required: false, description: 'Only overdue tasks.' },
          { name: 'actionableOnly', type: 'boolean', required: false, description: 'Only open + unblocked.' },
          { name: 'limit', type: 'number', required: false, description: 'Max results (default 500).' },
        ],
        handler: async (args, signal) => {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          return handleProjectTasks({ ...args, action: 'list' }, { signal });
        },
      },
      {
        name: 'list_tree',
        description: 'List tasks as a tree (parent-child hierarchy).',
        parameters: [
          { name: 'projectPath', type: 'string', required: false, description: 'Project root.' },
          { name: 'status', type: 'string', required: false, description: 'Filter by status.', enum: ['pending', 'in_progress', 'blocked', 'done', 'cancelled'] },
          { name: 'limit', type: 'number', required: false, description: 'Max tasks (default 500).' },
        ],
        handler: async (args, signal) => {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          return handleProjectTasks({ ...args, action: 'list_tree' }, { signal });
        },
      },
      {
        name: 'get',
        description: 'Get a single task by ID.',
        parameters: [
          { name: 'projectPath', type: 'string', required: false, description: 'Project root.' },
          { name: 'taskId', type: 'string', required: true, description: 'Task ID.' },
        ],
        handler: async (args, signal) => {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          return handleProjectTasks({ ...args, action: 'get' }, { signal });
        },
      },
      {
        name: 'update',
        description: 'Update a task with a patch of partial fields.',
        parameters: [
          { name: 'projectPath', type: 'string', required: false, description: 'Project root.' },
          { name: 'taskId', type: 'string', required: true, description: 'Task ID.' },
          { name: 'patch', type: 'object', required: true, description: 'Partial fields to update.' },
        ],
        handler: async (args, signal) => {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          return handleProjectTasks({ ...args, action: 'update' }, { signal });
        },
      },
      {
        name: 'complete',
        description: 'Mark a task as completed.',
        parameters: [
          { name: 'projectPath', type: 'string', required: false, description: 'Project root.' },
          { name: 'taskId', type: 'string', required: true, description: 'Task ID.' },
        ],
        handler: async (args, signal) => {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          return handleProjectTasks({ ...args, action: 'complete_task' }, { signal });
        },
      },
      {
        name: 'delete',
        description: 'Delete a task. Mode: reject (default, refuse if subtasks exist), detach (move subtasks up), cascade (delete subtree).',
        parameters: [
          { name: 'projectPath', type: 'string', required: false, description: 'Project root.' },
          { name: 'taskId', type: 'string', required: true, description: 'Task ID.' },
          { name: 'mode', type: 'string', required: false, description: 'Delete mode.', enum: ['reject', 'detach', 'cascade'] },
        ],
        handler: async (args, signal) => {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          return handleProjectTasks({ ...args, action: 'delete' }, { signal });
        },
      },
      {
        name: 'from_audit',
        description:
          'Create tasks from audit violations with deduplication. Each violation gets a stable fingerprint; violations matching existing open tasks are skipped.',
        parameters: [
          { name: 'projectPath', type: 'string', required: false, description: 'Project root.' },
          { name: 'auditJobId', type: 'string', required: false, description: 'Audit job ID. Omit to use most recent completed audit.' },
          { name: 'severities', type: 'array', required: false, description: 'Severities to include (default: critical, warning).' },
          { name: 'analyzers', type: 'array', required: false, description: 'Filter violations by analyzer name.' },
          { name: 'paths', type: 'array', required: false, description: 'Filter violations by file path globs.' },
        ],
        handler: async (args, signal) => {
          const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
          return handleProjectTasks({ ...args, action: 'from_audit' }, { signal });
        },
      },
    ],
  });

  // ── guide ──────────────────────────────────────────────────────────────────
  registry.register({
    name: 'guide',
    description:
      'Get recommended workflows and best practices for using the code auditor tools effectively. Single action: get.',
    actions: [
      {
        name: 'get',
        description: 'Get workflow guide for a specific scenario or all scenarios.',
        parameters: [
          {
            name: 'scenario',
            type: 'string',
            required: false,
            description:
              'Specific scenario: initial-setup, react-development, code-review, find-patterns, maintenance. Leave empty to see all.',
          },
        ],
        handler: async (args) => {
          const scenario = args.scenario as string | undefined;
          const { getWorkflowGuide, getWorkflowTips } = await import('./mcp-tools/workflowGuide.js');
          try {
            const workflows = getWorkflowGuide(scenario);
            const tips = getWorkflowTips();
            return {
              success: true,
              ...(scenario ? { workflow: workflows } : { workflows }),
              tips,
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              availableScenarios: [
                'initial-setup',
                'react-development',
                'code-review',
                'find-patterns',
                'maintenance',
                'analyzer-configuration',
              ],
            };
          }
        },
      },
    ],
  });
}

// ── MCP Server ───────────────────────────────────────────────────────────────

async function startMcpServer() {
  logMcpInfo('startup', `code-auditor-mcp ${PACKAGE_VERSION} (stdio)`, {
    pid: process.pid,
    cwd: process.cwd(),
    dataDir: process.env.CODE_AUDITOR_DATA_DIR ?? '(default)',
    debug: process.env.CODE_AUDITOR_DEBUG ?? '0',
    logFile: process.env.CODE_AUDITOR_LOG_FILE ?? '(none)',
  });
  mcpDebugStderr(chalk.blue('[DEBUG]'), `Node ${process.version} · cwd ${process.cwd()}`);

  const registry = new ToolRegistry();
  registerAllTools(registry);

  const allTools = registry.getAllTools();
  const toolCount = allTools.length;

  const server = new Server(
    { name: 'code-auditor', version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.onerror = (error) => {
    console.error(chalk.red('[ERROR]'), 'Server error occurred:', error);
    console.error(chalk.red('[ERROR]'), 'Error stack:', error.stack);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const schemas = registry.getMCPToolSchemas();
    mcpTraceStderr(chalk.blue('[DEBUG]'), `ListTools → ${schemas.length} tools`);
    return { tools: schemas };
  });

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    mcpTraceStderr(chalk.blue('[DEBUG]'), 'initialize', JSON.stringify(request, null, 2));
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'code-auditor', version: PACKAGE_VERSION },
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    mcpTraceStderr(chalk.blue('[DEBUG]'), `CallTool ${name}`, JSON.stringify({
      argKeys: args && typeof args === 'object' ? Object.keys(args as object) : [],
      hasArgs: !!args,
    }));
    const requestSignal = extra?.signal;

    const toolStartedAt = Date.now();
    try {
      if (name !== 'notify') {
        logMcpDebug('tool', `call ${name}`, {
          argKeys: args && typeof args === 'object' ? Object.keys(args as object) : [],
          pathArg: (args as { path?: string })?.path,
          cwd: process.cwd(),
        });
      }

      throwIfRequestAborted(requestSignal, `start ${name}`);

      const tool = registry.getTool(name);
      if (!tool) {
        return {
          content: [
            {
              type: 'text' as const,
              text: serializeForMcp({
                success: false,
                error: `Unknown tool: "${name}". Available tools: ${allTools.map((t) => t.name).join(', ')}.`,
              }),
            },
          ],
          isError: true,
        };
      }

      const action = (args as Record<string, unknown>).action as string | undefined;
      const result = await registry.dispatch(name, action, args as Record<string, unknown>, requestSignal);

      // Check if registry returned a structured error
      if (result && typeof result === 'object' && 'success' in result && (result as any).success === false && 'validActions' in result) {
        return {
          content: [{ type: 'text' as const, text: serializeForMcp(result) }],
          isError: true,
        };
      }

      const response = {
        content: [{ type: 'text' as const, text: serializeForMcp(result) }],
      };
      mcpTraceStderr(chalk.blue('[DEBUG]'), `Tool ${name} ok`, `responseBytes=${response.content[0].text.length}`);
      throwIfRequestAborted(requestSignal, `before response ${name}`);
      return response;
    } catch (error) {
      if (error instanceof RequestAbortedError) {
        if (name !== 'audit_status') {
          logMcpDebug('tool', `call ${name} aborted`, { ms: Date.now() - toolStartedAt });
        }
        throw error;
      }
      console.error(chalk.red('[ERROR]'), `Tool ${name} execution failed:`, error);
      console.error(chalk.red('[ERROR]'), 'Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      if (name !== 'audit_status') {
        logMcpDebug('tool', `call ${name} failed`, {
          ms: Date.now() - toolStartedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        content: [{ type: 'text' as const, text: serializeForMcp(formatMcpToolErrorPayload(name, error)) }],
        isError: true,
      };
    } finally {
      if (name !== 'audit_status') {
        logMcpDebug('tool', `call ${name} finished`, { ms: Date.now() - toolStartedAt });
      }
    }
  });

  const transport = new StdioServerTransport();
  if (transport.onclose) {
    transport.onclose = () => console.error(chalk.yellow('[WARN]'), 'Transport closed');
  }
  if (transport.onerror) {
    transport.onerror = (error) => console.error(chalk.red('[ERROR]'), 'Transport error:', error);
  }

  await server.connect(transport);
  console.error(chalk.green('✓ Code Auditor MCP Server started'));
  console.error(chalk.gray(`Listening on stdio · ${toolCount} tools · ${PACKAGE_VERSION}`));
  mcpDebugStderr(chalk.blue('[DEBUG]'), 'Server ready', {
    name: 'code-auditor',
    transport: 'stdio',
    toolCount,
  });
}

// ── Process setup ────────────────────────────────────────────────────────────

registerProcessReliabilityHandlers();

process.on('SIGTERM', () => {
  console.error(chalk.yellow('[WARN]'), 'Received SIGTERM, shutting down gracefully...');
  process.exitCode = 0;
});

process.on('SIGINT', () => {
  console.error(chalk.yellow('[WARN]'), 'Received SIGINT, shutting down gracefully...');
  process.exitCode = 0;
});

process.stdin.on('error', (error) => {
  console.error(chalk.red('[ERROR]'), 'stdin error:', error);
});

process.stdout.on('error', (error) => {
  console.error(chalk.red('[ERROR]'), 'stdout error:', error);
});

// ── Mode dispatch ────────────────────────────────────────────────────────────

async function main() {
  await initParsers();

  if (autoIndexPath) {
    // --auto-index: sync the index and exit
    const { runAutoIndex } = await import('./mcpAutoIndex.js');
    await runAutoIndex(autoIndexPath);
    process.exit(0);
  }

  if (uiMode) {
    // --ui: start the HTTP UI server
    const { startMcpUIServer } = await import('./mcp-ui-simple.js');
    await startMcpUIServer();
    return;
  }

  // --stdio (default): start the MCP server
  await startMcpServer();
}

main().catch((error) => {
  console.error(chalk.red('[ERROR]'), 'Failed to start:', error);
  console.error(chalk.red('[ERROR]'), 'Stack:', error.stack);
  process.exitCode = 1;
});
