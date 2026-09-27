/**
 * Spec 68 §3.2 — parity: the three migrated code-block DRY rules reproduce the
 * old `UniversalDRYAnalyzer`'s findings exactly.
 *
 * `dry/duplicate`, `dry/structural-similarity` and `dry/similar-expression` all
 * read the new `code-block` fact (blocks + shape fragments), which the
 * `codeBlocks.ts` producer projects with no threshold and no dedup. This test
 * runs BOTH paths — the still-live `UniversalDRYAnalyzer.analyzeAST` and the new
 * `runDrySlice` — and asserts the identity multiset (file, line, column, rule,
 * severity) is equal and non-empty for each rule.
 *
 * The load-bearing property is the per-file split: the legacy `analyzeAST` ran
 * once per AST, so a block in file A is never compared against a block in file
 * B. The migrated rules partition the corpus-wide `code-block` fact by `file`
 * and run their filter → dedupe → compare within one file.
 *
 * Each case lowers `minLineThreshold` to 5 (the default 15 would need a much
 * larger fixture) and isolates the rule under test by disabling the other two
 * check-gates (`checkStructuralSimilarity` / `checkExpressionSimilarity`), the
 * same as the legacy `checkImports`/`checkStrings` isolation in the sibling
 * dry-parity test. The normalization flags (`ignoreComments`/`ignoreWhitespace`)
 * are left at their defaults on both paths — the producer pins them true and
 * they are not part of the rules' declared threshold surface.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDRYAnalyzer } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import { runDrySlice } from '../phase/runner.js';
import type { Violation } from '../types.js';

const BLOCK_RULES = new Set(['dry/duplicate', 'dry/structural-similarity', 'dry/similar-expression']);

let adapter: LanguageAdapter;
let analyzer: UniversalDRYAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDRYAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** Run the old `analyzeAST` and the new slice, return the per-rule identity multisets. */
async function parity(source: string, config: Record<string, unknown>) {
  const ast = parseFile('parity.ts', source);
  expect(ast, 'fixture failed to parse').not.toBeNull();
  const oldRaw = await (analyzer as unknown as {
    analyzeAST(ast: unknown, a: LanguageAdapter, c: unknown, s: string): Promise<Violation[]>;
  }).analyzeAST(ast, adapter, { checkImports: false, checkStrings: false, ...config }, source);
  const old = oldRaw
    .filter((v) => BLOCK_RULES.has(v.rule))
    .map((v) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();

  const fresh = await runDrySlice([{ path: 'parity.ts', content: source }], config);
  const nu = fresh
    .filter((f) => BLOCK_RULES.has(f.ruleId))
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();

  return { old, nu, fresh };
}

describe('Spec 68 code-block DRY parity (new analyze(ctx) === old UniversalDRYAnalyzer)', () => {
  it('two identical for-loops fire dry/duplicate once, anchored at the later block', async () => {
    const source = [
      'function process(rows) {',
      '  for (const row of rows) {',
      '    const id = row.id;',
      '    const name = row.name;',
      '    const value = row.value;',
      '    push({ id, name, value });',
      '  }',
      '  for (const row of rows) {',
      '    const id = row.id;',
      '    const name = row.name;',
      '    const value = row.value;',
      '    push({ id, name, value });',
      '  }',
      '}',
    ].join('\n');
    const { old, nu, fresh } = await parity(source, {
      minLineThreshold: 5,
      checkStructuralSimilarity: false,
      checkExpressionSimilarity: false,
    });
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    const dup = fresh.filter((f) => f.ruleId === 'dry/duplicate');
    expect(dup.length).toBe(1);
    expect(dup[0]).toMatchObject({
      line: 8,
      column: 3,
      message: 'Duplicate code block detected (6 lines). First occurrence at parity.ts:2',
    });
  });

  it('structurally-identical for-loops with different identifiers fire dry/structural-similarity', async () => {
    const source = [
      'function process(rows) {',
      '  for (const row of rows) {',
      '    const id = row.id;',
      '    const name = row.name;',
      '    const value = row.value;',
      '    pushA({ id, name, value });',
      '  }',
      '  for (const item of items) {',
      '    const id = item.id;',
      '    const name = item.name;',
      '    const value = item.value;',
      '    pushB({ id, name, value });',
      '  }',
      '}',
    ].join('\n');
    const { old, nu, fresh } = await parity(source, {
      minLineThreshold: 5,
      checkStructuralSimilarity: true,
      checkExpressionSimilarity: false,
    });
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    // No exact duplicate (different identifiers); the one finding is structural.
    expect(fresh.filter((f) => f.ruleId === 'dry/structural-similarity')).toHaveLength(1);
    expect(fresh.filter((f) => f.ruleId === 'dry/duplicate')).toHaveLength(0);
  });

  it('two near-identical object literals for the same target fire dry/similar-expression', async () => {
    const source = [
      'const info = {};',
      'info.resultSummary = { completedAt: now, tables: t, tableCounts: tc, stagingCounts: sc, steps: st };',
      'info.resultSummary = { completedAt: now, tables: t, tableCounts: tc, stagingCounts: sc, steps: st, durationMs: d };',
    ].join('\n');
    const { old, nu, fresh } = await parity(source, {
      checkStructuralSimilarity: false,
      checkExpressionSimilarity: true,
    });
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    const expr = fresh.filter((f) => f.ruleId === 'dry/similar-expression');
    expect(expr.length).toBe(1);
    expect(expr[0]).toMatchObject({
      line: 3,
      message: 'Near-identical object literal built for "info.resultSummary" detected ' +
        '(5 shared fields: completedAt, tables, tableCounts, stagingCounts, steps). ' +
        'First occurrence at parity.ts:2',
    });
  });

  it('§10 — structural-similarity fires unconditionally (flag no longer gates it off)', async () => {
    const source = [
      'function process(rows) {',
      '  for (const row of rows) {',
      '    const id = row.id;',
      '    const name = row.name;',
      '    const value = row.value;',
      '    pushA({ id, name, value });',
      '  }',
      '  for (const item of items) {',
      '    const id = item.id;',
      '    const name = item.name;',
      '    const value = item.value;',
      '    pushB({ id, name, value });',
      '  }',
      '}',
    ].join('\n');

    // §10 made the rule unconditional: the phase rule fires regardless of
    // `checkStructuralSimilarity`. It reproduces the legacy finding with the
    // legacy gate ON (the legacy analyzer is still gated until §15 deletes it).
    const { old, nu } = await parity(source, {
      minLineThreshold: 5,
      checkStructuralSimilarity: true,
      checkExpressionSimilarity: false,
    });
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);

    // The flag being off does NOT suppress the phase finding.
    const off = await runDrySlice([{ path: 'parity.ts', content: source }], {
      minLineThreshold: 5,
      checkStructuralSimilarity: false,
      checkExpressionSimilarity: false,
    });
    expect(off.filter((f) => f.ruleId === 'dry/structural-similarity').length).toBe(1);
  });

  it('does not compare blocks across different files (per-file grouping)', async () => {
    // One for-loop in each file — no duplicate within either file, so the
    // corpus-wide `code-block` fact must not collapse them into a false pair.
    const block = [
      'function process(rows) {',
      '  for (const row of rows) {',
      '    const id = row.id;',
      '    const name = row.name;',
      '    const value = row.value;',
      '    push({ id, name, value });',
      '  }',
      '}',
    ].join('\n');
    const fresh = await runDrySlice(
      [
        { path: 'a.ts', content: block },
        { path: 'b.ts', content: block },
      ],
      { minLineThreshold: 5, checkStructuralSimilarity: false, checkExpressionSimilarity: false },
    );
    expect(fresh.filter((f) => BLOCK_RULES.has(f.ruleId))).toEqual([]);
  });
});
