#!/usr/bin/env node
/**
 * Codex hook adapter — `code-audit codex-hook`.
 *
 * Reads Codex's PostToolUse stdin JSON and runs a diff-scoped audit.
 *
 * Phase 0 verification (2026-07-19):
 *   - Source: learn.chatgpt.com/docs/hooks
 *   - PostToolUse is BLOCKING: exit 2 replaces the tool result with feedback
 *   - Matcher in hooks.json: "apply_patch" (Codex's file-editing tool)
 *   - stdin shape: { session_id, tool_name, tool_use_id, tool_input, tool_response }
 *   - tool_input.file_path contains the edited file
 *
 * Exit codes:
 *   0 — no violations found
 *   2 — violations found (blocking feedback loop — severity is urgency, not permission)
 *   1 — internal error (adapter crash, not violation-related)
 */

import { readStdin, runHookAudit } from './core.js';
import type { HookAuditOutput } from './core.js';
import chalk from 'chalk';

export interface CodexPostToolUse {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: {
    file_path?: string;
    path?: string;
    [key: string]: unknown;
  };
  tool_response?: unknown;
}

export interface CodexHookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Build the Codex feedback payload from audit output.
 */
export function formatCodexFeedback(output: HookAuditOutput): {
  feedback: Record<string, unknown> | null;
  isBlocking: boolean;
} {
  if (output.violations.length === 0) {
    return { feedback: null, isBlocking: false };
  }

  // Every finding is a defect — severity is urgency (how fast to act), not
  // permission (whether to block). All three levels gate the edit.
  const criticals = output.violations.filter((v) => v.severity === 'critical');

  return {
    feedback: {
      decision: 'block',
      reason: criticals.length > 0
        ? `code-auditor found ${criticals.length} critical violation(s)`
        : `code-auditor found ${output.violations.length} violation(s)`,
      violations: output.violations.map((v) => ({
        severity: v.severity,
        message: v.message,
        file: v.file,
        line: v.line,
        rule: v.rule,
        suggestion: v.suggestion || null,
      })),
    },
    isBlocking: true,
  };
}

/**
 * Process a Codex PostToolUse event and return the hook result.
 * Extracted from main() for testability — tests inject a mock audit function.
 */
export async function processCodexEvent(
  rawStdin: string,
  auditFn: (filePaths: string[], projectRoot: string) => Promise<HookAuditOutput> = async (filePaths, projectRoot) =>
    runHookAudit({ filePaths, projectRoot, failOn: 'high' }),
  resolveRoot: (event: CodexPostToolUse) => string = (event) =>
    event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
): Promise<CodexHookResult> {
  const result: CodexHookResult = { exitCode: 0, stdout: '', stderr: '' };

  if (!rawStdin) {
    return result;
  }

  let event: CodexPostToolUse;
  try {
    event = JSON.parse(rawStdin);
  } catch {
    result.stderr = chalk.red('[code-auditor codex-hook] Failed to parse stdin JSON');
    return result;
  }

  const filePath = event.tool_input?.file_path || event.tool_input?.path;
  if (!filePath) {
    return result;
  }

  // Determine project root:
  // 1. cwd from the event (native Codex — learn.chatgpt.com/docs/hooks)
  // 2. CLAUDE_PROJECT_DIR env var (Claude Code compat mode)
  // 3. process.cwd() fallback
  const projectRoot = resolveRoot(event);

  try {
    const output = await auditFn([filePath], projectRoot);

    const { feedback, isBlocking } = formatCodexFeedback(output);

    if (feedback) {
      result.stdout = JSON.stringify(feedback, null, 2) + '\n';
      if (isBlocking) {
        result.exitCode = 2;
      }
    }
  } catch (error) {
    result.stderr = chalk.red(
      `[code-auditor codex-hook] Error: ${error instanceof Error ? error.message : String(error)}`
    );
    // Internal error — never wedge the agent loop
  }

  return result;
}

/**
 * CLI entry point — reads stdin, processes, writes result, exits.
 */
export async function main(): Promise<void> {
  const raw = await readStdin();
  const result = await processCodexEvent(raw);

  if (result.stderr) {
    console.error(result.stderr);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  process.exit(result.exitCode);
}

// Auto-run when executed as an entry point (not imported by tests)
// vitest sets process.env.VITEST; when set, tests call processCodexEvent directly
if (!process.env.VITEST) {
  main();
}
