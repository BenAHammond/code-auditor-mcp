/**
 * Spec-19 Corrective Batch Item 1 — 27-item Oracle Sweep
 *
 * One test per triage item, each with a standalone fixture file structurally
 * equivalent to the cited code. The fixture file carries the item number in
 * its filename and a JSDoc comment identifying the item.
 *
 * Split per the 2026-07 recall-warning triage table:
 *   8 false-positive items → 0 violations for triage-attributed rule (2,5,6,9,10,11,12,17)
 *   10 true-positive items  → fire at appropriate severity (1,3,4,7,8,13,14,15,16,18)
 *   9 DRY items             → fire per current DRY defaults (19-27)
 *
 * Gate: 27/27 passing with the named split.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../../languages/index.js';
import { parseFile } from '../../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../../languages/types.js';
import { UniversalSOLIDAnalyzer, DEFAULT_SOLID_CONFIG, type SOLIDAnalyzerConfig } from '../../../analyzers/universal/UniversalSOLIDAnalyzer.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../../../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { UniversalDRYAnalyzer, DEFAULT_DRY_CONFIG, type DRYAnalyzerConfig } from '../../../analyzers/universal/UniversalDRYAnalyzer.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── SOLID config for complexity-path verification ────────────────────
//
// maxMethodComplexity: 10 — low threshold to verify the complexity path works
//   deterministically on genuinely complex functions (items 13-16).
// maxLinesPerMethod: 200 — suppress the line-count path so complexity is the
//   only signal for method-complexity.
// classMethodsThreshold: 5 — low threshold so item 18 class-size fires reliably.
// classAggregateComplexity: 30 — low threshold so item 18 aggregate fires.
const ORACLE_SOLID_CONFIG: SOLIDAnalyzerConfig = {
  ...DEFAULT_SOLID_CONFIG,
  maxMethodComplexity: 10,
  maxLinesPerMethod: 200,
  maxParametersPerMethod: 20,
  classMethodsThreshold: 5,
  classAggregateComplexity: 30,
  skipTestFiles: false,
};

// ── DRY config for structural-similarity positive control ────────────
const DRY_STRUCTURAL_ENABLED: DRYAnalyzerConfig = {
  ...DEFAULT_DRY_CONFIG,
  checkStructuralSimilarity: true,
  minLineThreshold: 10, // lower threshold so ~20-line CRUD/api-router functions qualify
};

// ── Helpers ───────────────────────────────────────────────────────────

function fixturePath(name: string): string {
  return join(__dirname, name);
}

/** SOLID analyzer — returns violations grouped by rule. */
async function runSolidAnalyzer(filePath: string): Promise<{
  methodComplexity: import('../../../types.js').Violation[];
  singleResponsibility: import('../../../types.js').Violation[];
  classSize: import('../../../types.js').Violation[];
  all: import('../../../types.js').Violation[];
}> {
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${filePath}`);

  const analyzer = new UniversalSOLIDAnalyzer();
  const violations = await (analyzer as any).analyzeAST(ast, tsAdapter, ORACLE_SOLID_CONFIG, sourceCode);

  return {
    methodComplexity: violations.filter((v: any) => v.rule === 'solid/method-complexity'),
    singleResponsibility: violations.filter((v: any) => v.rule === 'single-responsibility'),
    classSize: violations.filter((v: any) => v.rule === 'solid/class-size'),
    all: violations,
  };
}

/** Data-access analyzer — returns violations grouped by rule. */
async function runDataAccessAnalyzer(filePath: string): Promise<{
  loopQuery: import('../../../types.js').Violation[];
  sqlInjection: import('../../../types.js').Violation[];
  all: import('../../../types.js').Violation[];
}> {
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${filePath}`);

  const analyzer = new UniversalDataAccessAnalyzer();
  const violations = await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode);

  return {
    loopQuery: violations.filter((v: any) => v.rule === 'loop-query'),
    sqlInjection: violations.filter((v: any) => v.rule === 'sql-injection-risk'),
    all: violations,
  };
}

