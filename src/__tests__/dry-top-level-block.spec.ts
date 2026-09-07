/**
 * Spec 49 "after-33" pass — Bug B1: the `program`-node location collision.
 *
 * `extractCodeBlocks` collects a block for every function/class/method by
 * resolving its start location back to an AST node via `findNodeByLocation`.
 * That helper was a BFS that returned the *first* node whose `location.start`
 * matched. The AST `program` node reports its start at the same (line, column)
 * as its first child, so for a *non-`export`ed* top-level declaration (whose
 * `function_declaration` node starts at column 1, the same as `program`) the
 * BFS matched `program` — the whole-file wrapper — instead of the declaration
 * itself. `deduplicateBlocks` then absorbed that whole-file block (an outer
 * block fully containing its inner blocks is replaced by them), so the first
 * top-level function in every file was silently dropped as a candidate block
 * and never compared.
 *
 * The consequence is that a pair of structurally-identical *top-level*
 * functions could not fire `dry/structural-similarity` — only their inner
 * `if`/`for` bodies survived to be compared. These tests pin the fix: the
 * most-specific node (smallest span) at a location must win, so a top-level
 * declaration is compared as itself.
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
  const ast = parseFile('dry-top-level-block.ts', sourceCode)!;
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

/**
 * Two structurally-identical top-level functions (same token-kind skeleton,
 * different names). `first` spans lines 1–6, `second` starts at line 8.
 */
const IDENTICAL_TOP_LEVEL = `function first(items: string[]) {
  const out = items.map((i) => i.toLowerCase());
  const joined = out.join(",");
  const suffix = out.slice(0, 2);
  return joined + suffix.length;
}

function second(items: string[]) {
  const out = items.map((i) => i.toLowerCase());
  const joined = out.join(",");
  const suffix = out.slice(0, 2);
  return joined + suffix.length;
}`;

/** Two structurally-different top-level functions. */
const DIFFERENT_TOP_LEVEL = `function first(items: string[]) {
  const out = items.map((i) => i.toLowerCase());
  return out.join(",");
}

function second(items: string[]) {
  const total = items.reduce((sum, item) => sum + item.length, 0);
  return String(total);
}`;

describe('dry — top-level blocks survive the program-node collision', () => {
  it('fires structural-similarity for two identical top-level functions', async () => {
    const vs = structural(await run(IDENTICAL_TOP_LEVEL, ENABLED));
    expect(vs.length).toBeGreaterThanOrEqual(1);
    // The finding must land on the *second function* (line 8), not an inner
    // body line — the old program-node collision never compared the top-level
    // declaration itself.
    expect(vs.some((v) => v.line === 8)).toBe(true);
  });

  it('stays silent on two different top-level functions (near-miss)', async () => {
    const vs = structural(await run(DIFFERENT_TOP_LEVEL, ENABLED));
    expect(vs).toHaveLength(0);
  });

  it('fires when the first identical function starts at line 1 (inverse near-miss)', async () => {
    // No leading newline: `first` is the file's first token, exactly where the
    // program-node collision was worst (program.start === first.start).
    const source = `function first(items: string[]) {
  const out = items.map((i) => i.toLowerCase());
  const joined = out.join(",");
  return joined;
}

function second(items: string[]) {
  const out = items.map((i) => i.toLowerCase());
  const joined = out.join(",");
  return joined;
}`;
    const vs = structural(await run(source, ENABLED));
    expect(vs.length).toBeGreaterThanOrEqual(1);
    // `second` starts at line 7.
    expect(vs.some((v) => v.line === 7)).toBe(true);
  });
});
