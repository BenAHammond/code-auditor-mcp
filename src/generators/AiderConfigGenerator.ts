/**
 * Aider Configuration Generator — RETIRED
 *
 * Originally added Spec-16 R5.3 with path .aider.mcp.json as a "convention
 * bridge" (users would reference it from .aider.conf.yml).
 *
 * Retired 2026-07-20 (Task #18 — generator path audit):
 *   Aider has zero documented MCP support. Verification per standing rule:
 *   - aider.chat/docs/config/mcp.html → 404
 *   - aider.chat/docs/llm.html → 404
 *   - aider.chat/docs/ (complete docs index) → zero MCP pages
 *   Both the specific MCP doc URL fails AND the docs sitemap lacks any MCP
 *   entries. The .aider.mcp.json convention bridge was entirely our invention
 *   with no doc support. No generator to write.
 *   This file is kept as a tombstone; the class is no longer registered in
 *   ConfigGeneratorFactory.
 */

import { BaseConfigGenerator, ConfigOutput } from './BaseConfigGenerator.js';

export class AiderConfigGenerator extends BaseConfigGenerator {
  getToolName(): string {
    return 'Aider';
  }

  getFilename(): string {
    return '.aider.mcp.json';
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
Aider MCP Configuration Instructions:

1. Save this file and reference it in .aider.conf.yml:
     mcp-config: .aider.mcp.json
2. Or pass directly: aider --mcp .aider.mcp.json
3. The code-auditor MCP tools will be available in Aider sessions

Skill install (separate step):
  code-audit install --agent agents --scope project

Note: Aider supports SKILL.md via the agents standard.
For blocking hooks, use Claude Code or Codex.
`;
  }

  requiresAuth(): boolean {
    return false;
  }
}
