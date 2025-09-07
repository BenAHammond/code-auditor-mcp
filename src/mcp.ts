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
  getIndexStats,
  findDefinition,
  clearIndex,
  syncFileIndex
} from './codeIndexService.js';
import { scanFunctionsInFile, scanFunctionsInDirectory } from './functionScanner.js';
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
  {
    name: 'audit_run',
    description: 'Run a comprehensive code audit on the specified codebase',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'The directory path to audit (defaults to current directory)',
        default: process.cwd(),
      },
      {
        name: 'enabledAnalyzers',
        type: 'array',
        required: false,
        description: 'List of analyzers to run (solid, dry, security, component, data-access)',
        default: ['solid', 'dry', 'security'],
      },
      {
        name: 'minSeverity',
        type: 'string',
        required: false,
        description: 'Minimum severity level to report',
        default: 'warning',
        enum: ['info', 'warning', 'critical'],
      },
    ],
  },
  {
    name: 'audit_analyze_file',
    description: 'Analyze a specific file for code quality issues',
    parameters: [
      {
        name: 'filePath',
        type: 'string',
        required: true,
        description: 'The file path to analyze',
      },
      {
        name: 'analyzers',
        type: 'array',
        required: false,
        description: 'Specific analyzers to run on this file',
        default: ['solid', 'dry', 'security'],
      },
    ],
  },
  {
    name: 'audit_check_health',
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
    ],
  },
  {
    name: 'audit_list_analyzers',
    description: 'List all available code analyzers and their capabilities',
    parameters: [],
  },
  {
    name: 'register_functions',
    description: 'Register functions with metadata for code indexing',
    parameters: [
      {
        name: 'functions',
        type: 'array',
        required: true,
        description: 'Array of function objects with metadata',
      },
      {
        name: 'overwrite',
        type: 'boolean',
        required: false,
        description: 'Whether to overwrite existing entries',
        default: false,
      },
    ],
  },
  {
    name: 'search_functions',
    description: 'Search registered functions by various criteria',
    parameters: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query (supports full-text search)',
      },
      {
        name: 'filters',
        type: 'object',
        required: false,
        description: 'Optional filters (language, filePath, dependencies)',
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
    name: 'index_functions',
    description: 'Index functions from TypeScript/JavaScript files',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'File or directory path to index',
      },
      {
        name: 'recursive',
        type: 'boolean',
        required: false,
        description: 'Recursively index directories',
        default: true,
      },
      {
        name: 'fileTypes',
        type: 'array',
        required: false,
        description: 'File extensions to process',
        default: ['.ts', '.tsx', '.js', '.jsx'],
      },
    ],
  },
  {
    name: 'find_definition',
    description: 'Find the definition of a specific function',
    parameters: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'Function name to search for',
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
    name: 'get_index_stats',
    description: 'Get statistics about the code index',
    parameters: [],
  },
  {
    name: 'clear_index',
    description: 'Clear all indexed functions',
    parameters: [
      {
        name: 'confirm',
        type: 'boolean',
        required: false,
        description: 'Confirm clearing the index',
        default: false,
      },
    ],
  },
  {
    name: 'generate_ai_configs',
    description: 'Generate configuration files for AI coding assistants',
    parameters: [
      {
        name: 'tools',
        type: 'array',
        required: true,
        description: 'AI tools to generate configs for (cursor, continue, copilot, claude, etc.)',
      },
      {
        name: 'serverUrl',
        type: 'string',
        required: false,
        description: 'MCP server URL',
        default: DEFAULT_SERVER_URL,
      },
      {
        name: 'outputDir',
        type: 'string',
        required: false,
        description: 'Output directory for configuration files',
        default: '.',
      },
      {
        name: 'overwrite',
        type: 'boolean',
        required: false,
        description: 'Overwrite existing files',
        default: false,
      },
    ],
  },
  {
    name: 'list_ai_tools',
    description: 'List all supported AI tools for configuration generation',
    parameters: [],
  },
  {
    name: 'get_ai_tool_info',
    description: 'Get detailed information about a specific AI tool',
    parameters: [
      {
        name: 'tool',
        type: 'string',
        required: true,
        description: 'AI tool name (cursor, continue, copilot, etc.)',
      },
    ],
  },
  {
    name: 'validate_ai_config',
    description: 'Validate a generated AI tool configuration',
    parameters: [
      {
        name: 'tool',
        type: 'string',
        required: true,
        description: 'AI tool name',
      },
      {
        name: 'config',
        type: 'object',
        required: true,
        description: 'Configuration object to validate',
      },
    ],
  },
  {
    name: 'bulk_cleanup',
    description: 'Remove index entries for deleted files',
    parameters: [],
  },
  {
    name: 'deep_sync',
    description: 'Deep synchronize all indexed files to update signatures and remove stale entries',
    parameters: [],
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
        case 'audit_run': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          const options: AuditRunnerOptions = {
            projectRoot: auditPath,
            enabledAnalyzers: (args.enabledAnalyzers as string[]) || ['solid', 'dry', 'security'],
            minSeverity: ((args.minSeverity as string) || 'warning') as Severity,
            verbose: false,
          };

          const runner = createAuditRunner(options);
          const auditResult = await runner.run();

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
          };
          break;
        }

        case 'audit_analyze_file': {
          const absolutePath = path.resolve(args.filePath as string);
          await fs.access(absolutePath); // Check file exists

          const options: AuditRunnerOptions = {
            projectRoot: path.dirname(absolutePath),
            enabledAnalyzers: (args.analyzers as string[]) || ['solid', 'dry', 'security'],
            includePaths: [absolutePath],
            verbose: false,
          };

          const runner = createAuditRunner(options);
          const auditResult = await runner.run();
          
          const fileViolations = getAllViolations(auditResult).filter(v => v.file === absolutePath);
          result = {
            file: absolutePath,
            violations: fileViolations,
            summary: {
              total: fileViolations.length,
              bySeverity: fileViolations
                .reduce((acc, v) => {
                  acc[v.severity] = (acc[v.severity] || 0) + 1;
                  return acc;
                }, {} as Record<string, number>),
            },
          };
          break;
        }

        case 'audit_check_health': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          const threshold = (args.threshold as number) || 70;

          const runner = createAuditRunner({
            projectRoot: auditPath,
            enabledAnalyzers: ['solid', 'dry', 'security'],
            minSeverity: 'warning',
            verbose: false,
          });

          const auditResult = await runner.run();
          const healthScore = calculateHealthScore(auditResult);

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
          };
          break;
        }

        case 'audit_list_analyzers': {
          result = {
            analyzers: [
              {
                id: 'solid',
                name: 'SOLID Analyzer',
                description: 'Checks adherence to SOLID principles',
                checks: [
                  'Single Responsibility violations',
                  'Open/Closed violations',
                  'Liskov Substitution issues',
                  'Interface Segregation problems',
                  'Dependency Inversion violations',
                ],
              },
              {
                id: 'dry',
                name: 'DRY Analyzer',
                description: 'Identifies code duplication',
                checks: [
                  'Exact code duplicates',
                  'Similar code patterns',
                  'Duplicate imports',
                  'Repeated string literals',
                ],
              },
              {
                id: 'security',
                name: 'Security Analyzer',
                description: 'Verifies security patterns',
                checks: [
                  'Missing authentication',
                  'Authorization issues',
                  'SQL injection risks',
                  'Unvalidated inputs',
                ],
              },
              {
                id: 'component',
                name: 'Component Analyzer',
                description: 'Analyzes UI components',
                checks: [
                  'Missing error boundaries',
                  'Complex render methods',
                  'Deep nesting',
                  'Performance issues',
                ],
              },
              {
                id: 'data-access',
                name: 'Data Access Analyzer',
                description: 'Reviews database patterns',
                checks: [
                  'N+1 queries',
                  'Missing transactions',
                  'Direct DB access in UI',
                  'Performance issues',
                ],
              },
            ],
          };
          break;
        }

        case 'register_functions': {
          const functions = args.functions as any[];
          const overwrite = (args.overwrite as boolean) || false;
          
          if (!Array.isArray(functions)) {
            throw new Error('functions must be an array');
          }
          
          result = await registerFunctions(functions, { overwrite });
          break;
        }
        
        case 'search_functions': {
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
        
        case 'index_functions': {
          const targetPath = path.resolve(args.path as string);
          const recursive = (args.recursive as boolean) !== false;
          const fileTypes = (args.fileTypes as string[]) || ['.ts', '.tsx', '.js', '.jsx'];
          
          const stats = await fs.stat(targetPath);
          
          if (stats.isFile()) {
            // For single files, use sync to handle additions/updates/removals
            const functions = await scanFunctionsInFile(targetPath);
            const syncResult = await syncFileIndex(targetPath, functions);
            result = {
              success: true,
              registered: syncResult.added + syncResult.updated,
              failed: 0,
              path: targetPath,
              totalScanned: functions.length,
              syncStats: syncResult
            };
          } else {
            // For directories, use regular registration (could be improved later)
            const functions = await scanFunctionsInDirectory(targetPath, { recursive, fileTypes });
            const registerResult = await registerFunctions(functions);
            result = {
              ...registerResult,
              path: targetPath,
              totalScanned: functions.length,
            };
          }
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
        
        case 'get_index_stats': {
          result = await getIndexStats();
          break;
        }
        
        case 'clear_index': {
          const confirm = args.confirm as boolean;
          
          if (!confirm) {
            throw new Error('Please set confirm: true to clear the index');
          }
          
          await clearIndex();
          result = { message: 'Index cleared successfully' };
          break;
        }

        case 'generate_ai_configs': {
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
        
        case 'list_ai_tools': {
          const factory = new ConfigGeneratorFactory();
          const toolInfo = factory.getToolInfo();
          
          result = {
            tools: toolInfo,
            totalCount: toolInfo.length,
            categories: {
              native_mcp: toolInfo.filter(t => !t.requiresAuth).map(t => t.name),
              api_based: toolInfo.filter(t => t.requiresAuth).map(t => t.name)
            }
          };
          break;
        }
        
        case 'get_ai_tool_info': {
          const toolName = args.tool as string;
          
          if (!toolName) {
            throw new Error('tool parameter is required');
          }
          
          const factory = new ConfigGeneratorFactory();
          const generator = factory.createGenerator(toolName);
          
          if (!generator) {
            throw new Error(`Unknown tool: ${toolName}`);
          }
          
          const config = generator.generateConfig();
          
          result = {
            name: toolName,
            displayName: generator.getToolName(),
            requiresAuth: generator.requiresAuth(),
            defaultApiKey: generator.getDefaultApiKey(),
            configFilename: generator.getFilename(),
            instructions: generator.getInstructions(),
            sampleConfig: JSON.parse(config.content)
          };
          break;
        }
        
        case 'validate_ai_config': {
          const toolName = args.tool as string;
          const config = args.config as any;
          
          if (!toolName) {
            throw new Error('tool parameter is required');
          }
          
          if (!config) {
            throw new Error('config parameter is required');
          }
          
          const factory = new ConfigGeneratorFactory();
          const generator = factory.createGenerator(toolName);
          
          if (!generator) {
            throw new Error(`Unknown tool: ${toolName}`);
          }
          
          // Generate reference config to compare structure
          const referenceConfig = generator.generateConfig();
          const reference = JSON.parse(referenceConfig.content);
          
          // Basic validation - check if main structure matches
          const errors: string[] = [];
          const validateObject = (ref: any, actual: any, path = '') => {
            for (const key in ref) {
              const currentPath = path ? `${path}.${key}` : key;
              if (!(key in actual)) {
                errors.push(`Missing required field: ${currentPath}`);
              } else if (typeof ref[key] === 'object' && ref[key] !== null && !Array.isArray(ref[key])) {
                if (typeof actual[key] === 'object' && actual[key] !== null) {
                  validateObject(ref[key], actual[key], currentPath);
                } else {
                  errors.push(`Field ${currentPath} should be an object`);
                }
              }
            }
          };
          
          validateObject(reference, config);
          
          result = {
            valid: errors.length === 0,
            tool: toolName,
            errors: errors.length > 0 ? errors : undefined,
            warnings: [] // Could add warnings for extra fields, deprecated settings, etc.
          };
          break;
        }
        
        case 'bulk_cleanup': {
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          
          const cleanupResult = await db.bulkCleanup();
          
          result = {
            success: true,
            scannedFiles: cleanupResult.scannedCount,
            removedEntries: cleanupResult.removedCount,
            removedFiles: cleanupResult.removedFiles,
            errors: cleanupResult.errors,
            message: `Cleaned up ${cleanupResult.removedCount} entries from ${cleanupResult.removedFiles.length} deleted files`
          };
          break;
        }
        
        case 'deep_sync': {
          const db = CodeIndexDB.getInstance();
          await db.initialize();
          
          // Progress tracking
          const progressUpdates: any[] = [];
          const syncResult = await db.deepSync((progress) => {
            progressUpdates.push({
              current: progress.current,
              total: progress.total,
              file: progress.file,
              percentage: Math.round((progress.current / progress.total) * 100)
            });
          });
          
          result = {
            success: true,
            syncedFiles: syncResult.syncedFiles,
            addedFunctions: syncResult.addedFunctions,
            updatedFunctions: syncResult.updatedFunctions,
            removedFunctions: syncResult.removedFunctions,
            errors: syncResult.errors,
            message: `Synced ${syncResult.syncedFiles} files: ${syncResult.addedFunctions} added, ${syncResult.updatedFunctions} updated, ${syncResult.removedFunctions} removed`
          };
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