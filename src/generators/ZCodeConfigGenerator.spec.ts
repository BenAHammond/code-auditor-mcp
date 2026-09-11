import { describe, it, expect } from 'vitest';
import { ZCodeConfigGenerator } from './ZCodeConfigGenerator.js';

describe('ZCodeConfigGenerator', () => {
  const generator = new ZCodeConfigGenerator();

  it('names the tool and emits the project-scope file', () => {
    expect(generator.getToolName()).toBe('ZCode');
    expect(generator.getFilename()).toBe('.zcode/config.json');
  });

  it('generates ZCode-native mcp.servers config with stdio transport', () => {
    const output = generator.generateConfig();
    const config = JSON.parse(output.content);

    // ZCode uses the key "mcp.servers", not "mcpServers".
    expect(config.mcpServers).toBeUndefined();

    const server = config.mcp.servers['code-auditor'];
    expect(server).toBeDefined();
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', 'code-auditor-mcp', '--stdio']);
    expect(server.env).toEqual({});
  });

  it('does not require auth', () => {
    expect(generator.requiresAuth()).toBe(false);
  });
});