/** DRY analyzer — returns violations grouped by rule. Accepts optional config overrides. */
async function runDRYAnalyzer(
  filePath: string,
  configOverrides?: Partial<DRYAnalyzerConfig>,
): Promise<{
  dryDuplicate: import('../../../types.js').Violation[];
  structuralSimilarity: import('../../../types.js').Violation[];
  duplicateImport: import('../../../types.js').Violation[];
  duplicateString: import('../../../types.js').Violation[];
  all: import('../../../types.js').Violation[];
}> {
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${filePath}`);

  const analyzer = new UniversalDRYAnalyzer();
  const config = { ...DEFAULT_DRY_CONFIG, ...configOverrides };
  const violations = await (analyzer as any).analyzeAST(ast, tsAdapter, config, sourceCode);

  return {
    dryDuplicate: violations.filter((v: any) => v.rule === 'dry/duplicate'),
    structuralSimilarity: violations.filter((v: any) => v.rule === 'dry/structural-similarity'),
    duplicateImport: violations.filter((v: any) => v.rule === 'duplicate-import'),
    duplicateString: violations.filter((v: any) => v.rule === 'duplicate-string-literal'),
    all: violations,
  };
}

let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — SOLID false positives (items 11, 12, 17)
//   method-complexity MUST stay silent on complexity-1 functions
// ═══════════════════════════════════════════════════════════════════════════

describe('Oracle: SOLID false positives', () => {

  it('item 11: long simple function (complexity 1, 52 lines) → 0 method-complexity', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-11-long-simple-function.ts'));
    expect(r.methodComplexity.length,
      `Item 11 is complexity 1 — method-complexity MUST NOT fire (got ${r.methodComplexity.length})`
    ).toBe(0);
    // 52 lines but maxLinesPerMethod=200 suppresses single-responsibility
    expect(r.singleResponsibility.length).toBe(0);
  });

  it('item 12: branchless JSX component (complexity 1, ~40 lines) → 0 method-complexity', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-12-branchless-jsx.tsx'));
    expect(r.methodComplexity.length,
      `Item 12 is complexity 1 — method-complexity MUST NOT fire (got ${r.methodComplexity.length})`
    ).toBe(0);
  });

  it('item 17: data assembly with object spread (complexity 1, zero branches) → 0 method-complexity', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-17-data-assembly.ts'));
    expect(r.methodComplexity.length,
      `Item 17 is complexity 1 — method-complexity MUST NOT fire (got ${r.methodComplexity.length})`
    ).toBe(0);
  });

  it('items 11/17 class-method variants → 0 method-complexity', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-11-17-class-methods.ts'));
    expect(r.methodComplexity.length,
      `Class-method variants of items 11/17 are complexity 1 — MUST NOT fire (got ${r.methodComplexity.length})`
    ).toBe(0);
  });

  it('item 2: hero-repo.ts:83 shape — repository method with query + .map(), complexity 1 → 0 method-complexity', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-02-hero-repo-shape.ts'));
    expect(r.methodComplexity.length,
      `Item 2: repository query+map is complexity 1 — method-complexity MUST NOT fire (got ${r.methodComplexity.length})`
    ).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — SOLID true positives (items 13, 14, 15, 16, 18)
//   method-complexity and class-size MUST fire on genuinely complex code
// ═══════════════════════════════════════════════════════════════════════════

describe('Oracle: SOLID true positives', () => {

  it('item 13: large switch handler (15+ branches) → method-complexity fires at warning', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-13-large-switch-handler.ts'));
    expect(r.methodComplexity.length, 'Item 13 is genuinely complex — MUST fire').toBeGreaterThan(0);
    expect(r.methodComplexity[0].severity).toBe('warning');
  });

  it('item 14: deep validation (8 nested conditionals) → method-complexity fires at warning', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-14-deep-validation.ts'));
    expect(r.methodComplexity.length, 'Item 14 has nested conditionals — MUST fire').toBeGreaterThan(0);
    expect(r.methodComplexity[0].severity).toBe('warning');
  });

  it('item 15: complex query builder (chained conditionals) → method-complexity fires at warning', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-15-complex-query-builder.ts'));
    expect(r.methodComplexity.length, 'Item 15 has chained conditionals — MUST fire').toBeGreaterThan(0);
    expect(r.methodComplexity[0].severity).toBe('warning');
  });

  it('item 16: field mapping dispatch (20+ branches) → method-complexity fires at warning', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-16-field-mapping-dispatch.ts'));
    expect(r.methodComplexity.length, 'Item 16 has 20+ branches — MUST fire').toBeGreaterThan(0);
    expect(r.methodComplexity[0].severity).toBe('warning');
  });

  it('item 18: large service class (18 methods) → class-size fires at suggestion', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-18-large-service-class.ts'));
    expect(r.classSize.length, 'Item 18 has 18 methods — class-size MUST fire').toBeGreaterThan(0);
    for (const v of r.classSize) {
      expect(v.severity).toBe('suggestion');
    }
  });

  it('item 18: complex methods within service class → method-complexity fires', async () => {
    const r = await runSolidAnalyzer(fixturePath('item-18-large-service-class.ts'));
    expect(r.methodComplexity.length,
      'Service class has complex methods exceeding threshold 10'
    ).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — Data-access false positives (items 2, 5, 6, 9, 10)
//   loop-query and sql-injection-risk MUST stay silent on non-DB operations
// ═══════════════════════════════════════════════════════════════════════════

describe('Oracle: Data-access false positives', () => {

  it('item 2: LLM call in loop, INSERT outside loop → 0 loop-query', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-02-llm-loop-no-db.ts'));
    expect(r.loopQuery.length,
      `Item 2: INSERT is outside loop body — loop-query MUST NOT fire (got ${r.loopQuery.length})`
    ).toBe(0);
  });

  it('item 5: .findIndex() in forEach → 0 loop-query', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-05-findindex-not-db.ts'));
    expect(r.loopQuery.length,
      `Item 5: findIndex is an Array method — loop-query MUST NOT fire (got ${r.loopQuery.length})`
    ).toBe(0);
  });

  it('item 6: in-memory data transformation in loop → 0 loop-query', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-06-immemory-iteration.ts'));
    expect(r.loopQuery.length,
      `Item 6: pure data transform — loop-query MUST NOT fire (got ${r.loopQuery.length})`
    ).toBe(0);
  });

  it('item 9: page.evaluate() with CSS selector → 0 sql-injection-risk', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-09-playwright-evaluate.ts'));
    expect(r.sqlInjection.length,
      `Item 9: page.evaluate is a Playwright API — sql-injection-risk MUST NOT fire (got ${r.sqlInjection.length})`
    ).toBe(0);
  });

  it('item 10: parameterized query with $1 → 0 sql-injection-risk', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-10-const-ternary-table.ts'));
    expect(r.sqlInjection.length,
      `Item 10: $1 parameterized placeholder — sql-injection-risk MUST NOT fire (got ${r.sqlInjection.length})`
    ).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 4 — Data-access true positives (items 1, 3, 4, 7, 8)
//   loop-query and sql-injection-risk MUST still fire on genuine DB issues
// ═══════════════════════════════════════════════════════════════════════════

describe('Oracle: Data-access true positives', () => {

  it('item 1: INSERT in loop body → loop-query fires at warning', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-01-real-loop-insert.ts'));
    expect(r.loopQuery.length, 'Item 1: real N+1 — loop-query MUST fire').toBeGreaterThan(0);
    expect(r.loopQuery[0].severity).toBe('warning');
  });

  it('item 3: INSERT RETURNING per iteration → loop-query fires at warning', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-03-real-n-plus-one.ts'));
    expect(r.loopQuery.length, 'Item 3: N+1 INSERT RETURNING — loop-query MUST fire').toBeGreaterThan(0);
    expect(r.loopQuery[0].severity).toBe('warning');
  });

  it('item 4: SQL injection via string concatenation → sql-injection-risk fires at suggestion', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-04-real-sql-injection.ts'));
    expect(r.sqlInjection.length, 'Item 4: concatenated user input — sql-injection-risk MUST fire').toBeGreaterThan(0);
    expect(r.sqlInjection[0].severity).toBe('suggestion');
  });

  it('item 7: template literal injection → sql-injection-risk fires at suggestion', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-07-real-template-injection.ts'));
    expect(r.sqlInjection.length, 'Item 7: template literal with ${filter} — sql-injection-risk MUST fire').toBeGreaterThan(0);
    expect(r.sqlInjection[0].severity).toBe('suggestion');
  });

  it('item 8: nested N+1 (outer + per-row child queries) → loop-query fires at warning', async () => {
    const r = await runDataAccessAnalyzer(fixturePath('item-08-real-nested-n-plus-one.ts'));
    expect(r.loopQuery.length, 'Item 8: classic nested N+1 — loop-query MUST fire').toBeGreaterThan(0);
    expect(r.loopQuery[0].severity).toBe('warning');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 5 — DRY items 19–27
//   dry/duplicate fires on token-identical blocks (items 19, 20).
//   duplicate-import, duplicate-string-literal are retired → 0 findings
//     (items 21–23, 24–25).
//   dry/structural-similarity is default-off → 0 findings (item 26).
//   dry/structural-similarity fires when enabled (item 27 positive control).
// ═══════════════════════════════════════════════════════════════════════════

describe('Oracle: DRY items 19–27', () => {

  // ── dry/duplicate fires ─────────────────────────────────────────────

  it('item 19: config block duplicated → dry/duplicate fires', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-19-config-duplicate.ts'));
    expect(r.dryDuplicate.length,
      'Item 19: two token-identical config blocks ≥15 lines — dry/duplicate MUST fire'
    ).toBeGreaterThan(0);
    expect(r.dryDuplicate[0].severity).toBe('warning');
  });

  it('item 20: i18n block duplicated → dry/duplicate fires', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-20-i18n-duplicate.ts'));
    expect(r.dryDuplicate.length,
      'Item 20: two token-identical i18n blocks ≥15 lines — dry/duplicate MUST fire'
    ).toBeGreaterThan(0);
    expect(r.dryDuplicate[0].severity).toBe('warning');
  });

  // ── duplicate-import retired → 0 ────────────────────────────────────

  it('item 21: react imported twice → 0 duplicate-import (rule retired)', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-21-dup-import.ts'));
    expect(r.duplicateImport.length,
      `Item 21: duplicate-import is retired — MUST NOT fire (got ${r.duplicateImport.length})`
    ).toBe(0);
  });

  it('item 22: lodash imported twice → 0 duplicate-import (rule retired)', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-22-dup-import.ts'));
    expect(r.duplicateImport.length,
      `Item 22: duplicate-import is retired — MUST NOT fire (got ${r.duplicateImport.length})`
    ).toBe(0);
  });

  it('item 23: axios imported twice → 0 duplicate-import (rule retired)', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-23-dup-import.ts'));
    expect(r.duplicateImport.length,
      `Item 23: duplicate-import is retired — MUST NOT fire (got ${r.duplicateImport.length})`
    ).toBe(0);
  });

  // ── duplicate-string-literal retired → 0 ────────────────────────────

  it('item 24: CSS class strings repeated → 0 duplicate-string-literal (rule retired)', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-24-dup-string-css.ts'));
    expect(r.duplicateString.length,
      `Item 24: duplicate-string-literal is retired — MUST NOT fire (got ${r.duplicateString.length})`
    ).toBe(0);
  });

  it('item 25: test fixture name repeated → 0 duplicate-string-literal (rule retired)', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-25-dup-string-test.ts'));
    expect(r.duplicateString.length,
      `Item 25: duplicate-string-literal is retired — MUST NOT fire (got ${r.duplicateString.length})`
    ).toBe(0);
  });

  // ── structural-similarity default-off → 0 / enabled → fires ─────────

  it('item 26: CRUD handlers structurally similar → 0 dry/structural-similarity (default-off)', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-26-crud-similar.ts'));
    expect(r.structuralSimilarity.length,
      `Item 26: structural-similarity is default-off — MUST NOT fire (got ${r.structuralSimilarity.length})`
    ).toBe(0);
  });

  it('item 27: API routers structurally similar → dry/structural-similarity fires when enabled', async () => {
    const r = await runDRYAnalyzer(fixturePath('item-27-api-routers.ts'), DRY_STRUCTURAL_ENABLED);
    expect(r.structuralSimilarity.length,
      'Item 27: two structurally similar API routers with enabled check — MUST fire'
    ).toBeGreaterThan(0);
    expect(r.structuralSimilarity[0].severity).toBe('suggestion');
  });
});
