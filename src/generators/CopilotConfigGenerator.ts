/**
 * GitHub Copilot Configuration Generator
 * Generates configuration for GitHub Copilot
 */

import { BaseConfigGenerator, ConfigOutput, AdditionalFile } from './BaseConfigGenerator.js';

export class CopilotConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'GitHub Copilot';
  }

  getFilename(): string {
    return '.vscode/settings.json';
  }

  generateConfig(): ConfigOutput {
    const config = {
      'github.copilot.advanced': {
        customModels: [
          {
            name: 'code-index',
            baseUrl: `${this.serverUrl}/api/copilot`,
            apiKey: this.getDefaultApiKey(),
            model: 'code-index-v1',
            provider: 'custom'
          }
        ]
      },
      'github.copilot.chat.customProviders': [
        {
          id: 'code-index-provider',
          name: 'Code Index',
          description: 'Local code index search',
          endpoint: `${this.serverUrl}/api/copilot/chat`,
          features: ['search', 'explain', 'fix']
        }
      ]
    };

    const proxyConfig = {
      start_command: `npx copilot-api@latest start --backend ${this.serverUrl}/api/copilot --port 8181`,
      api_endpoint: 'http://localhost:8181',
      models: ['code-index']
    };

    const additionalFiles: AdditionalFile[] = [
      {
        filename: 'copilot-proxy.json',
        content: this.formatJson(proxyConfig)
      }
    ];

    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      additionalFiles,
      instructions: this.getInstructions()
    };
  }

  getInstructions(): string {
    return `
GitHub Copilot Configuration Instructions:

Method 1 - VS Code with BYOK (Bring Your Own Key):
1. Open VS Code settings (Cmd/Ctrl + ,)
2. Search for "GitHub Copilot"
3. Click "Manage Models" 
4. Add custom provider with URL: ${this.serverUrl}/api/copilot
5. Use API key: ${this.getDefaultApiKey()}

Method 2 - Copilot API Proxy:
1. Run: npx copilot-api@latest start --backend ${this.serverUrl}/api/copilot
2. Configure your IDE to use http://localhost:8181
3. The proxy will handle API translation

Features:
- Custom completions from your code index
- Chat integration with @code-index
- Explain and fix suggestions based on your codebase
`;
  }
}