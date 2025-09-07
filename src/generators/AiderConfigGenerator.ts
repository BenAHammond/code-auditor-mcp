import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class AiderConfigGenerator extends BaseConfigGenerator {
  getToolName(): string { return 'Aider'; }
  getFilename(): string { return '.aider.conf.yml'; }
  
  generateConfig(): ConfigOutput {
    const config = {
      model: 'gpt-4',
      'edit-format': 'diff',
      'auto-commits': false,
      'api-base': `${this.serverUrl}/api/aider`,
      'api-key': this.getDefaultApiKey()
    };
    
    return {
      filename: this.getFilename(),
      content: this.formatYaml(config),
      instructions: 'Place in project root as .aider.conf.yml'
    };
  }
  
  getInstructions(): string {
    return 'Aider configuration instructions...';
  }
}