#!/usr/bin/env node

// MCP servers use stdio: stdout for protocol messages, stderr for logging
// All log messages must go to stderr to avoid interfering with MCP protocol

import chalk from 'chalk';
console.error(chalk.blue('[INFO]'), 'Loading modules...');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
console.error(chalk.blue('[INFO]'), 'MCP SDK loaded');

import { createAuditRunner } from './auditRunner.js';
import type { Severity, AuditResult, AuditRunnerOptions, Violation } from './types.js';
console.error(chalk.blue('[INFO]'), 'Audit runner loaded');

import { 
  registerFunctions, 
  searchFunctions, 
  findDefinition,
  syncFileIndex
} from './codeIndexService.js';
import { ConfigGeneratorFactory } from './generators/ConfigGeneratorFactory.js';
import { DEFAULT_SERVER_URL } from './constants.js';
console.error(chalk.blue('[INFO]'), 'Code index service loaded');

import path from 'node:path';
import fs from 'node:fs/promises';
import { CodeIndexDB } from './codeIndexDB.js';
console.error(chalk.blue('[INFO]'), 'All modules loaded successfully');

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
        description: 'List of analyzers to run (solid, dry, security, react, data-access)',
        default: ['solid', 'dry'],
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
];

async function startMcpServer() {
  console.error(chalk.blue('[INFO]'), 'Starting Code Auditor MCP Server...');
  
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
  
  console.error(chalk.blue('[INFO]'), 'Server instance created');

  // Handle tool listing
  console.error(chalk.blue('[INFO]'), 'Setting up request handlers...');
  
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(chalk.blue('[DEBUG]'), 'Handling ListTools request');
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
  
  console.error(chalk.blue('[INFO]'), `Registered ${tools.length} tools`);

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(chalk.blue('[DEBUG]'), `Handling CallTool request for: ${name}`);

    try {
      let result: any;

      switch (name) {
        case 'audit': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          const indexFunctions = (args.indexFunctions as boolean) !== false; // Default true
          
          // Check if path is a file or directory
          const stats = await fs.stat(auditPath).catch(() => null);
          const isFile = stats?.isFile() || false;
          
          const options: AuditRunnerOptions = {
            projectRoot: isFile ? path.dirname(auditPath) : auditPath,
            enabledAnalyzers: (args.analyzers as string[]) || ['solid', 'dry', 'security'],
            minSeverity: ((args.minSeverity as string) || 'warning') as Severity,
            verbose: false,
            indexFunctions,
            ...(isFile && { includePaths: [auditPath] }),
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


        case 'audit_health': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          const threshold = (args.threshold as number) || 70;
          const indexFunctions = (args.indexFunctions as boolean) !== false; // Default true

          const runner = createAuditRunner({
            projectRoot: auditPath,
            enabledAnalyzers: ['solid', 'dry', 'security'],
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
              console.error(chalk.yellow('[WARN]'), 'Failed to sync functions:', error);
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
              availableScenarios: ['initial-setup', 'react-development', 'code-review', 'find-patterns', 'maintenance']
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
                message: 'Index cleared successfully'
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

  console.error(chalk.blue('[INFO]'), 'Request handlers configured');
  
  const transport = new StdioServerTransport();
  console.error(chalk.blue('[INFO]'), 'Creating stdio transport...');
  
  await server.connect(transport);

  console.error(chalk.green('✓ Code Auditor MCP Server started'));
  console.error(chalk.gray('Listening on stdio...'));
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
  let score = 100;
  const critical = result.summary.criticalIssues;
  const warning = result.summary.warnings;
  
  score -= critical * 10;
  score -= warning * 2;
  
  return Math.max(0, Math.min(100, score));
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
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('[ERROR]'), 'Unhandled rejection at:', promise);
  console.error(chalk.red('[ERROR]'), 'Reason:', reason);
  process.exit(1);
});

// Start server
console.error(chalk.blue('[INFO]'), 'Initializing server...');
startMcpServer().catch(error => {
  console.error(chalk.red('[ERROR]'), 'Failed to start MCP server:', error);
  console.error(chalk.red('[ERROR]'), 'Stack:', error.stack);
  process.exit(1);
});