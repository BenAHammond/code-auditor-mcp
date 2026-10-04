/**
 * Spec 68 §3.2 — parity: the migrated `missing-org-filter` rule reproduces the
 * old Stage-4 reducer's findings exactly.
 *
 * Unlike the other three data-access rules (whose old path was
 * `UniversalDataAccessAnalyzer.analyzeWithFacts`), `missing-org-filter` was
 * moved to a Stage-4 reducer in Spec 62 Amendment B (B1), so its old path is
 * `createOrgFilterReducer().reduce(allFacts, context)`. This test runs BOTH
 * paths — the reducer over reshaped facts and the new `analyze(ctx)` over the
 * same `data-access-calls` + `resolution` facts — and asserts the multisets
 * of identity tuples (file, line, column, severity) are equal and non-empty.
 *
 * The producer half is pinned by construction: `buildDataAccessCalls` runs the
 * same `extractDatabaseCalls` the legacy pipeline ran, and `buildResolution`
 * reduces the DDL fixture through the corpus processor. Feeding the reducer the
 * SAME extracted facts (reshaped into its `Record<file, {calls}>` +
 * `schema.tableColumns` input shape) isolates the *rule* half — the firing
 * predicate — which is the thing §15 deletes when the reducer goes away.
 *
 * Two tenancy tiers are pinned because the defect that motivated B was a tier
 * asymmetry: Tier 3 (DDL-discovered tenancy) is the case the old two-tier
 * predicate missed, and Tier 1 (config `orgFilterTables`) proves the config
 * surface reaches the same tier set from both paths.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { createOrgFilterReducer } from '../pipelineAdapters.js';
import {
  buildDataAccessCalls,
  buildResolution,
  analyzeDataAccessCalls,
} from '../phase/runner.js';
import type { ResolvedQuery, ResolutionFact } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** A query scoped by primary key only — no organization/tenant predicate. The
 *  exact near-miss the legacy reducer fired on (an IDOR surface: scoped by id,
 *  not by tenant). */
const PK_SCOPED_QUERY =
  'const db: D1Database = getDb();\n' +
  'export function getProject(id: number) {\n' +
  '  return db.query("SELECT * FROM projects WHERE id = ?", [id]);\n' +
  '}\n';

/** DDL that declares `projects` with a tenant-scoping `org_id` column (Tier 3). */
const DDL =
  'export const up = `\n' +
  'CREATE TABLE projects (id INT, org_id INT);\n' +
  '`;\n';

/** Reshape the flat `ResolvedQuery[]` fact into the reducer's per-file map. */
function toReducerDataAccess(calls: ResolvedQuery[]): Record<string, { calls: ResolvedQuery[] }> {
  const daFacts: Record<string, { calls: ResolvedQuery[] }> = {};
  for (const call of calls) {
    (daFacts[call.file] ??= { calls: [] }).calls.push(call);
  }
  return daFacts;
}

/** Reshape the `resolution` into the reducer's `schema.tableColumns` input. */
function toReducerTableColumns(catalog: ResolutionFact): Record<string, string[]> {
  const tableColumns: Record<string, string[]> = {};
  for (const table of catalog.tables) tableColumns[table.name] = table.columns.map((c) => c.name);
  return tableColumns;
}

/** Run the old reducer and the new rule, return the `missing-org-filter` multisets. */
async function parity(opts: {
  query?: string;
  ddl?: string;
  config?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
}) {
  const files = [];
  if (opts.ddl) files.push({ path: 'migrations/001_projects.ts', content: opts.ddl });
  if (opts.query) files.push({ path: 'parity.ts', content: opts.query });

  const calls = await buildDataAccessCalls(files, 'sqlite');
  const catalog = await buildResolution(files, 'sqlite');

  // Old path — the Stage-4 reducer, fed the same facts reshaped into its shape.
  const reducer = createOrgFilterReducer();
  const { violations } = await reducer.reduce(
    {
      'data-access': toReducerDataAccess(calls),
      'schema': { tableColumns: toReducerTableColumns(catalog) },
    },
    { projectRoot: '/test', config: opts.config ?? {} },
  );
  const old = violations.filter((v) => v.rule === 'missing-org-filter').map(key).sort();

  // New path — the migrated rule over the same facts.
  const fresh = await analyzeDataAccessCalls(calls, catalog, opts.thresholds ?? {});
  const nu = fresh.filter((f) => f.ruleId === 'missing-org-filter').map(key).sort();

  return { old, nu };
}

describe('Spec 68 missing-org-filter parity (new analyze(ctx) === old Stage-4 reducer)', () => {
  it('Tier 3 (DDL-discovered tenancy) — the case the old two-tier predicate missed', async () => {
    const { old, nu } = await parity({ query: PK_SCOPED_QUERY, ddl: DDL });
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('Tier 1 (config orgFilterTables) — config reaches the same tier set from both paths', async () => {
    const { old, nu } = await parity({
      query: PK_SCOPED_QUERY,
      config: { orgFilterTables: ['projects'] },
      thresholds: { orgFilterTables: ['projects'] },
    });
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('a query on a non-tenant table does not fire (no tenancy, no finding)', async () => {
    // `projects` is not declared tenant-scoped in any tier (no DDL, no config).
    const { old, nu } = await parity({ query: PK_SCOPED_QUERY });
    expect(nu).toEqual(old);
    expect(nu).toEqual([]);
  });

  it('a query with an explicit org predicate does not fire', async () => {
    const orgFiltered =
      'const db: D1Database = getDb();\n' +
      'export function getProject(orgId: string, id: number) {\n' +
      '  return db.query("SELECT * FROM projects WHERE org_id = ? AND id = ?", [orgId, id]);\n' +
      '}\n';
    const { old, nu } = await parity({ query: orgFiltered, ddl: DDL });
    // The migrated rule reads the AST WHERE columns (`sqlWhereColumns`) and sees
    // the `org_id` predicate, so it stays quiet. The legacy reducer reads
    // `hasOrganizationFilter` — an ORM-shape regex (Spec 70 R2 site #5) that has
    // no raw-SQL arm and cannot see a `WHERE org_id = ?` predicate — so it fires a
    // false positive on a query that IS tenant-scoped. That divergence is the
    // point of R2: the AST path is correct where the regex path was blind.
    expect(nu).toEqual([]);
    expect(old).not.toEqual([]);
  });
});
