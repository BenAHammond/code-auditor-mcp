/**
 * Spec 44 R3 — the four missing extensions parse to a NON-EMPTY AST.
 *
 * `.mts`/`.cts` are syntactically plain TypeScript and `.mjs`/`.cjs` plain JS,
 * so they should resolve to the TypeScript adapter and parse to a real tree.
 * The hard check here is that the AST is *non-empty*: a grammar that silently
 * yields an empty tree (or one full of parse errors) looks identical to "a file
 * with no functions", which is precisely the silent-drop shape R3 exists to kill.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../index.js';
import { parseFile } from '../adapterBridge.js';

describe('R3 — missing extensions parse to non-empty ASTs', () => {
  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  const CASES: Array<{ ext: string; source: string }> = [
    {
      ext: '.mts',
      source: 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
    },
    {
      ext: '.cts',
      source: 'interface User { id: number }\nexport const u: User = { id: 1 };\n',
    },
    {
      ext: '.mjs',
      source: 'export function greet(name) {\n  return `hi ${name}`;\n}\n',
    },
    {
      ext: '.cjs',
      source: 'function greet(name) {\n  return `hi ${name}`;\n}\nmodule.exports = { greet };\n',
    },
  ];

  for (const { ext, source } of CASES) {
    it(`${ext} resolves the TypeScript adapter and parses to a non-empty AST`, () => {
      const registry = LanguageRegistry.getInstance();
      const adapter = registry.getAdapterForFile(`test${ext}`);
      expect(adapter, `no adapter for ${ext}`).toBeDefined();
      expect(adapter!.name).toBe('typescript');

      const ast = parseFile(`test${ext}`, source);
      expect(ast, `parseFile returned null for ${ext}`).not.toBeNull();
      expect(ast!.errors, `${ext} produced parse errors`).toEqual([]);

      // The hard check: a real, non-empty tree.
      expect(ast!.root.children, `${ext} parsed to an empty AST`).toBeDefined();
      expect(ast!.root.children!.length, `${ext} parsed to an empty AST`).toBeGreaterThan(0);
    });
  }

  it('.mts/.cts do not collide with the .ts suffix check (they are distinct, still routed to TS)', () => {
    // `.mts`/`.cts` do not end in `.ts`, so any naive endsWith('.ts')/endsWith('.tsx')
    // dispatch would misroute them. Assert the registry maps all four explicitly.
    const registry = LanguageRegistry.getInstance();
    expect(registry.getAdapterForFile('a.mts')!.name).toBe('typescript');
    expect(registry.getAdapterForFile('a.cts')!.name).toBe('typescript');
    expect(registry.getAdapterForFile('a.mjs')!.name).toBe('typescript');
    expect(registry.getAdapterForFile('a.cjs')!.name).toBe('typescript');
  });
});
