#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
import { DEFAULT_SERVER_URL } from './constants.js';
import { scanFunctionsInDirectory } from './functionScanner.js';
import path from 'node:path';
import chalk from 'chalk';

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
        description: 'Optional filters (language, filePath, dependencies, componentType, entityType)',
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
  let score = 100;
  const critical = result.summary.criticalIssues;
  const warning = result.summary.warnings;
  
  score -= critical * 10;
  score -= warning * 2;
  
  return Math.max(0, Math.min(100, score));
}

async function startMcpServer() {
  const server = new Server(
    {
      name: 'code-auditor',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
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
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: any;

      switch (name) {
        case 'audit': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          const indexFunctions = (args.indexFunctions as boolean) !== false; // Default true
          const analyzers = (args.analyzers as string[]) || ['solid', 'dry'];
          const minSeverity = (args.minSeverity as string) as Severity;
          
          const options: AuditRunnerOptions = {
            projectRoot: auditPath,
            enabledAnalyzers: analyzers,
            minSeverity,
            verbose: false,
            indexFunctions,
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

          // Format for MCP
          result = {
            summary: {
              totalViolations: auditResult.summary.totalViolations,
              criticalIssues: auditResult.summary.criticalIssues,
              warnings: auditResult.summary.warnings,
              suggestions: auditResult.summary.suggestions,
              filesAnalyzed: auditResult.metadata.filesAnalyzed,
              executionTime: auditResult.metadata.auditDuration,
              healthScore: calculateHealthScore(auditResult),
            },
            violations: getAllViolations(auditResult).slice(0, 100), // Limit to first 100
            recommendations: auditResult.recommendations,
            ...(indexingResult && { functionIndexing: indexingResult }),
          };
          break;
        }

        case 'audit_check_health': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          const indexFunctions = (args.indexFunctions as boolean) !== false; // Default true
          
          const runner = createAuditRunner({
            projectRoot: auditPath,
            enabledAnalyzers: ['solid', 'dry'],
            minSeverity: 'warning',
            verbose: false,
            indexFunctions, // Pass the flag to the runner
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
          
          result = await searchFunctions({ query, filters, limit, offset });
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
              if (targetPath) {
                const functions = await scanFunctionsInDirectory(targetPath);
                const syncResult = await syncFileIndex(targetPath, functions);
                result = {
                  success: true,
                  mode: 'sync',
                  path: targetPath,
                  ...syncResult
                };
              } else {
                const syncResult = await db.deepSync();
                result = {
                  success: true,
                  mode: 'sync',
                  filesProcessed: syncResult.syncedFiles,
                  functionsAdded: syncResult.addedFunctions,
                  functionsUpdated: syncResult.updatedFunctions,
                  functionsRemoved: syncResult.removedFunctions
                };
              }
              break;
            }
            
            case 'reset': {
              await clearIndex();
              result = {
                success: true,
                mode: 'reset',
                message: 'Index cleared successfully'
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
              availableScenarios: ['initial-setup', 'react-development', 'code-review', 'find-patterns', 'maintenance']
            };
          }
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: error instanceof Error ? error.message : 'Unknown error',
              tool: name,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(chalk.green('✓ Code Auditor MCP Server started (standalone mode)'));
  console.error(chalk.gray('Listening on stdio...'));
}

// Start server
startMcpServer().catch(error => {
  console.error(chalk.red('Failed to start MCP server:'), error);
  process.exit(1);
});