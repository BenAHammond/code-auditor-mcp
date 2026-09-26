/**
 * Spec 68 §3.2 — the `function-index` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array
 * from a trivial fixture; it does not prove the extraction is *correct*. This
 * test feeds real TS/TSX fixtures and asserts the rows the conventions rules
 * read — entity/component classification, export status, and the resolved
 * `functionCalls` set that usage-pair mines. It is the §3.2 re-homing of
 * `createFunctionIndexVisitor`'s three passes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import type { ParsedFile, FunctionIndexFact } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function rows(path: string, source: string): FunctionIndexFact[] {
  const format = path.endsWith('.tsx') ? 'tsx' : 'typescript';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = { file: path, format, source, ast, adapter: adapter! };
  try {
    return PRODUCERS['function-index'][format].process(file);
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 68 function-index producer', () => {
  it('extracts a named function with export status and resolved calls', () => {
    const out = rows('/fixture/a.ts', [
      'import { send } from "./mail";',
      'export function notify() { send(); }',
    ].join('\n'));

    const fn = out.find((f) => f.name === 'notify')!;
    expect(fn).toBeDefined();
    expect(fn.entityType).toBe('function');
    expect(fn.isExported).toBe(true);
    expect(fn.functionCalls).toEqual(['send']);
    expect(fn.file).toBe('/fixture/a.ts');
    expect(fn.language).toBe('typescript');
  });

  it('extracts a class method under its class-qualified name', () => {
    const out = rows('/fixture/b.ts', [
      'class Service {',
      '  run() { this.go(); }',
      '}',
    ].join('\n'));

    const method = out.find((f) => f.name === 'Service.run')!;
    expect(method).toBeDefined();
    expect(method.entityType).toBe('method');
    expect(method.isExported).toBe(false);
    // `extractFunctionCalls` records the callee name, not the `this.` receiver.
    expect(method.functionCalls).toContain('go');
  });

  it('classifies a JSX function as a component and records its component type', () => {
    const out = rows('/fixture/c.tsx', [
      'export function Button({ label }: { label: string }) {',
      '  return <button>{label}</button>;',
      '}',
    ].join('\n'));

    const comp = out.find((f) => f.name === 'Button')!;
    expect(comp).toBeDefined();
    expect(comp.entityType).toBe('component');
    expect(comp.componentType).not.toBeNull();
  });

  it('returns an empty array for a file with no functions', () => {
    expect(rows('/fixture/d.ts', 'export const x = 1;\n')).toEqual([]);
  });
});
