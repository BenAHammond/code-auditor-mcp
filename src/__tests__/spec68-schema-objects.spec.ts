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
      { file: '/fixture/schema.ts', identifier: 'sampleOwnership', table: 'sample_ownership', uniqueColumns: [] },
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

  it('captures natural UNIQUE columns and excludes `.primaryKey()`', () => {
    // Mirrors the openstatus api_key shape: `prefix`/`slug` are JS==SQL, while
    // `hashedToken` is the JS name of the SQL `hashed_token` column — the two
    // namespaces a Drizzle filter (`eq(apiKey.prefix, …)`) and a raw-SQL filter
    // (`WHERE hashed_token = ?`) each write. `id` is a surrogate primary key (the
    // IDOR surface, not a bootstrap signal), so it is excluded.
    const out = objects('/fixture/api_key.ts', [
      'export const apiKey = sqliteTable(',
      '  "api_key",',
      '  {',
      '    id: integer("id").primaryKey({ autoIncrement: true }),',
      '    prefix: text("prefix").notNull().unique(),',
      '    hashedToken: text("hashed_token").notNull().unique(),',
      '    workspaceId: integer("workspace_id").notNull(),',
      '  },',
      ');',
    ].join('\n'));

    expect(out).toEqual([
      {
        file: '/fixture/api_key.ts',
        identifier: 'apiKey',
        table: 'api_key',
        uniqueColumns: ['prefix', 'hashedToken', 'hashed_token'],
      },
    ]);
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
    tables: [{ name: 'sample_ownership', source: '/fixture/schema.sql', columns: ['organization_id'], uniqueColumns: [] }],
    aliases: { sampleOwnership: 'sample_ownership' },
  };

  it('fires on a tenant table queried through its ORM identifier', () => {
    const out = analyzeOrg([call(['sampleOwnership'])], catalog);

    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('sample_ownership');
    expect(out[0].message).not.toContain('sampleOwnership');
  });

  it('stays quiet when the same query carries an organization predicate', () => {
    // §69 Fix 1 — the rule re-derives the predicate from `queryText` + thresholds,
    // not the producer's `hasOrganizationFilter` fact field (baked with the default
    // config). The predicate must live in the text to stay quiet.
    const scoped = {
      ...call(['sampleOwnership']),
      queryText: 'SELECT * FROM sample_ownership WHERE organization_id = $1',
    };
    expect(analyzeOrg([scoped], catalog)).toEqual([]);
  });

  it('stays quiet on a non-tenant table (no tenant column)', () => {
    const nonTenant: TableCatalog = {
      tables: [{ name: 'sample_ownership', source: '/fixture/schema.sql', columns: ['id'], uniqueColumns: [] }],
      aliases: { sampleOwnership: 'sample_ownership' },
    };
    expect(analyzeOrg([call(['sampleOwnership'])], nonTenant)).toEqual([]);
  });

  it('stays quiet when the filter is an equality lookup on a UNIQUE column (bootstrap lookup)', () => {
    // `eq(apiKey.prefix, …)` binds a UNIQUE column → at most one row, so tenant
    // scoping is structurally unnecessary. The catalog carries the Drizzle name.
    const uniqueCatalog: TableCatalog = {
      tables: [{ name: 'api_key', source: '/fixture/api_key.ts', columns: ['workspace_id'], uniqueColumns: ['prefix'] }],
      aliases: { apiKey: 'api_key' },
    };
    const bootstrap = {
      ...call(['apiKey']),
      queryText: 'db.select().from(apiKey).where(eq(apiKey.prefix, prefix)).get()',
    };
    expect(analyzeOrg([bootstrap], uniqueCatalog)).toEqual([]);
  });

  it('still fires when the filter is NOT on a natural UNIQUE column', () => {
    // `name` is neither a tenant column (no org-predicate quiet) nor a natural
    // UNIQUE column (no bootstrap quiet) — a filter on it scopes the query by
    // neither tenant nor key. (`workspaceId` would be the tenant column here, so
    // it is *correctly* quiet after §69 Fix 1; this test needs a non-tenant
    // non-unique column to keep firing.)
    const idOnlyCatalog: TableCatalog = {
      tables: [{ name: 'api_key', source: '/fixture/api_key.ts', columns: ['workspace_id'], uniqueColumns: [] }],
      aliases: { apiKey: 'api_key' },
    };
    const byName = {
      ...call(['apiKey']),
      queryText: 'db.select().from(apiKey).where(eq(apiKey.name, name))',
    };
    expect(analyzeOrg([byName], idOnlyCatalog)).toHaveLength(1);
  });

  it('still fires when the filter is on a PRIMARY-KEY column (surrogate id = IDOR surface)', () => {
    // `eq(apiKey.id, …)` selects at most one row — but by a caller-supplied
    // surrogate id, which is precisely the IDOR case. The natural-UNIQUE quiet
    // must not extend to a primary key (Thing 1 correction).
    const pkCatalog: TableCatalog = {
      tables: [{ name: 'api_key', source: '/fixture/api_key.ts', columns: ['workspace_id'], uniqueColumns: [] }],
      aliases: { apiKey: 'api_key' },
    };
    const byId = {
      ...call(['apiKey']),
      queryText: 'db.select().from(apiKey).where(eq(apiKey.id, id)).get()',
    };
    expect(analyzeOrg([byId], pkCatalog)).toHaveLength(1);
  });

  it('fires when a UNIQUE column appears only in a JOIN … ON condition, not a WHERE predicate', () => {
    // The openstatus `monitors.go` three-table join shape: a UNIQUE column in a
    // JOIN … ON equality scopes how rows match, not which rows return, so it is
    // not a bootstrap lookup. The raw-SQL matcher must read WHERE clauses only.
    const joinCatalog: TableCatalog = {
      tables: [
        { name: 'monitor', source: '/fixture/monitor.ts', columns: ['workspace_id'], uniqueColumns: ['slug'] },
        { name: 'private_location', source: '/fixture/pl.ts', columns: ['workspace_id'], uniqueColumns: ['token'] },
      ],
      aliases: {},
    };
    const joined = {
      ...call(['monitor', 'private_location']),
      queryText:
        'SELECT m.id FROM monitor m JOIN private_location p ON m.slug = p.token WHERE p.active = 1',
    };
    expect(analyzeOrg([joined], joinCatalog)).toHaveLength(1);
  });
});
