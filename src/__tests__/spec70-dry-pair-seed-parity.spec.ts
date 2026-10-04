/**
 * Spec 70 2b — parity: `seedDryPairs` over the phase `code-block` fact reproduces
 * the legacy `UniversalDRYAnalyzer`'s accumulated pair seed byte-for-byte.
 *
 * The `dry_pair_history` write moved off `createDryVisitor` (which accumulated
 * pairs during its own `analyzeAST`) onto the phase `code-block` fact at the end
 * of the phase run. This test pins that the moved writer seeds the *identical*
 * `(pairFingerprint, file, symbol, line, contentHash, similarity)` multiset the
 * legacy visitor would have written — same per-file filter → dedupe → compare,
 * and, load-bearing, the legacy **bare-token-set** Jaccard for the structural
 * arm (the migrated `dry/structural-similarity` rule uses a bigram Jaccard, a
 * deliberate divergence that the *write* must not inherit).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDRYAnalyzer } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import { buildCodeBlocks } from '../phase/runner.js';
import { seedDryPairs, resolveBlockConfig, type DryPairSeed } from '../phase/rules/dry.js';
import type { Violation } from '../types.js';

let adapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

/** A fresh legacy analyzer (its pair accumulator is per-instance, not reset). */
function freshAnalyzer(): UniversalDRYAnalyzer {
  return new UniversalDRYAnalyzer();
}

/** Canonical key so the multiset is order-independent. */
function key(p: DryPairSeed): string {
  return [
    p.pairFingerprint, p.file1, p.symbol1, p.line1, p.contentHash1,
    p.file2, p.symbol2, p.line2, p.contentHash2, p.similarity, p.rule,
  ].join('|');
}

async function parity(source: string, config: Record<string, unknown>): Promise<{ legacy: DryPairSeed[]; seeded: DryPairSeed[] }> {
  const analyzer = freshAnalyzer();
  const ast = parseFile('parity.ts', source);
  expect(ast, 'fixture failed to parse').not.toBeNull();
  await (analyzer as unknown as {
    analyzeAST(ast: unknown, a: LanguageAdapter, c: unknown, s: string): Promise<Violation[]>;
  }).analyzeAST(ast, adapter, { checkImports: false, checkStrings: false, ...config }, source);
  const legacy = (analyzer as unknown as { dryPairs: DryPairSeed[] }).dryPairs;

  const codeBlocks = await buildCodeBlocks([{ path: 'parity.ts', content: source }]);
  const seeded = seedDryPairs(codeBlocks, resolveBlockConfig(config));

  return { legacy, seeded };
}

describe('Spec 70 dry-pair seed parity (seedDryPairs === legacy UniversalDRYAnalyzer.dryPairs)', () => {
  it('seeds the exact-duplicate pair the legacy visitor accumulated', async () => {
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
    const { legacy, seeded } = await parity(source, {
      minLineThreshold: 5,
      checkStructuralSimilarity: false,
      checkExpressionSimilarity: false,
    });
    expect(legacy.length).toBe(1);
    expect(legacy[0].rule).toBe('dry/duplicate');
    expect(legacy[0].similarity).toBe(1.0);
    expect(seeded.map(key).sort()).toEqual(legacy.map(key).sort());
  });

  it('seeds structural pairs with the legacy bare-token-set Jaccard, gated on checkStructuralSimilarity', async () => {
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
    const { legacy, seeded } = await parity(source, {
      minLineThreshold: 5,
      checkStructuralSimilarity: true,
      checkExpressionSimilarity: false,
    });
    expect(legacy.length).toBe(1);
    expect(legacy[0].rule).toBe('dry/structural-similarity');
    // The fixture's two loops normalize to identical token-kind skeletons, so the
    // bare-token-set Jaccard is exactly 1.0 (>= the 0.85 threshold). The load-bearing
    // check is the next line: the seed reproduces the legacy similarity value exactly.
    expect(legacy[0].similarity).toBe(1.0);
    expect(seeded.map(key).sort()).toEqual(legacy.map(key).sort());
  });

  it('does not seed a structural pair when checkStructuralSimilarity is off (legacy gate)', async () => {
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
    const { legacy, seeded } = await parity(source, {
      minLineThreshold: 5,
      checkStructuralSimilarity: false,
      checkExpressionSimilarity: false,
    });
    // No exact duplicate (different identifiers) and no structural seed (gate off).
    expect(legacy.length).toBe(0);
    expect(seeded.length).toBe(0);
  });

  it('does not compare blocks across files (per-file seed, mirroring analyzeAST)', async () => {
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
    const codeBlocks = await buildCodeBlocks([
      { path: 'a.ts', content: block },
      { path: 'b.ts', content: block },
    ]);
    const seeded = seedDryPairs(codeBlocks, resolveBlockConfig({ minLineThreshold: 5, checkStructuralSimilarity: false, checkExpressionSimilarity: false }));
    expect(seeded).toEqual([]);
  });
});
