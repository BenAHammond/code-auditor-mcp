/**
 * Dynamic import()/require() edges for reachability (Spec 58 R2).
 *
 * `clCollectFileInfo` feeds `clComputeReachability`, which decides whether a
 * file is dead. A dynamic `await import('./email')` with a static string
 * argument is an import edge — the target file is live, so `unreferenced-module`
 * must not fire. A computed specifier (`import(someVar)`) cannot be resolved
 * into an edge; it is surfaced as `unresolvedDynamicImports` rather than
 * silently dropped.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from './languages/index.js';
import { LanguageRegistry } from './languages/LanguageRegistry.js';
import { createCrossLanguageEntityVisitor } from './pipelineAdapters.js';
import type { LanguageAdapter, AST } from './languages/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function getAdapter(): LanguageAdapter {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('auth.ts');
  if (!adapter) throw new Error('TypeScript adapter not registered');
  return adapter;
}

interface FileFact {
  imports: string[];
  hasExports: boolean;
  unresolvedDynamicImports: Array<{ line: number; expression: string }>;
}

async function visit(source: string): Promise<Record<string, FileFact>> {
  const visitor = createCrossLanguageEntityVisitor();
  const adapter = getAdapter();
  const ast: AST = await adapter.parse('auth.ts', source);
  const result = await visitor.visit(ast, adapter, { filePath: 'auth.ts' } as any, source);
  return (result.facts ?? {}) as any;
}

describe('createCrossLanguageEntityVisitor — dynamic import()/require() edges', () => {
  it('records a static-string await import() as an import edge', async () => {
    const facts = await visit("const { sendOtp } = await import('./email');");
    expect(facts['auth.ts'].imports).toContain('./email');
    expect(facts['auth.ts'].unresolvedDynamicImports).toEqual([]);
  });

  it('records a static-string require() as an import edge', async () => {
    const facts = await visit("const { sendOtp } = require('./email');");
    expect(facts['auth.ts'].imports).toContain('./email');
    expect(facts['auth.ts'].unresolvedDynamicImports).toEqual([]);
  });

  it('surfaces a computed import() specifier as unresolved (not silenced)', async () => {
    const facts = await visit('const mod = await import(specifier);');
    expect(facts['auth.ts'].imports).toEqual([]);
    expect(facts['auth.ts'].unresolvedDynamicImports).toHaveLength(1);
    expect(facts['auth.ts'].unresolvedDynamicImports[0].expression).toBe('specifier');
    expect(facts['auth.ts'].unresolvedDynamicImports[0].line).toBeGreaterThan(0);
  });

  it('surfaces a computed require() specifier as unresolved', async () => {
    const facts = await visit('const mod = require(specifier);');
    expect(facts['auth.ts'].imports).toEqual([]);
    expect(facts['auth.ts'].unresolvedDynamicImports).toHaveLength(1);
    expect(facts['auth.ts'].unresolvedDynamicImports[0].expression).toBe('specifier');
  });

  it('records a no-interpolation template literal as an import edge (not computed)', async () => {
    const facts = await visit('const x = await import(`./email`);');
    expect(facts['auth.ts'].imports).toContain('./email');
    expect(facts['auth.ts'].unresolvedDynamicImports).toEqual([]);
  });

  it('surfaces an interpolated template literal as a computed specifier', async () => {
    const facts = await visit('const x = await import(`./${name}.js`);');
    expect(facts['auth.ts'].imports).toEqual([]);
    expect(facts['auth.ts'].unresolvedDynamicImports).toHaveLength(1);
    expect(facts['auth.ts'].unresolvedDynamicImports[0].expression).toBe('`./${name}.js`');
  });
});
