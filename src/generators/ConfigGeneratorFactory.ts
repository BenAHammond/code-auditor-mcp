/**
 * Configuration Generator Factory
 * Creates appropriate config generators for each AI tool.
 *
 * Updated 2026-07-19 (Spec-16 R5.3):
 *   Added Codex and Gemini generators. All generators now use standard
 *   npx-based stdio MCP transport. Removed fictional /api/* endpoints.
 *
 * Updated 2026-07-20 (Task #18 — generator path audit):
 *   Retired AiderConfigGenerator (zero MCP docs). Updated Continue generator
 *   from .continue/mcp.json to .continue/config.yaml (verified against
 *   docs.continue.dev). Confirmed AWS Q .amazonq/mcp.json as valid legacy path.
 */

import { DEFAULT_SERVER_URL } from '../constants.js';
import { BaseConfigGenerator } from './BaseConfigGenerator.js';
import { CursorConfigGenerator } from './CursorConfigGenerator.js';
import { ContinueConfigGenerator } from './ContinueConfigGenerator.js';
import { CopilotConfigGenerator } from './CopilotConfigGenerator.js';
import { ClaudeConfigGenerator } from './ClaudeConfigGenerator.js';
import { AWSQConfigGenerator } from './AWSQConfigGenerator.js';
import { CodeiumConfigGenerator } from './CodeiumConfigGenerator.js';
import { VSCodeConfigGenerator } from './VSCodeConfigGenerator.js';
// JetBrainsConfigGenerator retired 2026-07-20: JetBrains MCP is configured
// through the IDE's settings UI, not a file-based path. No generator to write.
import { ClineConfigGenerator } from './ClineConfigGenerator.js';
// AiderConfigGenerator retired 2026-07-20: no MCP support documented
import { CodexConfigGenerator } from './CodexConfigGenerator.js';
import { GeminiConfigGenerator } from './GeminiConfigGenerator.js';

export class ConfigGeneratorFactory {
  private generators: Map<string, () => BaseConfigGenerator>;
  private serverUrl: string;

  constructor(serverUrl: string = DEFAULT_SERVER_URL) {
    this.serverUrl = serverUrl;
    this.generators = new Map([
      ['claude', () => new ClaudeConfigGenerator(this.serverUrl)],
      ['codex', () => new CodexConfigGenerator(this.serverUrl)],
      ['cursor', () => new CursorConfigGenerator(this.serverUrl)],
      ['gemini', () => new GeminiConfigGenerator(this.serverUrl)],
      ['copilot', () => new CopilotConfigGenerator(this.serverUrl)],
      ['continue', () => new ContinueConfigGenerator(this.serverUrl)],
      ['awsq', () => new AWSQConfigGenerator(this.serverUrl)],
      ['codeium', () => new CodeiumConfigGenerator(this.serverUrl)],
      ['vscode', () => new VSCodeConfigGenerator(this.serverUrl)],
      // JetBrains retired 2026-07-20: no file-based MCP config path
      ['cline', () => new ClineConfigGenerator(this.serverUrl)],
      // Aider retired 2026-07-20: no MCP support documented in aider.chat/docs/
    ]);
  }

  /**
   * Create a generator for the specified tool
   */
  createGenerator(tool: string): BaseConfigGenerator | null {
    const generatorFactory = this.generators.get(tool.toLowerCase());
    return generatorFactory ? generatorFactory() : null;
  }

  /**
   * Get all available tool names
   */
  getAvailableTools(): string[] {
    return Array.from(this.generators.keys());
  }

  /**
   * Get all generators
   */
  getAllGenerators(): Map<string, BaseConfigGenerator> {
    const result = new Map<string, BaseConfigGenerator>();
    for (const [tool, factory] of this.generators) {
      result.set(tool, factory());
    }
    return result;
  }

  /**
   * Check if a tool is supported
   */
  isToolSupported(tool: string): boolean {
    return this.generators.has(tool.toLowerCase());
  }

  /**
   * Get tool display information
   */
  getToolInfo(): Array<{ name: string; displayName: string; requiresAuth: boolean }> {
    return this.getAvailableTools().map(tool => {
      const generator = this.createGenerator(tool)!;
      return {
        name: tool,
        displayName: generator.getToolName(),
        requiresAuth: generator.requiresAuth(),
      };
    });
  }
}
