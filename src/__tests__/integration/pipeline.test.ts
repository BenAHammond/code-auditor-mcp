/**
 * Integration Suite — real runAudit() pipeline (WASM + MCP server)
 *
 * These tests verify wiring that unit tests cannot: that isExempt is actually
 * called in the documentation analyzer's file loop, and that a real audit run
 * compared against a real baseline classifies findings correctly.
 *
 * Each test uses real runAudit() and therefore loads tree-sitter WASM. They
 * carry their own timeout budget and are excluded from `npm run test` (the 803).
 * Run them with: npm run test:integration
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, test as vitestTest } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { initParsers, initializeLanguages } from '../../languages/index.js';
import { runAudit } from '../../auditRunner.js';
import {
  createBaselineFromFindings,
  saveBaseline,
  loadBaseline,
  matchFindings,
} from '../../baseline.js';

// ── Module-level setup ─────────────────────────────────────────────────────────

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

// ── Fixture content ────────────────────────────────────────────────────────────

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

/** Small helper to write minimal .codeauditor.json config. */
async function writeConfig(
  testDir: string,
  overrides: Record<string, any> = {},
) {
  await writeFile(
    join(testDir, '.codeauditor.json'),
    JSON.stringify({
      enabledAnalyzers: ['documentation'],
      includePaths: ['src/**/*.ts'],
      excludePaths: ['**/node_modules/**', '**/*.test.ts'],
      minSeverity: 'suggestion',
      showProgress: false,
      ...overrides,
    }, null, 2),
    'utf-8',
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test 1 — isExempt wired into the documentation analyzer file loop
// ═══════════════════════════════════════════════════════════════════════════════

describe('isExempt — wired in the documentation analyzer file loop', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-int-'));
    await mkdir(join(testDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  vitestTest('exemptPatterns configured in .codeauditor.json suppress violations on matching files', { timeout: 30_000 }, async () => {
    // Create two identical source files — one exempt by path, one not.
    await writeFile(join(testDir, 'src', 'utils.spec.ts'), UNDOCUMENTED);
    await writeFile(join(testDir, 'src', 'utils.ts'), UNDOCUMENTED);

    await writeConfig(testDir, {
      analyzerConfigs: {
        documentation: {
          exemptPatterns: ['\\.spec\\.', '\\.test\\.'],
        },
      },
    });

    const result = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const violations = result.analyzerResults['documentation']?.violations ?? [];
    const files = [...new Set(violations.map((v) => v.file))];

    // The spec file matches the exempt pattern — no violation for it.
    expect(
      files.some((f) => f.includes('utils.spec.ts')),
      'utils.spec.ts should be exempt from documentation checks',
    ).toBe(false);

    // The plain production file does NOT match — it gets flagged.
    expect(
      files.some((f) => f.includes('utils.ts')),
      'utils.ts should NOT be exempt and should produce a violation',
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test 2 — R6.1 end-to-end: baseline suppresses known findings in real audit
// ═══════════════════════════════════════════════════════════════════════════════

describe('R6.1 — baseline suppresses known findings (real audit pipeline)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-int-'));
    await mkdir(join(testDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  vitestTest('known findings stay known, new findings surface as new', { timeout: 30_000 }, async () => {
    // Step 1: Baseline the tree — one undocumented function → one violation.
    await writeFile(join(testDir, 'src', 'lib.ts'), UNDOCUMENTED);
    await writeConfig(testDir);

    const result1 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const violations1 = result1.analyzerResults['documentation']?.violations ?? [];
    expect(violations1.length, 'Step 1: one undocumented function → one violation').toBe(1);

    const baseline = createBaselineFromFindings(violations1, {
      toolVersion: '3.4.8',
      totalFindings: violations1.length,
      analyzerCounts: { documentation: violations1.length },
      corpusStats: { files: 1, functions: 1 },
    });
    saveBaseline(testDir, baseline);

    // Step 2: Re-audit unchanged tree — known = 1, new = 0.
    const result2 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    expect(result2.metadata.baseline, 'Step 2: baseline block must exist').toBeDefined();
    expect(result2.metadata.baseline!.present, 'Step 2: baseline should be present').toBe(true);
    expect(result2.metadata.baseline!.knownCount, 'Step 2: knownCount').toBe(1);
    expect(result2.metadata.baseline!.newCount, 'Step 2: newCount — unchanged tree, nothing new').toBe(0);

    // Step 3: Add a second undocumented function — old is still known, new is new.
    await writeFile(join(testDir, 'src', 'lib.ts'), TWO_UNDOCUMENTED);

    const result3 = await runAudit({
      projectRoot: testDir,
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    expect(result3.metadata.baseline!.present, 'Step 3: baseline should still be present').toBe(true);
    expect(result3.metadata.baseline!.knownCount, 'Step 3: knownCount — old finding still known').toBe(1);
    expect(result3.metadata.baseline!.newCount, 'Step 3: newCount — one new function, one new violation').toBe(1);
  });
});
