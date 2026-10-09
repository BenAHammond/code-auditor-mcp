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

/**
 * Hook mode — set by `hook-audit.sh` before it invokes the CLI. A PostToolUse
 * hook's stderr is surfaced by the host as a blocking error, so a *successful*
 * audit must never write to stderr. In hook mode, `info`/`debug` lines are
 * written to the log file only (`CODE_AUDITOR_LOG_FILE`); `warn` — a real
 * failure signal, not progress — still goes to stderr.
 */
const hookMode =
  process.env.CODE_AUDITOR_HOOK === '1' ||
  process.env.CODE_AUDITOR_HOOK === 'true';

const logFilePath = process.env.CODE_AUDITOR_LOG_FILE?.trim();
let writeQueue: Promise<void> = Promise.resolve();

function appendFileLine(line: string): void {
  if (!logFilePath) return;
  // Queue async writes to avoid blocking the MCP event loop. The previous queued
  // write is awaited first so the line ordering is preserved; errors are
  // swallowed so a failed append never breaks the queue for later callers.
  const prev = writeQueue;
  writeQueue = (async () => {
    await prev;
    try {
      await new Promise<void>((resolve) => {
        fs.appendFile(logFilePath, line + '\n', () => resolve());
      });
    } catch {
      /* ignore */
    }
  })();
}

/**
 * Write a diagnostic line to stderr and, when configured, the log file.
 * @param level - The diagnostic level (info, warn, or debug).
 * @param phase - The phase or milestone the line describes.
 * @param message - The message to log.
 * @param detail - Optional structured detail to append as JSON.
 */
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
  } else if (!hookMode) {
    // info / debug: stderr is the host's blocking-error channel in a hook, so
    // in hook mode these go to the log file only (via appendFileLine below).
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
