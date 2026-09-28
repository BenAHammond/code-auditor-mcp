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
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import type { ParsedFile, ResolvedQuery } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function calls(path: string, source: string): ResolvedQuery[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = {
    file: path,
    format: 'typescript',
    source,
    ast,
    adapter: adapter!,
  };
  try {
    return PRODUCERS['data-access-calls']['typescript'].process(file);
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 68 data-access-calls producer', () => {
  it('resolves a raw db.query call to its table with filter + injection signals', () => {
    const out = calls('/fixture/a.ts', [
      'export function getUser(db, id) {',
      '  return db.query("SELECT * FROM users WHERE id = " + id);',
      '}',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    const call = out[0];
    expect(call.file).toBe('/fixture/a.ts');
    expect(call.tables).toContain('users');
    expect(call.hasFilter).toBe(true);
    expect(call.enclosingFunction).toBe('getUser');
    // String-concatenated input is the injection-risk signal.
    expect(call.hasSqlInjectionRisk).toBe(true);
  });

  it('extracts a bare tagged-template SQL call (`sql`…`) by tag name', () => {
    const out = calls('/fixture/tag.ts', [
      'const q = sql`SELECT * FROM users WHERE id = ${id}`;',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    expect(out[0].tables).toContain('users');
    expect(out[0].method).toBe('sql');
  });

  it('extracts a `this.sql` member tag — a wrapper re-exposing the tag', () => {
    // The receiver (`this.sql`) is not a bare identifier, so provenance alone
    // cannot resolve it; tag-name recognition is what makes the query visible.
    const out = calls('/fixture/this-tag.ts', [
      'class Repo {',
      '  health() { return this.sql`SELECT * FROM users`; }',
      '}',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    expect(out[0].tables).toContain('users');
    expect(out[0].method).toBe('sql');
  });

  it('extracts a tagged-template wrapped in a provenanced DB call under the call method', () => {
    const out = calls('/fixture/wrapped.ts', [
      'db.execute(sql`SELECT * FROM users`);',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    expect(out[0].tables).toContain('users');
    expect(out[0].method).toBe('execute');
  });

  it('returns an empty array for a file with no DB calls', () => {
    const out = calls('/fixture/b.ts', 'export const x = 1;\n');
    expect(out).toEqual([]);
  });
});

/**
 * Spec 68 Thing 2 (#312) — query-builder discovery is shape-based, not
 * receiver-name-based. A chain carrying a verb plus its required companion is a
 * query builder regardless of what the receiver is called; the same shape test
 * rejects `.delete`/`.update` on non-builder receivers that share the verb.
 */
describe('Spec 68 query-builder shape test', () => {
  it('admits a `.select().from()` chain on an un-provenanced receiver', () => {
    const out = calls('/fixture/shape-select.ts', [
      'appDb.getDb().select().from(users).where(eq(users.id, id));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((c) => c.tables.includes('users'))).toBe(true);
  });

  it('admits an `.insert().values()` chain', () => {
    const out = calls('/fixture/shape-insert.ts', [
      'appDb.getDb().insert(users).values({ name });',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
  });

  it('admits an `.update().set().where()` chain', () => {
    const out = calls('/fixture/shape-update.ts', [
      'appDb.getDb().update(users).set({ name }).where(eq(users.id, id));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
  });

  it('admits a `.delete().where()` chain', () => {
    const out = calls('/fixture/shape-delete.ts', [
      'appDb.getDb().delete(users).where(eq(users.id, id));',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
  });

  it('admits a `.selectDistinct().from()` chain (word-boundary regression)', () => {
    const out = calls('/fixture/shape-distinct.ts', [
      'db.selectDistinct({ a: t.a }).from(t);',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((c) => c.tables.includes('t'))).toBe(true);
  });

  it('admits the Prisma object form `prisma.<model>.<verb>({ where, data })`', () => {
    const out = calls('/fixture/shape-prisma.ts', [
      'prisma.user.update({ where: { id }, data: { name } });',
    ].join('\n'));
    expect(out.length).toBeGreaterThan(0);
  });

  it('rejects `map.delete(key)` — a verb with no query-builder companion', () => {
    const out = calls('/fixture/shape-map.ts', 'params.delete(key);\n');
    expect(out).toEqual([]);
  });

  it('rejects `crypto.createHash().update()` — `.update` without a companion', () => {
    const out = calls('/fixture/shape-crypto.ts', [
      'crypto.createHash("sha256").update(input);',
    ].join('\n'));
    expect(out).toEqual([]);
  });

  it('rejects `stripe.customers.update(id, data)` — no `where`/`data` object form', () => {
    const out = calls('/fixture/shape-stripe.ts', [
      'stripe.customers.update(id, data);',
    ].join('\n'));
    expect(out).toEqual([]);
  });

  it('rejects `cookies.delete(name)` — `.delete` with no chained `.where`', () => {
    const out = calls('/fixture/shape-cookies.ts', [
      'response.cookies.delete("auth");',
    ].join('\n'));
    expect(out).toEqual([]);
  });
});
