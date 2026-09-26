/**
 * Spec 68 §3.2 — the `schema-usage` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array;
 * this test proves the extraction is *correct* against the fields the
 * cross-domain lifecycle rules read: the resolved `tableName`, the usage verb
 * (`usageType`), and the enclosing-function identity (`functionName` +
 * coordinate). It exercises the producer wiring in `producers.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import type { ParsedFile, SchemaUsageFact } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function usage(path: string, source: string): SchemaUsageFact[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = {
    file: path,
    format: 'typescript',
    source,
    ast,
    adapter: adapter!,
  };
  try {
    const producer = PRODUCERS['schema-usage'] as { process(f: ParsedFile): SchemaUsageFact[] };
    return producer.process(file);
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 68 schema-usage producer', () => {
  it('resolves a tagged-template SELECT to its table with the enclosing function', () => {
    const out = usage('/fixture/a.ts', [
      'export function listUsers(db) {',
      '  const q = sql`SELECT * FROM users WHERE id = 1`;',
      '  return q;',
      '}',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    const row = out[0];
    expect(row.tableName).toBe('users');
    expect(row.usageType).toBe('select');
    expect(row.functionName).toBe('listUsers');
    expect(row.filePath).toBe('/fixture/a.ts');
    // The identity is a coordinate: the enclosing function's start line is the
    // function's declaration line, never null for an in-function usage.
    expect(row.functionStartLine).toBe(1);
  });

  it('returns an empty array for a file with no table references', () => {
    const out = usage('/fixture/b.ts', 'export const x = 1;\n');
    expect(out).toEqual([]);
  });
});
