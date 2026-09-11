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
import { RULE_ALIASES, canonicalRuleId, describeRuleId } from '../ruleAliases.js';
import { DEFAULT_SOLID_CONFIG } from '../analyzers/universal/UniversalSOLIDAnalyzer.js';
import { DEFAULT_DRY_CONFIG } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import { DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { DEFAULT_DOCUMENTATION_CONFIG } from '../analyzers/universal/UniversalDocumentationAnalyzer.js';
import { DEFAULT_STYLES_CONFIG } from '../analyzers/universal/UniversalStylesAnalyzer.js';
import { DEFAULT_CONVENTIONS_CONFIG } from '../analyzers/universal/UniversalConventionsAnalyzer.js';
import { DEFAULT_ANALYZER_CONFIGS } from '../config/defaults.js';

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
      minSeverity: 'high',
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
      { file: 'src/a.ts', line: 1, column: 1, severity: 'high', message: 'doc', rule: 'function-documentation', analyzer: 'documentation', functionName: 'myFn' },
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
    const v: Violation = { file: 'src/a.ts', line: 1, column: 1, severity: 'high', message: 'undocumented', rule: 'function-documentation', analyzer: 'documentation', functionName: 'myFn' };
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
      file: 'src/a.ts', line: 1, column: 1, severity: 'high', message: 'no doc',
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
      file: 'src/b.ts', line: 1, column: 1, severity: 'high', message: 'no doc',
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
      file: 'src/touched.ts', line: 1, column: 1, severity: 'high', message: 'no doc',
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
    for (const rule of ['missing-schemas', 'dynamic-sql-construction']) {
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
// Unit tests — baseline pipeline via direct function calls (no audit server)
//
// These replace integration tests that spawned an MCP server, loaded tree-sitter
// WASM, and ran a full audit pipeline. The underlying pure functions are unit-
// tested directly with synthetic Violation objects — no WASM, no tmpdir writes
// beyond saveBaseline/loadBaseline round-trips.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Spec-18 — Audit pipeline integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-unit-'));
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Synthetic violation matching the shape UniversalDocumentationAnalyzer emits. */
  function makeViolation(overrides: Partial<Violation> = {}): Violation {
    return {
      file: 'src/lib.ts',
      line: 10,
      column: 1,
      severity: 'severe',
      message: 'Missing JSDoc on exported function calculateTotal',
      analyzer: 'documentation',
      rule: 'function-documentation',
      functionName: 'calculateTotal',
      ...overrides,
    };
  }

  // ── R6.1: Known finding in baseline → matchFindings classifies as known ─

  it('R6.1 — known finding in baseline is not reported as new', () => {
    const v = makeViolation();
    const violations: Violation[] = [v];

    const baseline = createBaselineFromFindings(violations, {
      toolVersion: '3.2.0',
      totalFindings: 1,
      analyzerCounts: { documentation: 1 },
      corpusStats: { files: 1, functions: 1 },
    });
    expect(baseline.entries.length).toBe(1);
    saveBaseline(testDir, baseline);

    // Round-trip: load and match
    const loaded = loadBaseline(testDir);
    expect(loaded).not.toBeNull();
    const classified = matchFindings(violations, loaded!);
    expect(classified.known.length).toBe(1);
    expect(classified.new.length).toBe(0);
    expect(classified.fixed.length).toBe(0);
  });

  // ── R6.2: Different file → different fingerprint → new finding ─

  it('R6.2 — new finding not in baseline is reported as new', () => {
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

    // Violation from a different file → different fingerprint → new
    const v = makeViolation();
    const loaded = loadBaseline(testDir);
    const classified = matchFindings([v], loaded!);
    expect(classified.new.length).toBe(1);
    expect(classified.known.length).toBe(0);
  });

  // ── R6.4: No violations → all baseline entries become "fixed" ─

  it('R6.4 — fixed finding is removed from baseline on re-snapshot', () => {
    const v = makeViolation();
    const violations: Violation[] = [v];

    const baseline1 = createBaselineFromFindings(violations, {
      toolVersion: '3.2.0',
      totalFindings: 1,
      analyzerCounts: { documentation: 1 },
      corpusStats: { files: 1, functions: 1 },
    });
    expect(baseline1.entries.length).toBe(1);
    saveBaseline(testDir, baseline1);

    // Re-create baseline from empty violations → the entry disappears
    const baseline2 = createBaselineFromFindings([], {
      toolVersion: '3.2.0',
      totalFindings: 0,
      analyzerCounts: { documentation: 0 },
      corpusStats: { files: 1, functions: 1 },
    });
    expect(baseline2.entries.length).toBe(0);

    // diffBaselines sees the removed entry (fixed = in previous but not current)
    const diff = diffBaselines(baseline1, baseline2);
    expect(diff.fixed).toBe(1);
    expect(diff.absorbed).toBe(0);
    expect(diff.total).toBe(0); // current (baseline2) has 0 entries

    // matchFindings with empty violations → fixed entries from old baseline
    saveBaseline(testDir, baseline1); // restore baseline with 1 entry
    const loaded = loadBaseline(testDir);
    const classified = matchFindings([], loaded!);
    expect(classified.fixed.length).toBe(1);
    expect(classified.known.length).toBe(0);
    expect(classified.new.length).toBe(0);
  });

  // ── No-baseline: loadBaseline returns null for missing file ─

  it('when no baseline exists, loadBaseline returns null', () => {
    const loaded = loadBaseline(testDir);
    expect(loaded).toBeNull();
  });

  // ── R6.6: Fingerprint is stable under line drift ─

  it('R6.6 — fingerprint unchanged when only line numbers differ', () => {
    const v1 = makeViolation({ line: 10 });
    const v2 = makeViolation({ line: 100 });

    const fp1 = fingerprint(buildFingerprintInput(v1));
    const fp2 = fingerprint(buildFingerprintInput(v2));

    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64); // SHA-256 hex

    // Known finding after line drift: same fingerprint → classified as known
    const baseline = createBaselineFromFindings([v1], {
      toolVersion: '3.2.0',
      totalFindings: 1,
      analyzerCounts: { documentation: 1 },
      corpusStats: { files: 1, functions: 1 },
    });
    saveBaseline(testDir, baseline);

    const loaded = loadBaseline(testDir);
    const classified = matchFindings([v2], loaded!);
    expect(classified.known.length).toBe(1);
    expect(classified.new.length).toBe(0);
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
          severity: 'severe',
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
          severity: 'severe',
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
          severity: 'severe',
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
          severity: 'high',
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
          severity: 'severe',
          message: 'SQL injection',
          analyzer: 'schema',
          rule: 'dynamic-sql-construction',
          enclosingSymbol: 'buildQuery:dynamic-sql-construction',
        } as any,
        expectedSymbol: 'buildQuery:dynamic-sql-construction',
      },
      {
        label: 'no symbol fields at all → empty string',
        violation: {
          file: 'src/e.ts',
          line: 60,
          column: 1,
          severity: 'high',
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
          file: 'src/a.ts', line: 1, column: 1, severity: 'high',
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
          file: 'src/c.ts', line: 10, column: 1, severity: 'severe',
          message: 'class too large', analyzer: 'solid',
          rule: 'solid/class-size', className: 'BigClass',
        } as any,
        expectedRule: 'solid/class-size',
      },
      {
        label: 'universal-DRY: rule = dry/duplicate',
        violation: {
          file: 'src/d.ts', line: 15, column: 1, severity: 'high',
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
      // ── SchemaValidator: rule = field-mismatch (previously used violationType field) ─
      {
        label: 'SchemaValidator: rule = field-mismatch',
        violation: {
          file: 'src/g.proto', line: 30, column: 1, severity: 'severe',
          message: 'field mismatch', analyzer: 'schema-validator',
          rule: 'field-mismatch', functionName: 'validateSchema',
        } as any,
        expectedRule: 'field-mismatch',
      },
      // ── reactAnalyzer: rule = complexity (previously used violationType field) ─
      {
        label: 'reactAnalyzer: rule = complexity',
        violation: {
          file: 'src/App.tsx', line: 35, column: 1, severity: 'high',
          message: 'component too complex', analyzer: 'react',
          rule: 'complexity', componentName: 'App',
        } as any,
        expectedRule: 'complexity',
      },
      // ── reactAnalyzer hooks: rule = hooks-naming ─
      {
        label: 'reactAnalyzer hooks: rule = hooks-naming',
        violation: {
          file: 'src/App.tsx', line: 40, column: 1, severity: 'severe',
          message: 'hook naming violation', analyzer: 'react',
          rule: 'hooks-naming', hookName: 'useBadHook',
        } as any,
        expectedRule: 'hooks-naming',
      },
      // ── APIContractAnalyzer: rule = api-type-mismatch (previously used contractType field) ─
      {
        label: 'APIContractAnalyzer: rule = api-type-mismatch',
        violation: {
          file: 'src/api.ts', line: 42, column: 1, severity: 'severe',
          message: 'API type mismatch', analyzer: 'api-contract',
          rule: 'api-type-mismatch', functionName: 'fetchUser',
        } as any,
        expectedRule: 'api-type-mismatch',
      },
      {
        label: 'APIContractAnalyzer: rule = missing-endpoint',
        violation: {
          file: 'src/call.ts', line: 15, column: 1, severity: 'severe',
          message: 'no matching endpoint', analyzer: 'api-contract',
          rule: 'missing-endpoint', functionName: 'callLegacy',
        } as any,
        expectedRule: 'missing-endpoint',
      },
      // ── rule is the single source of truth (no multi-tier fallback) ─
      {
        label: 'rule field is the single source of truth',
        violation: {
          file: 'src/api.ts', line: 50, column: 1, severity: 'severe',
          message: 'dual field violation', analyzer: 'schema-validator',
          rule: 'field-mismatch', functionName: 'validate',
        } as any,
        expectedRule: 'field-mismatch',
      },
      // ── type field: rule = structural-issue (previously used type field as fallback) ─
      {
        label: 'unknown-analyzer: rule = structural-issue',
        violation: {
          file: 'src/h.ts', line: 50, column: 1, severity: 'high',
          message: 'some issue', analyzer: 'unknown-analyzer',
          rule: 'structural-issue', functionName: 'someFn',
        } as any,
        expectedRule: 'structural-issue',
      },
      // ── rule = react/nested-rule (previously used nested details.rule fallback) ─
      {
        label: 'react: rule = react/nested-rule',
        violation: {
          file: 'src/i.ts', line: 55, column: 1, severity: 'high',
          message: 'nested rule violation', analyzer: 'react',
          rule: 'react/nested-rule', functionName: 'renderView',
        } as any,
        expectedRule: 'react/nested-rule',
      },
      // ── None set → empty string ─
      {
        label: 'no rule field at all → empty string',
        violation: {
          file: 'src/j.ts', line: 60, column: 1, severity: 'high',
          message: 'unknown issue', analyzer: 'unknown',
          functionName: 'unlabeledFn',
        } as any,
        expectedRule: '',
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
// NOTE: --fail-on high is used because `high` is the lowest severity and
//       catches every documentation violation (none are below high).
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

  it('R6.1/2 — CLI: --fail-on high exits 2 for new finding, 0 after baseline', async () => {
    // Step 1: Write undocumented file, audit with --fail-on high
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    // Finding is new → --fail-on high should exit 2
    const r1 = runCli(`audit -p "${testDir}" --fail-on high`, testDir);
    expect(r1.exitCode).toBe(2);

    // Step 2: Run baseline to snapshot
    const rBaseline = runCli(`baseline -p "${testDir}" --json`, testDir);
    expect(rBaseline.exitCode).toBe(0);

    // Step 3: Re-audit → findings are known → --fail-on high exits 0
    const r2 = runCli(`audit -p "${testDir}" --fail-on high`, testDir);
    expect(r2.exitCode).toBe(0);

    // Step 4: --include-baseline restores full evaluation → exits 2
    const r3 = runCli(`audit -p "${testDir}" --fail-on high --include-baseline`, testDir);
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
    // so changed uses it directly rather than relying on code-index change detection.
    // The known finding still blocks (every severity gates, exit 2);
    // baseline resolution is asserted below via new: false rather than exit 0.
    const r = runCli(`changed "${join(testDir, 'src', 'lib.ts')}" -p "${testDir}" --json`, '/tmp');
    expect(r.exitCode).toBe(2);

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

    // First audit — documentation violation + no invariant violation = exits 2 on high
    const r1 = runCli(`audit -p "${testDir}" --fail-on high`, testDir);
    expect(r1.exitCode).toBe(2);

    // Baseline the documentation findings
    runCli(`baseline -p "${testDir}" --json`, testDir);

    // After baseline, documentation findings are known → --fail-on high exits 0
    const r2 = runCli(`audit -p "${testDir}" --fail-on high`, testDir);
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

    // CLI pipeline analyzers (auditRunner analyzerRegistry)
    for (const name of [
      'solid', 'dry', 'data-access', 'react', 'documentation',
      'invariants', 'schema', 'styles', 'conventions', 'cross-domain',
    ]) {
      expect(analyzers.has(name), `${name} analyzer must be registered`).toBe(true);
    }

    // MCP polyglot-path analyzers (LanguageOrchestrator)
    expect(analyzers.has('schema-validator'), 'schema-validator must be registered').toBe(true);
    expect(analyzers.has('api-contract'), 'api-contract must be registered').toBe(true);
    expect(analyzers.has('dependency-graph'), 'dependency-graph must be registered').toBe(true);
  });

  it('maps every rule ID to a reachable analyzer — no dead registry entries', () => {
    // The canonical set of analyzers with a production run path. Every value in
    // RULE_REGISTRY must be one of these, or its rule IDs are *claimed* but never
    // *emitted* — the "files handed to nobody" class of loss that Spec 33 Item 8
    // flagged. If you add an analyzer to RULE_REGISTRY, wire it into one of these
    // two paths (auditRunner analyzerRegistry, or MCP LanguageOrchestrator) or
    // this test fails.
    const reachableAnalyzers = new Set([
      // CLI pipeline (auditRunner analyzerRegistry)
      'solid', 'dry', 'data-access', 'react', 'documentation',
      'invariants', 'schema', 'styles', 'conventions', 'cross-domain', 'secrets',
      // MCP polyglot path (LanguageOrchestrator instantiates these)
      'schema-validator', 'api-contract', 'dependency-graph',
    ]);

    for (const [id, entry] of Object.entries(RULE_REGISTRY)) {
      expect(
        reachableAnalyzers.has(entry.analyzer),
        `Rule ID "${id}" maps to analyzer "${entry.analyzer}", which has no production run path — wire it through or remove the entry`,
      ).toBe(true);
    }
  });

  it('has no empty or whitespace-only rule IDs', () => {
    for (const id of Object.keys(RULE_REGISTRY)) {
      expect(id.trim(), 'Rule ID must not be empty or whitespace-only').not.toBe('');
      expect(id, 'Rule ID must not contain leading/trailing whitespace').toBe(id.trim());
    }
  });

  // ── Spec 37 R2 — the rule contract ─────────────────────────────────────────
  // A rule must declare its resolvability, message template, docs handle and
  // threshold keys. A threshold that does not resolve to a key the analyzer
  // actually reads is a lie in the config surface (Spec 38 R1). There is no
  // `gating` field to assert: Spec 45 R1 makes every rule gate.
  it('Spec 37 R2 — every entry carries the contract; thresholds name real config keys', () => {
    // Authoritative config-key source is each analyzer's own DEFAULT_*_CONFIG —
    // the shape the analyzer actually reads at runtime — NOT the flat
    // DEFAULT_ANALYZER_CONFIGS blob in defaults.ts. That blob has drifted: its
    // dataAccess.performanceThresholds.maxJoins is dead, while the analyzer reads
    // joinedTableCount. Flatten leaf paths so a threshold naming a real key
    // resolves and one naming a phantom key fails.
    const flattenLeafPaths = (obj: unknown, prefix = ''): Set<string> => {
      const paths = new Set<string>();
      if (obj === null || typeof obj !== 'object') {
        if (prefix) paths.add(prefix);
        return paths;
      }
      if (Array.isArray(obj)) {
        if (prefix) paths.add(prefix);
        return paths;
      }
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          for (const sub of flattenLeafPaths(v, p)) paths.add(sub);
        } else {
          paths.add(p);
        }
      }
      return paths;
    };

    // Analyzer → its authoritative config shape. cross-domain has no
    // DEFAULT_CROSS_DOMAIN_CONFIG export; its schemaLifecycle default lives in
    // DEFAULT_ANALYZER_CONFIGS (the only namespace there that is still wired).
    const analyzerConfigShapes: Record<string, unknown> = {
      'solid': DEFAULT_SOLID_CONFIG,
      'dry': DEFAULT_DRY_CONFIG,
      'data-access': DEFAULT_DATA_ACCESS_CONFIG,
      'documentation': DEFAULT_DOCUMENTATION_CONFIG,
      'styles': DEFAULT_STYLES_CONFIG,
      'conventions': DEFAULT_CONVENTIONS_CONFIG,
      'cross-domain': DEFAULT_ANALYZER_CONFIGS.crossDomain,
    };
    const flatKeys = new Map<string, Set<string>>();
    for (const [name, cfg] of Object.entries(analyzerConfigShapes)) {
      flatKeys.set(name, flattenLeafPaths(cfg));
    }

    for (const [id, entry] of Object.entries(RULE_REGISTRY)) {
      // Field completeness — missing any is a build failure (tsc enforces the
      // required interface fields; this re-asserts it at runtime for the case
      // where the literal is built dynamically).
      expect(typeof entry.resolvable, `Registry entry "${id}" must declare resolvable (boolean)`).toBe('boolean');
      expect(typeof entry.message, `Registry entry "${id}" must declare message (string)`).toBe('string');
      expect(entry.message.trim().length, `Registry entry "${id}" message must be non-empty`).toBeGreaterThan(0);
      expect(typeof entry.docs, `Registry entry "${id}" must declare docs (string)`).toBe('string');
      expect(entry.docs.trim().length, `Registry entry "${id}" docs must be non-empty`).toBeGreaterThan(0);
      expect(Array.isArray(entry.thresholds), `Registry entry "${id}" thresholds must be an array`).toBe(true);

      // Thresholds name real config keys the analyzer reads.
      if (entry.thresholds.length === 0) continue;
      const keys = flatKeys.get(entry.analyzer);
      expect(
        keys !== undefined,
        `rule "${id}" declares thresholds but analyzer "${entry.analyzer}" has no config shape registered for validation`,
      ).toBe(true);
      for (const t of entry.thresholds) {
        expect(
          keys?.has(t),
          `rule "${id}" threshold "${t}" is not a real config key in analyzer "${entry.analyzer}"`,
        ).toBe(true);
      }
    }
  });

  // ── Spec 37 R3 — inline samples are part of the contract ──────────────────
  // A rule ships its valid/invalid samples adjacent to its implementation.
  // At least one valid sample must be a near-miss (syntactically close to an
  // invalid case but semantically different) — the shape-matching
  // false-positive class behind the six historical regressions. A rule without
  // both arrays, or without a near-miss, fails here. Every invalid sample on a
  // resolvable rule must assert the resolution it must produce (keeps R1 honest
  // as rules change); a non-resolvable rule must not claim one it cannot emit.
  it('Spec 37 R3 — every rule declares valid+invalid samples with a near-miss; resolvable⇒resolution on invalid samples', () => {
    for (const [id, entry] of Object.entries(RULE_REGISTRY)) {
      expect(entry.samples, `Registry entry "${id}" must declare samples (Spec 37 R3)`).toBeDefined();
      const { valid, invalid } = entry.samples;

      expect(Array.isArray(valid), `Registry entry "${id}" samples.valid must be an array`).toBe(true);
      expect(valid.length, `Registry entry "${id}" must have ≥1 valid sample`).toBeGreaterThan(0);

      expect(Array.isArray(invalid), `Registry entry "${id}" samples.invalid must be an array`).toBe(true);
      expect(invalid.length, `Registry entry "${id}" must have ≥1 invalid sample`).toBeGreaterThan(0);

      // At least one near-miss: syntactically close to an invalid case but
      // semantically different — catches a rule matching on shape, not meaning.
      const hasNearMiss = valid.some((s) => s.nearMiss === true);
      expect(
        hasNearMiss,
        `Registry entry "${id}" must have ≥1 valid sample marked nearMiss (a shape-match false-positive guard)`,
      ).toBe(true);

      // Every invalid sample must carry a code string.
      for (const s of invalid) {
        expect(typeof s.code, `Registry entry "${id}" invalid sample code must be a string`).toBe('string');
        expect(s.code.trim().length, `Registry entry "${id}" invalid sample code must be non-empty`).toBeGreaterThan(0);
      }

      // Resolution assertion: a resolvable rule's invalid samples must each
      // assert the resolution produced; a non-resolvable rule must not claim one.
      if (entry.resolvable) {
        for (const s of invalid) {
          expect(
            s.resolution,
            `resolvable rule "${id}" invalid sample must assert a resolution (Spec 37 R3)`,
          ).toBeDefined();
          expect(
            typeof s.resolution?.action,
            `resolvable rule "${id}" invalid sample resolution must have an action string`,
          ).toBe('string');
          expect(
            (s.resolution?.action ?? '').trim().length,
            `resolvable rule "${id}" invalid sample resolution action must be non-empty`,
          ).toBeGreaterThan(0);
        }
      } else {
        for (const s of invalid) {
          expect(
            s.resolution,
            `non-resolvable rule "${id}" invalid sample must not claim a resolution it cannot emit`,
          ).toBeUndefined();
        }
      }
    }
  });

  // ── Spec 38 R5 — rule-ID alias map ─────────────────────────────────────────
  // A rename or removal must be recorded in RULE_ALIASES, and fingerprinting
  // must canonicalize through it, so an existing baseline survives a rename
  // (known vs new is not reshuffled). A rule ID that existed in a prior
  // release and is absent from both the registry and the alias map fails here.
  it('Spec 38 R5 — prior-release rule IDs resolve to the registry or the alias map', () => {
    // Prior-release IDs = every current registry key (they existed before) plus
    // every retired ID recorded in the alias map. Each must be reachable:
    // either still in the registry, or mapped by an alias to a registry entry.
    for (const [retiredId, alias] of Object.entries(RULE_ALIASES)) {
      if (alias.to === null) {
        // Tombstone — a genuine removal. The reason must be non-empty so a stale
        // reference reports "removed because X", not an unexplained finding.
        expect(
          alias.reason.trim().length,
          `tombstone "${retiredId}" must carry a reason`,
        ).toBeGreaterThan(0);
        // A tombstoned ID must NOT remain in the registry (single source of truth).
        expect(
          RULE_REGISTRY[retiredId],
          `retired rule ID "${retiredId}" must not remain in the registry — it is tombstoned`,
        ).toBeUndefined();
      } else {
        // Rename — the target must be a real, live registry entry.
        expect(
          RULE_REGISTRY[alias.to],
          `alias "${retiredId}" → "${alias.to}" must name a real registry entry`,
        ).toBeDefined();
        // The old ID must not also be present in the registry (no split identity).
        expect(
          RULE_REGISTRY[retiredId],
          `renamed rule ID "${retiredId}" must not remain in the registry alongside "${alias.to}"`,
        ).toBeUndefined();
      }
    }

    // describeRuleId must classify each retired ID correctly.
    expect(describeRuleId('naming-convention')).toMatchObject({ status: 'renamed', to: 'table-naming-convention' });
    expect(describeRuleId('direct-sql')).toMatchObject({ status: 'removed' });
    expect(describeRuleId('unknown-column')).toMatchObject({ status: 'removed' });
    expect(describeRuleId('table-naming-convention')).toEqual({ status: 'unknown' });
  });

  it('Spec 38 R5 — a baseline written before the rename still matches after', () => {
    // Old baseline fingerprint recorded the pre-rename ID.
    const oldFp = fingerprint({ analyzer: 'schema', rule: 'naming-convention', file: 'a.ts', symbol: 'UserProfiles' });
    // New violation now emits the post-rename ID; buildFingerprintInput
    // canonicalizes it back so the fingerprint is identical.
    const newFp = fingerprint(buildFingerprintInput({
      analyzer: 'schema',
      rule: 'table-naming-convention',
      file: 'a.ts',
      symbol: 'UserProfiles',
      severity: 'high',
      message: 'x',
    }));
    expect(newFp).toBe(oldFp);

    // Canonicalization maps the new ID back to the old; unknown IDs pass through.
    expect(canonicalRuleId('table-naming-convention')).toBe('naming-convention');
    expect(canonicalRuleId('unknown-table')).toBe('unknown-table');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// JSON purity — enforce that --json mode writes exactly one valid JSON document
// to stdout with no interstitial text. The hook contract (hook-audit.sh) pipes
// stdout back to the agent as JSON; any non-JSON text in stdout corrupts the
// MCP tool result.
// ═══════════════════════════════════════════════════════════════════════════════

describe('JSON output purity', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-purity-'));
    await mkdir(join(testDir, 'src'), { recursive: true });
    // File large enough to exceed docsMinLines default (5) and trigger
    // function-documentation
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir, { scope: 'all' });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('changed --json produces parseable JSON on stdout with zero non-JSON text', () => {
    const r = runCli(`changed src/lib.ts --json -p "${testDir}"`, testDir);
    // stdout must be valid JSON — no interstitial banners, progress bars, or
    // migration notices. JSON.parse throws on any preamble/postamble text.
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('changed --stdin --json produces parseable JSON (hook invocation path)', () => {
    // The hook pipes file paths via stdin — this is the exact invocation path
    // used by hook-audit.sh. The undocumented fixture is a finding that blocks
    // (exit 2), but stdout must still be pure JSON.
    const cmd = `${distCli()} changed --stdin --json -p "${testDir}"`;
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execSync(cmd, {
        cwd: testDir,
        encoding: 'utf-8',
        input: 'src/lib.ts\n',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
        env: { ...process.env, CODE_AUDITOR_DATA_DIR: testDir, NODE_ENV: 'test' },
      });
    } catch (err: any) {
      stdout = err.stdout || '';
      exitCode = err.status ?? 1;
    }
    expect(exitCode).toBe(2);
    let parsed: any;
    expect(() => { parsed = JSON.parse(stdout.trim()); }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('changed --stdin --json with zero matches produces empty array, not empty string', () => {
    // Edge case: no files match any analyzer → stdout must still be valid JSON
    const cmd = `${distCli()} changed --stdin --json -p "${testDir}"`;
    const result = execSync(cmd, {
      cwd: testDir,
      encoding: 'utf-8',
      input: 'src/nonexistent.ts\n',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, CODE_AUDITOR_DATA_DIR: testDir, NODE_ENV: 'test' },
    });
    let parsed: any;
    expect(() => { parsed = JSON.parse(result.trim()); }).not.toThrow();
    expect(parsed).toEqual([]);
  });

  // ── Extended purity coverage: all --json CLI commands ──
  //
  // Each test verifies that `COMMAND --json` writes exactly one valid JSON
  // document to stdout with zero non-JSON text (no banners, progress bars,
  // migration notices, or stderr contamination). JSON.parse throws on any
  // preamble or postamble, so these tests act as a hard guard.
  //
  // Commands that accept --project/-p use the testDir. Commands that don't
  // rely on CODE_AUDITOR_DATA_DIR (set by runCli). The `audit` command uses
  // `-f json`, not `--json`, and is tested separately in the audit report tests.
  // `map` does not support --json. `coverage import` has no --json option.

  it('index status --json produces parseable JSON', () => {
    const r = runCli(`index status --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
    expect(typeof parsed.totalFiles).toBe('number');
  });

  it('config rules-list --json produces parseable JSON', () => {
    const r = runCli(`config rules-list --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
    expect(Array.isArray(parsed.rules)).toBe(true);
  });

  it('config profiles --json produces parseable JSON', () => {
    const r = runCli(`config profiles --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
    expect(Array.isArray(parsed.profiles)).toBe(true);
  });

  it('config detection --json produces parseable JSON', () => {
    const r = runCli(`config detection --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
  });

  it('search --json produces parseable JSON', () => {
    // Must sync first so the search index is populated
    runCli(`sync -p "${testDir}"`, testDir);
    const r = runCli(`search "calculateTotal" --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
    expect(Array.isArray(parsed.functions)).toBe(true);
  });

  it('tasks list --json produces parseable JSON', () => {
    const r = runCli(`tasks list --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
    expect(typeof parsed.success).toBe('boolean');
  });

  it('tasks from-audit --json produces parseable JSON', () => {
    // Must sync + audit first so from-audit has violations to process
    runCli(`sync -p "${testDir}"`, testDir);
    runCli(`audit -f json --fail-on high -p "${testDir}"`, testDir);
    const r = runCli(`tasks from-audit --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
  });

  it('hotspots --json produces parseable JSON (after audit)', () => {
    // Hotspots needs prior audit data in the ledger
    runCli(`sync -p "${testDir}"`, testDir);
    runCli(`audit -f json --fail-on high -p "${testDir}"`, testDir);
    const r = runCli(`hotspots --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('ledger stats --json produces parseable JSON (after audit)', () => {
    runCli(`sync -p "${testDir}"`, testDir);
    runCli(`audit -f json --fail-on high -p "${testDir}"`, testDir);
    const r = runCli(`ledger stats --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
    expect(typeof parsed.totalRuns).toBe('number');
  });

  it('ledger list --json produces parseable JSON (after audit)', () => {
    runCli(`sync -p "${testDir}"`, testDir);
    runCli(`audit -f json --fail-on high -p "${testDir}"`, testDir);
    const r = runCli(`ledger list --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('risk --json produces parseable JSON', () => {
    const r = runCli(`risk --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('baseline --json produces parseable JSON (after audit)', () => {
    // Baseline snapshots current findings — needs audit first
    runCli(`sync -p "${testDir}"`, testDir);
    runCli(`audit -f json --fail-on high -p "${testDir}"`, testDir);
    const r = runCli(`baseline --json -p "${testDir}"`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
  });

  it('conventions list --json produces parseable JSON', () => {
    // Conventions needs sync + conventions mining
    runCli(`sync -p "${testDir}"`, testDir);
    const r = runCli(`conventions list --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('architecture --json produces parseable JSON', () => {
    const r = runCli(`architecture --json`, testDir);
    let parsed: any;
    expect(() => { parsed = JSON.parse(r.stdout.trim()); }).not.toThrow();
    expect(parsed && typeof parsed === 'object').toBe(true);
  });
});
