/**
 * JetBrains IDEs Configuration Generator — RETIRED
 *
 * Originally added Spec-16 R5.3 with path .idea/mcp.json.
 *
 * Retired 2026-07-20 (Task #17 — generator path audit):
 *   JetBrains MCP is configured through the IDE's Settings UI (MCP plugin),
 *   not a file-based path. No generator to write. This file is kept as a
 *   tombstone; the class is no longer registered in ConfigGeneratorFactory.
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class JetBrainsConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'JetBrains IDEs';
  }

  getFilename(): string {
    return '.idea/mcp.json';
  }

  generateConfig(): ConfigOutput {
    const config = {
      mcpServers: {
        'code-auditor': {
          command: 'npx',
          args: ['-y', 'code-auditor-mcp', '--mcp-mode'],
        },
      },
    };

    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: this.getInstructions(),
    };
  }

  getInstructions(): string {
    return `
JetBrains IDEs MCP Configuration Instructions:

1. Install the "MCP" plugin for JetBrains IDEs
2. Place this file at .idea/mcp.json in your project root
3. Restart your IDE
4. The code-auditor MCP tools will be available

Skill install (separate step):
  code-audit install --agent agents --scope project

Note: JetBrains IDEs support SKILL.md via the agents standard.
For blocking hooks, use Claude Code or Codex.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
