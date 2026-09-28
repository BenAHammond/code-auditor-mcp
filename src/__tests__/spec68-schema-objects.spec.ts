/**
 * Spec 68 §3.2 / §5 — the `schema-objects` producer and the ORM identifier →
 * SQL-name resolution it feeds.
 *
 * The producer extracts `const <id> = pgTable|mysqlTable|sqliteTable('<table>',
 * …)` bindings; the `table-catalog` corpus reducer folds them into an alias map
 * (proven in `spec68-table-catalog.spec.ts`). This test proves the chain that
 * the alias map exists to close: `missing-org-filter` reads a query whose
 * `.from(sampleOwnership)` extracted the *identifier* (`sampleOwnership`), and
 * must resolve it to the SQL name (`sample_ownership`) so the DDL-declared
 * tenant column is seen — the Drizzle tenant-isolation hole #311 closes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { PRODUCERS } from '../phase/producers.js';
import { dataAccessRules } from '../phase/rules/dataAccess.js';
import type { ParsedFile, SchemaObject, ResolvedQuery, TableCatalog, Finding } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function objects(path: string, source: string): SchemaObject[] {
  const file: ParsedFile = { file: path, format: 'typescript', source };
  return PRODUCERS['schema-objects']['typescript'].process(file);
}

describe('Spec 68 schema-objects producer', () => {
  it('extracts a pgTable binding (identifier → SQL name)', () => {
    const out = objects('/fixture/schema.ts', [
      'export const sampleOwnership = pgTable("sample_ownership", {',
      '  organizationId: text("organization_id"),',
      '});',
    ].join('\n'));

    expect(out).toEqual([
      { file: '/fixture/schema.ts', identifier: 'sampleOwnership', table: 'sample_ownership' },
    ]);
  });

  it('extracts mysqlTable and sqliteTable bindings too', () => {
    const out = objects('/fixture/schema.ts', [
      'export const users = mysqlTable("users", {});',
      'export const sessions = sqliteTable("sessions", {});',
    ].join('\n'));

    expect(out.map((o) => [o.identifier, o.table])).toEqual([
      ['users', 'users'],
      ['sessions', 'sessions'],
    ]);
  });

  it('ignores non-ORM const bindings', () => {
    const out = objects('/fixture/other.ts', 'export const MAX = 5;\n');
    expect(out).toEqual([]);
  });

  it('returns an empty array for a file with no schema objects', () => {
    expect(objects('/fixture/b.ts', 'export const x = 1;\n')).toEqual([]);
  });
});

describe('Spec 68 missing-org-filter resolves ORM identifiers (Drizzle chain)', () => {
  /** Drive `missing-org-filter` directly with a catalog carrying the alias map. */
  function analyzeOrg(calls: ResolvedQuery[], catalog: TableCatalog): Finding[] {
    const rule = dataAccessRules.find((r) => r.id === 'missing-org-filter')!;
    const ctx = {
      facts: { 'data-access-calls': calls, 'table-catalog': catalog },
      formats: ['typescript', 'tsx', 'javascript', 'go'] as const,
      thresholds: {},
    };
    return [...rule.analyze(ctx)];
  }

  function call(tables: string[]): ResolvedQuery {
    return {
      type: 'db.select',
      method: 'select',
      file: '/fixture/route.ts',
      line: 1,
      column: 1,
      tables,
      queryText: `SELECT * FROM ${tables[0]}`,
      hasOrganizationFilter: false,
      hasFilter: false,
      hasParameterizedQuery: false,
      hasSqlInjectionRisk: false,
      sqlEscaped: false,
      enclosingFunction: 'GET',
    };
  }

  const catalog: TableCatalog = {
    tables: [{ name: 'sample_ownership', source: '/fixture/schema.sql', columns: ['organization_id'] }],
    aliases: { sampleOwnership: 'sample_ownership' },
  };

  it('fires on a tenant table queried through its ORM identifier', () => {
    const out = analyzeOrg([call(['sampleOwnership'])], catalog);

    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('sample_ownership');
    expect(out[0].message).not.toContain('sampleOwnership');
  });

  it('stays quiet when the same query carries an organization predicate', () => {
    const scoped = { ...call(['sampleOwnership']), hasOrganizationFilter: true };
    expect(analyzeOrg([scoped], catalog)).toEqual([]);
  });

  it('stays quiet on a non-tenant table (no tenant column)', () => {
    const nonTenant: TableCatalog = {
      tables: [{ name: 'sample_ownership', source: '/fixture/schema.sql', columns: ['id'] }],
      aliases: { sampleOwnership: 'sample_ownership' },
    };
    expect(analyzeOrg([call(['sampleOwnership'])], nonTenant)).toEqual([]);
  });
});
