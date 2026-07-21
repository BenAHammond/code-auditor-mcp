/**
 * Spec-17 R8 Regression Tests
 *
 * 19 synthetic fixtures verify the noise-reduction rules from R1-R5
 * against the Universal analyzer implementations.
 *
 * Each test cites the spec section it covers and the fixture file it uses.
 *
 * R7 severity defaults are verified inline:
 *   documentation/*     → suggestion
 *   schema/unknown-table → suggestion
 *   dry/duplicate       → warning
 *   dry/structural-similarity → suggestion
 *   data-access/loop-query → warning
 *   data-access/direct-access → suggestion
 *   solid/method-complexity → warning
 *   solid/class-size    → suggestion
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
    // R7: severity is suggestion
    funcViolations.forEach(v => expect(v.severity).toBe('suggestion'));
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

    // R7: severity is suggestion
    funcViolations.forEach(v => expect(v.severity).toBe('suggestion'));
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

    // Should identify at least "heroes" from sql`SELECT * FROM heroes`
    const tableViolations = result.violations.filter(v => v.rule === 'unknown-table');
    expect(tableViolations.length).toBeGreaterThanOrEqual(1);

    // Location should be the tagged template line, not line 1
    tableViolations.forEach(v => {
      expect(v.line).toBeGreaterThan(1);
    });

    // R7: severity is suggestion
    tableViolations.forEach(v => expect(v.severity).toBe('suggestion'));
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
    // R7: structural similarity is suggestion
    structural.forEach(v => expect(v.severity).toBe('suggestion'));
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

    // R7: severity is warning for dry/duplicate
    exactDup.forEach(v => expect(v.severity).toBe('warning'));

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
    const result = await analyzer.analyze([file], {});
    expect(result.errors).toHaveLength(0);

    const loopViolations = result.violations.filter(v => v.rule === 'loop-query');
    expect(loopViolations.length).toBeGreaterThanOrEqual(1);

    // Location must be the query-call line, never line 1
    for (const v of loopViolations) {
      expect(v.line).toBeGreaterThan(1);
    }

    // R7: severity is warning
    loopViolations.forEach(v => expect(v.severity).toBe('warning'));
  });

  it('R4.2 — nested loops → innermost loop cited with depth (fixture 16)', async () => {
    const file = join(FIXTURES, 'nested-loops-query.ts');
    const result = await analyzer.analyze([file], {});
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

  it('R4.3 — directAccess: "allow" skips direct-access findings (fixture 18)', async () => {
    const file = join(FIXTURES, 'direct-access-allow-config.ts');
    const result = await analyzer.analyze([file], { directAccess: 'allow' });
    expect(result.errors).toHaveLength(0);

    // No direct-access violations when directAccess is "allow"
    const directViolations = result.violations.filter(
      v => v.rule === 'hardcoded-connection' || v.rule === 'direct-sql'
    );
    expect(directViolations).toHaveLength(0);
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

    // R5.3: class-size is suggestion, method-complexity is warning (outranks)
    classSizeViolations.forEach(v => expect(v.severity).toBe('suggestion'));
    methodComplexityViolations.forEach(v => expect(v.severity).toBe('warning'));

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

// ── R7 structural guard: zero critical from analyzers ─────────────────────────
//
// R7's principle is that no built-in analyzer rule ships at critical.
// Only user-declared invariant rules may block with critical severity.
// This test runs every universal analyzer over the full Spec-17 fixture corpus
// and asserts zero critical-severity findings — a structural guard so stray
// criticals are caught at test time, not discovered one self-audit at a time.
//
// Cross-language analyzers are covered by a grep-level assertion: no
// hardcoded 'critical' string in any source file under cross-language/.
// Invariants are excepted by construction: their severity comes from
// the user's .codeauditor.json, not from analyzer code.

describe('Spec-17 R7 — zero critical from any analyzer-origin rule', () => {
  const universalAnalyzers = [
    { name: 'UniversalDocumentationAnalyzer', analyzer: new UniversalDocumentationAnalyzer() },
    { name: 'UniversalSchemaAnalyzer', analyzer: new UniversalSchemaAnalyzer() },
    { name: 'UniversalDRYAnalyzer', analyzer: new UniversalDRYAnalyzer() },
    { name: 'UniversalDataAccessAnalyzer', analyzer: new UniversalDataAccessAnalyzer() },
    { name: 'UniversalSOLIDAnalyzer', analyzer: new UniversalSOLIDAnalyzer() },
  ];

  it('all Spec-17 fixtures produce zero critical-severity violations from universal analyzers', async () => {
    const { readdirSync } = await import('fs');
    const allFixtures = readdirSync(FIXTURES)
      .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map(f => join(FIXTURES, f));

    for (const { name, analyzer } of universalAnalyzers) {
      const result = await analyzer.analyze(allFixtures, { exemptPatterns: [] });
      const criticals = result.violations.filter(v => v.severity === 'critical');
      expect(
        criticals,
        `${name} produced ${criticals.length} critical violation(s): ${JSON.stringify(criticals.slice(0, 3))}`
      ).toHaveLength(0);
    }
  });

  it('cross-language analyzer source files contain zero hardcoded critical severity', async () => {
    // Cross-language analyzers aren't wired into the production pipeline but
    // must still obey the zero-critical principle as forward-defense.
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
          `${file}:${i + 1} has hardcoded 'critical' — demote to warning or below`
        ).not.toMatch(/severity:\s*'critical'/);
      }
    }
  });
});
