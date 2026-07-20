#!/usr/bin/env node
/**
 * Cursor hook adapter — `code-audit cursor-hook`.
 *
 * Reads Cursor's postToolUse stdin JSON (native or Claude Code compat) and
 * runs a scoped audit on edited files. Blocks edits with critical violations.
 *
 * Phase 0 verification (2026-07-20):
 *   - Source: cursor.com/docs/hooks + cursor.com/docs/reference/third-party-hooks
 *   - postToolUse with Write matcher IS BLOCKING: exit 2 blocks the action
 *   - additional_context is injected into the conversation after the tool result
 *   - afterFileEdit EXISTS but is observation-only ("No output fields defined")
 *   - Cursor natively reads .claude/settings.json hooks (PostToolUse→postToolUse)
 *   - Tool name mapping: Edit→Write, Bash→Shell
 *   - Dual response format support: both Claude nested format and Cursor flat format
 *
 * Input formats (both accepted):
 *   Cursor native: { tool_name, tool_input, tool_output, tool_use_id, cwd, ... }
 *   Claude Code compat: { tool_name, tool_input, tool_output, session_id, cwd, ... }
 *   (CLAUDE_PROJECT_DIR env var set in Claude Code compat mode)
 *
 * Exit codes:
 *   0 — no critical violations found
 *   2 — critical violations found (blocks the action, additional_context injected)
 *   1 — internal error (adapter crash, not violation-related)
 */

import { readStdin, runHookAudit } from './core.js';
import type { HookAuditOutput } from './core.js';
import chalk from 'chalk';

export interface CursorPostToolUse {
  // Cursor native (camelCase)
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_use_id?: string;
  // Claude Code compat (PascalCase) — Cursor maps to camelCase but also may pass raw
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  session_id?: string;
  transcript_path?: string;
  // Common
  cwd?: string;
}

export interface CursorHookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Detect whether this is a Write/Edit tool invocation we should audit.
 */
export function isWriteOrEdit(event: CursorPostToolUse): boolean {
  const toolName = (event.tool_name || event.toolName || '').toLowerCase();
  // Cursor native: "Write" (camelCase mapped). Claude Code compat: "Edit".
  // Also accept "edit", "write" for robustness.
  return toolName === 'write' || toolName === 'edit';
}

/**
 * Extract the edited file path from tool_input.
 * Cursor Write: tool_input.file_path
 * Claude Code Edit: tool_input.file_path
 */
export function extractFilePath(event: CursorPostToolUse): string | null {
  const input = event.tool_input || event.toolInput;
  if (!input) return null;

  const filePath = input.file_path as string | undefined;
  if (filePath && typeof filePath === 'string') return filePath;

  return null;
}

/**
 * Build the additional_context string for violations.
 */
export function formatViolationContext(output: HookAuditOutput): {
  context: string;
  isBlocking: boolean;
} {
  const criticals = output.violations.filter((v) => v.severity === 'critical');
  const warnings = output.violations.filter((v) => v.severity === 'warning');
  const suggestions = output.violations.filter((v) => v.severity === 'suggestion');

  if (criticals.length > 0) {
    const lines = [
      `🚨 **Code Auditor found ${criticals.length} critical violation(s)**`,
      '',
      ...criticals.map((v) =>
        `- **${v.file}${v.line ? `:${v.line}` : ''}** — ${v.message}` +
        (v.suggestion ? `\n  Suggestion: ${v.suggestion}` : '')
      ),
    ];
    if (warnings.length > 0 || suggestions.length > 0) {
      lines.push(
        '',
        `Also found: ${warnings.length} warning(s), ${suggestions.length} suggestion(s).`
      );
    }
    lines.push(
      '',
      'Fix the critical violations above and retry. The edit has been blocked.',
    );
    return { context: lines.join('\n'), isBlocking: true };
  }

  if (warnings.length > 0 || suggestions.length > 0) {
    const notes: string[] = [];
    if (warnings.length > 0) {
      notes.push(`${warnings.length} warning(s):`);
      warnings.forEach((v) => {
        notes.push(`  - ${v.file}${v.line ? `:${v.line}` : ''} — ${v.message}`);
      });
    }
    if (suggestions.length > 0) {
      notes.push(`${suggestions.length} suggestion(s):`);
      suggestions.forEach((v) => {
        notes.push(`  - ${v.file}${v.line ? `:${v.line}` : ''} — ${v.message}`);
      });
    }
    return {
      context: `ℹ️ **Code Auditor notes:**\n${notes.join('\n')}`,
      isBlocking: false,
    };
  }

  return { context: '', isBlocking: false };
}

/**
 * Process a Cursor postToolUse event and return the hook result.
 * Extracted from main() for testability — tests inject a mock audit function.
 */
export async function processCursorEvent(
  rawStdin: string,
  auditFn: (filePaths: string[], projectRoot: string) => Promise<HookAuditOutput> = async (filePaths, projectRoot) =>
    runHookAudit({ filePaths, projectRoot, failOn: 'critical' })
): Promise<CursorHookResult> {
  const result: CursorHookResult = { exitCode: 0, stdout: '', stderr: '' };

  if (!rawStdin) {
    return result;
  }

  let event: CursorPostToolUse;
  try {
    event = JSON.parse(rawStdin);
  } catch (err) {
    result.stderr = chalk.red(
      `[code-auditor cursor-hook] Failed to parse stdin JSON: ${err instanceof Error ? err.message : String(err)}`
    );
    // Degrade gracefully — never wedge the agent on parse errors
    return result;
  }

  // Guard: only audit Write/Edit tool calls
  if (!isWriteOrEdit(event)) {
    return result;
  }

  const filePath = extractFilePath(event);
  if (!filePath) {
    return result;
  }

  // Determine project root:
  // 1. cwd from the event (native Cursor)
  // 2. CLAUDE_PROJECT_DIR env var (Claude Code compat mode)
  // 3. process.cwd() fallback
  const projectRoot =
    (event.cwd && event.cwd.trim()) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  try {
    const output = await auditFn([filePath], projectRoot);

    const { context, isBlocking } = formatViolationContext(output);

    if (context) {
      const response = { additional_context: context };
      result.stdout = JSON.stringify(response) + '\n';
      if (isBlocking) {
        result.exitCode = 2;
      }
    }
  } catch (error) {
    result.stderr = chalk.red(
      `[code-auditor cursor-hook] Error: ${error instanceof Error ? error.message : String(error)}`
    );
    // Internal error — never wedge the agent loop
  }

  return result;
}

/**
 * CLI entry point — reads stdin, processes, writes result, exits.
 * Exported so the CLI can call it explicitly after importing.
 */
export async function main(): Promise<void> {
  const raw = await readStdin();
  const result = await processCursorEvent(raw);

  if (result.stderr) {
    console.error(result.stderr);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  process.exit(result.exitCode);
}

// Auto-run when executed as an entry point (not imported by tests)
// vitest sets process.env.VITEST; when set, tests call processCursorEvent directly
if (!process.env.VITEST) {
  main();
}
