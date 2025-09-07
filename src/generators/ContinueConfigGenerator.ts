/**
 * Continue Configuration Generator
 * Generates configuration for Continue AI assistant
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';
import { resolve } from 'path';

export class ContinueConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Continue';
  }

  getFilename(): string {
    return '.continue/config.yaml';
  }

  generateConfig(): ConfigOutput {
    const config = {
      name: 'Continue Config with MCP Code Index',
      version: '0.0.1',
      models: [
        {
          name: 'Code Index Model',
          provider: 'openai',
          model: 'gpt-4',
          apiBase: `${this.serverUrl}/api/continue`,
          apiKey: this.getDefaultApiKey(),
          roles: ['chat', 'apply', 'edit'],
          capabilities: ['tool_use']
        }
      ],
      experimental: {
        modelContextProtocolServers: {
          codeIndex: {
            transport: {
              type: 'stdio',
              command: 'node',
              args: [resolve(process.cwd(), 'dist/mcp.js'), '--mcp-mode']
            }
          },
          codeIndexRemote: {
            transport: {
              type: 'http',
              url: `${this.serverUrl}/mcp`,
              headers: {
                Authorization: `Bearer ${this.getDefaultApiKey()}`
              }
            }
          }
        }
      },
      contextProviders: [
        {
          name: 'codebase',
          type: 'mcp',
          server: 'codeIndex'
        }
      ],
      slashCommands: [
        {
          name: 'search',
          description: 'Search codebase',
          handler: 'mcp:codeIndex:search_functions'
        },
        {
          name: 'definition',
          description: 'Find definition',
          handler: 'mcp:codeIndex:find_definition'
        },
        {
          name: 'index',
          description: 'Index files',
          handler: 'mcp:codeIndex:index_functions'
        }
      ]
    };

    return {
      filename: this.getFilename(),
      content: this.formatYaml(config),
      instructions: this.getInstructions()
    };
  }

  getInstructions(): string {
    return `
Continue Configuration Instructions:

1. Install Continue extension in VS Code or JetBrains
2. Place this file in ~/.continue/config.yaml
3. Restart your IDE
4. The MCP server will be automatically connected

Usage:
- Use @codebase to reference your indexed code
- Use /search to search functions
- Use /definition to find definitions
- Use /index to index new files

Continue has native MCP support, providing the best integration experience!
`;
  }
}