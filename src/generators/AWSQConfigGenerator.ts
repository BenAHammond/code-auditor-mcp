import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class AWSQConfigGenerator extends BaseConfigGenerator {
  getToolName(): string { return 'AWS Q Developer'; }
  getFilename(): string { return 'awsq-customization.json'; }
  
  generateConfig(): ConfigOutput {
    const config = {
      customizations: {
        name: 'CodeIndexCustomization',
        description: 'Local code index for AWS Q',
        repositories: [{
          type: 'external',
          endpoint: `${this.serverUrl}/api/awsq`,
          authentication: { type: 'bearer', token: this.getDefaultApiKey() }
        }],
        capabilities: {
          codeCompletion: true,
          codeExplanation: true,
          codeTransformation: false,
          search: true
        }
      }
    };
    
    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: 'Install AWS Toolkit, open AWS Q settings, import this configuration file.'
    };
  }
  
  getInstructions(): string {
    return 'AWS Q configuration instructions...';
  }
}