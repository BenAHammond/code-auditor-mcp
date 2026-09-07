/**
 * Spec 49 Session 26 — `dry/structural-similarity` (authenticity ledger row 120).
 *
 * The ledger gap: the registry advertises `{similarity}%` and a
 * `similarityThreshold` (0.85), but the detection is exact token-kind-sequence
 * equality (grouped by `structuralHash`) — no similarity percentage is computed,
 * and `similarityThreshold` is declared but never read. Worse, the emitted
 * message interpolates a *text* Jaccard over `normalizedText` (raw identifiers
 * and literals still present), not a *structural* Jaccard over the token-kind
 * skeleton. A structurally-identical pair would be reported as e.g. "60% similar"
 * because the *identifiers* differ, even though the *structure* is 100% identical.
 *
 * The honest fix: compute structural Jaccard over the token-kind skeletons and
 * actually gate on `similarityThreshold`, so the rule detects "≥ N% structurally
 * similar" rather than only "structurally identical".
 *
 * Fixtures are class-wrapped methods rather than top-level functions: the AST
 * `program` node's start location collides with the first top-level declaration
 * (a pre-existing block-extraction bug, flagged separately), so a top-level
 * function pair would collapse to a single block and never compare. Methods
 * survive `deduplicateBlocks` as sibling inner blocks.
 *
 * These three tests pin that behavior through `analyzeAST`:
 *   1. positive — structurally identical blocks fire with an honest ~100%
 *      structural similarity (not the lower text similarity).
 *   2. near-miss — structurally different blocks stay silent.
 *   3. inverse near-miss — blocks ≥ threshold but not identical fire (the case
 *      the exact-hash grouping would miss entirely).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDRYAnalyzer, DEFAULT_DRY_CONFIG } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import type { Violation } from '../types.js';

let analyzer: UniversalDRYAnalyzer;
let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
  analyzer = new UniversalDRYAnalyzer();
}, 30_000);

async function run(sourceCode: string, overrides: Record<string, unknown> = {}): Promise<Violation[]> {
  const ast = parseFile('dry-structural-similarity.ts', sourceCode)!;
  if (!ast) throw new Error('failed to parse fixture');
  return (await (analyzer as any).analyzeAST(
    ast,
    tsAdapter,
    { ...DEFAULT_DRY_CONFIG, ...overrides },
    sourceCode,
  )) as Violation[];
}

const structural = (vs: Violation[]) => vs.filter((v) => v.rule === 'dry/structural-similarity');

/** Enable structural similarity with a low line floor so small fixtures qualify. */
const ENABLED = { checkStructuralSimilarity: true, minLineThreshold: 3 };

/** Structurally identical: same token-kind skeleton, different identifiers/literals. */
const IDENTICAL_STRUCTURE = `
class Processor {
  alpha(id: string) {
    const a = id + "suffix";
    const b = a.toUpperCase();
    const c = b.split(",");
    return c.join("|");
  }
  beta(name: string) {
    const x = name + "other";
    const y = x.toLowerCase();
    const z = y.split(";");
    return z.join("#");
  }
}
`;

/** Structurally different: different statement shapes, low structural overlap. */
const DIFFERENT_STRUCTURE = `
class Processor {
  alpha(x: number) {
    const r = x + 1;
    return r * r;
  }
  beta(s: string) {
    const t = s.length;
    const u = t.toString();
    return u;
  }
}
`;

/** Near-miss: same shape plus one extra statement — ≥85% but not identical. */
const NEAR_MISS_STRUCTURE = `
class Processor {
  alpha(x: number) {
    const a = x + 1;
    const b = x * 2;
    return a + b;
  }
  beta(y: number) {
    const a = y + 1;
    const b = y * 2;
    const c = y - 3;
    return a + b + c;
  }
}
`;

describe('dry/structural-similarity — honest thresholded structural similarity', () => {
  it('fires on structurally-identical blocks and reports ~100% structural similarity', async () => {
    const vs = structural(await run(IDENTICAL_STRUCTURE, ENABLED));
    expect(vs.length).toBeGreaterThanOrEqual(1);

    const pct = vs[0].message?.match(/(\d+)% similar/)?.[1];
    expect(pct).toBeTruthy();
    // Structural similarity is 100% for identical skeletons — the message must
    // report that, not the lower text similarity the old code computed.
    expect(Number(pct)).toBeGreaterThanOrEqual(95);
  });

  it('stays silent on structurally different blocks (below threshold)', async () => {
    const vs = structural(await run(DIFFERENT_STRUCTURE, ENABLED));
    expect(vs).toHaveLength(0);
  });

  it('fires on near-miss blocks ≥ threshold but not identical (exact-hash grouping misses these)', async () => {
    const vs = structural(await run(NEAR_MISS_STRUCTURE, ENABLED));
    expect(vs.length).toBeGreaterThanOrEqual(1);

    const pct = vs[0].message?.match(/(\d+)% similar/)?.[1];
    expect(pct).toBeTruthy();
    // Honest near-miss: below 100% (not an exact skeleton match), at/above 85%.
    const n = Number(pct);
    expect(n).toBeGreaterThanOrEqual(85);
    expect(n).toBeLessThan(100);
  });
});
