import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';
import { resolve } from 'path';

export class VSCodeConfigGenerator extends BaseConfigGenerator {
  getToolName(): string { return 'VS Code MCP'; }
  getFilename(): string { return '.vscode/mcp.json'; }
  
  generateConfig(): ConfigOutput {
    const config = {
      'mcp.servers': [{
        name: 'code-index',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: [resolve(process.cwd(), 'dist/mcp.js'), '--mcp-mode'],
        env: { NODE_ENV: 'production' }
      }],
      'mcp.autoStart': true,
      'mcp.showInStatusBar': true
    };
    
    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: 'Install MCP extension for VS Code, place in .vscode/mcp.json'
    };
  }
  
  getInstructions(): string {
    return 'VS Code MCP configuration instructions...';
  }
}