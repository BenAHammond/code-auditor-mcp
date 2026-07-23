/**
 * Spec-19 R1.3 — Per-node-shape unit tests for getComplexity()
 *
 * Verifies that the TypeScript adapter's getComplexity() returns correct
 * cyclomatic complexity for each function declaration shape.
 * This guards against one shape silently returning 1 while the code
 * expects a higher value (or vice versa — returning high values for
 * simple shapes, which is the Spec-19 R1 defect).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../../languages/index.js';
import { parseFile } from '../../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../../languages/types.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtureDir = join(tmpdir(), 'spec19-complexity-' + Date.now());

// All the test shapes — each is a complete TypeScript module with one
// function/component of known cyclomatic complexity.
// We parse each and call adapter.getComplexity() to verify the result.
const SHAPES: Record<string, { code: string; expected: number }> = {
  // ── Branched shapes (positive controls) ────────────────────────────
  'function with if-else': {
    code: `export function branched(a: number): string {
  if (a > 0) {
    return 'positive';
  } else if (a < 0) {
    return 'negative';
  } else {
    return 'zero';
  }
}`,
    expected: 3, // 1 base + 2 if/else-if
  },
  'function with ternary': {
    code: `export function ternary(n: number): string {
  return n % 2 === 0 ? 'even' : 'odd';
}`,
    expected: 2, // 1 base + 1 ternary
  },
  'function with for loop': {
    code: `export function withLoop(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}`,
    expected: 2, // 1 base + 1 for_in_statement
  },
  'function with while': {
    code: `export function whileLoop(n: number): number {
  let i = 0;
  while (i < n) {
    i++;
  }
  return i;
}`,
    expected: 2, // 1 base + 1 while
  },
  'function with && and || operators': {
    code: `export function logicalOps(a: boolean, b: boolean, c: boolean): boolean {
  return a && b || c;
}`,
    expected: 3, // 1 base + 2 logical operators (&&, ||)
  },
  'function with switch-case': {
    code: `export function switcher(x: string): number {
  switch (x) {
    case 'a':
      return 1;
    case 'b':
      return 2;
    default:
      return 0;
  }
}`,
    expected: 3, // 1 base + 2 switch_case (a, b) — default is also a case but we count cases
  },
  // ── Simple shapes (assert complexity = 1) ──────────────────────────
  'simple function declaration': {
    code: `export function simple(a: number, b: number): number {
  return a + b;
}`,
    expected: 1,
  },
  'arrow function': {
    code: `export const arrow = (a: number, b: number): number => a + b;`,
    expected: 1,
  },
  'arrow function with block body': {
    code: `export const blockArrow = (items: string[]): string[] => {
  const result = items.map(i => i.trim());
  return result;
};`,
    expected: 1,
  },
  'async function': {
    code: `export async function fetcher(url: string): Promise<string> {
  const resp = await fetch(url);
  return resp.text();
}`,
    expected: 1,
  },
  'generator function': {
    code: `export function* gen(): Generator<number> {
  yield 1;
  yield 2;
  yield 3;
}`,
    expected: 1,
  },
  'class method': {
    code: `export class Calc {
  add(a: number, b: number): number {
    return a + b;
  }
}`,
    expected: 1,
  },
  // Item 11 shape: long function with only a .map() callback (no branches)
  'long function with map callback': {
    code: `export async function longWithMap(): Promise<Array<{ id: number; name: string }>> {
  const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  return rows.map(row => ({
    id: row.id,
    name: row.name.toUpperCase(),
  }));
}`,
    expected: 1,
  },
  // Item 17 shape: data assembly with object spread (no branches)
  'data assembly with object spread': {
    code: `export function assemble(record: { id: string; fields: Record<string, string> }): Record<string, unknown> {
  const { id, fields } = record;
  const attrs = { ...fields, source: 'engine' };
  const result = { id, attrs, normalized: true };
  return result;
}`,
    expected: 1,
  },
  // Nested arrow function with branches — current implementation
  // counts inner arrow branches as part of the outer function's complexity.
  // This is a known behavior (not a bug for Spec-19); the recursive walk
  // treats arrow bodies as part of the enclosing function's subtree.
  'outer function with branched inner arrow': {
    code: `export function outer(items: Array<{ a: number }>): string[] {
  return items.map(item => {
    if (item.a > 0) {
      return 'positive';
    }
    return 'zero';
  });
}`,
    expected: 2, // OUTER 1 + inner arrow's if = 2 (current behavior)
  },
};

describe('Spec-19 R1.3: getComplexity() per node shape', () => {
  let tsAdapter: LanguageAdapter;

  beforeAll(async () => {
    // Init parsers once
    initializeLanguages();
    await initParsers();
    await mkdir(fixtureDir, { recursive: true });
    // Get the TypeScript adapter
    tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
    if (!tsAdapter) {
      throw new Error('TypeScript adapter not found');
    }
  });

  for (const [name, { code, expected }] of Object.entries(SHAPES)) {
    it(name, async () => {
      const filePath = join(fixtureDir, `test-${name.replace(/[^a-z0-9]+/g, '-')}.ts`);
      await writeFile(filePath, code, 'utf-8');

      // Read and parse the file
      const sourceCode = await readFile(filePath, 'utf-8');
      const ast = parseFile(filePath, sourceCode)!;
      if (!ast) throw new Error(`Failed to parse ${filePath}`);

      // Find the first function-like node
      const fnInfo = tsAdapter.extractFunctions(ast);
      expect(fnInfo.length, `Expected at least one function found in: ${name}`).toBeGreaterThan(0);

      // Use findNodeByLocation (BFS) — same algorithm used by SOLID analyzer — to locate the raw AST
      // node that produced this FunctionInfo entry
      const firstFn = fnInfo[0];
      const fnNode = findInAST(ast.root, firstFn.location.start.line, firstFn.location.start.column);
      expect(fnNode, `Could not find AST node for function at ${firstFn.location.start.line}:${firstFn.location.start.column} in: ${name}`).not.toBeNull();

      const complexity = tsAdapter.getComplexity(fnNode!);

      // Allow an `expected` of -1 to skip the exact match (documentation-only test)
      if (expected >= 0) {
        expect(complexity, `Complexity mismatch for "${name}"`).toBe(expected);
      }
    });
  }
});

/** BFS search for a node at (line, column) — same algorithm as the SOLID analyzer uses. */
function findInAST(root: { location: { start: { line: number; column: number } }; type?: string; children?: any[] }, line: number, column: number): any | null {
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.location?.start?.line === line && node.location?.start?.column === column) {
      return node;
    }
    if (node.children) {
      queue.push(...node.children);
    }
  }
  return null;
}
