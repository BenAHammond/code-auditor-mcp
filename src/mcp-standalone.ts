#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
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

async function runCliCommand(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'cli.js');
    const child = spawn('node', [cliPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
      } else {
        try {
          // Try to parse as JSON first
          const result = JSON.parse(stdout);
          resolve(result);
        } catch {
          // If not JSON, return as text
          resolve({ output: stdout, stderr });
        }
      }
    });
  });
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
          const auditPath = (args.path as string) || process.cwd();
          result = await runCliCommand(['--json', '--path', auditPath]);
          break;
        }

        case 'audit_check_health': {
          const auditPath = (args.path as string) || process.cwd();
          // Run a quick audit and calculate health score
          const auditResult = await runCliCommand(['--json', '--path', auditPath, '--quick']);
          
          // Simple health calculation
          const violations = auditResult.violations || [];
          const critical = violations.filter((v: any) => v.severity === 'critical').length;
          const warnings = violations.filter((v: any) => v.severity === 'warning').length;
          
          const healthScore = Math.max(0, 100 - (critical * 10) - (warnings * 2));
          
          result = {
            healthScore,
            status: healthScore >= 70 ? 'healthy' : 'needs-attention',
            metrics: {
              totalViolations: violations.length,
              criticalViolations: critical,
              warningViolations: warnings,
            },
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