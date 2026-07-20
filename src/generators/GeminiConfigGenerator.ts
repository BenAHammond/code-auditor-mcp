/**
 * Gemini CLI Configuration Generator
 * Generates MCP configuration for Google Gemini CLI.
 *
 * Added 2026-07-19 (Spec-16 R5.3):
 *   New generator for Gemini CLI. Gemini supports MCP via .gemini/mcp.json.
 *   Skills: agents-standard (.gemini/skills/), installed via code-audit install.
 *   Hooks: none (Gemini CLI has no edit hooks as of 2026-07-19).
 *
 * Fixed 2026-07-20 (Task #17 — generator path audit):
 *   Gemini MCP config is at .gemini/settings.json (NOT .gemini/mcp.json).
 *   Format uses "mcpServers" key. Also configurable via "gemini mcp add" CLI.
 *   Verified against: github.com/google-gemini/gemini-cli (2026-07-20).
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class GeminiConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Gemini CLI';
  }

  getFilename(): string {
    return '.gemini/settings.json';
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
Gemini CLI MCP Configuration Instructions:

1. Place this file at .gemini/settings.json in your project root
   (or merge the "mcpServers" key into your existing settings.json)
2. Alternatively, use the CLI: gemini mcp add code-auditor -- npx -y code-auditor-mcp --mcp-mode
3. Restart your Gemini CLI session
4. The code-auditor MCP tools will be available

Skill install (separate step):
  code-audit install --agent gemini --scope project

Note: Gemini CLI has no edit hooks as of 2026-07-20. Use MCP tools
interactively for auditing. For blocking hooks, use Claude Code or Codex.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
