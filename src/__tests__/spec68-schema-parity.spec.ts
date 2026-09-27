/**
 * Spec 68 §3.2 — parity: the migrated schema rules reproduce the old analyzer's
 * findings exactly.
 *
 * A rule is "migrated" only when the new `analyze(ctx)` over the `schema-usage`
 * (and, for `unknown-table`, `table-catalog`) facts produces the *same* findings
 * the pre-migration `UniversalSchemaAnalyzer.analyzeAST` produced on a fixture —
 * same file, line, column, rule, severity. Not a "similar count": the full
 * multiset of identity tuples. This test runs BOTH paths per rule (the old
 * analyzer still live at the time it is written) and asserts the multisets are
 * equal and non-empty. It is the pin that lets §15 delete the old analyzer path
 * without losing the golden reference.
 *
 * Both extraction strategies are pinned, because the migrated rules must be
 * byte-identical on each: *tagged-template* SQL (`sql\`…\``) and *string-argument*
 * calls (`db.query("SELECT …")`). The new `schema-usage` producer now builds the
 * same hybrid provenance context the old `analyzeAST` built (see
 * `extractSchemaUsage`), so the string-argument path — which the legacy
 * pipeline recorded via `db.query` / `db.raw` — matches too. Each strategy has
 * its own case; the tagged-template path needs no provenance, the string-arg
 * path needs exactly the hybrid context both sides now share.
 *
 * `unknown-table` also exercises the corpus boundary: the old analyzer derives
 * its known-table set from `config.schemas`, while the new model derives it from
 * a DDL fixture file reduced through the `table-catalog` corpus producer. The
 * `CREATE TABLE users` DDL here is the new pipeline's `{ users }`, matching the
 * old analyzer's `schemas: [{ name: 'users', … }]`. The DDL fixture is supplied
 * in both shapes — a code migration (`migration.ts` tagged template) and a raw
 * `.sql` migration file — because the `.sql` producer is the §5 addition that
 * lets `unknown-table` read the corpus from migration files, not just code.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalSchemaAnalyzer, DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/UniversalSchemaAnalyzer.js';
import { runSchemaSlice } from '../phase/runner.js';
import { schemaRules } from '../phase/rules/schema.js';
import type { Violation } from '../types.js';

let adapter: LanguageAdapter;
let analyzer: UniversalSchemaAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalSchemaAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

interface ParityOpts {
  /** Known-table set the OLD analyzer reads from config.schemas. */
  schemas?: { name: string; tables: { name: string; columns: string[] }[] }[];
  /** DDL fixture the NEW model reduces into `table-catalog`. */
  ddl?: { path: string; content: string };
}

/** Run the old analyzer and the new slice, return the per-rule identity multisets. */
async function parity(ruleId: string, usageSource: string, opts: ParityOpts = {}) {
  const ast = parseFile('parity.ts', usageSource);
  expect(ast, `fixture failed to parse`).not.toBeNull();

  const config = { ...DEFAULT_SCHEMA_CONFIG, schemas: opts.schemas ?? [] };
  const oldRaw = await (analyzer as unknown as {
    analyzeAST(a: unknown, ad: LanguageAdapter, c: unknown, s: string): Promise<Violation[]>;
  }).analyzeAST(ast, adapter, config, usageSource);
  const old = oldRaw.filter((v) => v.rule === ruleId).map(key).sort();

  const files = [];
  if (opts.ddl) files.push({ path: opts.ddl.path, content: opts.ddl.content });
  files.push({ path: 'parity.ts', content: usageSource });
  const fresh = await runSchemaSlice(files);
  const nu = fresh.filter((f) => f.ruleId === ruleId).map(key).sort();

  return { old, nu };
}

/** The three TypeScript schema rules, in registry order — the slice under test. */
const RULE_IDS = schemaRules.map((r) => r.id);

describe('Spec 68 schema parity (new analyze(ctx) === old UniversalSchemaAnalyzer)', () => {
  it('covers exactly the three migrated schema rules', () => {
    expect(RULE_IDS).toEqual(['unknown-table', 'table-naming-convention', 'stale-table-reference']);
  });

  it('table-naming-convention (CamelCase table via tagged template)', async () => {
    const { old, nu } = await parity(
      'table-naming-convention',
      'import { sql } from "./db";\n' +
      'export function getProfiles() {\n' +
      '  return sql`SELECT * FROM UserProfiles`;\n' +
      '}\n',
      { schemas: [] },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('unknown-table (reference not in the known-table catalog)', async () => {
    const ddl =
      'export const up = `\n' +
      'CREATE TABLE users (id INT);\n' +
      '`;\n';
    const { old, nu } = await parity(
      'unknown-table',
      'import { sql } from "./db";\n' +
      'export function getProducts() {\n' +
      '  return sql`SELECT * FROM products`;\n' +
      '}\n',
      {
        schemas: [{ name: 'users', tables: [{ name: 'users', columns: [] }] }],
        ddl: { path: 'migration.ts', content: ddl },
      },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('unknown-table (string-arg db.query against a raw .sql migration catalog)', async () => {
    const { old, nu } = await parity(
      'unknown-table',
      'export function getProducts(db: { query(sql: string): unknown }) {\n' +
      '  return db.query("SELECT * FROM products");\n' +
      '}\n',
      {
        schemas: [{ name: 'users', tables: [{ name: 'users', columns: [] }] }],
        ddl: { path: 'migrations/001_init.sql', content: 'CREATE TABLE users (id INT);\n' },
      },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('table-naming-convention (string-arg db.query)', async () => {
    const { old, nu } = await parity(
      'table-naming-convention',
      'export function getProfiles(db: { query(sql: string): unknown }) {\n' +
      '  return db.query("SELECT * FROM UserProfiles");\n' +
      '}\n',
      { schemas: [] },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });
});
