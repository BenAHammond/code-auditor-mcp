/**
 * Spec 68 §3.2 — the `data-access-calls` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array;
 * this test proves the extraction is *correct* against the fields the
 * data-access rules read: resolved `tables`, the write/read filter signals
 * (`hasFilter` / `hasOrganizationFilter`), injection-risk flags, and the
 * enclosing function. It exercises the producer wiring in `producers.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { buildDataAccessCalls } from '../phase/runner.js';
import type { ResolvedQuery } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function calls(path: string, source: string): Promise<ResolvedQuery[]> {
  return buildDataAccessCalls([{ path, content: source }], 'sqlite');
}

describe('Spec 68 data-access-calls producer', async () => {
  it('extracts a string-concatenated db.query call with the injection signal; SQL facts cannot-fire', async () => {
    const out = await calls('/fixture/a.ts', [
      'import { Pool } from "pg";',
      'const db = new Pool();',
      'export function getUser(id: string) {',
      '  return db.query("SELECT * FROM users WHERE id = " + id);',
      '}',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    const call = out[0];
    expect(call.file).toBe('/fixture/a.ts');
    // A string-concatenated argument is not a parseable statement: its table and
    // filter facts are `cannot-fire` (empty/false), not a regex guess (Spec 70 R1).
    expect(call.tables).toEqual([]);
    expect(call.hasFilter).toBe(false);
    expect(call.enclosingFunction).toBe('getUser');
    // String-concatenated input is the injection-risk signal (site #11, host-language).
    expect(call.hasSqlInjectionRisk).toBe(true);
  });

  it('extracts a bare tagged-template SQL call (`sql`…`) by tag name', async () => {
    const out = await calls('/fixture/tag.ts', [
      'const q = sql`SELECT * FROM users WHERE id = ${id}`;',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    // The interpolated body is not a parseable statement: table facts are
    // `cannot-fire`. The tag *name* is what makes the query visible (Spec 70 R2).
    expect(out[0].tables).toEqual([]);
    expect(out[0].method).toBe('sql');
  });

  it('extracts a `this.sql` member tag — a wrapper re-exposing the tag', async () => {
    // The receiver (`this.sql`) is not a bare identifier, so provenance alone
    // cannot resolve it; tag-name recognition is what makes the query visible.
    const out = await calls('/fixture/this-tag.ts', [
      'class Repo {',
      '  health() { return this.sql`SELECT * FROM users`; }',
      '}',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    expect(out[0].tables).toContain('users');
    expect(out[0].method).toBe('sql');
  });

  it('extracts a tagged-template wrapped in a provenanced DB call under the call method', async () => {
    const out = await calls('/fixture/wrapped.ts', [
      'const db: D1Database = getDb();',
      'db.execute(sql`SELECT * FROM users`);',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    expect(out[0].tables).toContain('users');
    expect(out[0].method).toBe('execute');
  });

  it('returns an empty array for a file with no DB calls', async () => {
    const out = await calls('/fixture/b.ts', 'export const x = 1;\n');
    expect(out).toEqual([]);
  });
});

/**
 * Spec 68 Thing 2 (#312) — query-builder discovery is shape-based, not
 * receiver-name-based. A chain carrying a verb plus its required companion is a
 * query builder regardless of what the receiver is called; the same shape test
 * rejects `.delete`/`.update` on non-builder receivers that share the verb.
 */
