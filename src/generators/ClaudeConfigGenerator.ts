/**
 * Claude Desktop Configuration Generator
 * Generates configuration for Claude Desktop app
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';
import { resolve } from 'path';
import { platform } from 'os';

export class ClaudeConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Claude Desktop';
  }

  getFilename(): string {
    return 'claude_desktop_config.json';
  }

  generateConfig(): ConfigOutput {
    const config = {
      mcpServers: {
        'code-index': {
          command: 'node',
          args: [
            resolve(process.cwd(), 'dist/mcp.js'),
            '--mcp-mode'
          ],
          env: {
            MCP_SERVER_URL: this.serverUrl
          }
        }
      }
    };

    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: this.getInstructions()
    };
  }

  getInstructions(): string {
    const configPath = this.getConfigPath();
    
    return `
Claude Desktop Configuration Instructions:

1. Place this file at: ${configPath}
2. Restart Claude Desktop
3. Look for the "hammer" icon (🔨) to access MCP tools
4. Your code index tools will be available

Available MCP Tools:
- search_functions: Search your codebase
- find_definition: Find function definitions
- index_functions: Index new files
- get_index_stats: View indexing statistics
- register_functions: Manually register functions

Note: Claude Desktop has excellent MCP support built-in!
`;
  }

  private getConfigPath(): string {
    switch (platform()) {
      case 'darwin':
        return '~/Library/Application Support/Claude/claude_desktop_config.json';
      case 'win32':
        return '%APPDATA%\\Claude\\claude_desktop_config.json';
      default:
        return '~/.config/Claude/claude_desktop_config.json';
    }
  }

  requiresAuth(): boolean {
    return false; // Claude Desktop uses local MCP connection
  }
}