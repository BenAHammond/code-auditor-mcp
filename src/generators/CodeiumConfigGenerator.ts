/**
 * Codeium / Windsurf Configuration Generator
 * Generates MCP configuration for Codeium/Windsurf.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Windsurf now supports native MCP. Replaced fictional /api/codeium/*
 *   endpoints with standard stdio MCP transport.
 *   Skills: agents-standard, installed via code-audit install --agent agents.
 *
 * Fixed 2026-07-20 (Task #17 — generator path audit):
 *   Windsurf (now part of Devin) MCP config is at
 *   ~/.codeium/windsurf/mcp_config.json (NOT .windsurf/mcp.json).
 *   Verified against: docs.devin.ai/desktop/cascade/mcp (2026-07-20).
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class CodeiumConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Codeium/Windsurf';
  }

  getFilename(): string {
    return '~/.codeium/windsurf/mcp_config.json';
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
Codeium/Windsurf MCP Configuration Instructions:

1. Place this file at ~/.codeium/windsurf/mcp_config.json
   (create the directory if it doesn't exist: mkdir -p ~/.codeium/windsurf)
2. Restart Windsurf
3. The code-auditor MCP tools will be available

Reference: https://docs.devin.ai/desktop/cascade/mcp

Skill install (separate step):
  code-audit install --agent agents --scope project

Note: Codeium/Windsurf supports SKILL.md via the agents standard.
For blocking hooks, use Claude Code or Codex.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
