#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAuditRunner } from './auditRunner.js';
import type { Severity, AuditResult, AuditRunnerOptions, Violation } from './types.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import chalk from 'chalk';

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
];

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

// Start server
startMcpServer().catch(error => {
  console.error(chalk.red('Failed to start MCP server:'), error);
  process.exit(1);
});