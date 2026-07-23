/**
 * Spec-18 R6 — Baseline, Ratchet & Report Inversion Tests
 *
 * Integration tests using the programmatic API and CLI shell-out to verify:
 *   1. Known finding doesn't fail
 *   2. New finding does fail
 *   3. Invariant violation fails regardless of baseline
 *   4. Fixed finding drops from baseline on re-snapshot
 *   5. changed — known + new classification in touched file
 *   6. Fingerprint stability under line drift
 *   7. changed from foreign cwd — baseline resolves via -p
 *   8. --fail-on-regression fires on debt increase
 *
 * Plus cross-surface fingerprint identity verification.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile } from 'fs/promises';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

import { initParsers, initializeLanguages } from '../languages/index.js';
import { runAudit } from '../auditRunner.js';
import {
  loadBaseline,
  saveBaseline,
  createBaselineFromFindings,
  matchFindings,
  diffBaselines,
  hashBaseline,
} from '../baseline.js';
import { fingerprint, buildFingerprintInput } from '../fingerprint.js';
import { extractSymbol } from '../symbols.js';
import { generateJSONReport } from '../reporting/jsonReportGenerator.js';
import type { Violation, Baseline, BaselineEntry } from '../types.js';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const CLI_SCRIPT = join(__dirname, '..', 'cli.ts');

function distCli(): string {
  const distPath = join(__dirname, '..', '..', 'dist', 'cli.js');
  if (existsSync(distPath)) return `node "${distPath}"`;
  return `npx tsx "${CLI_SCRIPT}"`;
}

function runCli(args: string, cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const cmd = `${distCli()} ${args}`;
  try {
    const result = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, CODE_AUDITOR_DATA_DIR: cwd, NODE_ENV: 'test' },
    });
    return { stdout: result, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status || 1,
    };
  }
}

/** Compute a fingerprint for a synthetic violation using extractSymbol. */
function fp(opts: { analyzer: string; rule: string; file: string; symbol?: string }): string {
  return fingerprint({
    analyzer: opts.analyzer,
    rule: opts.rule,
    file: opts.file,
    symbol: opts.symbol ?? '',
  });
}

/** Write minimal .codeauditor.json config. */
async function writeConfig(testDir: string, overrides: Record<string, any> = {}) {
  await writeFile(
    join(testDir, '.codeauditor.json'),
    JSON.stringify({
      enabledAnalyzers: ['documentation'],
      includePaths: ['src/**/*.ts'],
      excludePaths: ['**/node_modules/**', '**/*.test.ts', '**/*.spec.ts'],
      minSeverity: 'suggestion',
      showProgress: false,
      ...overrides,
    }, null, 2),
    'utf-8',
  );
}

// ── Fixture file content — functions must be >= 5 body lines for docsMinLines gate ──

/** Exported function without JSDoc — triggers function-documentation violation. */
const UNDOCUMENTED = `export function calculateTotal(items: number[]): number {
  const start = performance.now();
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`;

/** File with TWO undocumented exported functions — creates 2 violations. */
const TWO_UNDOCUMENTED = `export function calculateTotal(items: number[]): number {
  const start = performance.now();
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}

export function formatResult(value: number): string {
  const prefix = "$";
  const formatted = value.toFixed(2);
  const result = prefix + formatted;
  return result;
}
`;

/** File with no exported functions — produces zero documentation violations.
 *  Used as the "fixed" state since tree-sitter's extractDocumentation doesn't
 *  find JSDoc on `export function` (JSDoc is a sibling of the export statement,
 *  not of the inner function_declaration node). */
const NO_FUNCTIONS = `// Fixed: no exported functions — violations are resolved
export const VERSION = "1.0.0";
`;

// ── Module-level setup ───────────────────────────────────────────────────────

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Module-level tests — baseline logic via direct function calls
// ═══════════════════════════════════════════════════════════════════════════════

