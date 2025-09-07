/**
 * Configuration Generator Factory
 * Creates appropriate config generators for each AI tool
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
import { JetBrainsConfigGenerator } from './JetBrainsConfigGenerator.js';
import { ClineConfigGenerator } from './ClineConfigGenerator.js';
import { AiderConfigGenerator } from './AiderConfigGenerator.js';

export class ConfigGeneratorFactory {
  private generators: Map<string, () => BaseConfigGenerator>;
  private serverUrl: string;

  constructor(serverUrl: string = DEFAULT_SERVER_URL) {
    this.serverUrl = serverUrl;
    this.generators = new Map([
      ['cursor', () => new CursorConfigGenerator(this.serverUrl)],
      ['continue', () => new ContinueConfigGenerator(this.serverUrl)],
      ['copilot', () => new CopilotConfigGenerator(this.serverUrl)],
      ['claude', () => new ClaudeConfigGenerator(this.serverUrl)],
      ['awsq', () => new AWSQConfigGenerator(this.serverUrl)],
      ['codeium', () => new CodeiumConfigGenerator(this.serverUrl)],
      ['vscode', () => new VSCodeConfigGenerator(this.serverUrl)],
      ['jetbrains', () => new JetBrainsConfigGenerator(this.serverUrl)],
      ['cline', () => new ClineConfigGenerator(this.serverUrl)],
      ['aider', () => new AiderConfigGenerator(this.serverUrl)],
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
        requiresAuth: generator.requiresAuth()
      };
    });
  }
}