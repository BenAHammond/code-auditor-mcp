/**
 * Continue Configuration Generator
 * Generates MCP configuration for Continue AI assistant.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Removed fictional /api/continue endpoint. Retained proper MCP stdio
 *   transport. Continue has native MCP support via modelContextProtocolServers.
 *   Skills: agents-standard, installed via code-audit install --agent agents.
 *
 * ✅ VERIFIED (2026-07-20):
 *   Source: docs.continue.dev/customize/mcp-tools + docs.continue.dev/reference
 *   Continue uses config.yaml (NOT a standalone mcp.json). MCP servers are
 *   configured at the top-level mcpServers key in config.yaml — the old
 *   experimental.modelContextProtocolServers key in JSON is deprecated.
 *   Continue has migrated from .continue/config.json to .continue/config.yaml
 *   (YAML is now the only format). This generator emits a YAML snippet for
 *   .continue/config.yaml — users merge it into their existing config.yaml.
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class ContinueConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Continue';
  }

  getFilename(): string {
    return '.continue/config.yaml';
  }

  generateConfig(): ConfigOutput {
    const content = `# Add this to your .continue/config.yaml under the mcpServers key.
# If you already have an mcpServers section, merge the code-auditor entry.
mcpServers:
  code-auditor:
    command: npx
    args:
      - "-y"
      - "code-auditor-mcp"
      - "--mcp-mode"
`;

    return {
      filename: this.getFilename(),
      content,
      instructions: this.getInstructions(),
    };
  }

  getInstructions(): string {
    return `
Continue MCP Configuration Instructions:

1. Install Continue extension in VS Code or JetBrains
2. Merge the code-auditor entry into your .continue/config.yaml file
   under the mcpServers key (project-level) or ~/.continue/config.yaml
   (global). Do NOT add an experimental wrapper — mcpServers is a
   top-level key.
3. Restart your IDE (or reload the Continue extension)
4. The code-auditor MCP tools will be available

Skill install (separate step):
  code-audit install --agent agents --scope project

Note: Continue has native MCP support since config.yaml migration.
For blocking hooks, use Claude Code or Codex.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
