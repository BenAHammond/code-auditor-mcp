/**
 * Claude Code Configuration Generator
 * Generates MCP configuration for Claude Code.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Updated for Claude Code (not Claude Desktop). Uses standard stdio MCP
 *   transport with npx. Claude Code supports MCP via .mcp.json in the project
 *   root or ~/.claude/.mcp.json globally.
 *   Skills: .claude/skills/ (installed via code-audit install --agent claude).
 *   Hooks: blocking (PostToolUse, exit 2 replaces tool result with feedback).
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

/**
 * MCP config generator for Claude Code.
 */
export class ClaudeConfigGenerator extends BaseConfigGenerator {
  /**
   * Return the display name of the tool.
   * @returns The tool display name.
   */
  getToolName(): string {
    return 'Claude Code';
  }

  /**
   * Return the default config file path for the tool.
   * @returns The default config file path.
   */
  getFilename(): string {
    return '.mcp.json';
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
Claude Code MCP Configuration Instructions:

1. Place this file at .mcp.json in your project root
   (or merge into ~/.claude/.mcp.json for global access)
2. Restart Claude Code or run /mcp to reload
3. The code-auditor MCP tools will be available in Claude Code sessions

Skill install (separate step):
  code-audit install --agent claude --scope project

Hook wiring (separate step):
  code-audit install --agent claude --hooks

Note: Claude Code has full blocking hooks via PostToolUse (exit 2 replaces
tool result with violation feedback). This is the most complete integration.
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
