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
    process(facts: { 'ddl-declarations': SchemaDeclaration[] }): unknown;
  };
  return producer.process({ 'ddl-declarations': decls }) as { tables: { name: string; source: string }[] };
}

describe('Spec 68 table-catalog corpus processor', () => {
  it('reduces schema declarations to a flat, de-duplicated table set', () => {
    const decls: SchemaDeclaration[] = [
      { name: 'users', file: 'migrations/002_users.ts', columns: [], origin: 'code' },
      { name: 'orders', file: 'migrations/001_orders.ts', columns: [], origin: 'code' },
      // duplicate name across files — first wins
      { name: 'users', file: 'migrations/000_legacy.ts', columns: [], origin: 'code' },
      // unnamed declaration — skipped
      { name: '', file: 'migrations/000_empty.ts', columns: [], origin: 'code' },
    ];

    const out = catalog(decls);
    expect(out.tables).toEqual([
      { name: 'users', source: 'migrations/002_users.ts' },
      { name: 'orders', source: 'migrations/001_orders.ts' },
    ]);
  });

  it('returns an empty table set for no schema declarations', () => {
    expect(catalog([]).tables).toEqual([]);
  });
});
