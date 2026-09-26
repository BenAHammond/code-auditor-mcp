/**
 * Spec 68 §3.2 — the `ddl-declarations` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array;
 * this test proves the extraction is *correct* against the fields the
 * `table-catalog` corpus processor and the tenant-scoping question read: the
 * net table `name` after CREATE/DROP/RENAME replay, the per-table `columns`,
 * and the `origin: 'code'` tag. It exercises the producer wiring in
 * `producers.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import type { ParsedFile, SchemaDeclaration } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function code(path: string, source: string): SchemaDeclaration[] {
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
    return PRODUCERS['ddl-declarations']['typescript'].process(file);
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 68 ddl-declarations producer', () => {
  it('declares a CREATE TABLE from DDL in a template literal, with columns', () => {
    const out = code('/fixture/migration.ts', [
      'export const up = `',
      'CREATE TABLE users (',
      '  id TEXT PRIMARY KEY,',
      '  organization_id TEXT NOT NULL',
      ');',
      '`;',
    ].join('\n'));

    expect(out).toHaveLength(1);
    const decl = out[0];
    expect(decl.name).toBe('users');
    expect(decl.origin).toBe('code');
    expect(decl.file).toBe('/fixture/migration.ts');
    // Columns are lowercased by the DDL extractor (the tenant-scoping question
    // compares case-insensitively).
    expect(decl.columns.map((c) => c.name)).toEqual(['id', 'organization_id']);
  });

  it('replays DROP so a dropped table is not declared', () => {
    const out = code('/fixture/dropped.ts', [
      'export const up = `',
      'CREATE TABLE scratch (id TEXT);',
      'DROP TABLE scratch;',
      '`;',
    ].join('\n'));

    expect(out).toEqual([]);
  });

  it('returns an empty array for a file with no DDL', () => {
    const out = code('/fixture/c.ts', 'export const x = 1;\n');
    expect(out).toEqual([]);
  });
});
