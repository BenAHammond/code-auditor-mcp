/**
 * ToolRegistry — Single source of truth for MCP tool definitions.
 *
 * Each tool declares its name, MCP description, and a set of actions
 * (action name, description, parameters, handler). The registry generates
 * MCP Tool[] schemas for ListToolsRequestSchema and handles dispatch for
 * CallToolRequestSchema with structured errors.
 *
 * In Specs 04/07, `getCLISubcommands()` will extend the same definitions
 * to CLI subcommand wiring so tool surfaces are never written twice.
 */

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description: string;
  default?: unknown;
  enum?: string[];
}

export interface ActionDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  handler: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  actions: ActionDefinition[];
}

export interface StructuredError {
  success: false;
  error: string;
  validActions?: Array<{
    action: string;
    description: string;
    parameters: ToolParameter[];
  }>;
}

export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Build a combined input schema for a tool: the `action` enum parameter
   * plus all action-specific parameters. The action enum lists every action
   * name so agents see the full surface in the schema.
   */
  buildToolInputSchema(tool: ToolDefinition): {
    properties: Record<string, unknown>;
    required: string[];
  } {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    // action enum — always required
    properties.action = {
      type: 'string',
      description: `Action to perform. One of: ${tool.actions.map((a) => a.name).join(', ')}.`,
      enum: tool.actions.map((a) => a.name),
    };
    required.push('action');

    // Collect action-specific parameters. Duplicate param names across
    // actions are merged (last-wins for required/default/enum). In practice
    // each tool's actions share a parameter vocabulary (e.g. `path` means
    // the same thing across all audit actions).
    const seen = new Set<string>();
    for (const action of tool.actions) {
      for (const param of action.parameters) {
        if (!seen.has(param.name)) {
          seen.add(param.name);
          const schema: Record<string, unknown> = {
            type: param.type,
            description: param.description,
          };
          if (param.default !== undefined) {
            schema.default = param.default;
          }
          if (param.enum) {
            schema.enum = param.enum;
          }
          properties[param.name] = schema;
          if (param.required) {
            required.push(param.name);
          }
        }
      }
    }

    return { properties, required };
  }

  getMCPToolSchemas(): MCPToolSchema[] {
    const schemas: MCPToolSchema[] = [];
    for (const tool of this.tools.values()) {
      const { properties, required } = this.buildToolInputSchema(tool);
      schemas.push({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object',
          properties,
          required,
        },
      });
    }
    return schemas;
  }

  /**
   * Dispatch a tool call. Returns the handler result on success, or a
   * StructuredError when the tool name or action is invalid.
   */
  async dispatch(
    toolName: string,
    action: string | undefined,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: "${toolName}". Available tools: ${Array.from(this.tools.keys()).join(', ')}.`,
      } satisfies StructuredError;
    }

    if (!action) {
      return {
        success: false,
        error: `Missing required parameter "action" for tool "${toolName}".`,
        validActions: tool.actions.map((a) => ({
          action: a.name,
          description: a.description,
          parameters: a.parameters,
        })),
      } satisfies StructuredError;
    }

    const actionDef = tool.actions.find((a) => a.name === action);
    if (!actionDef) {
      return {
        success: false,
        error: `Invalid action "${action}" for tool "${toolName}". Valid actions: ${tool.actions.map((a) => a.name).join(', ')}.`,
        validActions: tool.actions.map((a) => ({
          action: a.name,
          description: a.description,
          parameters: a.parameters,
        })),
      } satisfies StructuredError;
    }

    try {
      return await actionDef.handler(args, signal);
    } catch (error) {
      throw error; // re-throw — caller wraps in MCP error response
    }
  }

  /**
   * Placeholder: generates CLI subcommand definitions from the same
   * tool definitions. Used in Specs 04/07 for `code-audit changed` etc.
   */
  getCLISubcommands(): Array<{ name: string; description: string; actions: string[] }> {
    return this.getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      actions: t.actions.map((a) => a.name),
    }));
  }
}
