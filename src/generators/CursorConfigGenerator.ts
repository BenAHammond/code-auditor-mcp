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

/**
 * MCP config generator for Cursor.
 */
export class CursorConfigGenerator extends BaseConfigGenerator {
  /**
   * Return the display name of the tool.
   * @returns The tool display name.
   */
  getToolName(): string {
    return 'Cursor';
  }

  /**
   * Return the default config file path for the tool.
   * @returns The default config file path.
   */
  getFilename(): string {
    return '.cursor/mcp.json';
  }

  /**
   * Generate the tool's MCP configuration.
   * @returns The generated config output.
   */
  generateConfig(): ConfigOutput {
    const config = {
      mcpServers: {
        'code-auditor': {
          command: 'npx',
          args: ['-y', 'code-auditor-mcp', '--stdio'],
        },
      },
    };

    return {
      filename: this.getFilename(),
      content: this.formatJson(config),
      instructions: this.getInstructions(),
    };
  }

  /**
   * Return setup instructions for the tool.
   * @returns The setup instructions.
   */
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

  /**
   * Return whether the tool requires authentication.
   * @returns True when the tool requires authentication.
   */
  requiresAuth(): boolean {
    return false;
  }
}
