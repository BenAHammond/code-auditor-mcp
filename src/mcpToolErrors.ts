/**
 * Rich errors and MCP tool error payloads so clients can show actionable messages
 * (missing paths, storage permissions, errno hints).
 */

import { promises as fs } from 'node:fs';

/** Error with structured `context` for MCP JSON responses */
export class ContextualError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown>,
    cause?: Error
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ContextualError';
  }
}

export function getErrnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as NodeJS.ErrnoException).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

/**
 * Ensure audit `path` exists and is a file or directory; otherwise throw ContextualError.
 */
export async function assertAuditPathExists(auditPath: string): Promise<{ isFile: boolean }> {
  try {
    const st = await fs.stat(auditPath);
    if (!st.isFile() && !st.isDirectory()) {
      throw new ContextualError(`Path is not a file or directory: ${auditPath}`, {
        auditPath,
      });
    }
    return { isFile: st.isFile() };
  } catch (e: unknown) {
    if (e instanceof ContextualError) throw e;
    const code = getErrnoCode(e);
    if (code === 'ENOENT') {
      throw new ContextualError(`Audit path does not exist: ${auditPath}`, {
        auditPath,
        resolvedPath: auditPath,
        errnoCode: code,
        hint:
          'Use an absolute path, or verify cwd — MCP servers often run with a different working directory than your editor project root.',
      }, e instanceof Error ? e : undefined);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ContextualError(`Permission denied when accessing audit path: ${auditPath}`, {
        auditPath,
        errnoCode: code,
      }, e instanceof Error ? e : undefined);
    }
    throw new ContextualError(
      `Cannot access audit path: ${auditPath} (${e instanceof Error ? e.message : String(e)})`,
      {
        auditPath,
        ...(code && { errnoCode: code }),
      },
      e instanceof Error ? e : undefined
    );
  }
}

/**
 * Shape returned as JSON in MCP CallTool error content.
 */
export function formatMcpToolErrorPayload(tool: string, error: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = { tool };
  if (error instanceof ContextualError) {
    return {
      ...base,
      error: error.message,
      context: error.context,
    };
  }
  if (error instanceof Error) {
    const e = error as Error & { code?: string };
    return {
      ...base,
      error: error.message,
      ...(typeof e.code === 'string' && e.code.length > 0 && { code: e.code }),
    };
  }
  return { ...base, error: String(error) };
}