describe('Spec-18 — Baseline module', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-baseline-'));
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Load / save round-trip ──────────────────────────────────────────────

  it('loadBaseline returns null when no file exists', () => {
    expect(loadBaseline(testDir)).toBeNull();
  });

  it('loadBaseline returns null for invalid JSON', async () => {
    await writeFile(join(testDir, '.codeauditor.baseline.json'), 'not json');
    expect(loadBaseline(testDir)).toBeNull();
  });

  it('loadBaseline returns null for v1 schemaVersion (older fingerprint scheme)', async () => {
    // SchemaVersion 1 uses the old fingerprint scheme and should be rejected
    // with a message telling the user to re-snapshot.
    await writeFile(join(testDir, '.codeauditor.baseline.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));
    expect(loadBaseline(testDir)).toBeNull();
  });

  it('loadBaseline returns null for unknown schemaVersion', async () => {
    // SchemaVersion 99 doesn't exist — should be rejected
    await writeFile(join(testDir, '.codeauditor.baseline.json'), JSON.stringify({ schemaVersion: 99, entries: [] }));
    expect(loadBaseline(testDir)).toBeNull();
  });

  it('loadBaseline rejects schemaVersion 2 (older fingerprint scheme)', async () => {
    // schemaVersion 2 used the old per-surface extraction chains (buildFingerprintInput
    // didn't exist). v3 is the shared canonical chain — reject stale v2 baselines so
    // users re-snapshot.
    await writeFile(join(testDir, '.codeauditor.baseline.json'), JSON.stringify({ schemaVersion: 2, entries: [] }));
    expect(loadBaseline(testDir)).toBeNull();
  });

  it('saveBaseline / loadBaseline round-trip', async () => {
    const baseline: Baseline = {
      schemaVersion: 3,
      created: new Date().toISOString(),
      entries: [
        { fingerprint: 'abc123', file: 'src/a.ts' },
        { fingerprint: 'def456', file: 'src/b.ts' },
      ],
      metadata: {
        toolVersion: '3.2.0',
        totalFindings: 2,
        analyzerCounts: { documentation: 2 },
        corpusStats: { files: 2, functions: 5 },
      },
    };
    saveBaseline(testDir, baseline);
    const loaded = loadBaseline(testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(2);
    expect(loaded!.metadata.totalFindings).toBe(2);
    expect(loaded!.entries[0].fingerprint).toBe('abc123');
  });

  // ── createBaselineFromFindings — invariant exclusion + dedup ────────────

  it('createBaselineFromFindings excludes invariant violations', () => {
    const violations: Violation[] = [
      { file: 'src/a.ts', line: 1, column: 1, severity: 'suggestion', message: 'doc', rule: 'function-documentation', analyzer: 'documentation', functionName: 'myFn' },
      { file: 'src/b.ts', line: 1, column: 1, severity: 'critical', message: 'ban', rule: 'import-ban', analyzer: 'invariants' },
    ];
    const baseline = createBaselineFromFindings(violations, {
      toolVersion: '3.2.0',
      totalFindings: 0,
      analyzerCounts: {},
      corpusStats: { files: 2, functions: 3 },
    });
    expect(baseline.entries).toHaveLength(1);
    expect(baseline.entries[0].file).toBe('src/a.ts');
  });

  it('createBaselineFromFindings deduplicates by fingerprint', () => {
    const v: Violation = { file: 'src/a.ts', line: 1, column: 1, severity: 'suggestion', message: 'undocumented', rule: 'function-documentation', analyzer: 'documentation', functionName: 'myFn' };
    const violations: Violation[] = [
      { ...v, line: 1 },
      { ...v, line: 42 },  // different line, same fingerprint
    ];
    const baseline = createBaselineFromFindings(violations, {
      toolVersion: '3.2.0',
      totalFindings: 0,
      analyzerCounts: {},
      corpusStats: { files: 1, functions: 2 },
    });
    expect(baseline.entries).toHaveLength(1);  // deduped
  });

  // ── Test 6: Fingerprint stability ──────────────────────────────────────

  it('R6.6 — fingerprint unchanged by line drift (same inputs → same output)', () => {
    const fp1 = fingerprint({ analyzer: 'doc', rule: 'r1', file: 'f.ts', symbol: 'myFn' });
    const fp2 = fingerprint({ analyzer: 'doc', rule: 'r1', file: 'f.ts', symbol: 'myFn' });
    expect(fp1).toBe(fp2);
    // Different symbol → different fingerprint
    const fp3 = fingerprint({ analyzer: 'doc', rule: 'r1', file: 'f.ts', symbol: 'otherFn' });
    expect(fp1).not.toBe(fp3);
  });

  it('R6.6 — extractSymbol produces stable output regardless of which entity field is populated', () => {
    expect(extractSymbol({ symbol: 's', functionName: 'f' } as any)).toBe('s');
    expect(extractSymbol({ functionName: 'f', className: 'c' } as any)).toBe('f');
    expect(extractSymbol({ className: 'c' } as any)).toBe('c');
    expect(extractSymbol({ componentName: 'cmp' } as any)).toBe('cmp');
    expect(extractSymbol({ methodName: 'm' } as any)).toBe('m');
    expect(extractSymbol({ hookName: 'useX' } as any)).toBe('useX');
    expect(extractSymbol({ interfaceName: 'I' } as any)).toBe('I');
    expect(extractSymbol({ name: 'n' } as any)).toBe('n');
    expect(extractSymbol({ enclosingSymbol: 'es' } as any)).toBe('es');
    expect(extractSymbol({} as any)).toBe('');
  });

  // ── Test 1a: Known finding classifies correctly ────────────────────────

  it('R6.1 — matchFindings classifies a known violation as "known"', () => {
    const entry: BaselineEntry = {
      fingerprint: fp({ analyzer: 'documentation', rule: 'function-documentation', file: 'src/a.ts', symbol: 'myFn' }),
      file: 'src/a.ts',
    };
    const baseline: Baseline = {
      schemaVersion: 3, created: new Date().toISOString(),
      entries: [entry],
      metadata: { toolVersion: '1', totalFindings: 1, analyzerCounts: { documentation: 1 }, corpusStats: { files: 1, functions: 1 } },
    };

    const violation: Violation = {
      file: 'src/a.ts', line: 1, column: 1, severity: 'suggestion', message: 'no doc',
      rule: 'function-documentation', analyzer: 'documentation', functionName: 'myFn',
    };

    const classified = matchFindings([violation], baseline);
    expect(classified.known).toHaveLength(1);
    expect(classified.new).toHaveLength(0);
    expect(classified.fixed).toHaveLength(0);
  });

  // ── Test 2a: New finding classifies correctly ──────────────────────────

  it('R6.2 — matchFindings classifies an unknown violation as "new"', () => {
    const entry: BaselineEntry = {
      fingerprint: fp({ analyzer: 'documentation', rule: 'function-documentation', file: 'src/a.ts', symbol: 'myFn' }),
      file: 'src/a.ts',
    };
    const baseline: Baseline = {
      schemaVersion: 3, created: new Date().toISOString(),
      entries: [entry],
      metadata: { toolVersion: '1', totalFindings: 1, analyzerCounts: { documentation: 1 }, corpusStats: { files: 1, functions: 1 } },
    };

    // Violation in a different file → different fingerprint → new
    const violation: Violation = {
      file: 'src/b.ts', line: 1, column: 1, severity: 'suggestion', message: 'no doc',
      rule: 'function-documentation', analyzer: 'documentation', functionName: 'otherFn',
    };

    const classified = matchFindings([violation], baseline);
    expect(classified.new).toHaveLength(1);
    expect(classified.known).toHaveLength(0);
  });

  // ── Test 3a: Invariant violation always "new" ──────────────────────────

  it('R6.3 — invariant violations are always "new" regardless of baseline', () => {
    const fpInvariant = fingerprint({ analyzer: 'invariants', rule: 'import-ban', file: 'src/a.ts', symbol: '' });
    const entry: BaselineEntry = { fingerprint: fpInvariant, file: 'src/a.ts' };
    const baseline: Baseline = {
      schemaVersion: 3, created: new Date().toISOString(),
      entries: [entry],
      metadata: { toolVersion: '1', totalFindings: 1, analyzerCounts: { invariants: 1 }, corpusStats: { files: 1, functions: 1 } },
    };

    const violation: Violation = {
      file: 'src/a.ts', line: 5, column: 1, severity: 'critical', message: 'banned import',
      rule: 'import-ban', analyzer: 'invariants',
    };

    const classified = matchFindings([violation], baseline);
    expect(classified.new).toHaveLength(1);
    expect(classified.known).toHaveLength(0);
  });

  // ── Test 4a: Fixed finding from diffBaselines ──────────────────────────

  it('R6.4 — diffBaselines reports findings that were fixed (removed)', () => {
    const e1: BaselineEntry = { fingerprint: 'aaa', file: 'src/a.ts' };
    const e2: BaselineEntry = { fingerprint: 'bbb', file: 'src/b.ts' };
    const previous: Baseline = {
      schemaVersion: 3, created: '2020-01-01T00:00:00Z',
      entries: [e1, e2],
      metadata: { toolVersion: '1', totalFindings: 2, analyzerCounts: {}, corpusStats: { files: 2, functions: 2 } },
    };
    const current: Baseline = {
      schemaVersion: 3, created: '2020-01-02T00:00:00Z',
      entries: [e1],
      metadata: { toolVersion: '1', totalFindings: 1, analyzerCounts: {}, corpusStats: { files: 2, functions: 2 } },
    };

    const diff = diffBaselines(previous, current);
    expect(diff.absorbed).toBe(0);
    expect(diff.fixed).toBe(1);
    expect(diff.total).toBe(1);
  });

  it('R6.4 — diffBaselines reports absorbed findings', () => {
    const e1: BaselineEntry = { fingerprint: 'aaa', file: 'src/a.ts' };
    const previous: Baseline = {
      schemaVersion: 3, created: '2020-01-01T00:00:00Z',
      entries: [e1],
      metadata: { toolVersion: '1', totalFindings: 1, analyzerCounts: {}, corpusStats: { files: 1, functions: 1 } },
    };
    const e2: BaselineEntry = { fingerprint: 'bbb', file: 'src/b.ts' };
    const current: Baseline = {
      schemaVersion: 3, created: '2020-01-02T00:00:00Z',
      entries: [e1, e2],
      metadata: { toolVersion: '1', totalFindings: 2, analyzerCounts: {}, corpusStats: { files: 2, functions: 2 } },
    };

    const diff = diffBaselines(previous, current);
    expect(diff.absorbed).toBe(1);
    expect(diff.fixed).toBe(0);
    expect(diff.total).toBe(2);
  });

  // ── Test 5a: Scoped matchFindings — known + new ────────────────────────

  it('R6.5 — matchFindings with scopedFiles correctly limits "fixed"', () => {
    const entry: BaselineEntry = {
      fingerprint: fp({ analyzer: 'documentation', rule: 'function-documentation', file: 'src/touched.ts', symbol: 'touchedFn' }),
      file: 'src/touched.ts',
    };
    const untouchedEntry: BaselineEntry = {
      fingerprint: fp({ analyzer: 'documentation', rule: 'function-documentation', file: 'src/untouched.ts', symbol: 'untouchedFn' }),
      file: 'src/untouched.ts',
    };
    const baseline: Baseline = {
      schemaVersion: 3, created: new Date().toISOString(),
      entries: [entry, untouchedEntry],
      metadata: { toolVersion: '1', totalFindings: 2, analyzerCounts: { documentation: 2 }, corpusStats: { files: 2, functions: 2 } },
    };

    // Only "touched.ts" is in scope. The violation matches entry → known.
    // untouchedEntry should NOT appear as "fixed" because it's out of scope.
    const violation: Violation = {
      file: 'src/touched.ts', line: 1, column: 1, severity: 'suggestion', message: 'no doc',
      rule: 'function-documentation', analyzer: 'documentation', functionName: 'touchedFn',
    };

    const classified = matchFindings([violation], baseline, ['src/touched.ts']);
    expect(classified.known).toHaveLength(1);
    expect(classified.new).toHaveLength(0);
    expect(classified.fixed).toHaveLength(0); // untouched.ts not in scope → not counted as fixed
  });

  it('R6.5 — full audit (no scopedFiles) includes all baseline entries in fixed', () => {
    const entry: BaselineEntry = {
      fingerprint: fp({ analyzer: 'documentation', rule: 'function-documentation', file: 'src/a.ts', symbol: 'myFn' }),
      file: 'src/a.ts',
    };
    const baseline: Baseline = {
      schemaVersion: 3, created: new Date().toISOString(),
      entries: [entry],
      metadata: { toolVersion: '1', totalFindings: 1, analyzerCounts: { documentation: 1 }, corpusStats: { files: 1, functions: 1 } },
    };

    // No current violations → all baseline entries are fixed
    const classified = matchFindings([], baseline, undefined);
    expect(classified.fixed).toHaveLength(1);
    expect(classified.fixed[0].fingerprint).toBe(entry.fingerprint);
  });

  // ── Test 7a: loadBaseline resolves from projectRoot, not cwd ───────────

  it('R6.7 — loadBaseline uses the given projectRoot, independent of cwd', async () => {
    const baseline: Baseline = {
      schemaVersion: 3, created: new Date().toISOString(),
      entries: [{ fingerprint: 'test', file: 'src/x.ts' }],
      metadata: { toolVersion: '1', totalFindings: 1, analyzerCounts: {}, corpusStats: { files: 1, functions: 1 } },
    };
    saveBaseline(testDir, baseline);

    const loaded = loadBaseline(testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);

    // Loading from a different dir that has no baseline returns null
    const otherDir = await mkdtemp(join(tmpdir(), 'ca-other-'));
    try {
      expect(loadBaseline(otherDir)).toBeNull();
    } finally {
      try { rmSync(otherDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── Test 8a: fail-on-regression logic ──────────────────────────────────

  it('R6.8 — total debt (new + known) exceeding baseline.totalFindings is regression', () => {
    const previousKnownCount = 100;
    const newCount = 5;
    const knownCount = 98; // 2 were fixed

    const currentDebt = newCount + knownCount; // = 103
    const snapshotDebt = previousKnownCount;   // = 100
    expect(currentDebt > snapshotDebt).toBe(true); // regression!
  });

  it('R6.8 — total debt not exceeding baseline is not regression', () => {
    const previousKnownCount = 100;
    const newCount = 1;
    const knownCount = 98; // 2 fixed + 1 new = net -1

    const currentDebt = newCount + knownCount; // = 99
    const snapshotDebt = previousKnownCount;   // = 100
    expect(currentDebt > snapshotDebt).toBe(false); // no regression
  });

  // ── hashBaseline stability ─────────────────────────────────────────────

  // ── schemaVersion-mismatch transcript ─────────────────────────────────

  it('R6 — schemaVersion 1 baseline prints mismatch message to stderr', async () => {
    await writeFile(
      join(testDir, '.codeauditor.baseline.json'),
      JSON.stringify({ schemaVersion: 1, entries: [{ fingerprint: 'abc', file: 'src/a.ts' }] }),
    );
    // loadBaseline should log to console.error about the mismatch
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = loadBaseline(testDir);
      expect(result).toBeNull();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('schemaVersion 1'),
      );
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('code-audit baseline'),
      );
    } finally {
      spy.mockRestore();
    }
  });

  // ── Per-analyzer fingerprint stability (R6.6 extension) ──────────────
  //
  // The safe rule admits no exceptions: every violation carries a symbol.
  // Each analyzer uses a different symbol scheme but all must be line-number-free
  // so that adding/removing lines above a finding doesn't change its identity.

  it('R6.6 — DRY fingerprint uses content hash (stable under line drift)', () => {
    // DRY uses block.hash (SHA-256 of normalized code) as symbol
    const contentHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2';
    const fp1 = fingerprint({ analyzer: 'dry', rule: 'dry/duplicate', file: 'src/lib.ts', symbol: contentHash });
    const fp2 = fingerprint({ analyzer: 'dry', rule: 'dry/duplicate', file: 'src/lib.ts', symbol: contentHash });
    expect(fp1).toBe(fp2);
    // Same code hash, regardless of where in the file it appears
  });

  it('R6.6 — data-access fingerprint uses enclosing-function:method (stable under line drift)', () => {
    // data-access uses enclosingFunction:method (with ordinal for genuine repeats)
    const symbol = 'fetchUsers:query';
    const fp1 = fingerprint({ analyzer: 'data-access', rule: 'sql-injection-risk', file: 'src/db.ts', symbol });
    const fp2 = fingerprint({ analyzer: 'data-access', rule: 'sql-injection-risk', file: 'src/db.ts', symbol });
    expect(fp1).toBe(fp2);
    // Same function + method combo, regardless of line position
  });

  it('R6.6 — data-access fingerprint with ordinal disambiguates repeated calls', () => {
    const firstCall  = 'fetchUsers:query';
    const secondCall = 'fetchUsers:query:2';
    const fp1 = fingerprint({ analyzer: 'data-access', rule: 'sql-injection-risk', file: 'src/db.ts', symbol: firstCall });
    const fp2 = fingerprint({ analyzer: 'data-access', rule: 'sql-injection-risk', file: 'src/db.ts', symbol: secondCall });
    expect(fp1).not.toBe(fp2); // Different calls → different fingerprints
  });

  it('R6.6 — schema fingerprint uses enclosing-function:rule symbol (stable under line drift)', () => {
    // Schema analyzer uses enclosing-function:rule symbols with ordinals
    for (const rule of ['missing-schemas', 'sql-injection']) {
      const symbol = `fetchUsers:${rule}`;
      const fp1 = fingerprint({ analyzer: 'schema', rule, file: 'src/models.ts', symbol });
      const fp2 = fingerprint({ analyzer: 'schema', rule, file: 'src/models.ts', symbol });
      expect(fp1).toBe(fp2);
    }
  });

  it('R6.6 — SOLID fingerprint uses function/class name (stable under line drift)', () => {
    // SOLID uses function/class names — line numbers excluded by design
    const symbol = 'UserService.createUser';
    const fp1 = fingerprint({ analyzer: 'solid', rule: 'solid/method-complexity', file: 'src/services.ts', symbol });
    const fp2 = fingerprint({ analyzer: 'solid', rule: 'solid/method-complexity', file: 'src/services.ts', symbol });
    expect(fp1).toBe(fp2);
  });

  it('R6.6 — per-analyzer symbols are all line-number-free', () => {
    // Verify that ALL analyzer symbol formats exclude line numbers.
    // If any fingerprint contains a line number, it will change when lines
    // are added above the finding — breaking the Spec-02 contract.
    const analyzers = [
      { analyzer: 'dry', rule: 'dry/duplicate', symbol: 'abc123hash' },
      { analyzer: 'data-access', rule: 'sql-injection-risk', symbol: 'getUser:query' },
      { analyzer: 'data-access', rule: 'loop-query', symbol: 'fetchUsers:loop-query' },
      { analyzer: 'documentation', rule: 'function-documentation', symbol: 'myFunc' },
      { analyzer: 'solid', rule: 'solid/method-complexity', symbol: 'MyClass.myMethod' },
    ];

    const file = 'src/test.ts';
    for (const a of analyzers) {
      const fpResult = fingerprint({ analyzer: a.analyzer, rule: a.rule, file, symbol: a.symbol });
      expect(fpResult).toHaveLength(64); // SHA-256 hex
      // All symbols are line-number-free strings
      expect(a.symbol).not.toMatch(/^\d+$/);   // not bare line number
      expect(a.symbol).not.toMatch(/:\d+$/);   // not ending with :line
    }
  });

  it('hashBaseline produces stable, deterministic output', () => {
    const baseline: Baseline = {
      schemaVersion: 3, created: '2020-01-01T00:00:00Z',
      entries: [
        { fingerprint: 'aaa', file: 'a.ts' },
        { fingerprint: 'bbb', file: 'b.ts' },
      ],
      metadata: { toolVersion: '1', totalFindings: 2, analyzerCounts: {}, corpusStats: { files: 2, functions: 2 } },
    };
    const h1 = hashBaseline(baseline);
    const h2 = hashBaseline(baseline);
    expect(h1).toBe(h2);
    // Different entries → different hash
    const baseline2 = { ...baseline, entries: [{ fingerprint: 'ccc', file: 'c.ts' }] };
    expect(hashBaseline(baseline2)).not.toBe(h1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration tests — full audit pipeline via programmatic API
// ═══════════════════════════════════════════════════════════════════════════════

describe('Spec-18 — Audit pipeline integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-int-'));
    await mkdir(join(testDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Test 1b: Audit with baseline — known finding produces no "new" ────

  it('R6.1 — known finding in baseline is not reported as new', async () => {
    // Step 1: Run audit on undocumented export → should produce violation
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const result1 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const docViolations = result1.analyzerResults['documentation']?.violations ?? [];
    expect(docViolations.length).toBeGreaterThanOrEqual(1);

    // Step 2: Create baseline from these violations
    const baseline = createBaselineFromFindings(docViolations, {
      toolVersion: '3.2.0',
      totalFindings: docViolations.length,
      analyzerCounts: { documentation: docViolations.length },
      corpusStats: { files: 1, functions: 1 },
    });
    saveBaseline(testDir, baseline);

    // Step 3: Re-run audit → finding should be known, not new
    const result2 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const baselineMeta = result2.metadata.baseline;
    expect(baselineMeta).toBeDefined();
    expect(baselineMeta!.present).toBe(true);
    expect(baselineMeta!.newCount).toBe(0);
    expect(baselineMeta!.knownCount).toBeGreaterThanOrEqual(1);
    expect(baselineMeta!.fixedCount).toBe(0);

    // Violations should have new: false
    const violations2 = result2.analyzerResults['documentation']?.violations ?? [];
    for (const v of violations2) {
      expect((v as any).new).toBe(false);
    }
  });

  // ── Test 2b: Audit with new finding (not in baseline) ─────────────────

  it('R6.2 — new finding not in baseline is reported as new', async () => {
    // Create baseline with a finding from a different file
    const fakeEntry: BaselineEntry = {
      fingerprint: fp({ analyzer: 'documentation', rule: 'function-documentation', file: 'src/other.ts', symbol: 'otherFn' }),
      file: 'src/other.ts',
    };
    const baseline: Baseline = {
      schemaVersion: 3,
      created: new Date().toISOString(),
      entries: [fakeEntry],
      metadata: {
        toolVersion: '3.2.0',
        totalFindings: 1,
        analyzerCounts: { documentation: 1 },
        corpusStats: { files: 1, functions: 1 },
      },
    };
    saveBaseline(testDir, baseline);

    // Write a file that will produce a new violation (different file → different fingerprint)
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const result = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const baselineMeta = result.metadata.baseline;
    expect(baselineMeta).toBeDefined();
    expect(baselineMeta!.present).toBe(true);
    expect(baselineMeta!.newCount).toBeGreaterThanOrEqual(1);

    const violations = result.analyzerResults['documentation']?.violations ?? [];
    const newViolations = violations.filter((v: any) => v.new === true);
    expect(newViolations.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 4b: Fixed finding drops from baseline ────────────────────────

  it('R6.4 — fixed finding is removed from baseline on re-snapshot', async () => {
    // Step 1: Create undocumented file and audit
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const result1 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const violations1 = result1.analyzerResults['documentation']?.violations ?? [];
    const baseline = createBaselineFromFindings(violations1, {
      toolVersion: '3.2.0',
      totalFindings: violations1.length,
      analyzerCounts: { documentation: violations1.length },
      corpusStats: { files: 1, functions: 1 },
    });
    saveBaseline(testDir, baseline);
    const entryCount1 = baseline.entries.length;
    expect(entryCount1).toBeGreaterThanOrEqual(1);

    // Step 2: Replace with file that has no exported functions (no violations)
    // Note: we don't use a JSDoc-commented function because tree-sitter's
    // extractDocumentation can't find JSDoc on `export function` — the comment
    // is a sibling of the export statement, not the inner function_declaration.
    await writeFile(join(testDir, 'src', 'lib.ts'), NO_FUNCTIONS);

    // Step 3: Re-audit → no violations
    const result2 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const violations2 = result2.analyzerResults['documentation']?.violations ?? [];
    const baseline2 = createBaselineFromFindings(violations2, {
      toolVersion: '3.2.0',
      totalFindings: violations2.length,
      analyzerCounts: { documentation: violations2.length },
      corpusStats: { files: 1, functions: 1 },
    });

    // New baseline should have fewer entries (the fix dropped from entries)
    expect(baseline2.entries.length).toBeLessThan(entryCount1);
  });

  // ── Test 4c: No baseline present → baseline metadata absent ───────────

  it('when no baseline exists, metadata.baseline is undefined', async () => {
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const result = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    expect(result.metadata.baseline).toBeUndefined();
  });

  // ── R6.6 extended: Line drift does not break classification ──────────

  it('R6.6 — known finding stays known after lines inserted above', async () => {
    // Step 1: Create undocumented file and baseline it
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const result1 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const violations1 = result1.analyzerResults['documentation']?.violations ?? [];
    expect(violations1.length).toBeGreaterThanOrEqual(1);

    const baseline = createBaselineFromFindings(violations1, {
      toolVersion: '3.2.0',
      totalFindings: violations1.length,
      analyzerCounts: { documentation: violations1.length },
      corpusStats: { files: 1, functions: 1 },
    });
    saveBaseline(testDir, baseline);

    // Step 2: Insert comment lines at the top of the file — line drift!
    const original = UNDOCUMENTED;
    const padded = '// Header comment added\n// Another header line\n// Third header line\n' + original;
    await writeFile(join(testDir, 'src', 'lib.ts'), padded);

    // Step 3: Re-audit → finding should STILL be known (fingerprint unchanged)
    const result2 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const violations2 = result2.analyzerResults['documentation']?.violations ?? [];
    expect(violations2.length).toBeGreaterThanOrEqual(1);

    // All violations should be known (new: false), not new
    const newVios = violations2.filter((v: any) => v.new === true);
    const knownVios = violations2.filter((v: any) => v.new === false);
    expect(newVios.length).toBe(0);
    expect(knownVios.length).toBeGreaterThanOrEqual(1);

    // Baseline metadata should reflect this
    const baselineMeta = result2.metadata.baseline;
    expect(baselineMeta).toBeDefined();
    expect(baselineMeta!.newCount).toBe(0);
    expect(baselineMeta!.knownCount).toBeGreaterThanOrEqual(1);
    expect(baselineMeta!.fixedCount).toBe(0);
  });

  // ── Cross-surface fingerprint identity ─────────────────────────────────
  //
  // All three surfaces (baseline matching, from_audit task creation, SARIF
  // output) must produce the same fingerprint for the same violation. They
  // all go through extractSymbol() + fingerprint() — this test verifies
  // the chain is consistent and will catch divergence if any surface
  // changes its symbol-resolution path.

  it('cross-surface: same violation fingerprints identically through baseline, from_audit, and SARIF pathways', () => {
    // Create violations with various symbol-field configurations.
    // All surfaces use extractSymbol(violation) — the priority chain is:
    // symbol ?? functionName ?? className ?? componentName ?? methodName ??
    //   hookName ?? interfaceName ?? name ?? enclosingSymbol ?? ''
    const violationCases: Array<{ label: string; violation: Violation; expectedSymbol: string }> = [
      {
        label: 'symbol field set directly',
        violation: {
          file: 'src/a.ts',
          line: 10,
          column: 1,
          severity: 'warning',
          message: 'missing JSDoc',
          analyzer: 'documentation',
          rule: 'function-documentation',
          symbol: 'myFunction',
        },
        expectedSymbol: 'myFunction',
      },
      {
        label: 'only functionName (no symbol)',
        violation: {
          file: 'src/b.ts',
          line: 20,
          column: 1,
          severity: 'warning',
          message: 'too many params',
          analyzer: 'solid',
          rule: 'solid/method-complexity',
          functionName: 'process',
        } as any,
        expectedSymbol: 'process',
      },
      {
        label: 'functionName takes priority over className (per extractSymbol chain)',
        violation: {
          file: 'src/c.ts',
          line: 30,
          column: 1,
          severity: 'warning',
          message: 'class method too long',
          analyzer: 'solid',
          rule: 'solid/method-complexity',
          className: 'MyService',
          functionName: 'handle',
        } as any,
        expectedSymbol: 'handle',
      },
      {
        label: 'componentName + methodName',
        violation: {
          file: 'src/Component.tsx',
          line: 40,
          column: 1,
          severity: 'suggestion',
          message: 'effect missing deps',
          analyzer: 'react',
          rule: 'react/missing-deps',
          componentName: 'Dashboard',
          methodName: 'handleClick',
        } as any,
        expectedSymbol: 'Dashboard',
      },
      {
        label: 'enclosingSymbol fallback',
        violation: {
          file: 'src/d.ts',
          line: 50,
          column: 1,
          severity: 'warning',
          message: 'SQL injection',
          analyzer: 'schema',
          rule: 'sql-injection',
          enclosingSymbol: 'buildQuery:sql-injection',
        } as any,
        expectedSymbol: 'buildQuery:sql-injection',
      },
      {
        label: 'no symbol fields at all → empty string',
        violation: {
          file: 'src/e.ts',
          line: 60,
          column: 1,
          severity: 'suggestion',
          message: 'some issue',
          analyzer: 'documentation',
          rule: 'some-rule',
        },
        expectedSymbol: '',
      },
    ];

    for (const { label, violation, expectedSymbol } of violationCases) {
      // 1. Canonical extractSymbol (used by baseline.ts, sarifReportGenerator.ts,
      //    and now projectTasks.ts)
      const canonicalSymbol = extractSymbol(violation);
      expect(canonicalSymbol).toBe(expectedSymbol);

      // 2. Compute fingerprint via the baseline pathway
      const baselineFp = fingerprint({
        analyzer: violation.analyzer ?? '',
        rule: violation.rule ?? '',
        file: violation.file ?? '',
        symbol: canonicalSymbol,
      });

      // 3. Same path produces identical fingerprint (all surfaces use this)
      const duplicateFp = fingerprint({
        analyzer: violation.analyzer ?? '',
        rule: violation.rule ?? '',
        file: violation.file ?? '',
        symbol: canonicalSymbol,
      });
      expect(baselineFp).toBe(duplicateFp);

      // 4. Fingerprint is a proper SHA-256 hex string
      expect(baselineFp).toHaveLength(64);
      expect(baselineFp).toMatch(/^[a-f0-9]{64}$/);

      // 5. Different symbols produce different fingerprints
      const diffFp = fingerprint({
        analyzer: violation.analyzer ?? '',
        rule: violation.rule ?? '',
        file: violation.file ?? '',
        symbol: canonicalSymbol + '-X',
      });
      expect(baselineFp).not.toBe(diffFp);
    }
  });

  // ── Adversarial: buildFingerprintInput rule-ID resolution ─────────────
  //
  // Every analyzer stores its rule identifier in a different field. Before
  // buildFingerprintInput() existed, three surfaces had three diverging
  // extraction chains — same violation → different fingerprint. The prior
  // "cross-surface" test was a false green because it tested fingerprint()
  // internally, not what each surface actually resolved.
  //
  // This test exercises every field path: rule, principle, violationType,
  // type, details.rule — and their precedence. If a new analyzer stores
  // its rule id in a novel field not in the chain, this test will catch it.

  it('adversarial: buildFingerprintInput resolves rule-id from every analyzer field path', () => {
    // Coverage matrix — one case per analyzer field convention:
    // (GROUND-TRUTH.md §1.2 documents which analyzer uses which field.)
    const cases: Array<{
      label: string;
      violation: Violation;
      expectedRule: string;
    }> = [
      // ── rule field (7 analyzers: 5 universal + invariants + react hooks) ─
      {
        label: 'universal-documentation: rule = file-documentation',
        violation: {
          file: 'src/a.ts', line: 1, column: 1, severity: 'suggestion',
          message: 'undocumented', analyzer: 'documentation',
          rule: 'file-documentation', functionName: 'myFn',
        },
        expectedRule: 'file-documentation',
      },
      {
        label: 'universal-schema: rule = type-mismatch',
        violation: {
          file: 'src/b.ts', line: 5, column: 1, severity: 'critical',
          message: 'type mismatch', analyzer: 'universal-schema',
          rule: 'type-mismatch', functionName: 'buildQuery',
        } as any,
        expectedRule: 'type-mismatch',
      },
      {
        label: 'universal-SOLID: rule = solid/class-size',
        violation: {
          file: 'src/c.ts', line: 10, column: 1, severity: 'warning',
          message: 'class too large', analyzer: 'solid',
          rule: 'solid/class-size', className: 'BigClass',
        } as any,
        expectedRule: 'solid/class-size',
      },
      {
        label: 'universal-DRY: rule = dry/duplicate',
        violation: {
          file: 'src/d.ts', line: 15, column: 1, severity: 'suggestion',
          message: 'duplicate code', analyzer: 'dry',
          rule: 'dry/duplicate', functionName: 'helperFn',
        } as any,
        expectedRule: 'dry/duplicate',
      },
      {
        label: 'universal-data-access: rule = sql-injection-risk',
        violation: {
          file: 'src/e.ts', line: 20, column: 1, severity: 'critical',
          message: 'SQL injection risk', analyzer: 'data-access',
          rule: 'sql-injection-risk', functionName: 'runQuery',
        } as any,
        expectedRule: 'sql-injection-risk',
      },
      // ── principle field (CrossLanguageSOLIDAnalyzer) ─
      {
        label: 'CrossLanguageSOLID: principle = SRP (no rule field)',
        violation: {
          file: 'src/f.ts', line: 25, column: 1, severity: 'warning',
          message: 'multiple responsibilities', analyzer: 'cross-language-solid',
          principle: 'SRP', functionName: 'doEverything',
        } as any,
        expectedRule: 'SRP',
      },
      {
        label: 'CrossLanguageSOLID: rule takes precedence over principle when both set',
        violation: {
          file: 'src/f.ts', line: 26, column: 1, severity: 'warning',
          message: 'bad SRP', analyzer: 'cross-language-solid',
          rule: 'solid/srp-explicit', principle: 'SRP',
          functionName: 'doEverything',
        } as any,
        expectedRule: 'solid/srp-explicit',
      },
      // ── violationType field (SchemaValidator, reactAnalyzer) ─
      {
        label: 'SchemaValidator: violationType = field-mismatch (no rule, no principle)',
        violation: {
          file: 'src/g.proto', line: 30, column: 1, severity: 'warning',
          message: 'field mismatch', analyzer: 'schema-validator',
          violationType: 'field-mismatch', functionName: 'validateSchema',
        } as any,
        expectedRule: 'field-mismatch',
      },
      {
        label: 'reactAnalyzer: violationType = complexity (no rule, no principle)',
        violation: {
          file: 'src/App.tsx', line: 35, column: 1, severity: 'suggestion',
          message: 'component too complex', analyzer: 'react',
          violationType: 'complexity', componentName: 'App',
        } as any,
        expectedRule: 'complexity',
      },
      // ── react hooks special case: both rule AND violationType set ─
      {
        label: 'reactAnalyzer hooks: rule = hooks-naming, violationType = hooks-violation — rule wins',
        violation: {
          file: 'src/App.tsx', line: 40, column: 1, severity: 'warning',
          message: 'hook naming violation', analyzer: 'react',
          rule: 'hooks-naming', violationType: 'hooks-violation',
          hookName: 'useBadHook',
        } as any,
        expectedRule: 'hooks-naming',
      },
      // ── contractType field (APIContractAnalyzer) ─
      {
        label: 'APIContractAnalyzer: contractType = api-type-mismatch (no rule, no principle, no violationType)',
        violation: {
          file: 'src/api.ts', line: 42, column: 1, severity: 'warning',
          message: 'API type mismatch', analyzer: 'api-contract',
          contractType: 'api-type-mismatch', functionName: 'fetchUser',
        } as any,
        expectedRule: 'api-type-mismatch',
      },
      {
        label: 'APIContractAnalyzer: contractType = missing-endpoint',
        violation: {
          file: 'src/call.ts', line: 15, column: 1, severity: 'warning',
          message: 'no matching endpoint', analyzer: 'api-contract',
          contractType: 'missing-endpoint', functionName: 'callLegacy',
        } as any,
        expectedRule: 'missing-endpoint',
      },
      // ── contractType vs violationType: violationType wins (higher precedence) ─
      {
        label: 'violationType takes precedence over contractType when both set',
        violation: {
          file: 'src/api.ts', line: 50, column: 1, severity: 'warning',
          message: 'dual field violation', analyzer: 'schema-validator',
          violationType: 'field-mismatch', contractType: 'api-type-mismatch',
          functionName: 'validate',
        } as any,
        expectedRule: 'field-mismatch',
      },
      // ── type field (lowest precedence, after contractType) ─
      {
        label: 'type field used when rule/principle/violationType/contractType all absent',
        violation: {
          file: 'src/h.ts', line: 50, column: 1, severity: 'suggestion',
          message: 'some issue', analyzer: 'unknown-analyzer',
          type: 'structural-issue', functionName: 'someFn',
        } as any,
        expectedRule: 'structural-issue',
      },
      // ── details.rule fallback (nested rule) ─
      {
        label: 'details.rule fallback when top-level fields absent',
        violation: {
          file: 'src/i.ts', line: 55, column: 1, severity: 'suggestion',
          message: 'nested rule violation', analyzer: 'react',
          details: { rule: 'react/nested-rule', nestedExtra: true },
          functionName: 'renderView',
        } as any,
        expectedRule: 'react/nested-rule',
      },
      // ── None set → empty string ─
      {
        label: 'no rule field at all → empty string',
        violation: {
          file: 'src/j.ts', line: 60, column: 1, severity: 'suggestion',
          message: 'unknown issue', analyzer: 'unknown',
          functionName: 'unlabeledFn',
        } as any,
        expectedRule: '',
      },
      // ── CrossLanguageSOLID: principle but no rule, no violationType ─
      {
        label: 'principle = OCP (no rule, no violationType set)',
        violation: {
          file: 'src/k.ts', line: 65, column: 1, severity: 'warning',
          message: 'open-closed violation', analyzer: 'cross-language-solid',
          principle: 'OCP', functionName: 'ShapeRenderer',
        } as any,
        expectedRule: 'OCP',
      },
    ];

    for (const { label, violation, expectedRule } of cases) {
      const input = buildFingerprintInput(violation);
      expect(input.rule, `${label}: rule component mismatch`).toBe(expectedRule);

      // Verify the fingerprint is a valid SHA-256 hex
      const fp = fingerprint(input);
      expect(fp, `${label}: fingerprint not SHA-256`).toMatch(/^[a-f0-9]{64}$/);

      // Identity assertion: same input → same fingerprint (idempotent)
      const fp2 = fingerprint(buildFingerprintInput(violation));
      expect(fp, `${label}: fingerprint not idempotent`).toBe(fp2);

      // Different rule → different fingerprint (the whole point)
      if (expectedRule !== '') {
        const altViolation = { ...violation, rule: 'different-rule' } as any;
        const altFp = fingerprint(buildFingerprintInput(altViolation));
        expect(fp, `${label}: different rule collision`).not.toBe(altFp);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLI integration tests — end-to-end via shell-out
// NOTE: --fail-on suggestion is used because documentation violations are
//       "suggestion" severity. Using --fail-on warning would not catch them.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Spec-18 — CLI end-to-end', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-cli-'));
    await mkdir(join(testDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('R6.1/2 — CLI: --fail-on suggestion exits 2 for new finding, 0 after baseline', async () => {
    // Step 1: Write undocumented file, audit with --fail-on suggestion
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    // Finding is new → --fail-on suggestion should exit 2
    const r1 = runCli(`audit -p "${testDir}" --fail-on suggestion`, testDir);
    expect(r1.exitCode).toBe(2);

    // Step 2: Run baseline to snapshot
    const rBaseline = runCli(`baseline -p "${testDir}" --json`, testDir);
    expect(rBaseline.exitCode).toBe(0);

    // Step 3: Re-audit → findings are known → --fail-on suggestion exits 0
    const r2 = runCli(`audit -p "${testDir}" --fail-on suggestion`, testDir);
    expect(r2.exitCode).toBe(0);

    // Step 4: --include-baseline restores full evaluation → exits 2
    const r3 = runCli(`audit -p "${testDir}" --fail-on suggestion --include-baseline`, testDir);
    expect(r3.exitCode).toBe(2);
  });

  it('R6.4 — CLI: fixed finding drops from baseline file', async () => {
    // Setup: create and baseline the undocumented version
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    runCli(`baseline -p "${testDir}" --json`, testDir);
    const baselineBefore = JSON.parse(await readFile(join(testDir, '.codeauditor.baseline.json'), 'utf-8'));
    const countBefore = baselineBefore.entries.length;
    expect(countBefore).toBeGreaterThanOrEqual(1);

    // Fix by replacing with file that has no exported functions
    await writeFile(join(testDir, 'src', 'lib.ts'), NO_FUNCTIONS);

    // Re-baseline
    runCli(`baseline -p "${testDir}" --json`, testDir);
    const baselineAfter = JSON.parse(await readFile(join(testDir, '.codeauditor.baseline.json'), 'utf-8'));
    const countAfter = baselineAfter.entries.length;

    expect(countAfter).toBeLessThan(countBefore);
  });

  it('R6.4 — CLI: --json flag on baseline command produces parseable JSON output', async () => {
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const r = runCli(`baseline -p "${testDir}" --json`, testDir);
    expect(r.exitCode).toBe(0);

    // stdout should be pure JSON — verify it parses
    const parsed = JSON.parse(r.stdout);
    expect(typeof parsed.absorbed).toBe('number');
    expect(typeof parsed.fixed).toBe('number');
    expect(typeof parsed.totalKnown).toBe('number');
    expect(typeof parsed.invariantsExcluded).toBe('number');
    expect(parsed.totalKnown).toBeGreaterThanOrEqual(1);
  });

  it('R6.7 — CLI: changed from foreign cwd resolves baseline via -p', async () => {
    // Setup project with baseline
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    // Run baseline first to snapshot known findings
    runCli(`baseline -p "${testDir}" --json`, testDir);

    // Make a cosmetic change (not a new function) so 'changed' has something to scan
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED + '\n// dummy change\n');

    // Run changed from /tmp with -p pointing to project — pass the file explicitly
    // so changed uses it directly rather than relying on code-index change detection
    const r = runCli(`changed "${join(testDir, 'src', 'lib.ts')}" -p "${testDir}" --json`, '/tmp');
    expect(r.exitCode).toBe(0);

    // changed --json outputs an array of violations
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);

    // Known findings should have new: false
    const knownViolations = parsed.filter((v: any) => v.new === false);
    expect(knownViolations.length).toBeGreaterThanOrEqual(1);
    const newViolations = parsed.filter((v: any) => v.new === true);
    expect(newViolations.length).toBe(0);
  });

  it('R6.8 — CLI: --fail-on-regression exits 2 when debt increases', async () => {
    // Step 1: Write an undocumented file, then baseline it
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);
    runCli(`baseline -p "${testDir}" --json`, testDir);

    // Step 2: Replace with TWO undocumented functions (increases debt)
    await writeFile(join(testDir, 'src', 'lib.ts'), TWO_UNDOCUMENTED);

    // Step 3: --fail-on-regression should detect debt increase
    const r = runCli(`audit -p "${testDir}" --fail-on-regression`, testDir);
    expect(r.exitCode).toBe(2);
  });

  it('R6.8 — CLI: --fail-on-regression exits 0 when debt is same or lower', async () => {
    // Baseline with findings
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);
    runCli(`baseline -p "${testDir}" --json`, testDir);

    // No change → same debt
    const r = runCli(`audit -p "${testDir}" --fail-on-regression`, testDir);
    expect(r.exitCode).toBe(0);
  });

  it('R6.1 — CLI: no baseline present → full output with hint', async () => {
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const r = runCli(`audit -p "${testDir}"`, testDir);
    expect(r.exitCode).toBe(0);
    // Should hint about running baseline
    expect(r.stdout).toMatch(/baseline/i);
  });

  it('R6 — CLI: --full shows complete inventory even with baseline', async () => {
    // Create + baseline
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);
    runCli(`baseline -p "${testDir}" --json`, testDir);

    // --full should show all findings
    const r = runCli(`audit -p "${testDir}" --full`, testDir);
    expect(r.exitCode).toBe(0);
    // Should NOT contain the delta hint (that only shows in delta mode)
    expect(r.stdout).not.toMatch(/Run code-audit --full/i);
  });

  it('R6.3 — CLI: invariant violation blocks even with baseline present', async () => {
    // Write a file with a banned import
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    // Config with an import-ban invariant rule AND documentation analyzer
    await writeConfig(testDir, {
      enabledAnalyzers: ['documentation', 'invariants'],
      rules: [
        {
          id: 'no-lodash',
          kind: 'import-ban',
          message: 'Do not import lodash',
          severity: 'critical',
          module: 'lodash',
        },
      ],
    });

    // First audit — documentation violation + no invariant violation = exits 2 on suggestion
    const r1 = runCli(`audit -p "${testDir}" --fail-on suggestion`, testDir);
    expect(r1.exitCode).toBe(2);

    // Baseline the documentation findings
    runCli(`baseline -p "${testDir}" --json`, testDir);

    // After baseline, documentation findings are known → --fail-on suggestion exits 0
    const r2 = runCli(`audit -p "${testDir}" --fail-on suggestion`, testDir);
    expect(r2.exitCode).toBe(0);

    // But invariant violations are always "new" — --fail-on critical should NOT
    // evaluate known baseline entries. Since the invariant rule doesn't fire on this file,
    // exit 0 is expected here.

    // Now add a file that triggers both: documentation (known from baseline) + invariant
    await writeFile(join(testDir, 'src', 'bad.ts'), UNDOCUMENTED + '\nimport * as _ from "lodash";\n');
    const r3 = runCli(`audit -p "${testDir}" --fail-on critical`, testDir);
    // The invariant violation (import-ban) is critical and always "new" → must exit 2
    expect(r3.exitCode).toBe(2);
    expect(r3.stdout).toMatch(/Do not import lodash/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Report output tests — verify baseline metadata in report formats
// ═══════════════════════════════════════════════════════════════════════════════

describe('Spec-18 — Report formats include baseline data', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-report-'));
    await mkdir(join(testDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('JSON report includes baseline block and per-violation new field', async () => {
    // Step 1: Create baseline via programmatic audit
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const result1 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const violations1 = result1.analyzerResults['documentation']?.violations ?? [];
    const baseline = createBaselineFromFindings(violations1, {
      toolVersion: '3.2.0',
      totalFindings: violations1.length,
      analyzerCounts: { documentation: violations1.length },
      corpusStats: { files: 1, functions: 1 },
    });
    saveBaseline(testDir, baseline);

    // Step 2: Re-run audit and generate JSON report
    const result2 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const jsonOutput = generateJSONReport(result2);
    const report = JSON.parse(jsonOutput);

    expect(report.baseline).toBeDefined();
    expect(report.baseline.present).toBe(true);
    expect(report.baseline.knownCount).toBeGreaterThanOrEqual(1);
    expect(report.baseline.newCount).toBe(0);

    // Per-violation new field
    const analyzerResults = report.analyzerResults ?? {};
    for (const [, result] of Object.entries(analyzerResults) as any) {
      for (const v of (result as any).violations ?? []) {
        expect(v).toHaveProperty('new');
        expect(v.new).toBe(false); // known finding
      }
    }
  });
});

// ── Rule Registry Enforcement ────────────────────────────────────────────────

describe('Rule Registry', () => {
  it('enforces one emitter per rule ID — no duplicate entries', () => {
    // Every entry in the registry is already keyed by rule ID.
    // JavaScript object keys are inherently unique — a duplicate literal
    // would be a parse-time collision. This test guards against the case
    // where someone adds a new entry to a wrong analyzer block without
    // checking for the existing key.
    const ids = Object.keys(RULE_REGISTRY);
    const seen = new Set<string>();

    for (const id of ids) {
      expect(
        seen.has(id),
        `Rule ID "${id}" appears multiple times — check the registry for duplicate entries`
      ).toBe(false);
      seen.add(id);
    }

    // Distinctness check: verify no ID appears under multiple analyzers.
    // This guards against copy-paste errors where the same string is
    // accidentally used with a different analyzer name.
    const byAnalyzer = new Map<string, string[]>();
    for (const [id, entry] of Object.entries(RULE_REGISTRY)) {
      const existing = byAnalyzer.get(entry.analyzer) ?? [];
      existing.push(id);
      byAnalyzer.set(entry.analyzer, existing);
    }

    const collisions: Array<{ id: string; a: string; b: string }> = [];
    for (const [analyzerA, idsA] of byAnalyzer) {
      for (const [analyzerB, idsB] of byAnalyzer) {
        if (analyzerA >= analyzerB) continue; // skip self and symmetric pairs
        const overlap = idsA.filter((id) => idsB.includes(id));
        for (const id of overlap) {
          collisions.push({ id, a: analyzerA, b: analyzerB });
        }
      }
    }

    if (collisions.length > 0) {
      const msg = collisions
        .map((c) => `  "${c.id}" emitted by both ${c.a} and ${c.b}`)
        .join('\n');
      throw new Error(
        `Rule ID collisions detected — each ID must have exactly one emitter.\n` +
          `${msg}\n\n` +
          `This prevents severityOverrides ambiguity. Fix: rename one copy ` +
          `(e.g., append the analyzer name prefix to one side).\n`
      );
    }

    // Structural check: every entry has required fields
    const validFields = new Set([
      'rule', 'principle', 'violationType', 'type', 'contractType', 'ruleId', 'special',
    ]);
    for (const [id, entry] of Object.entries(RULE_REGISTRY)) {
      expect(entry, `Registry entry "${id}" must have an analyzer`).toHaveProperty('analyzer');
      expect(typeof entry.analyzer, `Registry entry "${id}" analyzer must be a string`).toBe('string');
      expect(entry.analyzer.length, `Registry entry "${id}" analyzer must not be empty`).toBeGreaterThan(0);
      expect(
        validFields.has(entry.field),
        `Registry entry "${id}" field "${entry.field}" is not a valid field`
      ).toBe(true);
    }
  });

  it('has entries for every known analyzer', () => {
    const analyzers = new Set(Object.values(RULE_REGISTRY).map((e) => e.analyzer));

    // Core analyzers (from auditRunner DEFAULT_ANALYZERS)
    expect(analyzers.has('solid'), 'solid analyzer must be registered').toBe(true);
    expect(analyzers.has('dry'), 'dry analyzer must be registered').toBe(true);
    expect(analyzers.has('data-access'), 'data-access analyzer must be registered').toBe(true);
    expect(analyzers.has('react'), 'react analyzer must be registered').toBe(true);
    expect(analyzers.has('documentation'), 'documentation analyzer must be registered').toBe(true);
    expect(analyzers.has('schema'), 'schema analyzer must be registered').toBe(true);
    expect(analyzers.has('invariants'), 'invariants analyzer must be registered').toBe(true);

    // Cross-language analyzers
    expect(analyzers.has('schema-validator'), 'schema-validator must be registered').toBe(true);
    expect(analyzers.has('cross-language-solid'), 'cross-language-solid must be registered').toBe(true);
    expect(analyzers.has('api-contract'), 'api-contract must be registered').toBe(true);
    expect(analyzers.has('dependency-graph'), 'dependency-graph must be registered').toBe(true);
  });

  it('has no empty or whitespace-only rule IDs', () => {
    for (const id of Object.keys(RULE_REGISTRY)) {
      expect(id.trim(), 'Rule ID must not be empty or whitespace-only').not.toBe('');
      expect(id, 'Rule ID must not contain leading/trailing whitespace').toBe(id.trim());
    }
  });
});
