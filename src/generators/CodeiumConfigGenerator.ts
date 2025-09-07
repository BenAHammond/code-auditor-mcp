import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class CodeiumConfigGenerator extends BaseConfigGenerator {
  getToolName(): string { return 'Codeium/Windsurf'; }
  getFilename(): string { return 'codeium-config.json'; }
  
  generateConfig(): ConfigOutput {
    const config = {
      enterprise: false,
      portal_url: this.serverUrl,
      api_url: `${this.serverUrl}/api/codeium`,
      api_key: this.getDefaultApiKey(),
      indexing: {
        enabled: true,
        endpoint: `${this.serverUrl}/api/codeium/index`
      },
      search: {
        enabled: true,
        endpoint: `${this.serverUrl}/api/codeium/search`
      }
    };
    
    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: 'Install Codeium extension, enable Enterprise mode, set Portal URL.'
    };
  }
  
  getInstructions(): string {
    return 'Codeium configuration instructions...';
  }
}