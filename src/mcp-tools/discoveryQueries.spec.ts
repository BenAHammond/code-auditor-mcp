import { describe, it, expect } from 'vitest';
import {
  buildDiscoveryQueries,
  normalizeDialect,
  DISCOVERY_QUERY_BUILDERS,
  type Dialect,
} from './discoveryQueries.js';

const CTX = {
  tableFilter: "WHERE table_name IN ('users', 'orders')",
  includeIndexes: true,
  includeConstraints: true,
};

const names = (dialect: Dialect, ctx = CTX) =>
  buildDiscoveryQueries(dialect, ctx).map((q) => q.name);

describe('DISCOVERY_QUERY_BUILDERS', () => {
  it('is total over Dialect — every discriminant has a builder', () => {
    const dialects: readonly Dialect[] = ['postgresql', 'mysql', 'sqlite'];
    for (const d of dialects) {
      expect(DISCOVERY_QUERY_BUILDERS[d]).toBeDefined();
      expect(DISCOVERY_QUERY_BUILDERS[d].dialect).toBe(d);
    }
  });
});

describe('normalizeDialect', () => {
  it('maps every known dialect, trimming and lowercasing', () => {
    expect(normalizeDialect('postgresql')).toBe('postgresql');
    expect(normalizeDialect('PostgreSQL')).toBe('postgresql');
    expect(normalizeDialect('  mysql ')).toBe('mysql');
    expect(normalizeDialect('SQLite')).toBe('sqlite');
  });

  it('returns null for an engine that has no builder', () => {
    expect(normalizeDialect('oracle')).toBeNull();
    expect(normalizeDialect('sqlserver')).toBeNull();
    expect(normalizeDialect('')).toBeNull();
    expect(normalizeDialect('mongodb')).toBeNull();
  });
});

describe('buildDiscoveryQueries', () => {
  it('postgresql: tables + columns always, foreign_keys and indexes gated by flags', () => {
    expect(names('postgresql', { ...CTX, includeIndexes: true, includeConstraints: true })).toEqual([
      'tables',
      'columns',
      'foreign_keys',
      'indexes',
    ]);
    expect(names('postgresql', { ...CTX, includeIndexes: false, includeConstraints: false })).toEqual([
      'tables',
      'columns',
    ]);
    expect(names('postgresql', { ...CTX, includeIndexes: true, includeConstraints: false })).toEqual([
      'tables',
      'columns',
      'indexes',
    ]);
  });

  it('postgresql interpolates the pre-validated tableFilter, retargeting the column qualifier', () => {
    const queries = buildDiscoveryQueries('postgresql', CTX);
    const byName = Object.fromEntries(queries.map((q) => [q.name, q.sql]));
    // tables/columns carry the filter verbatim; foreign_keys and indexes retarget
    // `table_name` to their own qualifier (`tc.table_name` / `tablename`).
    expect(byName.tables).toContain(CTX.tableFilter);
    expect(byName.columns).toContain(CTX.tableFilter);
    expect(byName.foreign_keys).toContain("WHERE tc.table_name IN ('users', 'orders')");
    expect(byName.indexes).toContain("WHERE tablename IN ('users', 'orders')");
  });

  it('mysql: tables + columns always, foreign_keys gated; never emits indexes', () => {
    expect(names('mysql', { ...CTX, includeConstraints: true })).toEqual([
      'tables',
      'columns',
      'foreign_keys',
    ]);
    // includeIndexes is ignored for mysql — no 'indexes' query even when requested.
    expect(names('mysql', { ...CTX, includeConstraints: false })).toEqual(['tables', 'columns']);
  });

  it('sqlite: ignores the whole context (filter, flags) and returns the fixed pair', () => {
    const queries = buildDiscoveryQueries('sqlite', {
      tableFilter: "WHERE table_name IN ('users')",
      includeIndexes: true,
      includeConstraints: true,
    });
    expect(queries.map((q) => q.name)).toEqual(['tables', 'table_info']);
    // No tableFilter or flag-derived queries leak into the fixed sqlite pair.
    for (const q of queries) {
      expect(q.sql).not.toContain('tableFilter');
      expect(q.sql).not.toContain("'users'");
    }
  });

  it('every query carries a non-empty name and description', () => {
    for (const dialect of ['postgresql', 'mysql', 'sqlite'] as const) {
      for (const q of buildDiscoveryQueries(dialect, CTX)) {
        expect(q.name.length).toBeGreaterThan(0);
        expect(q.description.length).toBeGreaterThan(0);
      }
    }
  });
});
