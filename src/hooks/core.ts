/**
 * Shared hook adapter core — reads stdin, runs a diff-scoped audit, writes stdout.
 *
 * Each tool's hook adapter (cursor.ts, codex.ts) is a thin payload mapper that:
 * 1. Reads the tool-specific stdin JSON
 * 2. Extracts edited file paths
 * 3. Calls runHookAudit() with those paths
 * 4. Maps audit results back to the tool's stdout contract
 *
 * Phase 0 live-docs verification (2026-07-20):
 *   - Cursor postToolUse (Write matcher): BLOCKING (exit 2, additional_context)
 *     Verified: cursor.com/docs/hooks + cursor.com/docs/reference/third-party-hooks
 *   - Cursor afterFileEdit: EXISTS but observation-only — NOT used for blocking
 *   - Codex PostToolUse: blocking (exit 2 replaces tool result with feedback)
 *     Verified: learn.chatgpt.com/docs/extend/hooks
 *   - Claude Code PostToolUse: blocking (exit 2 blocks the edit)
 *     Cursor reads .claude/settings.json natively via third-party hooks compat
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { createAuditRunner } from '../auditRunner.js';
import { initParsers } from '../languages/index.js';
import type { Severity, AuditScope } from '../types.js';

export interface HookAuditInput {
  filePaths: string[];      // Absolute or relative paths to audit
  projectRoot: string;      // Project root directory
  failOn: Severity;         // 'critical' | 'warning' | 'suggestion'
}

export interface HookViolation {
  analyzer: string;
  rule: string;
  severity: Severity;
  message: string;
  file: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  enclosingSymbol?: string;
  suggestion?: string;
  details?: string;
}

export interface HookAuditOutput {
  violations: HookViolation[];
  summary: {
    total: number;
    critical: number;
    warning: number;
    suggestion: number;
  };
  filesAnalyzed: number;
}

/**
 * Read all of stdin as a string. Returns empty string on EOF/error.
 */
export async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // If stdin is a TTY, there's nothing to read
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: undefined as any,
      terminal: false,
    });

    const lines: string[] = [];
    rl.on('line', (line) => {
      lines.push(line);
    });
    rl.on('close', () => {
      resolve(lines.join('\n'));
    });
    rl.on('error', () => {
      resolve(lines.join('\n'));
    });

    // Timeout: if nothing arrives in 5s, assume no input
    setTimeout(() => {
      rl.close();
      resolve(lines.join('\n'));
    }, 5000).unref();
  });
}

/**
 * Run a diff-scoped audit on the given file paths.
 * This is the shared core — all hook adapters call this.
 */
export async function runHookAudit(input: HookAuditInput): Promise<HookAuditOutput> {
  // Initialize parsers (idempotent once loaded)
  await initParsers();

  if (input.filePaths.length === 0) {
    return {
      violations: [],
      summary: { total: 0, critical: 0, warning: 0, suggestion: 0 },
      filesAnalyzed: 0,
    };
  }

  // Convert to absolute paths
  const resolvedPaths = [...new Set(input.filePaths.map((f) =>
    resolve(input.projectRoot, f)
  ))];

  // Create runner with the resolved scope
  const runner = createAuditRunner({
    projectRoot: input.projectRoot,
    scope: resolvedPaths as unknown as AuditScope,
    analyzerConcurrency: 4,
  });

  const result = await runner.run();

  // Collect all violations
  const allViolations = Object.values(result.analyzerResults).flatMap(
    (r: any) => r.violations || []
  );

  const violations: HookViolation[] = allViolations.map((v: any) => ({
    analyzer: v.analyzer || '',
    rule: v.rule || v.type || '',
    severity: v.severity,
    message: v.message,
    file: v.file || '',
    line: v.line ?? v.start?.line,
    column: v.column ?? v.start?.column ?? 1,
    endLine: v.end?.line,
    endColumn: v.end?.column,
    enclosingSymbol: v.symbol || v.enclosingFunction || '',
    suggestion: v.suggestion || '',
    details: v.details || '',
  }));

  const criticalCount = violations.filter((v) => v.severity === 'critical').length;
  const warningCount = violations.filter((v) => v.severity === 'warning').length;
  const suggestionCount = violations.filter((v) => v.severity === 'suggestion').length;

  return {
    violations,
    summary: {
      total: violations.length,
      critical: criticalCount,
      warning: warningCount,
      suggestion: suggestionCount,
    },
    filesAnalyzed: result.metadata.filesAnalyzed,
  };
}

/**
 * Check if violations at or above failOn severity exist.
 */
export function hasViolationsAtOrAbove(
  violations: HookViolation[],
  failOn: Severity,
): boolean {
  const severityOrder: Severity[] = ['critical', 'warning', 'suggestion'];
  const failIndex = severityOrder.indexOf(failOn);
  return violations.some((v) => {
    const vIndex = severityOrder.indexOf(v.severity);
    return vIndex >= 0 && vIndex <= failIndex;
  });
}
