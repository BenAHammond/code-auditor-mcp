/**
 * Cline Configuration Generator
 * Generates MCP configuration for Cline AI assistant.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Standardized to npx-based stdio MCP transport. Cline supports MCP natively.
 *   Skills: agents-standard, installed via code-audit install --agent agents.
 *
 * Fixed 2026-07-20 (Task #17 — generator path audit):
 *   Cline MCP config path is .cline/mcp.json (NOT .cline/mcp-config.json).
 *   For CLI: ~/.cline/mcp.json. For VS Code extension: configured via UI.
 *   Verified against: docs.cline.bot/mcp/mcp-overview (2026-07-20).
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class ClineConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Cline';
  }

  getFilename(): string {
    return '.cline/mcp.json';
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
Cline MCP Configuration Instructions:

1. Place this file at .cline/mcp.json in your project root
   (User-level: ~/.cline/mcp.json. VS Code extension: use MCP Servers UI)
2. Restart Cline
3. The code-auditor MCP tools will be available

Reference: https://docs.cline.bot/mcp/mcp-overview

Skill install (separate step):
  code-audit install --agent agents --scope project

Note: Cline supports SKILL.md via the agents standard.
For blocking hooks, use Claude Code or Codex.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
