/**
 * MCP-safe diagnostics: always stderr (never stdout — stdio transport owns stdout).
 * - CODE_AUDITOR_DEBUG=1|true — normal debug diagnostics (milestones, lightweight detail).
 * - CODE_AUDITOR_TRACE=1|true — very verbose request/response dumps (raw MCP payloads).
 * - CODE_AUDITOR_LOG_FILE=/path — append structured lines from logMcp/logMcpInfo.
 */
import fs from 'node:fs';

const debugEnabled =
  process.env.CODE_AUDITOR_DEBUG === '1' ||
  process.env.CODE_AUDITOR_DEBUG === 'true';

const traceEnabled =
  process.env.CODE_AUDITOR_TRACE === '1' ||
  process.env.CODE_AUDITOR_TRACE === 'true';

const logFilePath = process.env.CODE_AUDITOR_LOG_FILE?.trim();
let writeQueue: Promise<void> = Promise.resolve();

function appendFileLine(line: string): void {
  if (!logFilePath) return;
  // Queue async writes to avoid blocking the MCP event loop.
  writeQueue = writeQueue
    .then(
      () =>
        new Promise<void>((resolve) => {
          fs.appendFile(logFilePath, line + '\n', () => resolve());
        })
    )
    .catch(() => {
      /* ignore */
    });
}

export function logMcp(
  level: 'info' | 'warn' | 'debug',
  phase: string,
  message: string,
  detail?: Record<string, unknown>
): void {
  if (level === 'debug' && !debugEnabled) return;
  const ts = new Date().toISOString();
  const pid = process.pid;
  const extra = detail !== undefined && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : '';
  const line = `[${ts}] [pid=${pid}] [code-auditor] [${level}] [${phase}] ${message}${extra}`;
  if (level === 'warn') {
    console.warn(line);
  } else {
    console.error(line);
  }
  appendFileLine(line);
}

/** Always logged (high-signal milestones). */
export function logMcpInfo(phase: string, message: string, detail?: Record<string, unknown>): void {
  logMcp('info', phase, message, detail);
}

export function logMcpDebug(phase: string, message: string, detail?: Record<string, unknown>): void {
  logMcp('debug', phase, message, detail);
}

export function isMcpDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Raw stderr (e.g. chalk-colored traces) — only when CODE_AUDITOR_DEBUG=1|true.
 * Use for per-request JSON dumps and noisy dev traces; keep hot paths quiet by default.
 */
export function mcpDebugStderr(...args: unknown[]): void {
  if (!debugEnabled) return;
  console.error(...args);
}

/**
 * Very noisy stderr diagnostics. Keep disabled unless actively debugging protocol payloads.
 */
export function mcpTraceStderr(...args: unknown[]): void {
  if (!traceEnabled) return;
  console.error(...args);
}
