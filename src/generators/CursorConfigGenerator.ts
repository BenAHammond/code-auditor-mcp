/**
 * Cursor Configuration Generator
 * Generates MCP configuration for Cursor AI editor.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Cursor now supports native MCP. Replaced fictional /api/cursor/* endpoints
 *   with standard stdio + HTTP MCP transports.
 *   Skills: project-only (.cursor/skills/), installed via code-audit install.
 *   Hooks: advisory (afterFileEdit is fire-and-forget).
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';
import { resolve } from 'path';

export class CursorConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Cursor';
  }

  getFilename(): string {
    return '.cursor/mcp.json';
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
Cursor MCP Configuration Instructions:

1. Place this file at .cursor/mcp.json in your project root
2. Restart Cursor
3. The code-auditor MCP tools will be available

Skill install (separate step):
  code-audit install --agent cursor --scope project

Note: Cursor skills are project-only. The afterFileEdit hook is advisory
(fire-and-forget, cannot block edits retroactively). Use Cursor's MCP
integration for interactive auditing.

For blocking hooks, use Claude Code or Codex.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
