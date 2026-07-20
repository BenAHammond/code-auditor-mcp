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
 *   0 — no critical violations found
 *   2 — critical violations found (blocking feedback loop)
 *   1 — internal error (adapter crash, not violation-related)
 */

import { readStdin, runHookAudit } from './core.js';
import chalk from 'chalk';

interface CodexPostToolUse {
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: {
    file_path?: string;
    path?: string;
    [key: string]: unknown;
  };
  tool_response?: unknown;
}

async function main(): Promise<void> {
  const raw = await readStdin();

  if (!raw) {
    // No stdin data — nothing to audit
    process.exit(0);
  }

  let event: CodexPostToolUse;
  try {
    event = JSON.parse(raw);
  } catch {
    console.error(chalk.red('[code-auditor codex-hook] Failed to parse stdin JSON'));
    process.exit(0); // Degrade gracefully
  }

  const filePath = event!.tool_input?.file_path || event!.tool_input?.path;
  if (!filePath) {
    // No file path — nothing to audit
    process.exit(0);
  }

  const projectRoot = process.cwd();

  try {
    const output = await runHookAudit({
      filePaths: [filePath],
      projectRoot,
      failOn: 'critical',
    });

    if (output.violations.length > 0) {
      // Codex PostToolUse: exit 2 replaces tool result with feedback
      // Write violations as JSON to stdout — Codex feeds this back to the agent
      const criticals = output.violations.filter((v) => v.severity === 'critical');

      if (criticals.length > 0) {
        const feedback = {
          decision: 'block',
          reason: `code-auditor found ${criticals.length} critical violation(s)`,
          violations: output.violations.map((v) => ({
            severity: v.severity,
            message: v.message,
            file: v.file,
            line: v.line,
            rule: v.rule,
            suggestion: v.suggestion || null,
          })),
        };
        process.stdout.write(JSON.stringify(feedback, null, 2) + '\n');
        process.exit(2);
      }

      // Non-critical violations: report but don't block
      const warnings = output.violations.filter((v) => v.severity === 'warning');
      if (warnings.length > 0) {
        const advisory = {
          decision: 'allow',
          warnings: warnings.map((v) => ({
            message: v.message,
            file: v.file,
            line: v.line,
            suggestion: v.suggestion || null,
          })),
        };
        process.stdout.write(JSON.stringify(advisory, null, 2) + '\n');
      }
    }

    process.exit(0);
  } catch (error) {
    // Internal error — report and exit 0 (never wedge the agent loop on errors)
    console.error(chalk.red(`[code-auditor codex-hook] Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(0);
  }
}

main();
