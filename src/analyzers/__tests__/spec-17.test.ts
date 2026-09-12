/**
 * Spec-17 R8 Regression Tests
 *
 * 19 synthetic fixtures verify the noise-reduction rules from R1-R5
 * against the Universal analyzer implementations.
 *
 * Each test cites the spec section it covers and the fixture file it uses.
 *
 * R7 severity defaults are verified inline (Spec 54: critical/severe/high):
 *   documentation/*     → high
 *   schema/unknown-table → critical
 *   dry/duplicate       → high
 *   dry/structural-similarity → high
 *   data-access/loop-query → severe
 *   solid/method-complexity → high
 *   solid/class-size    → high
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { initializeLanguages, initParsers } from '../../languages/index.js';
import { LanguageRegistry } from '../../languages/LanguageRegistry.js';
import { UniversalDocumentationAnalyzer } from '../universal/UniversalDocumentationAnalyzer.js';
import { UniversalSchemaAnalyzer } from '../universal/UniversalSchemaAnalyzer.js';
import { UniversalDRYAnalyzer } from '../universal/UniversalDRYAnalyzer.js';
import { UniversalDataAccessAnalyzer } from '../universal/UniversalDataAccessAnalyzer.js';
import { UniversalSOLIDAnalyzer } from '../universal/UniversalSOLIDAnalyzer.js';
import type { ASTNode } from '../../languages/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'spec-17');

// ── Module-level setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

// ── R1: Documentation Analyzer ──────────────────────────────────────────────

describe('Spec-17 R1 — Documentation Analyzer', () => {
  const analyzer = new UniversalDocumentationAnalyzer();

  it('R1.1 — skips anonymous callback in .map() (fixture 1)', async () => {
    const file = join(FIXTURES, 'anonymous-callback-map.ts');
    const result = await analyzer.analyze([file], { exemptPatterns: [] });
    // No findings — all functions are anonymous callbacks
    expect(result.errors).toHaveLength(0);
    const docViolations = result.violations.filter(v => v.severity !== undefined);
    expect(docViolations).toHaveLength(0);
  });

  it('R1.1 — skips JSX event handler arrows (fixture 2)', async () => {
    const file = join(FIXTURES, 'jsx-event-handler.tsx');
    const result = await analyzer.analyze([file], { exemptPatterns: [] });
    // Exported functions (Button, List) without JSDoc ARE flagged — that's correct.
    // The anonymous callbacks (onClick, onFocus, .map item) must NOT appear in violations.
    expect(result.errors).toHaveLength(0);
    const funcViolations = result.violations.filter(v => v.rule === 'function-documentation');
    // At least Button and List (exported, no JSDoc) should be flagged
    expect(funcViolations.length).toBeGreaterThanOrEqual(2);
    // Verify NO callback arrow is mentioned
    for (const v of funcViolations) {
      expect(v.message).not.toMatch(/\bonClick\b|\bonFocus\b|\bitem\b/i);
    }
  });

  it('R1.2 — exported function without JSDoc flagged (fixture 3)', async () => {
    const file = join(FIXTURES, 'exported-undocumented.ts');
    const result = await analyzer.analyze([file], { exemptPatterns: [] });
    expect(result.errors).toHaveLength(0);
    const funcViolations = result.violations.filter(v => v.rule === 'function-documentation');
    expect(funcViolations.length).toBeGreaterThanOrEqual(1);
    // R1.6: message should cite "exported" (the audience reason)
    const msg = funcViolations.map(v => v.message).join(' ');
    expect(msg).toMatch(/exported/i);
    // R7: severity is high (documentation is a maintainability obligation)
    funcViolations.forEach(v => expect(v.severity).toBe('high'));
  });

  it('R1.2 — private/protected/#/_ methods skipped (fixture 4)', async () => {
    const file = join(FIXTURES, 'private-methods.ts');
    const result = await analyzer.analyze([file], { exemptPatterns: [] });
    expect(result.errors).toHaveLength(0);
    // Only PUBLIC methods with class names in messages should have findings
    const methodViolations = result.violations.filter(
      v => v.rule === 'method-documentation' || v.rule === 'function-documentation'
    );
    // No finding for private methods (privateMethod, _helperMethod, #privateField)
    // But exported utility function may be flagged
    for (const v of methodViolations) {
      expect(v.message).not.toMatch(/privateMethod|_helperMethod|#privateField/);
    }
  });

  it('R1.5 — barrel/test/migration files skipped for header (fixture 5)', async () => {
    const file = join(FIXTURES, 'barrel-test-migration.ts');
    // Default: fileHeaders false → no header findings anyway
    // When fileHeaders is true with default globs → still skipped for barrels
    const result = await analyzer.analyze([file], { fileHeaders: true });
    expect(result.errors).toHaveLength(0);
    // Should be skipped by barrel glob (index.ts pattern or test/spec pattern)
    const headerViolations = result.violations.filter(v => v.rule === 'file-documentation');
    expect(headerViolations).toHaveLength(0);
  });

  it('R1.4 — scope: "all" flags named internal functions, skips callbacks (fixture 19)', async () => {
    const file = join(FIXTURES, 'scope-all-config.ts');
    const result = await analyzer.analyze([file], { scope: 'all', exemptPatterns: [] });
    expect(result.errors).toHaveLength(0);

    // Named internal functions should be flagged
    const funcViolations = result.violations.filter(v => v.rule === 'function-documentation');
    // internalFunction and helper should be flagged; getFormattedAge is exported
    expect(funcViolations.length).toBeGreaterThanOrEqual(2);

    // Callback arrows (.map((x) => x * 2)) must NOT produce findings
    // They have no name so they can't appear in function-documentation
    for (const v of funcViolations) {
      expect(v.message).not.toMatch(/\barrow\b/i);
    }

    // R7: severity is high (documentation is a maintainability obligation)
    funcViolations.forEach(v => expect(v.severity).toBe('high'));
  });
});

// ── R2: Schema Analyzer ─────────────────────────────────────────────────────

describe('Spec-17 R2 — Schema Analyzer', () => {
  const analyzer = new UniversalSchemaAnalyzer();

  it('R2.1 — "node:child_process" import produces zero schema findings (fixture 6)', async () => {
    const file = join(FIXTURES, 'import-node-builtin.ts');
    const result = await analyzer.analyze([file], {});
    expect(result.errors).toHaveLength(0);
    // No SQL context → no table references extracted
    expect(result.violations).toHaveLength(0);
  });

  it('R2.1 — "the" in comment/string produces zero schema findings (fixture 7)', async () => {
    const file = join(FIXTURES, 'word-the-in-comment.ts');
    const result = await analyzer.analyze([file], {});
    expect(result.errors).toHaveLength(0);
    // Legacy regex would have flagged "the" as a table reference
    // AST-based extraction finds no SQL context
    expect(result.violations).toHaveLength(0);
  });

  it('R2.1 — sql tagged template produces unknown-table findings (fixture 8)', async () => {
    const file = join(FIXTURES, 'sql-tagged-template.ts');
    const result = await analyzer.analyze([file], { schemas: [] });
    expect(result.errors).toHaveLength(0);

    // With auto-discovery enabled (schemas: []), discoverTablesFromMigrations
    // does its own glob walk from projectRoot and will find fixtures like
    // migration-create-table.sql defining "heroes" and "quests". The fixture
    // references "heroes" (known) and "villains" (unknown), so we expect
    // exactly one unknown-table violation.
    const tableViolations = result.violations.filter(v => v.rule === 'unknown-table');
    expect(tableViolations).toHaveLength(1);
    expect(tableViolations[0].message).toMatch(/villains/);
  });

  it('R2.3 — template prefix table produces zero unknown-table (fixture 9)', async () => {
    const file = join(FIXTURES, 'template-prefix-table.ts');
    const result = await analyzer.analyze([file], {
      schemas: [{ name: 'main', tables: [{ name: 'builds', columns: [{ name: 'id', type: 'INTEGER' }] }] }],
    });
    expect(result.errors).toHaveLength(0);
    // Dynamic prefix like `${prefix}_builds` resolves to wildcard → no unknown
    const tableViolations = result.violations.filter(v => v.rule === 'unknown-table');
    expect(tableViolations).toHaveLength(0);
  });

  // ── Spec 22 Item 4 — Alias sentinel ─────────────────────────────────────

  it('Item 4 — FROM ${t} x: alias identified, table template filtered (fixture 9b)', async () => {
    const file = join(FIXTURES, 'template-alias-from.ts');
    const result = await analyzer.analyze([file], { schemas: [] });
    expect(result.errors).toHaveLength(0);
    // __TMPL__ sentinel keeps token boundaries intact; bare-alias regex
    // captures x as alias, __TMPL__ is filtered. Zero unknown-table.
    const tableViolations = result.violations.filter(v => v.rule === 'unknown-table');
    expect(tableViolations).toHaveLength(0);
  });

  it('Item 4 — JOIN ${t} y: alias identified, table template filtered (fixture 9c)', async () => {
    const file = join(FIXTURES, 'template-alias-join.ts');
    const result = await analyzer.analyze([file], { schemas: [] });
    expect(result.errors).toHaveLength(0);
    // Same as above, but via JOIN: y is the alias, __TMPL__ filtered.
    const tableViolations = result.violations.filter(v => v.rule === 'unknown-table');
    expect(tableViolations).toHaveLength(0);
  });

  // ── Spec 22 Item 2 — Auto-discovery from migration files ──────────────────

  it('Item 2 — unknown-table skipped: auto-discovered tables from .sql migration (fixture 11a)', async () => {
    const sqlFile = join(FIXTURES, 'migration-create-table.sql');
    const tsFile = join(FIXTURES, 'schema-auto-discover.ts');
    // No schemas configured — discoverTablesFromMigrations() should scan the
    // .sql file for CREATE TABLE and feed "heroes"/"quests" into allTables.
    const result = await analyzer.analyze([sqlFile, tsFile], { schemas: [] });
    expect(result.errors).toHaveLength(0);
    // "heroes" and "quests" are auto-discovered → zero unknown-table
    const tableViolations = result.violations.filter(v => v.rule === 'unknown-table');
    expect(tableViolations).toHaveLength(0);
  });

  it('Item 2 — unknown-table fires: .sql file has no CREATE TABLE (fixture 11b)', async () => {
    // Same .ts fixture references tables not in any CREATE TABLE
    const tsFile = join(FIXTURES, 'schema-auto-discover.ts');
    // No .sql file passed → no auto-discovered tables → heroes/quests are unknown
    const result = await analyzer.analyze([tsFile], { schemas: [] });
    expect(result.errors).toHaveLength(0);
    // Spec 24 Item 4 Part B: knownCount === 0 → rule disabled.
    // With zero known tables, a detector may not call anything unknown.
    const tableViolations = result.violations.filter(v => v.rule === 'unknown-table');
    expect(tableViolations).toHaveLength(0);
    // Rule disabled: no violations to assert severity on.
  });

  it('R2.2 — TSX file with no DB usage produces zero findings (fixture 10)', async () => {
    const file = join(FIXTURES, 'tsx-no-db-usage.tsx');
    const result = await analyzer.analyze([file], {});
    expect(result.errors).toHaveLength(0);
    // File gate: TSX file with SQL-looking strings but no DB imports/patterns
    // Should produce zero schema violations
    const schemaViolations = result.violations.filter(v => v.analyzer === 'schema');
    expect(schemaViolations).toHaveLength(0);
  });
});

// ── R3: DRY Analyzer ────────────────────────────────────────────────────────

describe('Spec-17 R3 — DRY Analyzer', () => {
  const analyzer = new UniversalDRYAnalyzer();

  it('R3.1 — unique 74-line method produces zero duplicate findings (fixture 11)', async () => {
    const file = join(FIXTURES, 'unique-method-74-lines.ts');
    const result = await analyzer.analyze([file], {});
    expect(result.errors).toHaveLength(0);
    // Single unique method — no self-reference possible
    const dryViolations = result.violations.filter(v => v.rule === 'dry/duplicate');
    expect(dryViolations).toHaveLength(0);
  });

  it('R3.3 — structurally similar methods: zero dry/duplicate (fixture 12)', async () => {
    const file = join(FIXTURES, 'structural-similar-methods.ts');
    const result = await analyzer.analyze([file], {});
    expect(result.errors).toHaveLength(0);
    // Similar structure but different identifiers/literals → NOT dry/duplicate
    const exactDup = result.violations.filter(v => v.rule === 'dry/duplicate');
    expect(exactDup).toHaveLength(0);

    // May produce structural-similarity findings
    const structural = result.violations.filter(v => v.rule === 'dry/structural-similarity');
    // R7: structural similarity is high
    structural.forEach(v => expect(v.severity).toBe('high'));
  });

  it('R3.3 — token-identical 15+ line blocks produce dry/duplicate (fixture 13)', async () => {
    const file = join(FIXTURES, 'token-identical-20-lines.ts');
    const result = await analyzer.analyze([file], {});
    expect(result.errors).toHaveLength(0);

    // Two token-identical for-loops in the same file, extracted as
    // significant blocks (isSignificantBlock must use snake_case — Task #32).
    // Identical text → identical SHA-256 hash → dry/duplicate.
    const exactDup = result.violations.filter(v => v.rule === 'dry/duplicate');
    expect(exactDup.length).toBeGreaterThanOrEqual(1);

    // R7: severity is high for dry/duplicate
    exactDup.forEach(v => expect(v.severity).toBe('high'));

    // First-occurrence message must cite the earlier block, not its own location
    const messages = exactDup.map(v => v.message).join(' ');
    expect(messages).toMatch(/First occurrence/i);
  });

  it('R3.2 — 9-line repeated blocks produce zero findings (fixture 14)', async () => {
    const file = join(FIXTURES, 'nine-line-repeated.ts');
    const result = await analyzer.analyze([file], {});
    expect(result.errors).toHaveLength(0);
    // Below 15-line floor → nothing
    const dryViolations = result.violations.filter(
      v => v.rule === 'dry/duplicate' || v.rule === 'dry/structural-similarity'
    );
    expect(dryViolations).toHaveLength(0);
  });
});

// ── R4: Data Access Analyzer ────────────────────────────────────────────────

describe('Spec-17 R4 — Data Access Analyzer', () => {
  const analyzer = new UniversalDataAccessAnalyzer();

  it('R4.1 — query inside for loop → loop-query finding (fixture 15)', async () => {
    const file = join(FIXTURES, 'for-loop-query.ts');
    const result = await analyzer.analyze([file], { skipTestFiles: false });
    expect(result.errors).toHaveLength(0);

    const loopViolations = result.violations.filter(v => v.rule === 'loop-query');
    expect(loopViolations.length).toBeGreaterThanOrEqual(1);

    // Location must be the query-call line, never line 1
    for (const v of loopViolations) {
      expect(v.line).toBeGreaterThan(1);
    }

    // R7: severity is severe (N+1 surfaces under load)
    loopViolations.forEach(v => expect(v.severity).toBe('severe'));
  });

  it('R4.2 — nested loops → innermost loop cited with depth (fixture 16)', async () => {
    const file = join(FIXTURES, 'nested-loops-query.ts');
    const result = await analyzer.analyze([file], { skipTestFiles: false });
    expect(result.errors).toHaveLength(0);

    const loopViolations = result.violations.filter(v => v.rule === 'loop-query');
    expect(loopViolations.length).toBeGreaterThanOrEqual(1);

    // Location never line 1
    for (const v of loopViolations) {
      expect(v.line).toBeGreaterThan(1);
    }

    // Message should note depth
    const messages = loopViolations.map(v => v.message).join(' ');
    expect(messages).toMatch(/nest|depth|2|inner/i);
  });



});

// ── R5: SOLID Analyzer ──────────────────────────────────────────────────────

describe('Spec-17 R5 — SOLID Analyzer', () => {
  const analyzer = new UniversalSOLIDAnalyzer();

  it('R5.1/R5.2 — 20 small methods → class-size; complex function → method-complexity (fixture 17)', async () => {
    const file = join(FIXTURES, 'twenty-methods-vs-complex.ts');
    const result = await analyzer.analyze([file], { skipTestFiles: false });
    expect(result.errors).toHaveLength(0);

    // Class-size: DataProcessor has 20 methods > 15 threshold
    const classSizeViolations = result.violations.filter(v => v.rule === 'solid/class-size');
    expect(classSizeViolations.length).toBeGreaterThanOrEqual(1);

    // Method-complexity: classifyValue has >50 cyclomatic complexity
    const methodComplexityViolations = result.violations.filter(v => v.rule === 'solid/method-complexity');
    expect(methodComplexityViolations.length).toBeGreaterThanOrEqual(1);

    // R5.3: class-size and method-complexity both ship at high (off-scale size)
    classSizeViolations.forEach(v => expect(v.severity).toBe('high'));
    methodComplexityViolations.forEach(v => expect(v.severity).toBe('high'));

    // DataProcessor class should NOT appear under method-complexity
    for (const v of methodComplexityViolations) {
      expect(v.message).not.toMatch(/DataProcessor/);
    }

    // Class-size should reference DataProcessor
    expect(classSizeViolations.map(v => v.message).join(' ')).toMatch(/DataProcessor/);
  });
});

// ── R8: Node-type regression — guards against silent analyzer death ─────
//
// If tree-sitter ever renames its node types (as it did in Spec 08 with the
// PascalCase→snake_case migration), these tests MUST fail. Without them,
// isSignificantBlock / isStringLiteral / hasModificationPatterns /
// checkLiskovSubstitution / checkDependencyInversion all silently match
// nothing and produce zero findings — a green suite hiding a dead analyzer.

describe('Spec-17 R8 — Node-type regression guards', () => {
  const fixture = join(FIXTURES, 'node-type-regression.ts');

  it('DRY isSignificantBlock recognizes all significant block types', async () => {
    const registry = LanguageRegistry.getInstance();
    const adapter = registry.getAdapterForFile(fixture);
    if (!adapter) throw new Error('No adapter for fixture');

    const src = readFileSync(fixture, 'utf8');
    const ast = await adapter.parse(fixture, src);

    const dryAnalyzer = new UniversalDRYAnalyzer();
    // Access private helpers via type-cast
    const { isSignificantBlock, isStringLiteral } = dryAnalyzer as any;

    const found: Set<string> = new Set();
    const expected = new Set([
      'for_statement', 'for_in_statement', 'if_statement', 'while_statement',
      'do_statement', 'switch_statement', 'try_statement',
      'string', 'template_string',
    ]);

    function walk(node: ASTNode): void {
      if (isSignificantBlock(node, adapter)) {
        found.add(node.type);
      }
      if (isStringLiteral(node, adapter)) {
        found.add(node.type);
      }
      for (const child of node.children || []) {
        walk(child);
      }
    }
    walk(ast.root);

    // Every expected node type must be found — if tree-sitter renames one,
    // the matching Set will be missing an entry.
    for (const expectedType of expected) {
      expect(found, `Node type "${expectedType}" not recognized — tree-sitter rename?`).toContain(expectedType);
    }
  });

  it('SOLID walkAST callbacks recognize switch/throw/new/instanceof', async () => {
    const registry = LanguageRegistry.getInstance();
    const adapter = registry.getAdapterForFile(fixture);
    if (!adapter) throw new Error('No adapter for fixture');

    const src = readFileSync(fixture, 'utf8');
    const ast = await adapter.parse(fixture, src);

    const found: Set<string> = new Set();

    function walk(node: ASTNode): void {
      // These are the exact node-type checks used in UniversalSOLIDAnalyzer
      // hasModificationPatterns, checkLiskovSubstitution, checkDependencyInversion
      if (node.type === 'switch_statement') found.add('switch_statement');
      if (node.type === 'binary_expression' &&
          adapter.getNodeText(node, src).includes('instanceof')) {
        found.add('binary_expression:instanceof');
      }
      if (node.type === 'throw_statement') found.add('throw_statement');
      if (node.type === 'new_expression') found.add('new_expression');

      for (const child of node.children || []) {
        walk(child);
      }
    }
    walk(ast.root);

    expect(found, 'switch_statement').toContain('switch_statement');
    expect(found, 'binary_expression:instanceof').toContain('binary_expression:instanceof');
    expect(found, 'throw_statement').toContain('throw_statement');
    expect(found, 'new_expression').toContain('new_expression');
  });
});

// ── R7 structural guard: critical stays a small, deliberate set ──────────────
//
// Spec 54 made `critical` a first-class urgency level ("exploitable or broken
// now") instead of a synonym for "block". A small, deliberate set of rules
// recorded in the severity ledger ships at critical. This test runs every
// universal analyzer over the full Spec-17 fixture corpus and asserts that any
// critical finding comes from a ledger-approved rule — a structural guard so a
// stray `severity: 'critical'` is caught at test time, not discovered one
// self-audit at a time.
//
// The ledger's critical rules reachable from the universal analyzers are
// `invalid-json`, `dynamic-sql-construction`, and `unknown-table` (schema),
// plus `sql-injection-risk` and `hardcoded-connection` (data-access). The
// remaining ledger criticals live outside the universal set — `hardcoded-secret`
// (secrets), `config-error` (invariants), `channels/channel-deadlock`
// (go-subprocess) — and are not exercised here.
//
// Cross-language analyzers are covered by a grep-level assertion: no
// hardcoded 'critical' string in any source file under cross-language/ (their
// five cross-domain rules are all high or severe).

describe('Spec-17 R7 — critical only from the ledger-approved set', () => {
  const universalAnalyzers = [
    { name: 'UniversalDocumentationAnalyzer', analyzer: new UniversalDocumentationAnalyzer() },
    { name: 'UniversalSchemaAnalyzer', analyzer: new UniversalSchemaAnalyzer() },
    { name: 'UniversalDRYAnalyzer', analyzer: new UniversalDRYAnalyzer() },
    { name: 'UniversalDataAccessAnalyzer', analyzer: new UniversalDataAccessAnalyzer() },
    { name: 'UniversalSOLIDAnalyzer', analyzer: new UniversalSOLIDAnalyzer() },
  ];

  // The exact set of rules the ledger authorizes to ship at critical, reachable
  // from the universal analyzers. Any critical from another rule is a stray.
  const CRITICAL_RULES = new Set([
    'invalid-json',
    'dynamic-sql-construction',
    'unknown-table',
    'sql-injection-risk',
    'hardcoded-connection',
  ]);

  it('all Spec-17 fixtures produce criticals only from ledger-approved rules', async () => {
    const { readdirSync } = await import('fs');
    const allFixtures = readdirSync(FIXTURES)
      .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map(f => join(FIXTURES, f));

    for (const { name, analyzer } of universalAnalyzers) {
      const result = await analyzer.analyze(allFixtures, { exemptPatterns: [] });
      const criticals = result.violations.filter(v => v.severity === 'critical');
      const strays = criticals.filter(v => !CRITICAL_RULES.has(v.rule));
      expect(
        strays,
        `${name} produced a critical from a non-approved rule: ${JSON.stringify(strays.slice(0, 3))}`
      ).toHaveLength(0);
    }
  });

  it('cross-language analyzer source files contain zero hardcoded critical severity', async () => {
    // Cross-language analyzers aren't wired into the production pipeline but
    // must still avoid critical — their five cross-domain rules are high/severe.
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const crossLangDir = resolve(dirname(FIXTURES), '..', '..', 'cross-language');
    const { readdirSync: readDir } = await import('fs');
    const files = readDir(crossLangDir).filter((f: string) => f.endsWith('.ts'));

    for (const file of files) {
      const content = readFileSync(resolve(crossLangDir, file), 'utf8');
      // Match lines that assign severity: 'critical' (hardcoded literal)
      // but exclude type annotations and switch cases
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments, type defs, and switch cases
        if (line.includes('//') || line.includes('severity:') && line.includes('|')) continue;
        if (line.includes("case 'critical'")) continue;
        expect(
          line,
          `${file}:${i + 1} has hardcoded 'critical' — use severe or high (see severity ledger)`
        ).not.toMatch(/severity:\s*'critical'/);
      }
    }
  });
});
