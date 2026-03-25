/**
 * MCP-safe diagnostics: always stderr (never stdout — stdio transport owns stdout).
 * - CODE_AUDITOR_DEBUG=1|true — verbose traces (logMcpDebug, mcpDebugStderr request/audit noise).
 * - CODE_AUDITOR_LOG_FILE=/path — append structured lines from logMcp/logMcpInfo.
 */
import fs from 'node:fs';

const debugEnabled =
  process.env.CODE_AUDITOR_DEBUG === '1' ||
  process.env.CODE_AUDITOR_DEBUG === 'true';

const logFilePath = process.env.CODE_AUDITOR_LOG_FILE?.trim();

function appendFileLine(line: string): void {
  if (!logFilePath) return;
  try {
    fs.appendFileSync(logFilePath, line + '\n');
  } catch {
    /* ignore */
  }
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
