/**
 * #133 — dry/similar-expression, default-on.
 *
 * The block extractor only sees functions/classes/control-flow ≥15 lines, so the
 * two real duplication classes that slipped past dry/duplicate and
 * dry/structural-similarity were small *expressions*:
 *
 *   1. an object literal built twice with a near-identical field list
 *      (`resultSummary` in hhra-org/app/api/admin/etl/folders/route.ts);
 *   2. five switch arms of near-identical `.update().set().where().returning()`
 *      (hhra-org/app/api/admin/organizations/bulk/route.ts).
 *
 * To fire on those *without* flooding a default audit, the rule:
 *   - excludes query-builder chains (`.select().from().where()…` — idiomatic
 *     reads, "structurally similar by design");
 *   - only compares object literals that target the *same* identifier, so the
 *     `pgTable('users', {…})` / `pgTable('orders', {…})` schema literals (shared
 *     `id`/`createdAt` column names, different targets) never pair up.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDRYAnalyzer, DEFAULT_DRY_CONFIG } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import type { Violation } from '../types.js';

let analyzer: UniversalDRYAnalyzer;
let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
  analyzer = new UniversalDRYAnalyzer();
}, 30_000);

async function run(sourceCode: string, overrides: Record<string, unknown> = {}): Promise<Violation[]> {
  const ast = parseFile('dry-similar-expression.ts', sourceCode)!;
  if (!ast) throw new Error('failed to parse fixture');
  return (await (analyzer as any).analyzeAST(
    ast,
    tsAdapter,
    { ...DEFAULT_DRY_CONFIG, ...overrides },
    sourceCode,
  )) as Violation[];
}

const similarExpression = (vs: Violation[]) => vs.filter((v) => v.rule === 'dry/similar-expression');

/** The hhra-org folders/route.ts shape: `info.resultSummary` built twice. */
const RESULT_SUMMARY_DUPLICATE = `
export async function runEtl() {
  const info: any = {};
  info.resultSummary = {
    completedAt: now,
    tables: tableList,
    tableCounts: countList,
    stagingCounts: stagingList,
    steps: stepList,
  };
  info.resultSummary = {
    completedAt: now,
    tables: tableList,
    tableCounts: countList,
    stagingCounts: stagingList,
    steps: stepList,
    durationMs: elapsed,
    stepsCompletedCount: done,
  };
  return info;
}
`;

/** The hhra-org organizations/bulk/route.ts shape: near-identical mutation arms. */
const BULK_SWITCH_DUPLICATE = `
export async function bulkUpdate(action: string, organizationIds: string[]) {
  switch (action) {
    case 'activate':
      return await db.update(organizations).set({ active: true }).where(inArray(organizations.id, organizationIds)).returning({ id: organizations.id });
    case 'deactivate':
      return await db.update(organizations).set({ active: false }).where(inArray(organizations.id, organizationIds)).returning({ id: organizations.id });
    case 'delete':
      return await db.delete(organizations).where(inArray(organizations.id, organizationIds)).returning({ id: organizations.id });
    case 'change_type':
      return await db.update(organizations).set({ type: 'org' }).where(inArray(organizations.id, organizationIds)).returning({ id: organizations.id });
    case 'change_parent':
      return await db.update(organizations).set({ parentId: null }).where(inArray(organizations.id, organizationIds)).returning({ id: organizations.id });
  }
}
`;

/** Schema-table shape: unrelated object literals that share column names. */
const SCHEMA_TABLES = `
export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name'),
  email: text('email'),
  createdAt: timestamp('created_at'),
});
export const orders = pgTable('orders', {
  id: integer('id').primaryKey(),
  total: integer('total'),
  userId: integer('user_id'),
  createdAt: timestamp('created_at'),
});
`;

/** Idiomatic query-builder chains — structurally similar by design. */
const QUERY_CHAINS = `
export async function list(a: string[], b: string[]) {
  const x = await db.select().from(users).where(inArray(users.id, a)).limit(50);
  const y = await db.select().from(orders).where(inArray(orders.id, b)).limit(50);
  return { x, y };
}
`;

describe('#133 dry/similar-expression (default-on)', () => {
  it('fires once for a near-identical object literal built for the same target', async () => {
    const vs = similarExpression(await run(RESULT_SUMMARY_DUPLICATE));
    expect(vs).toHaveLength(1);

    const v = vs[0];
    expect(v.severity).toBe('suggestion');
    expect(v.resolution?.action).toBe('extract-shared-expression');
    expect(v.message).toContain('completedAt');
    expect(v.message).toContain('info.resultSummary');
  });

  it('fires three times for four near-identical .update().set().where().returning() arms', async () => {
    const vs = similarExpression(await run(BULK_SWITCH_DUPLICATE));
    // Four update arms share the 4-method chain; three are duplicates of the
    // first (earliest). The delete arm is `.delete().where().returning()`
    // (3 methods) — below the floor, so correctly NOT flagged.
    expect(vs).toHaveLength(3);
    for (const v of vs) {
      expect(v.severity).toBe('suggestion');
      expect(v.resolution?.action).toBe('extract-shared-expression');
    }
  });

  it('stays silent on unrelated schema literals (shared columns, different targets)', async () => {
    const vs = similarExpression(await run(SCHEMA_TABLES));
    expect(vs).toHaveLength(0);
  });

  it('stays silent on idiomatic query-builder chains', async () => {
    const vs = similarExpression(await run(QUERY_CHAINS));
    expect(vs).toHaveLength(0);
  });

  it('stays silent when the same target is assigned different field lists', async () => {
    const vs = similarExpression(await run(
      'const state = {};\nstate.summary = { a: 1, b: 2, c: 3, d: 4 };\nstate.summary = { e: 5, f: 6, g: 7, h: 8 };'
    ));
    expect(vs).toHaveLength(0);
  });
});