describe('Spec 68 query-builder shape test', async () => {
  it('admits a `.select().from()` chain on an un-provenanced receiver', async () => {
    const out = await calls('/fixture/shape-select.ts', [
      'appDb.getDb().select().from(users).where(eq(users.id, id));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((c) => c.tables.includes('users'))).toBe(true);
  });

  it('admits an `.insert().values()` chain', async () => {
    const out = await calls('/fixture/shape-insert.ts', [
      'appDb.getDb().insert(users).values({ name });',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
  });

  it('admits an `.update().set().where()` chain', async () => {
    const out = await calls('/fixture/shape-update.ts', [
      'appDb.getDb().update(users).set({ name }).where(eq(users.id, id));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
  });

  it('admits a `.delete().where()` chain', async () => {
    const out = await calls('/fixture/shape-delete.ts', [
      'appDb.getDb().delete(users).where(eq(users.id, id));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
  });

  it('admits a `.selectDistinct().from()` chain (word-boundary regression)', async () => {
    const out = await calls('/fixture/shape-distinct.ts', [
      'db.selectDistinct({ a: t.a }).from(t);',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((c) => c.tables.includes('t'))).toBe(true);
  });

  it('admits the Prisma object form `prisma.<model>.<verb>({ where, data })`', async () => {
    const out = await calls('/fixture/shape-prisma.ts', [
      'prisma.user.update({ where: { id }, data: { name } });',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
  });

  it('rejects `map.delete(key)` — a verb with no query-builder companion', async () => {
    const out = await calls('/fixture/shape-map.ts', 'params.delete(key);\n');
    expect(out).toEqual([]);
  });

  it('rejects `crypto.createHash().update()` — `.update` without a companion', async () => {
    const out = await calls('/fixture/shape-crypto.ts', [
      'crypto.createHash("sha256").update(input);',
    ].join('\n'));
    expect(out).toEqual([]);
  });

  it('rejects `stripe.customers.update(id, data)` — no `where`/`data` object form', async () => {
    const out = await calls('/fixture/shape-stripe.ts', [
      'stripe.customers.update(id, data);',
    ].join('\n'));
    expect(out).toEqual([]);
  });

  it('rejects `cookies.delete(name)` — `.delete` with no chained `.where`', async () => {
    const out = await calls('/fixture/shape-cookies.ts', [
      'response.cookies.delete("auth");',
    ].join('\n'));
    expect(out).toEqual([]);
  });
});

/**
 * Spec 68 Thing 2 (#313 follow-up) — `hasOrganizationFilter` treats a column as a
 * filter only when it is a predicate operand or a value key inside a scoping
 * verb, never a SELECT projection. The bare-`:` match misread
 * `.select({ organizationId: col })` as a filter, so an unfiltered tenant query
 * (`sample_ownership`) stayed quiet. The fix scopes the `:` to where/on/set/
 * values/data objects and must not regress Drizzle `.values({ org_id })`.
 */
describe('Spec 68 hasOrganizationFilter — projection vs. predicate', async () => {
  it('does NOT treat a `.select({ organizationId: col })` projection as a filter', async () => {
    const out = await calls('/fixture/org-projection.ts', [
      'appDb.getDb().select({ organizationId: sampleOwnership.organizationId })',
      '  .from(sampleOwnership).innerJoin(other, eq(sampleOwnership.organizationId, other.organizationId));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasOrganizationFilter).toBe(false);
  });

  it('still detects a Drizzle `.where({ organizationId: value })` predicate object', async () => {
    const out = await calls('/fixture/org-where-object.ts', [
      'appDb.getDb().select().from(sampleOwnership).where({ organizationId: orgId });',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasOrganizationFilter).toBe(true);
  });

  it('still detects a Drizzle `.values({ organization_id })` insert scope (parity)', async () => {
    const out = await calls('/fixture/org-values-object.ts', [
      'appDb.getDb().insert(users).values({ organization_id: orgId, name });',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasOrganizationFilter).toBe(true);
  });

  it('still detects the Prisma `where: { organizationId: value }` object form', async () => {
    const out = await calls('/fixture/org-prisma-where.ts', [
      'prisma.sampleOwnership.findMany({ where: { organizationId: orgId } });',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasOrganizationFilter).toBe(true);
  });

  it('detects a Drizzle `eq(orgCol, value)` comparison helper (org col as first arg)', async () => {
    const out = await calls('/fixture/org-eq-helper.ts', [
      'appDb.getDb().select().from(userOrganizations)',
      '  .where(and(eq(userOrganizations.userId, userId), eq(userOrganizations.organizationId, organizationId)));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasOrganizationFilter).toBe(true);
  });

  it('detects a Drizzle `inArray(orgCol, values)` comparison helper (org col as first arg)', async () => {
    const out = await calls('/fixture/org-inarray-helper.ts', [
      'appDb.getDb().select().from(sampleOwnership)',
      '  .where(and(inArray(sampleOwnership.sampleId, sampleIds), inArray(sampleOwnership.organizationId, userOrgIds)));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasOrganizationFilter).toBe(true);
  });

  it('does NOT treat a JOIN-on-org `innerJoin(x, eq(a.orgId, b.orgId))` as a filter', async () => {
    const out = await calls('/fixture/org-join-on.ts', [
      'appDb.getDb().select().from(userOrganizations)',
      '  .innerJoin(organizations, eq(userOrganizations.organizationId, organizations.id))',
      '  .where(eq(userOrganizations.userId, userId));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasOrganizationFilter).toBe(false);
  });

  it('treats a dotted *value* `eq(orgCol, session.orgId)` under `.where` as a filter (§69 Fix 1)', async () => {
    const out = await calls('/fixture/org-dotted-value.ts', [
      'appDb.getDb().select().from(userOrganizations)',
      '  .where(eq(userOrganizations.organizationId, session.organizationId));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasOrganizationFilter).toBe(true);
  });
});

/**
 * Spec 69 Fix 2 — tagged templates recurse for interpolation. A `sql` tag's
 * template is a direct child of the call (no `arguments` node), which the old
 * `isDynamicStringConstruction` never recursed into — so a real interpolation
 * inside a tag was an invisible `sql-injection-risk` false negative. The fix
 * makes the recursion happen, and recognizes a drizzle `sql`/`db` tag whose
 * `${…}` interpolations are all bare identifiers as parameterized-by-
 * construction (the "right reason" a clean tag is quiet). A string-
 * concatenation interpolation (`${'%' + x + '%'}`) is raw assembly and fires.
 */
describe('Spec 69 Fix 2 — tagged-template interpolation recursion', async () => {
  it('treats a clean `${id}` interpolation in a `sql` tag as parameterized', async () => {
    const out = await calls('/fixture/tag-clean.ts', [
      'export function f(id: string) {',
      '  return sql`SELECT * FROM products WHERE id = ${id}`;',
      '}',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasSqlInjectionRisk).toBe(false);
    expect(out[0].hasParameterizedQuery).toBe(true);
  });

  it('fires on a string-concatenation interpolation in a `sql` tag', async () => {
    const out = await calls('/fixture/tag-concat.ts', [
      "import { sql } from 'drizzle-orm';",
      'export function f(userInput: string) {',
      "  return sql`SELECT * FROM products WHERE name LIKE ${'%' + userInput + '%'}`;",
      '}',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasSqlInjectionRisk).toBe(true);
  });

  it('treats `db.execute(sql`…${id}…`)` as parameterized (right reason, not broken recursion)', async () => {
    const out = await calls('/fixture/tag-execute.ts', [
      'export function f(id: string) {',
      '  return db.execute(sql`SELECT * FROM products WHERE id = ${id}`);',
      '}',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].hasSqlInjectionRisk).toBe(false);
    expect(out[0].hasParameterizedQuery).toBe(true);
  });
});
