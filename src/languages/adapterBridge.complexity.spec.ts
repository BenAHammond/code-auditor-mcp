/**
 * Spec 68 tail — `calculateComplexity` (adapterBridge) must agree with
 * `getComplexity` (the adapter path `solid/method-complexity` reads) on the same
 * function. The defect this pins: `calculateComplexity`'s shared
 * `CONDITIONAL_TYPES` set counted BOTH a `switch_statement` and its `switch_case`
 * children, so every switch scored one higher than the rule's count. The fix
 * gives `calculateComplexity` its own decision-point set (drop `switch_statement`,
 * add `catch_clause`) so the two paths converge.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from './index.js';
import { parseFile, calculateComplexity } from './adapterBridge.js';
import { LanguageRegistry } from './LanguageRegistry.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function firstFunctionNode(adapter: ReturnType<LanguageRegistry['getAdapterForFile']>, source: string) {
  const ast = parseFile('/fixture/complexity.ts', source)!;
  const fns = adapter!.extractFunctions(ast);
  expect(fns.length).toBeGreaterThan(0);
  const fn = fns[0];
  // BFS to the function node at the first function's location (same algorithm the
  // SOLID analyzer uses), then wrap for the two complexity calculators.
  const queue: any[] = [ast.root];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (n.location?.start?.line === fn.location.start.line && n.location?.start?.column === fn.location.start.column) {
      return { node: n, adapter: adapter! };
    }
    if (n.children) queue.push(...n.children);
  }
  throw new Error('function node not found');
}

describe('calculateComplexity agrees with getComplexity', () => {
  const cases: Array<{ name: string; code: string }> = [
    {
      name: 'switch with two cases and a default',
      code: `export function switcher(x: string): number {
  switch (x) {
    case 'a': return 1;
    case 'b': return 2;
    default: return 0;
  }
}`,
    },
    {
      name: 'if / else-if / else',
      code: `export function branched(a: number): number {
  if (a > 0) return 1;
  else if (a < 0) return -1;
  else return 0;
}`,
    },
    {
      name: 'try / catch / finally',
      code: `export function guarded(a: number): number {
  try { return a; }
  catch { return 0; }
}`,
    },
    {
      name: 'loop + logical operators',
      code: `export function loopAndOp(items: number[]): number {
  let n = 0;
  for (const x of items) {
    if (x && x > 0) n++;
  }
  return n;
}`,
    },
  ];

  for (const { name, code } of cases) {
    it(name, () => {
      const adapter = LanguageRegistry.getInstance().getAdapterForFile('complexity.ts')!;
      const { node, adapter: ad } = firstFunctionNode(adapter, code);
      const bridge = calculateComplexity(node);
      const rule = ad.getComplexity(node);
      expect(bridge, 'adapterBridge.calculateComplexity').toBe(rule);
      expect(bridge, 'adapterBridge.calculateComplexity').toBe(ad.getComplexity(node));
    });
  }

  it('does not double-count the switch_statement itself', () => {
    const adapter = LanguageRegistry.getInstance().getAdapterForFile('complexity.ts')!;
    const source = `export function sw(x: string): number {
  switch (x) {
    case 'a': return 1;
    case 'b': return 2;
  }
  return 0;
}`;
    const { node } = firstFunctionNode(adapter, source);
    // 1 base + 2 switch_case = 3 (not 4 with a stray switch_statement).
    expect(calculateComplexity(node)).toBe(3);
  });
});
