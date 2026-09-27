/**
 * Spec 68 §3.2 — parity: the migrated `duplicate-string-literal` rule
 * reproduces the old `UniversalDRYAnalyzer.checkDuplicateStrings` findings
 * exactly.
 *
 * `checkDuplicateStrings` is the string-literal-servable DRY detector (the
 * code-block rules read blocks/shapes the `string-literals` fact cannot serve),
 * so this test runs both paths for that single rule and asserts the identity
 * multisets are equal and non-empty. The legacy side is `analyzeAST` with the
 * other DRY checks disabled (`checkStrings: true`, everything else off) so the
 * only dry finding emitted is `duplicate-string-literal`.
 *
 * The per-file grouping is the load-bearing property: the legacy detector ran
 * once per AST, so two files each containing the same literal twice are NOT
 * duplicates. The multi-file case pins that the corpus-wide `string-literals`
 * fact does not collapse those single-file occurrences into a false positive.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDRYAnalyzer } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import { runDrySlice } from '../phase/runner.js';
import { dryRules } from '../phase/rules/dry.js';
import type { Violation } from '../types.js';

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

/** Run the old `checkDuplicateStrings` and the new slice, return the identity multisets. */
async function parity(source: string) {
  const ast = parseFile('parity.ts', source);
  expect(ast, 'fixture failed to parse').not.toBeNull();
  const oldRaw = await (analyzer as unknown as {
    analyzeAST(ast: unknown, a: LanguageAdapter, c: unknown, s: string): Promise<Violation[]>;
  }).analyzeAST(ast, adapter, {
    checkImports: false,
    checkStrings: true,
    checkStructuralSimilarity: false,
    checkExpressionSimilarity: false,
  }, source);
  const old = oldRaw
    .filter((v) => v.rule === 'duplicate-string-literal')
    .map((v) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();

  // Thread the same config the legacy side runs under: `checkStrings: true` gates
  // the migrated `duplicate-string-literal` rule on (default off), matching `analyzeAST`.
  const fresh = await runDrySlice([{ path: 'parity.ts', content: source }], { checkStrings: true });
  const nu = fresh
    .filter((f) => f.ruleId === 'duplicate-string-literal')
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();

  return { old, nu, fresh };
}

describe('Spec 68 dry parity (new analyze(ctx) === old checkDuplicateStrings)', () => {
  it('covers exactly the six import/string/code-block/history-servable DRY rules', () => {
    expect(dryRules.map((r) => r.id)).toEqual([
      'duplicate-import',
      'duplicate-string-literal',
      'dry/duplicate',
      'dry/structural-similarity',
      'dry/similar-expression',
      'dry/diverging-clone',
    ]);
  });

  it('three identical string literals fire once, anchored at the first occurrence', async () => {
    const source = [
      "const a = 'the quick brown fox jumps over';",
      "const b = 'the quick brown fox jumps over';",
      "const c = 'the quick brown fox jumps over';",
      '',
    ].join('\n');
    const { old, nu, fresh } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(1);
    // `value` is the raw getNodeText (quotes included) — the same key the legacy
    // detector grouped and the same text its message/symbol substrings sliced.
    const value = "'the quick brown fox jumps over'";
    const dup = fresh.filter((f) => f.ruleId === 'duplicate-string-literal')[0];
    expect(dup).toMatchObject({
      line: 1,
      column: 11,
      symbol: value.substring(0, 50),
      message: `String literal "${value.substring(0, 30)}..." is duplicated 3 times`,
      severity: 'high',
      fix: { oldText: value, newText: '// Consider extracting to a constant' },
    });
  });

  it('two identical string literals do not fire (needs >2)', async () => {
    const source = [
      "const a = 'the quick brown fox jumps over';",
      "const b = 'the quick brown fox jumps over';",
      '',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(0);
  });

  it('short literals (length <= 10) never fire', async () => {
    const source = [
      "const a = 'short';",
      "const b = 'short';",
      "const c = 'short';",
      "const d = 'short';",
      '',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(0);
  });

  it('distinct literals do not fire', async () => {
    const source = [
      "const a = 'the quick brown fox jumps over';",
      "const b = 'the lazy dog sleeps all day';",
      "const c = 'the very different string here';",
      '',
    ].join('\n');
    const { old, nu } = await parity(source);
    expect(nu).toEqual(old);
    expect(nu.length).toBe(0);
  });

  it('does not collapse single-file occurrences across different files (per-file grouping)', async () => {
    // Each file contains the literal twice — within each file that is 2 (not >2).
    const fresh = await runDrySlice([
      { path: 'a.ts', content: "const a = 'the quick brown fox jumps over';\nconst b = 'the quick brown fox jumps over';\n" },
      { path: 'b.ts', content: "const a = 'the quick brown fox jumps over';\nconst b = 'the quick brown fox jumps over';\n" },
    ], { checkStrings: true });
    expect(fresh.filter((f) => f.ruleId === 'duplicate-string-literal')).toEqual([]);
  });
});
