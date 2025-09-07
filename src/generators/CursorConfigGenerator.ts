/**
 * Cursor Configuration Generator
 * Generates configuration for Cursor AI editor
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class CursorConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Cursor';
  }

  getFilename(): string {
    return 'cursor-config.json';
  }

  generateConfig(): ConfigOutput {
    const config = {
      models: [
        {
          title: 'Code Index Search',
          provider: 'openai',
          model: 'code-index-search',
          apiBase: `${this.serverUrl}/api/cursor`,
          apiKey: this.getDefaultApiKey(),
          contextWindow: 128000,
          capabilities: {
            codeCompletion: true,
            chat: true,
            search: true
          }
        }
      ],
      features: {
        codebaseIndexing: {
          enabled: true,
          endpoint: `${this.serverUrl}/api/cursor/index`
        },
        semanticSearch: {
          enabled: true,
          endpoint: `${this.serverUrl}/api/cursor/search`
        }
      },
      customCommands: [
        {
          name: 'search-symbol',
          description: 'Search for a symbol in the codebase',
          endpoint: `${this.serverUrl}/api/cursor/symbol`
        },
        {
          name: 'find-definition',
          description: 'Find symbol definition',
          endpoint: `${this.serverUrl}/api/cursor/definition`
        }
      ]
    };

    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: this.getInstructions()
    };
  }

  getInstructions(): string {
    return `
Cursor Configuration Instructions:

1. Open Cursor Settings (Cmd/Ctrl + ,)
2. Navigate to Models > Manage Models
3. Add a new model with "Override OpenAI Base URL"
4. Set base URL to: ${this.serverUrl}/api/cursor
5. Use API key: ${this.getDefaultApiKey()}

Alternative method:
- Place this file in ~/.cursor/config.json
- Restart Cursor

The Code Index Search model will now be available in:
- Chat interface (@codebase)
- Command palette (search-symbol, find-definition)
- Inline completions
`;
  }
}