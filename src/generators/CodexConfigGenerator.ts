/**
 * Codex Configuration Generator
 * Generates MCP configuration for OpenAI Codex CLI.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   New generator for Codex CLI. Codex supports MCP via .codex/mcp.json.
 *   Skills: agents-standard (.codex/skills/), installed via code-audit install.
 *   Hooks: blocking (PostToolUse, exit 2 replaces tool result with feedback).
 *   Phase 0 verified: Codex PostToolUse contract matches Claude Code's closely.
 *
 * Fixed 2026-07-20 (Task #17 — generator path audit):
 *   Codex MCP uses TOML at ~/.codex/config.toml (NOT .codex/mcp.json).
 *   Format: [mcp_servers.code-auditor] with command + args keys.
 *   Verified against: learn.chatgpt.com/docs/extend/mcp?surface=cli (2026-07-20).
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class CodexConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Codex CLI';
  }

  getFilename(): string {
    return '~/.codex/config.toml';
  }

  generateConfig(): ConfigOutput {
    const mcpSection = {
      'code-auditor': {
        command: 'npx',
        args: ['-y', 'code-auditor-mcp', '--mcp-mode'],
      },
    };

    const content = this.formatTomlMcpServers(mcpSection);

    return {
      filename: this.getFilename(),
      content,
      instructions: this.getInstructions(),
    };
  }

  /**
   * Format MCP server entries as TOML [mcp_servers.<name>] sections.
   * Codex uses TOML, not JSON, for its config file.
   */
  private formatTomlMcpServers(servers: Record<string, { command: string; args: string[] }>): string {
    let toml = '# Codex MCP Configuration\n';
    toml += '# Add this to your ~/.codex/config.toml file\n\n';

    for (const [name, server] of Object.entries(servers)) {
      toml += `[mcp_servers.${name}]\n`;
      toml += `command = "${server.command}"\n`;
      toml += `args = [${server.args.map(a => `"${a}"`).join(', ')}]\n`;
      toml += '\n';
    }

    return toml.trimEnd() + '\n';
  }

  getInstructions(): string {
    return `
Codex CLI MCP Configuration Instructions:

1. Copy the [mcp_servers.code-auditor] section into ~/.codex/config.toml
   (create the file if it doesn't exist)
2. Restart your Codex session
3. The code-auditor MCP tools will be available

Format reference:
  https://learn.chatgpt.com/docs/extend/mcp?surface=cli

Skill install (separate step):
  code-audit install --agent codex --scope project

Hook wiring (separate step):
  code-audit install --agent codex --hooks

Note: Codex has blocking PostToolUse hooks (exit 2 replaces tool result
with violation feedback). This provides the same protection level as
Claude Code.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
