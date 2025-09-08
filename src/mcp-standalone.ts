#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAuditRunner } from './auditRunner.js';
import type { AuditRunnerOptions, AuditResult, Violation, Severity } from './types.js';
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
    ],
  },
  {
    name: 'audit_check_health',
    description: 'Quick health check of a codebase',
    parameters: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'The directory path to check',
        default: process.cwd(),
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
        case 'audit_run': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          const options: AuditRunnerOptions = {
            projectRoot: auditPath,
            enabledAnalyzers: ['solid', 'dry'],
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

        case 'audit_check_health': {
          const auditPath = path.resolve((args.path as string) || process.cwd());
          
          const runner = createAuditRunner({
            projectRoot: auditPath,
            enabledAnalyzers: ['solid', 'dry'],
            minSeverity: 'warning',
            verbose: false,
          });

          const auditResult = await runner.run();
          const healthScore = calculateHealthScore(auditResult);

          result = {
            healthScore,
            threshold: 70,
            passed: healthScore >= 70,
            status: healthScore >= 70 ? 'healthy' : 'needs-attention',
            metrics: {
              filesAnalyzed: auditResult.metadata.filesAnalyzed,
              totalViolations: auditResult.summary.totalViolations,
              criticalViolations: auditResult.summary.criticalIssues,
              warningViolations: auditResult.summary.warnings,
            },
            recommendation: healthScore >= 90 ? 'Excellent code health!' :
                          healthScore >= 70 ? 'Good code health with room for improvement' :
                          'Code health needs attention - run detailed audit',
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

  console.error(chalk.green('✓ Code Auditor MCP Server started (standalone mode)'));
  console.error(chalk.gray('Listening on stdio...'));
}

// Start server
startMcpServer().catch(error => {
  console.error(chalk.red('Failed to start MCP server:'), error);
  process.exit(1);
});