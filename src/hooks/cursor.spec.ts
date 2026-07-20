/**
 * Cursor hook adapter tests — piped-fixture verification.
 *
 * Tests the postToolUse → audit → additional_context pipeline with
 * both Cursor native (camelCase) and Claude Code compat (PascalCase) formats.
 *
 * Verification date: 2026-07-20
 * Source: cursor.com/docs/hooks + cursor.com/docs/reference/third-party-hooks
 */

import { describe, it, expect } from 'vitest';
import {
  isWriteOrEdit,
  extractFilePath,
  formatViolationContext,
  processCursorEvent,
} from './cursor.js';
import type { CursorPostToolUse, CursorHookResult } from './cursor.js';
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

// ---------------------------------------------------------------------------
// isWriteOrEdit
// ---------------------------------------------------------------------------
describe('isWriteOrEdit', () => {
  it('detects Cursor native Write (camelCase)', () => {
    expect(isWriteOrEdit({ tool_name: 'Write' })).toBe(true);
  });

  it('detects Cursor native write (lowercase)', () => {
    expect(isWriteOrEdit({ tool_name: 'write' })).toBe(true);
  });

  it('detects Claude Code compat Edit (PascalCase)', () => {
    expect(isWriteOrEdit({ toolName: 'Edit' })).toBe(true);
  });

  it('detects Claude Code compat edit (lowercase)', () => {
    expect(isWriteOrEdit({ toolName: 'edit' })).toBe(true);
  });

  it('rejects non-edit tools (Bash/Shell)', () => {
    expect(isWriteOrEdit({ tool_name: 'Bash' })).toBe(false);
    expect(isWriteOrEdit({ toolName: 'Shell' })).toBe(false);
  });

  it('rejects non-edit tools (Read)', () => {
    expect(isWriteOrEdit({ tool_name: 'Read' })).toBe(false);
  });

  it('returns false for empty tool name', () => {
    expect(isWriteOrEdit({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractFilePath
// ---------------------------------------------------------------------------
describe('extractFilePath', () => {
  it('extracts file_path from Cursor native tool_input (camelCase)', () => {
    const event: CursorPostToolUse = {
      tool_name: 'Write',
      tool_input: { file_path: 'src/index.ts' },
    };
    expect(extractFilePath(event)).toBe('src/index.ts');
  });

  it('extracts file_path from Claude Code compat toolInput (PascalCase)', () => {
    const event: CursorPostToolUse = {
      toolName: 'Edit',
      toolInput: { file_path: 'lib/utils.go' },
    };
    expect(extractFilePath(event)).toBe('lib/utils.go');
  });

  it('returns null when tool_input is missing', () => {
    expect(extractFilePath({ tool_name: 'Write' })).toBeNull();
  });

  it('returns null when file_path is not a string', () => {
    const event: CursorPostToolUse = {
      tool_name: 'Write',
      tool_input: { file_path: 123 as unknown as string },
    };
    expect(extractFilePath(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatViolationContext
// ---------------------------------------------------------------------------
describe('formatViolationContext', () => {
  it('returns blocking context for critical violations', () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'critical', message: 'SQL injection risk', file: 'src/db.ts', line: 42 }),
      ],
      summary: { total: 1, critical: 1, warning: 0, suggestion: 0 },
    });
    const result = formatViolationContext(output);
    expect(result.isBlocking).toBe(true);
    expect(result.context).toContain('critical violation');
    expect(result.context).toContain('SQL injection risk');
    expect(result.context).toContain('src/db.ts:42');
    expect(result.context).toContain('edit has been blocked');
  });

  it('returns advisory context for warnings only (not blocking)', () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'warning', message: 'Function too long', file: 'src/foo.ts', line: 10 }),
      ],
      summary: { total: 1, critical: 0, warning: 1, suggestion: 0 },
    });
    const result = formatViolationContext(output);
    expect(result.isBlocking).toBe(false);
    expect(result.context).toContain('Code Auditor notes');
    expect(result.context).toContain('warning');
    expect(result.context).not.toContain('blocked');
  });

  it('returns empty context for no violations', () => {
    const output = makeAuditOutput({
      violations: [],
      summary: { total: 0, critical: 0, warning: 0, suggestion: 0 },
    });
    const result = formatViolationContext(output);
    expect(result.context).toBe('');
    expect(result.isBlocking).toBe(false);
  });

  it('includes suggestion count in blocking context when mixed', () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'critical', message: 'XSS risk', file: 'src/view.ts' }),
        makeViolation({ severity: 'warning', message: 'Missing doc', file: 'src/other.ts' }),
        makeViolation({ severity: 'suggestion', message: 'Use const', file: 'src/other.ts' }),
      ],
      summary: { total: 3, critical: 1, warning: 1, suggestion: 1 },
    });
    const result = formatViolationContext(output);
    expect(result.isBlocking).toBe(true);
    expect(result.context).toContain('1 warning(s), 1 suggestion(s)');
  });
});

