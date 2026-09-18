/**
 * Spec 57 — dismissals store fix contract.
 *
 *   - **positive**  — a dismissal whose fingerprint matches a finding clears
 *     that one finding (and only that one).
 *   - **near-miss** — a dismissal is scoped to the finding: same rule, different
 *     symbol/file does NOT match.
 *   - **guard**     — a hand-written entry missing a `reason` is rejected (config
 *     error, not a suppression).
 *   - **absence**   — no dismissals file is not an error; zero dismissals.
 *
 * The module is pure (no parser init); `applyDismissals` marks `dismissed` on
 * violations and records `summary.dismissed` without touching
 * `summary.totalViolations` — the total is never silently reduced.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDismissalEntry,
  loadDismissals,
  saveDismissals,
  upsertDismissal,
  matchDismissals,
  applyDismissals,
} from './dismissals.js';
import type { DismissalsFile, DismissalEntry } from './dismissals.js';
import { fingerprint, buildFingerprintInput } from './fingerprint.js';
import type { AuditResult, Violation } from './types.js';

const TOOL_VERSION = '0.0.0-test';

/** A violation with a distinct rule/file/symbol for fingerprint identity. */
function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    file: 'src/foo.ts',
    rule: 'loop-query',
    severity: 'critical',
    message: 'loop-query on foo',
    analyzer: 'data-access',
    symbol: 'handler',
    ...overrides,
  };
}

function dismissals(entries: DismissalEntry[]): DismissalsFile {
  return { schemaVersion: 1, entries };
}

let dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ca-dismiss-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('buildDismissalEntry', () => {
  it('produces the same fingerprint the finding itself resolves to', () => {
    const v = violation();
    const entry = buildDismissalEntry(v, 'generated code', TOOL_VERSION);
    expect(entry.fingerprint).toBe(fingerprint(buildFingerprintInput(v)));
    expect(entry.rule).toBe('loop-query');
    expect(entry.symbol).toBe('handler');
    expect(entry.reason).toBe('generated code');
    expect(entry.toolVersion).toBe(TOOL_VERSION);
    expect(entry.dismissedAt).toBeTruthy();
  });
});

describe('matchDismissals', () => {
  it('positive — a matching dismissal clears exactly that finding', () => {
    const v1 = violation({ symbol: 'handler' });
    const v2 = violation({ symbol: 'otherHandler' });
    const file = dismissals([buildDismissalEntry(v1, 'generated', TOOL_VERSION)]);
    const { dismissed, active } = matchDismissals([v1, v2], file);
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0].symbol).toBe('handler');
    expect(active).toHaveLength(1);
    expect(active[0].symbol).toBe('otherHandler');
  });

  it('near-miss — scoped to the finding: same rule, different symbol does not match', () => {
    const v1 = violation({ symbol: 'handler' });
    const v2 = violation({ symbol: 'handler', file: 'src/other.ts' });
    const file = dismissals([buildDismissalEntry(v1, 'generated', TOOL_VERSION)]);
    const { dismissed, active } = matchDismissals([v2], file);
    expect(dismissed).toHaveLength(0);
    expect(active).toHaveLength(1);
  });
});

describe('loadDismissals', () => {
  it('absence — no file is null, not an error', () => {
    expect(loadDismissals(scratch())).toBeNull();
  });

  it('guard — a hand-written entry missing a reason is rejected (config error)', () => {
    const dir = scratch();
    const bad = dismissals([
      { fingerprint: 'abc', rule: 'loop-query', file: 'src/foo.ts', symbol: 'handler', reason: '', dismissedAt: 'x', toolVersion: '0' },
    ]);
    writeFileSync(join(dir, '.codeauditor.dismissals.json'), JSON.stringify(bad), 'utf-8');
    expect(loadDismissals(dir)).toBeNull();
  });

  it('round-trips a valid file', () => {
    const dir = scratch();
    const file = dismissals([buildDismissalEntry(violation(), 'generated', TOOL_VERSION)]);
    saveDismissals(dir, file);
    const loaded = loadDismissals(dir);
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.entries[0].reason).toBe('generated');
  });
});

describe('upsertDismissal', () => {
  it('is idempotent — re-dismissing the same fingerprint updates the reason, no duplicate', () => {
    const dir = scratch();
    const v = violation();
    upsertDismissal(dir, buildDismissalEntry(v, 'first reason', TOOL_VERSION));
    upsertDismissal(dir, buildDismissalEntry(v, 'second reason', TOOL_VERSION));
    const loaded = loadDismissals(dir);
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.entries[0].reason).toBe('second reason');
  });
});

describe('applyDismissals', () => {
  function resultFor(violations: Violation[]): AuditResult {
    return {
      timestamp: new Date(),
      summary: {
        totalFiles: 1,
        totalViolations: violations.length,
        criticalIssues: violations.filter((v) => v.severity === 'critical').length,
        severe: 0,
        advisory: 0,
        violationsByCategory: {},
        topIssues: [],
      },
      analyzerResults: { 'data-access': { violations, executionTime: 0, status: { status: 'visitor-ran', filesProcessed: 1 }, analyzerName: 'data-access' } },
      recommendations: [],
      metadata: { auditDuration: 0, filesAnalyzed: 1, analyzersRun: ['data-access'] },
    };
  }

  it('marks dismissed findings, records the count, and never reduces the total', () => {
    const dir = scratch();
    const v1 = violation({ symbol: 'handler' });
    const v2 = violation({ symbol: 'other' });
    const v3 = violation({ symbol: 'alsoDismissed' });
    upsertDismissal(dir, buildDismissalEntry(v1, 'generated', TOOL_VERSION));
    upsertDismissal(dir, buildDismissalEntry(v3, 'also generated', TOOL_VERSION));

    const result = resultFor([v1, v2, v3]);
    applyDismissals(result, dir);

    expect(result.summary.totalViolations).toBe(3);
    expect(result.summary.dismissed).toBe(2);

    const bySymbol = Object.fromEntries(
      Object.values(result.analyzerResults)
        .flatMap((r) => r.violations)
        .map((v) => [v.symbol, v.dismissed]),
    );
    expect(bySymbol.handler).toBe(true);
    expect(bySymbol.alsoDismissed).toBe(true);
    expect(bySymbol.other).toBeUndefined();
  });
});
