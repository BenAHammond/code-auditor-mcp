/**
 * Re-export (`export … from`) extraction for reachability.
 *
 * `createCrossLanguageEntityVisitor` feeds `clCollectFileInfo`, whose imports
 * become the edges `clComputeReachability` uses to decide whether a file is
 * dead. A barrel re-export (`export { dbPool } from './connectionPool'`) is an
 * import edge: the re-exported file is live. Without it, every file reachable
 * only through a barrel is wrongly flagged `unreferenced-module` — the largest
 * remaining false-positive class after the absolute-path resolution fix.
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
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('index.ts');
  if (!adapter) throw new Error('TypeScript adapter not registered');
  return adapter;
}

async function visit(source: string): Promise<Record<string, { imports: string[]; hasExports: boolean }>> {
  const visitor = createCrossLanguageEntityVisitor();
  const adapter = getAdapter();
  const ast: AST = await adapter.parse('index.ts', source);
  const result = await visitor.visit(ast, adapter, { filePath: 'index.ts' } as any, source);
  return (result.facts ?? {}) as any;
}

describe('createCrossLanguageEntityVisitor — re-export import edges', () => {
  it('records named re-export sources as imports', async () => {
    const facts = await visit("export { dbPool } from './connectionPool';");
    expect(facts['index.ts'].imports).toContain('./connectionPool');
    expect(facts['index.ts'].hasExports).toBe(true);
  });

  it('records star re-export sources as imports', async () => {
    const facts = await visit("export * from './app-db';");
    expect(facts['index.ts'].imports).toContain('./app-db');
  });

  it('does not fabricate an import for a plain export without `from`', async () => {
    const facts = await visit('export const x = 1;');
    expect(facts['index.ts'].hasExports).toBe(true);
    expect(facts['index.ts'].imports).toEqual([]);
  });
});
