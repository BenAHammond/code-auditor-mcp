/**
 * #133 — dry/similar-expression, default-on.
 *
 * The block extractor only sees functions/classes/control-flow ≥15 lines, so the
 * real duplication class that slipped past dry/duplicate and
 * dry/structural-similarity is a small *expression*: an object literal built
 * twice with a near-identical field list (`resultSummary` in
 * hhra-org/app/api/admin/etl/folders/route.ts).
 *
 * The original theory also treated repeated fluent *mutation* chains
 * (`.update().set().where().returning()`) as signal. Corpus measurement
 * disproved it: the chains that actually fire are library fluent APIs — Zod
 * validators (`string().trim().min().max()`), query/schema builders
 * (`insert().onConflict().ignore()`, `integer().unsigned().references()`),
 * commander (`command().option().action()`), promises (`then().then().catch()`),
 * and DOM/stdlib method chains — all the library's public surface, none
 * duplicated logic. So the rule:
 *   - excludes fluent library/builder chains (query and schema builders, Zod,
 *     commander, promises, DOM and stdlib method chains) as "structurally
 *     similar by design";
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
  return runAt('dry-similar-expression.ts', sourceCode, overrides);
}

async function runAt(filePath: string, sourceCode: string, overrides: Record<string, unknown> = {}): Promise<Violation[]> {
  const ast = parseFile(filePath, sourceCode)!;
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

/** Zod validator chains — the dominant `similar-expression` noise on recall. */
const ZOD_CHAINS = `
export const userSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().min(3).max(120).email(),
  handle: z.string().trim().min(2).max(30),
});
export const postSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(200),
});
`;

/** commander registrations + promise flows — the knex CLI/driver noise. */
const COMMANDER_AND_PROMISE_CHAINS = `
export function register(program: any) {
  program.command('list').description('list').option('-v').action(go);
  program.command('show').description('show').option('-v').action(show);
  program.command('rm').description('rm').option('-v').action(remove);
}
export async function flow(db: any) {
  const a = await db.transaction().then(x => x).then(x => x).then(x => x).then(x => x).catch(err => null);
  const b = await db.transaction().then(x => x).then(x => x).then(x => x).then(x => x).catch(err => null);
  return [a, b];
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
    expect(v.severity).toBe('high');
    expect(v.resolution?.action).toBe('extract-shared-expression');
    expect(v.message).toContain('completedAt');
    expect(v.message).toContain('info.resultSummary');
  });

  it('stays silent on query-builder mutation chains (`.update().set().where().returning()`)', async () => {
    // These five arms are structurally near-identical, but they are the ORM's
    // fluent API surface, not duplicated domain logic — excluded as library
    // surface by the fluent-chain guard.
    const vs = similarExpression(await run(BULK_SWITCH_DUPLICATE));
    expect(vs).toHaveLength(0);
  });

  it('stays silent on Zod validator chains', async () => {
    const vs = similarExpression(await run(ZOD_CHAINS));
    expect(vs).toHaveLength(0);
  });

  it('stays silent on commander registrations and promise flows', async () => {
    const vs = similarExpression(await run(COMMANDER_AND_PROMISE_CHAINS));
    expect(vs).toHaveLength(0);
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

  it('stays silent on near-identical objects in test files (`.spec.js` and `test/` dirs)', async () => {
    // The same `ast` object built twice would fire in production code, but an
    // expected-output fixture is not duplication — excluded by the test-file
    // guard (language-agnostic: `.spec.js` and `test/` directories).
    const fixture = `
const ast = { temporary: true, exists: true, schema: 'x', table: 'y', columns: [], constraints: [], rowid: true };
const ast = { temporary: true, exists: true, schema: 'x', table: 'y', columns: [], constraints: [], rowid: true };
`;
    const vsSpec = similarExpression(await runAt('test/unit/example.spec.js', fixture));
    expect(vsSpec).toHaveLength(0);

    const vsDir = similarExpression(await runAt('test/unit/schema-builder/sqlite3.js', fixture));
    expect(vsDir).toHaveLength(0);
  });
});
