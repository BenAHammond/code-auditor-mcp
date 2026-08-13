/**
 * Phase 1b — Verify every AST parse path sets dispose.
 *
 * If any adapter's parse() omits dispose, tree.delete() is never called
 * and WASM linear memory leaks silently. This test catches that at build time.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../index.js';

describe('AST.dispose', () => {
  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  const CASES: Array<{ ext: string; source: string }> = [
    {
      ext: '.ts',
      source: 'export function hello(): string { return "hi"; }',
    },
    {
      ext: '.tsx',
      source: 'export const Button = () => <div>hi</div>;',
    },
    {
      ext: '.js',
      source: 'export function hello() { return "hi"; }',
    },
    {
      ext: '.go',
      source: 'package main\n\nfunc main() {\n\tprintln("hi")\n}',
    },
    {
      ext: '.css',
      source: '.foo { color: red; }',
    },
  ];

  for (const { ext, source } of CASES) {
    it(`sets dispose on AST returned by ${ext} adapter`, async () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = registry.getAdapterForFile(`test${ext}`);
      expect(adapter, `no adapter for ${ext}`).toBeDefined();

      const ast = await adapter!.parse(`test${ext}`, source);
      expect(ast, 'parse returned null/undefined').toBeDefined();

      expect(ast.dispose, `dispose is missing on ${ext} AST`).toBeTypeOf('function');

      // Call it — must not throw.
      expect(() => ast.dispose!()).not.toThrow();
    });
  }
});
