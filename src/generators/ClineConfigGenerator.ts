import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';
import { resolve } from 'path';

export class ClineConfigGenerator extends BaseConfigGenerator {
  getToolName(): string { return 'Cline'; }
  getFilename(): string { return '.cline/mcp-config.json'; }
  
  generateConfig(): ConfigOutput {
    const config = {
      mcpServers: {
        'code-index': {
          command: 'node',
          args: [resolve(process.cwd(), 'dist/mcp.js'), '--mcp-mode']
        }
      }
    };
    
    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: 'Place in .cline/mcp-config.json and restart Cline'
    };
  }
  
  getInstructions(): string {
    return 'Cline configuration instructions...';
  }
  
  requiresAuth(): boolean { return false; }
}