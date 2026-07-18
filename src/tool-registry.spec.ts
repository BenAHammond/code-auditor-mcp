import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './tool-registry.js';
import type { ActionDefinition, ToolDefinition } from './tool-registry.js';

function makeTool(
  name: string,
  actions: Array<{ name: string; params?: ActionDefinition['parameters']; handler?: ActionDefinition['handler'] }>,
  description?: string,
): ToolDefinition {
  return {
    name,
    description: description ?? `${name} tool description`,
    actions: actions.map((a) => ({
      name: a.name,
      description: `${a.name} action`,
      parameters: a.params ?? [],
      handler: a.handler ?? (async () => ({ ok: true, action: a.name })),
    })),
  };
}

describe('ToolRegistry', () => {
  describe('registration', () => {
    it('registers tools and retrieves them', () => {
      const registry = new ToolRegistry();
      const audit = makeTool('audit', [{ name: 'run' }, { name: 'status' }]);
      registry.register(audit);

      expect(registry.getTool('audit')).toBe(audit);
      expect(registry.getTool('nonexistent')).toBeUndefined();
      expect(registry.getAllTools()).toHaveLength(1);
    });

    it('throws on duplicate tool names', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool('audit', [{ name: 'run' }]));
      expect(() => registry.register(makeTool('audit', [{ name: 'start' }]))).toThrow(
        'Tool "audit" is already registered',
      );
    });
  });

  describe('getMCPToolSchemas', () => {
    it('generates correct MCP tool schemas', () => {
      const registry = new ToolRegistry();
      registry.register(
        makeTool('audit', [
          {
            name: 'run',
            params: [
              { name: 'path', type: 'string', required: false, description: 'Path to audit' },
              { name: 'analyzers', type: 'array', required: false, description: 'Analyzers to run' },
            ],
          },
          {
            name: 'status',
            params: [
              { name: 'jobId', type: 'string', required: true, description: 'Job ID' },
            ],
          },
        ]),
      );

      const schemas = registry.getMCPToolSchemas();
      expect(schemas).toHaveLength(1);

      const auditSchema = schemas[0];
      expect(auditSchema.name).toBe('audit');
      expect(auditSchema.inputSchema.properties.action).toEqual({
        type: 'string',
        description: 'Action to perform. One of: run, status.',
        enum: ['run', 'status'],
      });
      expect(auditSchema.inputSchema.required).toContain('action');
      expect(auditSchema.inputSchema.required).toContain('jobId'); // required param
      expect(auditSchema.inputSchema.required).not.toContain('path'); // optional param
      expect(auditSchema.inputSchema.required).not.toContain('analyzers'); // optional param
    });

    it('merges duplicate parameter names across actions', () => {
      const registry = new ToolRegistry();
      registry.register(
        makeTool('search', [
          {
            name: 'query',
            params: [
              { name: 'query', type: 'string', required: true, description: 'Search query' },
              { name: 'limit', type: 'number', required: false, description: 'Max results', default: 50 },
            ],
          },
          {
            name: 'definition',
            params: [
              { name: 'name', type: 'string', required: true, description: 'Function name' },
              { name: 'limit', type: 'number', required: false, description: 'Max results', default: 50 },
            ],
          },
        ]),
      );

      const schemas = registry.getMCPToolSchemas();
      const schema = schemas[0];
      // limit should only appear once in properties
      const keys = Object.keys(schema.inputSchema.properties);
      expect(keys.filter((k) => k === 'limit')).toHaveLength(1);
    });
  });

  describe('dispatch', () => {
    it('dispatches to the correct action handler', async () => {
      const registry = new ToolRegistry();
      registry.register(
        makeTool('audit', [
          { name: 'run', handler: async () => ({ result: 'audit complete' }) },
          { name: 'status', handler: async () => ({ status: 'running' }) },
        ]),
      );

      const runResult = await registry.dispatch('audit', 'run', {});
      expect(runResult).toEqual({ result: 'audit complete' });

      const statusResult = await registry.dispatch('audit', 'status', {});
      expect(statusResult).toEqual({ status: 'running' });
    });

    it('passes args and signal to handler', async () => {
      const registry = new ToolRegistry();
      let capturedArgs: any;
      let capturedSignal: any;
      const controller = new AbortController();

      registry.register(
        makeTool('tasks', [
          {
            name: 'create',
            handler: async (args, signal) => {
              capturedArgs = args;
              capturedSignal = signal;
              return { ok: true };
            },
          },
        ]),
      );

      await registry.dispatch('tasks', 'create', { title: 'Fix bug' }, controller.signal);
      expect(capturedArgs).toEqual({ title: 'Fix bug' });
      expect(capturedSignal).toBe(controller.signal);
    });

    it('returns structured error for unknown tool', async () => {
      const registry = new ToolRegistry();
      const result: any = await registry.dispatch('nonexistent', 'run', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
      expect(result.error).toContain('nonexistent');
    });

    it('returns structured error for missing action', async () => {
      const registry = new ToolRegistry();
      registry.register(makeTool('audit', [{ name: 'run' }]));

      const result: any = await registry.dispatch('audit', undefined, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required parameter "action"');
      expect(result.validActions).toBeDefined();
      expect(result.validActions).toHaveLength(1);
      expect(result.validActions[0].action).toBe('run');
    });

    it('returns structured error for invalid action with full parameter info', async () => {
      const registry = new ToolRegistry();
      registry.register(
        makeTool('audit', [
          {
            name: 'run',
            params: [
              { name: 'path', type: 'string', required: false, description: 'Path to audit' },
            ],
          },
          {
            name: 'status',
            params: [
              { name: 'jobId', type: 'string', required: true, description: 'Job ID' },
            ],
          },
          { name: 'health' },
        ]),
      );

      const result: any = await registry.dispatch('audit', 'bad_action', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid action "bad_action"');
      expect(result.error).toContain('run, status, health');
      expect(result.validActions).toBeDefined();
      expect(result.validActions).toHaveLength(3);
      expect(result.validActions.map((a: any) => a.action)).toEqual(['run', 'status', 'health']);
      // Action definitions include parameter schemas
      expect(result.validActions[0].parameters).toBeDefined();
      expect(result.validActions[0].description).toBeDefined();
    });

    it('re-throws handler errors for caller to wrap', async () => {
      const registry = new ToolRegistry();
      registry.register(
        makeTool('audit', [
          {
            name: 'run',
            handler: async () => {
              throw new Error('audit failed');
            },
          },
        ]),
      );

      await expect(registry.dispatch('audit', 'run', {})).rejects.toThrow('audit failed');
    });
  });

  describe('getCLISubcommands', () => {
    it('returns stub CLI subcommand list', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool('audit', [{ name: 'run' }, { name: 'start' }]));
      registry.register(makeTool('search', [{ name: 'query' }]));

      const cli = registry.getCLISubcommands();
      expect(cli).toHaveLength(2);
      expect(cli[0]).toEqual({
        name: 'audit',
        description: 'audit tool description',
        actions: ['run', 'start'],
      });
      expect(cli[1]).toEqual({
        name: 'search',
        description: 'search tool description',
        actions: ['query'],
      });
    });
  });
});
