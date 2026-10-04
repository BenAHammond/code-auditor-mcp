/**
 * Spec 68 §3.2 / §5 — the `resolution` corpus processor.
 *
 * The liveness guard (§16.1) runs every producer against *empty* upstream facts,
 * so it proves a corpus processor returns a live, shaped value — but not that its
 * reduction is correct. This test feeds real per-file `ddl-declarations` and
 * asserts the flat known-table set the `missing-org-filter` / `unknown-table`
 * rules read: the *net* table set after replaying CREATE/DROP/RENAME across
 * files in migration order (a table a later migration drops is a stale
 * reference, not a known table). Per-column constraints (PK / natural UNIQUE /
 * NOT NULL / FK) are carried separately — the Spec 69 R3 criterion 8 shape.
 */

import { describe, it, expect } from 'vitest';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import type { SchemaDeclaration, SchemaObject, ResolutionColumn } from '../phase/types.js';

/** A constraint-free column, the common case for table-name-only fixtures. */
function col(name: string, unique = false): ResolutionColumn {
  return { name, primaryKey: false, unique, notNull: false, foreignKey: null };
}

function catalog(decls: SchemaDeclaration[], objects: SchemaObject[] = []) {
  return CORPUS_PRODUCERS['resolution'].process({ 'ddl-declarations': decls, 'schema-objects': objects, 'file-symbols': [] });
}

/** The names of a table's natural-UNIQUE columns (the bootstrap-lookup quiet set). */
function uniqueNames(name: string, tables: ReturnType<typeof catalog>['tables']): string[] {
  return tables.find((t) => t.name === name)!.columns.filter((c) => c.unique).map((c) => c.name);
}

describe('Spec 68 resolution corpus processor', () => {
  it('reduces per-file DDL to the net table set in migration order', () => {
    const decls: SchemaDeclaration[] = [
      { file: 'migrations/001_orders.ts', ops: [{ op: 'CREATE', table: 'orders' }], tableColumns: {}, uniqueColumns: {}, primaryKeyColumns: {}, notNullColumns: {}, foreignKeys: {} },
      { file: 'migrations/002_users.ts', ops: [{ op: 'CREATE', table: 'users' }], tableColumns: {}, uniqueColumns: {}, primaryKeyColumns: {}, notNullColumns: {}, foreignKeys: {} },
    ];

    expect(catalog(decls).tables).toEqual([
      { name: 'orders', source: 'migrations/001_orders.ts', columns: [] },
      { name: 'users', source: 'migrations/002_users.ts', columns: [] },
    ]);
  });

  it('excludes a table dropped by a later migration (stale, not known)', () => {
    const decls: SchemaDeclaration[] = [
      { file: 'migrations/001_init.ts', ops: [{ op: 'CREATE', table: 'generation_queue' }], tableColumns: {}, uniqueColumns: {}, primaryKeyColumns: {}, notNullColumns: {}, foreignKeys: {} },
      { file: 'migrations/002_drop.ts', ops: [{ op: 'DROP', table: 'generation_queue' }], tableColumns: {}, uniqueColumns: {}, primaryKeyColumns: {}, notNullColumns: {}, foreignKeys: {} },
    ];

    expect(catalog(decls).tables).toEqual([]);
  });

  it('carries per-table columns through for Tier 3 DDL tenant discovery', () => {
    const decls: SchemaDeclaration[] = [
      {
        file: 'migrations/003_projects.ts',
        ops: [{ op: 'CREATE', table: 'projects' }],
        tableColumns: { projects: ['id', 'org_id'] },
        uniqueColumns: {},
        primaryKeyColumns: {},
        notNullColumns: {},
        foreignKeys: {},
      },
    ];

    expect(catalog(decls).tables).toEqual([
      { name: 'projects', source: 'migrations/003_projects.ts', columns: [col('id'), col('org_id')] },
    ]);
  });

  it('returns an empty table set for no schema declarations', () => {
    expect(catalog([]).tables).toEqual([]);
  });

  it('threads DDL natural-UNIQUE columns through as a per-column flag', () => {
    const decls: SchemaDeclaration[] = [
      {
        file: 'migrations/004_api_key.ts',
        ops: [{ op: 'CREATE', table: 'api_key' }],
        tableColumns: { api_key: ['id', 'prefix', 'workspace_id'] },
        uniqueColumns: { api_key: ['prefix'] },
        primaryKeyColumns: {},
        notNullColumns: {},
        foreignKeys: {},
      },
    ];

    const tables = catalog(decls).tables;
    expect(tables.map((t) => t.name)).toEqual(['api_key']);
    expect(uniqueNames('api_key', tables)).toEqual(['prefix']);
    // The non-unique columns stay flagged false.
    const prefix = tables[0].columns.find((c) => c.name === 'prefix')!;
    expect(prefix.unique).toBe(true);
    expect(tables[0].columns.find((c) => c.name === 'id')!.unique).toBe(false);
  });

  it('folds ORM schema-object bindings into the identifier → SQL-name alias map', () => {
    const objects: SchemaObject[] = [
      { file: 'database/schema.ts', identifier: 'sampleOwnership', table: 'sample_ownership', uniqueColumns: [], primaryKeyColumns: [] },
      { file: 'database/schema.ts', identifier: 'organizations', table: 'organizations', uniqueColumns: [], primaryKeyColumns: [] },
    ];

    expect(catalog([], objects).aliases).toEqual({
      sampleOwnership: 'sample_ownership',
      organizations: 'organizations',
    });
  });

  it('keeps the first binding when an identifier is declared twice', () => {
    const objects: SchemaObject[] = [
      { file: 'a.ts', identifier: 'users', table: 'users', uniqueColumns: [], primaryKeyColumns: [] },
      { file: 'b.ts', identifier: 'users', table: 'auth_users', uniqueColumns: [], primaryKeyColumns: [] },
    ];

    expect(catalog([], objects).aliases).toEqual({ users: 'users' });
  });

  it('merges Drizzle natural-UNIQUE columns (JS + SQL names) into the matching catalog entry', () => {
    const decls: SchemaDeclaration[] = [
      {
        file: 'migrations/001_api_key.ts',
        ops: [{ op: 'CREATE', table: 'api_key' }],
        tableColumns: { api_key: ['workspace_id', 'slug'] },
        uniqueColumns: { api_key: ['slug'] },
        primaryKeyColumns: {},
        notNullColumns: {},
        foreignKeys: {},
      },
    ];
    const objects: SchemaObject[] = [
      {
        file: 'schema/api_key.ts',
        identifier: 'apiKey',
        table: 'api_key',
        uniqueColumns: ['prefix', 'hashedToken', 'hashed_token'],
        primaryKeyColumns: [],
      },
    ];

    const tables = catalog(decls, objects).tables;
    expect(uniqueNames('api_key', tables)).toEqual(['slug', 'prefix', 'hashedToken', 'hashed_token']);
  });

  it('returns an empty alias map for no schema objects', () => {
    expect(catalog([]).aliases).toEqual({});
  });
});
