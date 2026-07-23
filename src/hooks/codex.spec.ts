/**
 * Codex hook adapter tests — piped-fixture verification.
 *
 * Tests the PostToolUse → audit → feedback pipeline for OpenAI Codex CLI.
 *
 * Verification date: 2026-07-20
 * Source: learn.chatgpt.com/docs/hooks
 */

import { describe, it, expect } from 'vitest';
import {
  formatCodexFeedback,
  processCodexEvent,
} from './codex.js';
import type { CodexPostToolUse, CodexHookResult } from './codex.js';
import type { HookAuditOutput, HookViolation } from './core.js';

function makeViolation(overrides: Partial<HookViolation> = {}): HookViolation {
  return {
    analyzer: 'test',
    rule: 'test-rule',
    severity: 'critical',
    message: 'Test violation',
    file: 'src/test.ts',
    line: 10,
    column: 1,
    ...overrides,
  };
}

function makeAuditOutput(overrides: Partial<HookAuditOutput> = {}): HookAuditOutput {
  return {
    violations: [makeViolation()],
    summary: { total: 1, critical: 1, warning: 0, suggestion: 0 },
    filesAnalyzed: 1,
    ...overrides,
  };
}

function makeRawEvent(overrides: Partial<CodexPostToolUse> = {}): string {
  return JSON.stringify({
    tool_name: 'apply_patch',
    tool_input: { file_path: 'src/test.ts' },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// formatCodexFeedback
// ---------------------------------------------------------------------------
describe('formatCodexFeedback', () => {
  it('returns blocking feedback for critical violations', () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'critical', message: 'SQL injection risk', file: 'src/db.ts', line: 42 }),
      ],
      summary: { total: 1, critical: 1, warning: 0, suggestion: 0 },
    });
    const { feedback, isBlocking } = formatCodexFeedback(output);
    expect(isBlocking).toBe(true);
    expect(feedback).toBeTruthy();
    expect(feedback!.decision).toBe('block');
    expect(feedback!.reason).toContain('1 critical violation');
    const violations = feedback!.violations as Array<Record<string, unknown>>;
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toBe('SQL injection risk');
    expect(violations[0].file).toBe('src/db.ts');
  });

  it('returns advisory feedback for warnings only (not blocking)', () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'warning', message: 'Function too long', file: 'src/foo.ts', line: 10 }),
      ],
      summary: { total: 1, critical: 0, warning: 1, suggestion: 0 },
    });
    const { feedback, isBlocking } = formatCodexFeedback(output);
    expect(isBlocking).toBe(false);
    expect(feedback).toBeTruthy();
    expect(feedback!.decision).toBe('allow');
    const warnings = feedback!.warnings as Array<Record<string, unknown>>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe('Function too long');
  });

  it('returns null feedback for clean audit', () => {
    const output = makeAuditOutput({
      violations: [],
      summary: { total: 0, critical: 0, warning: 0, suggestion: 0 },
    });
    const { feedback, isBlocking } = formatCodexFeedback(output);
    expect(feedback).toBeNull();
    expect(isBlocking).toBe(false);
  });

  it('returns null for suggestion-only violations', () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'suggestion', message: 'Use const', file: 'src/foo.ts' }),
      ],
      summary: { total: 1, critical: 0, warning: 0, suggestion: 1 },
    });
    const { feedback, isBlocking } = formatCodexFeedback(output);
    expect(feedback).toBeNull();
    expect(isBlocking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processCodexEvent
// ---------------------------------------------------------------------------
describe('processCodexEvent', () => {
  const mockAudit = (output: HookAuditOutput) =>
    async (_paths: string[], _root: string): Promise<HookAuditOutput> => output;

  it('returns exitCode 0 for empty stdin', async () => {
    const result = await processCodexEvent('', mockAudit(makeAuditOutput()));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('returns exitCode 0 for invalid JSON (never wedge the agent)', async () => {
    const result = await processCodexEvent('not json', mockAudit(makeAuditOutput()));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Failed to parse stdin JSON');
  });

  it('returns exitCode 0 for event with no file_path', async () => {
    const event = JSON.stringify({ tool_name: 'apply_patch', tool_input: {} });
    const result = await processCodexEvent(event, mockAudit(makeAuditOutput()));
    expect(result.exitCode).toBe(0);
  });

  it('returns exitCode 2 with block feedback on critical violations', async () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'critical', message: 'Broken invariant', file: 'src/bad.ts', line: 5 }),
      ],
      summary: { total: 1, critical: 1, warning: 0, suggestion: 0 },
    });
    const event = makeRawEvent({ tool_input: { file_path: 'src/bad.ts' } });

    const result = await processCodexEvent(event, mockAudit(output));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBeTruthy();

    const parsed = JSON.parse(result.stdout);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('critical violation');
  });

  it('returns exitCode 0 with advisory for warnings only', async () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'warning', message: 'Missing JSDoc', file: 'src/utils.ts' }),
      ],
      summary: { total: 1, critical: 0, warning: 1, suggestion: 0 },
    });
    const event = makeRawEvent({ tool_input: { file_path: 'src/utils.ts' } });

    const result = await processCodexEvent(event, mockAudit(output));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('allow');
    expect(result.stdout).toContain('Missing JSDoc');
  });

  it('returns exitCode 0 with empty stdout for clean audit', async () => {
    const output = makeAuditOutput({
      violations: [],
      summary: { total: 0, critical: 0, warning: 0, suggestion: 0 },
    });
    const event = makeRawEvent({ tool_input: { file_path: 'src/clean.ts' } });

    const result = await processCodexEvent(event, mockAudit(output));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('does not wedge on audit function throwing', async () => {
    const throwingAudit = async (): Promise<HookAuditOutput> => {
      throw new Error('Simulated audit failure');
    };
    const event = makeRawEvent({ tool_input: { file_path: 'src/foo.ts' } });

    const result = await processCodexEvent(event, throwingAudit);
    expect(result.exitCode).toBe(0); // Never wedge the agent
    expect(result.stderr).toContain('Simulated audit failure');
    expect(result.stdout).toBe('');
  });

  // ── Foreign cwd tests ──────────────────────────────────────────────────
  it('uses CLAUDE_PROJECT_DIR as project root when set (foreign cwd)', async () => {
    let capturedRoot = '';
    const auditSpy = async (paths: string[], root: string): Promise<HookAuditOutput> => {
      capturedRoot = root;
      return makeAuditOutput({ violations: [], summary: { total: 0, critical: 0, warning: 0, suggestion: 0 } });
    };
    const resolveRoot = (_event: CodexPostToolUse) => '/real/project';
    const event = makeRawEvent({ tool_input: { file_path: 'src/foo.ts' } });

    const result = await processCodexEvent(event, auditSpy, resolveRoot);
    expect(result.exitCode).toBe(0);
    expect(capturedRoot).toBe('/real/project');
  });

  it('falls back to cwd when CLAUDE_PROJECT_DIR is unset', async () => {
    let capturedRoot = '';
    const auditSpy = async (paths: string[], root: string): Promise<HookAuditOutput> => {
      capturedRoot = root;
      return makeAuditOutput({ violations: [], summary: { total: 0, critical: 0, warning: 0, suggestion: 0 } });
    };
    // Simulate neither CLAUDE_PROJECT_DIR nor special cwd — just process.cwd()
    const resolveRoot = (_event: CodexPostToolUse) => process.cwd();
    const event = makeRawEvent({ tool_input: { file_path: 'src/bar.ts' } });

    const result = await processCodexEvent(event, auditSpy, resolveRoot);
    expect(result.exitCode).toBe(0);
    expect(capturedRoot).toBe(process.cwd());
  });

  it('uses tool_input.path as fallback when file_path absent', async () => {
    let capturedPath = '';
    const auditSpy = async (paths: string[], _root: string): Promise<HookAuditOutput> => {
      capturedPath = paths[0];
      return makeAuditOutput({ violations: [], summary: { total: 0, critical: 0, warning: 0, suggestion: 0 } });
    };
    const event = JSON.stringify({
      tool_name: 'apply_patch',
      tool_input: { path: 'lib/utils.go' },
    });

    const result = await processCodexEvent(event, auditSpy);
    expect(result.exitCode).toBe(0);
    expect(capturedPath).toBe('lib/utils.go');
  });

  // ── Payload-first root resolution ──────────────────────────────────────
  it('uses event.cwd as project root (Codex native payload, no env set)', async () => {
    let capturedRoot = '';
    const auditSpy = async (_paths: string[], root: string): Promise<HookAuditOutput> => {
      capturedRoot = root;
      return makeAuditOutput({ violations: [], summary: { total: 0, critical: 0, warning: 0, suggestion: 0 } });
    };
    // Codex payload with cwd set, no CLAUDE_PROJECT_DIR in environment
    const event = makeRawEvent({
      cwd: '/home/user/my-codex-project',
      tool_input: { file_path: 'src/app.ts' },
    });

    const result = await processCodexEvent(event, auditSpy);
    expect(result.exitCode).toBe(0);
    expect(capturedRoot).toBe('/home/user/my-codex-project');
  });

  it('falls back CLAUDE_PROJECT_DIR when event has no cwd', async () => {
    let capturedRoot = '';
    const auditSpy = async (_paths: string[], root: string): Promise<HookAuditOutput> => {
      capturedRoot = root;
      return makeAuditOutput({ violations: [], summary: { total: 0, critical: 0, warning: 0, suggestion: 0 } });
    };
    // Inject resolveRoot that simulates CLAUDE_PROJECT_DIR set but no event.cwd
    const resolveRoot = (_event: CodexPostToolUse) => '/claude/compat/project';
    const event = makeRawEvent({ tool_input: { file_path: 'src/foo.ts' } });
    // event has no cwd field — fallback hits CLAUDE_PROJECT_DIR

    const result = await processCodexEvent(event, auditSpy, resolveRoot);
    expect(result.exitCode).toBe(0);
    expect(capturedRoot).toBe('/claude/compat/project');
  });

  it('uses process.cwd() as last resort (no cwd, no env)', async () => {
    let capturedRoot = '';
    const auditSpy = async (_paths: string[], root: string): Promise<HookAuditOutput> => {
      capturedRoot = root;
      return makeAuditOutput({ violations: [], summary: { total: 0, critical: 0, warning: 0, suggestion: 0 } });
    };
    const resolveRoot = (_event: CodexPostToolUse) => process.cwd();
    const event = makeRawEvent({ tool_input: { file_path: 'src/bar.ts' } });

    const result = await processCodexEvent(event, auditSpy, resolveRoot);
    expect(result.exitCode).toBe(0);
    expect(capturedRoot).toBe(process.cwd());
  });
});
