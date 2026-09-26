/**
 * Spec 68 §3.2 / §5 — the `table-catalog` corpus processor.
 *
 * The liveness guard (§16.1) runs every producer against *empty* upstream facts,
 * so it proves a corpus processor returns a live, shaped value — but not that its
 * reduction is correct. This test feeds real schema facts and asserts the flat
 * known-table set the `missing-org-filter` / `unknown-table` rules read.
 */

import { describe, it, expect } from 'vitest';
import { PRODUCERS } from '../phase/producers.js';
import type { SchemaDeclaration } from '../phase/types.js';

function catalog(decls: SchemaDeclaration[]) {
  const producer = PRODUCERS['table-catalog'] as {
    process(facts: { 'schema-json': SchemaDeclaration[]; 'schema-code': SchemaDeclaration[] }): unknown;
  };
  return producer.process({ 'schema-json': decls, 'schema-code': [] }) as { tables: { name: string; source: string }[] };
}

describe('Spec 68 table-catalog corpus processor', () => {
  it('reduces schema declarations to a flat, de-duplicated table set', () => {
    const decls: SchemaDeclaration[] = [
      { name: 'users', file: 'schemas/users.json', columns: [], origin: 'json' },
      { name: 'orders', file: 'migrations/001.ts', columns: [], origin: 'code' },
      // duplicate name across origins — first wins
      { name: 'users', file: 'migrations/000.ts', columns: [], origin: 'code' },
      // unnamed declaration — skipped
      { name: '', file: 'schemas/empty.json', columns: [], origin: 'json' },
    ];

    const out = catalog(decls);
    expect(out.tables).toEqual([
      { name: 'users', source: 'schemas/users.json' },
      { name: 'orders', source: 'migrations/001.ts' },
    ]);
  });

  it('returns an empty table set for no schema declarations', () => {
    expect(catalog([]).tables).toEqual([]);
  });
});
