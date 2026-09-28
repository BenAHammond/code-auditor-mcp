/**
 * AWS Q Developer Configuration Generator
 * Generates MCP configuration for AWS Q Developer.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Replaced fictional /api/awsq endpoint with standard stdio MCP transport.
 *   Q Developer supports MCP via its IDE extensions.
 *
 * ✅ VERIFIED (2026-07-20):
 *   Source: docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-ide.html
 *   (confirmed via llms.txt which lists 5 MCP pages).
 *   The current standard path is .amazonq/default.json (local) or
 *   ~/.aws/amazonq/default.json (global). However, .amazonq/mcp.json is
 *   an explicitly documented legacy path still supported by default
 *   (useLegacyMcpJson: true in default.json). This generator uses the
 *   legacy mcp.json path because it is a dedicated MCP-only file, making
 *   it safer for programmatic generation than merging into default.json.
 *   The format uses the standard mcpServers key with stdio transport.
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

/**
 * MCP config generator for AWS Q Developer.
 */
export class AWSQConfigGenerator extends BaseConfigGenerator {
  /**
   * Return the display name of the tool.
   * @returns The tool display name.
   */
  getToolName(): string {
    return 'AWS Q Developer';
  }

  /**
   * Return the default config file path for the tool.
   * @returns The default config file path.
   */
  getFilename(): string {
    return '.amazonq/mcp.json';
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
AWS Q Developer MCP Configuration Instructions:

1. Place this file at .amazonq/mcp.json in your project root
2. Restart your IDE with Q Developer
3. The code-auditor MCP tools will be available

Skill install (separate step):
  code-audit install --agent agents --scope project

Note: Q Developer supports SKILL.md via the agents standard.
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
