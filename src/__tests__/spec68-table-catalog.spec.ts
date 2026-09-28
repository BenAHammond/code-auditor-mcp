/**
 * Spec 68 §3.2 / §5 — the `table-catalog` corpus processor.
 *
 * The liveness guard (§16.1) runs every producer against *empty* upstream facts,
 * so it proves a corpus processor returns a live, shaped value — but not that its
 * reduction is correct. This test feeds real per-file `ddl-declarations` and
 * asserts the flat known-table set the `missing-org-filter` / `unknown-table`
 * rules read: the *net* table set after replaying CREATE/DROP/RENAME across
 * files in migration order (a table a later migration drops is a stale
 * reference, not a known table).
 */

import { describe, it, expect } from 'vitest';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import type { SchemaDeclaration, SchemaObject } from '../phase/types.js';

function catalog(decls: SchemaDeclaration[], objects: SchemaObject[] = []) {
  return CORPUS_PRODUCERS['table-catalog'].process({ 'ddl-declarations': decls, 'schema-objects': objects });
}

describe('Spec 68 table-catalog corpus processor', () => {
  it('reduces per-file DDL to the net table set in migration order', () => {
    const decls: SchemaDeclaration[] = [
      { file: 'migrations/001_orders.ts', ops: [{ op: 'CREATE', table: 'orders' }], tableColumns: {} },
      { file: 'migrations/002_users.ts', ops: [{ op: 'CREATE', table: 'users' }], tableColumns: {} },
    ];

    expect(catalog(decls).tables).toEqual([
      { name: 'orders', source: 'migrations/001_orders.ts', columns: [] },
      { name: 'users', source: 'migrations/002_users.ts', columns: [] },
    ]);
  });

  it('excludes a table dropped by a later migration (stale, not known)', () => {
    const decls: SchemaDeclaration[] = [
      { file: 'migrations/001_init.ts', ops: [{ op: 'CREATE', table: 'generation_queue' }], tableColumns: {} },
      { file: 'migrations/002_drop.ts', ops: [{ op: 'DROP', table: 'generation_queue' }], tableColumns: {} },
    ];

    expect(catalog(decls).tables).toEqual([]);
  });

  it('carries per-table columns through for Tier 3 DDL tenant discovery', () => {
    const decls: SchemaDeclaration[] = [
      {
        file: 'migrations/003_projects.ts',
        ops: [{ op: 'CREATE', table: 'projects' }],
        tableColumns: { projects: ['id', 'org_id'] },
      },
    ];

    expect(catalog(decls).tables).toEqual([
      { name: 'projects', source: 'migrations/003_projects.ts', columns: ['id', 'org_id'] },
    ]);
  });

  it('returns an empty table set for no schema declarations', () => {
    expect(catalog([]).tables).toEqual([]);
  });

  it('folds ORM schema-object bindings into the identifier → SQL-name alias map', () => {
    const objects: SchemaObject[] = [
      { file: 'database/schema.ts', identifier: 'sampleOwnership', table: 'sample_ownership' },
      { file: 'database/schema.ts', identifier: 'organizations', table: 'organizations' },
    ];

    expect(catalog([], objects).aliases).toEqual({
      sampleOwnership: 'sample_ownership',
      organizations: 'organizations',
    });
  });

  it('keeps the first binding when an identifier is declared twice', () => {
    const objects: SchemaObject[] = [
      { file: 'a.ts', identifier: 'users', table: 'users' },
      { file: 'b.ts', identifier: 'users', table: 'auth_users' },
    ];

    expect(catalog([], objects).aliases).toEqual({ users: 'users' });
  });

  it('returns an empty alias map for no schema objects', () => {
    expect(catalog([]).aliases).toEqual({});
  });
});
