import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';
import { resolve } from 'path';

export class JetBrainsConfigGenerator extends BaseConfigGenerator {
  getToolName(): string { return 'JetBrains IDEs'; }
  getFilename(): string { return '.idea/mcp-config.json'; }
  
  generateConfig(): ConfigOutput {
    const config = {
      mcp: {
        servers: [{
          name: 'Code Index',
          command: 'node',
          arguments: [resolve(process.cwd(), 'dist/mcp.js'), '--mcp-mode'],
          workingDirectory: process.cwd(),
          environment: { MCP_SERVER_URL: this.serverUrl }
        }]
      },
      ai: {
        customProviders: [{
          id: 'code-index',
          name: 'Code Index',
          endpoint: `${this.serverUrl}/api/jetbrains`,
          apiKey: this.getDefaultApiKey()
        }]
      }
    };
    
    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: 'Open Settings > Tools > AI Assistant > MCP, import configuration'
    };
  }
  
  getInstructions(): string {
    return 'JetBrains configuration instructions...';
  }
}