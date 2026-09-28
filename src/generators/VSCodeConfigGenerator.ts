/**
 * VS Code MCP Configuration Generator
 * Generates MCP configuration for VS Code (standalone, without Copilot).
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Standardized to npx-based stdio MCP transport. Uses the standard
 *   mcpServers object format.
 *   Skills: agents-standard, installed via code-audit install --agent agents.
 *
 * ✅ VERIFIED (2026-07-20):
 *   .vscode/mcp.json confirmed against code.visualstudio.com/docs/agents/reference/mcp-configuration.
 *   Also confirmed via VS Code command "MCP: Open Workspace Folder MCP Configuration".
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

/**
 * MCP config generator for standalone VS Code.
 */
export class VSCodeConfigGenerator extends BaseConfigGenerator {
  /**
   * Return the display name of the tool.
   * @returns The tool display name.
   */
  getToolName(): string {
    return 'VS Code MCP';
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
VS Code MCP Configuration Instructions:

1. Install the "MCP" extension for VS Code
2. Place this file at .vscode/mcp.json in your project root
3. Reload VS Code window
4. The code-auditor MCP tools will be available

Skill install (separate step):
  code-audit install --agent agents --scope project

Note: VS Code/Copilot has no edit hooks. Use MCP tools interactively for
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