// ---------------------------------------------------------------------------
// processCursorEvent — integration tests with mocked audit
// ---------------------------------------------------------------------------
describe('processCursorEvent', () => {
  const mockAudit = (output: HookAuditOutput) =>
    async (_paths: string[], _root: string): Promise<HookAuditOutput> => output;

  it('returns exitCode 0 for empty stdin', async () => {
    const result = await processCursorEvent('', mockAudit(makeAuditOutput()));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('returns exitCode 0 for non-write tool (Bash)', async () => {
    const event = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    const result = await processCursorEvent(event, mockAudit(makeAuditOutput()));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('returns exitCode 0 for invalid JSON (never wedge the agent)', async () => {
    const result = await processCursorEvent('not json', mockAudit(makeAuditOutput()));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Failed to parse stdin JSON');
  });

  it('returns exitCode 0 for Write event with no file_path', async () => {
    const event = JSON.stringify({ tool_name: 'Write', tool_input: {} });
    const result = await processCursorEvent(event, mockAudit(makeAuditOutput()));
    expect(result.exitCode).toBe(0);
  });

  it('returns exitCode 2 with additional_context on critical violations', async () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'critical', message: 'Broken invariant', file: 'src/bad.ts', line: 5 }),
      ],
      summary: { total: 1, critical: 1, warning: 0, suggestion: 0 },
    });
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'src/bad.ts' },
      cwd: '/tmp/test-project',
    });

    const result = await processCursorEvent(event, mockAudit(output));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBeTruthy();

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('additional_context');
    expect(parsed.additional_context).toContain('Broken invariant');
    expect(parsed.additional_context).toContain('blocked');
  });

  it('handles Claude Code compat PascalCase format with critical violations', async () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'critical', message: 'Security risk', file: 'src/auth.ts' }),
      ],
      summary: { total: 1, critical: 1, warning: 0, suggestion: 0 },
    });
    const event = JSON.stringify({
      toolName: 'Edit',
      toolInput: { file_path: 'src/auth.ts' },
    });

    const result = await processCursorEvent(event, mockAudit(output));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('additional_context');
  });

  it('returns exitCode 0 with advisory notes for warnings only', async () => {
    const output = makeAuditOutput({
      violations: [
        makeViolation({ severity: 'warning', message: 'Missing JSDoc', file: 'src/utils.ts' }),
      ],
      summary: { total: 1, critical: 0, warning: 1, suggestion: 0 },
    });
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'src/utils.ts' },
    });

    const result = await processCursorEvent(event, mockAudit(output));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('additional_context');
    expect(result.stdout).toContain('Code Auditor notes');
  });

  it('returns exitCode 0 with no stdout for clean audit', async () => {
    const output = makeAuditOutput({
      violations: [],
      summary: { total: 0, critical: 0, warning: 0, suggestion: 0 },
    });
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'src/clean.ts' },
    });

    const result = await processCursorEvent(event, mockAudit(output));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('does not wedge on audit function throwing', async () => {
    const throwingAudit = async (): Promise<HookAuditOutput> => {
      throw new Error('Simulated audit failure');
    };
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'src/foo.ts' },
    });

    const result = await processCursorEvent(event, throwingAudit);
    expect(result.exitCode).toBe(0); // Never wedge the agent
    expect(result.stderr).toContain('Simulated audit failure');
    expect(result.stdout).toBe('');
  });

  it('uses cwd from event as project root', async () => {
    let capturedRoot = '';
    const auditSpy = async (paths: string[], root: string): Promise<HookAuditOutput> => {
      capturedRoot = root;
      return makeAuditOutput({ violations: [], summary: { total: 0, critical: 0, warning: 0, suggestion: 0 } });
    };
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'src/foo.ts' },
      cwd: '/custom/project',
    });

    const result = await processCursorEvent(event, auditSpy);
    expect(result.exitCode).toBe(0);
    expect(capturedRoot).toBe('/custom/project');
  });
});
