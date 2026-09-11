/**
 * ZCode Configuration Generator
 * Generates MCP configuration for ZCode (Z.AI's agentic AI coding IDE).
 *
 * Verified 2026-09-10 against zcode.z.ai/en/docs/mcp-services:
 *   - User scope:   ~/.zcode/cli/config.json  (key `mcp.servers`, NOT `mcpServers`)
 *   - Project scope: <root>/.zcode/config.json (same key)
 *   - Skills: .agents convention (~/.agents/skills/<name>/SKILL.md),
 *     installed via `code-audit install --agent zcode`.
 *   - Hooks: plugin-scoped hooks/hooks.json (PostToolUse is blocking), not a
 *     standalone file — so no file-based hook wiring applies here.
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class ZCodeConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'ZCode';
  }

  getFilename(): string {
    return '.zcode/config.json';
  }

  generateConfig(): ConfigOutput {
    const config = {
      mcp: {
        servers: {
          'code-auditor': {
            command: 'npx',
            args: ['-y', 'code-auditor-mcp', '--stdio'],
            env: {},
          },
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
ZCode MCP Configuration Instructions:

1. Place this file at .zcode/config.json in your project root (project scope).
   For a global install available in every workspace, put the same JSON at
   ~/.zcode/cli/config.json instead.
2. Restart ZCode (or toggle the server in Settings → MCP Servers).
3. The code-auditor MCP tools will be available.

Note: ZCode's native config uses the key "mcp.servers" (not "mcpServers").
The transport is stdio (command + args), the same as the other agents.

Skill install (separate step):
  code-audit install --agent zcode

Blocking hooks are not wired here: ZCode's hooks live inside a plugin's
hooks/hooks.json (PostToolUse is the blocking event), not a standalone file.
Use the MCP tools for interactive auditing.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
