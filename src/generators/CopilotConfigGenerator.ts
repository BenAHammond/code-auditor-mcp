/**
 * GitHub Copilot / VS Code Configuration Generator
 * Generates MCP configuration for GitHub Copilot in VS Code.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Copilot now supports native MCP via VS Code. Replaced fictional
 *   /api/copilot/* endpoints with standard stdio MCP transport.
 *   Skills: agents-standard (.agents/skills/), installed via code-audit install.
 *   Hooks: none.
 *
 * ✅ VERIFIED (2026-07-20):
 *   .vscode/mcp.json confirmed against code.visualstudio.com/docs/agents/reference/mcp-configuration.
 *   Both workspace (.vscode/mcp.json) and user profile mcp.json are supported.
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

/**
 * MCP config generator for GitHub Copilot in VS Code.
 */
export class CopilotConfigGenerator extends BaseConfigGenerator {
  /**
   * Return the display name of the tool.
   * @returns The tool display name.
   */
  getToolName(): string {
    return 'GitHub Copilot / VS Code';
  }

  /**
   * Return the default config file path for the tool.
   * @returns The default config file path.
   */
  getFilename(): string {
    return '.vscode/mcp.json';
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
GitHub Copilot / VS Code MCP Configuration Instructions:

1. Place this file at .vscode/mcp.json in your project root (or merge into existing)
2. Install the "MCP" extension for VS Code if not already installed
3. Reload VS Code window

Skill install (separate step):
  code-audit install --agent agents --scope project

Note: Copilot/VS Code has no edit hooks. Use MCP tools interactively for
auditing. For blocking hooks, use Claude Code or Codex.
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
