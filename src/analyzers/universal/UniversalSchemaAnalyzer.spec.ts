/**
 * Spec 29 R2 — Table-source registry fixture tests.
 *
 * Each test parses a TypeScript snippet through the tree-sitter adapter,
 * calls extractTablesFromRegistry() directly, and asserts the extracted
 * table names and provenance are correct.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../../languages/index.js';
import { LanguageRegistry } from '../../languages/LanguageRegistry.js';
import { extractTablesFromRegistry } from './schema/discovery.js';
import { parseSqlTables, checkQueryPatterns, findTableReferences, checkUnresolvedQueries, checkUnparseableSql, checkUnresolvedReceiverImports } from './schema/codeAnalysis.js';
import type { ProvenanceContext } from '../../provenance.js';
import type { TableSourceEntry, TableProvenance } from './schema/types.js';
import type { LanguageAdapter, AST } from '../../languages/types.js';

// ── Module-level setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function getAdapter(): LanguageAdapter {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts');
  if (!adapter) throw new Error('TypeScript adapter not registered');
  return adapter;
}

async function parseSource(source: string, filePath = 'test.ts'): Promise<AST> {
  const adapter = getAdapter();
  return adapter.parse(filePath, source);
}

function extract(
  ast: AST,
  sourceCode: string,
  entries: TableSourceEntry[],
  filePath = 'test.ts',
  readModule?: (fromFile: string, specifier: string) => string | null
): Array<{ table: string; source: TableProvenance }> {
  return extractTablesFromRegistry(entries, {
    ast,
    adapter: getAdapter(),
    sourceCode,
    filePath,
    readModule,
  });
}

/**
 * Builds a readModule callback that answers from a `specifier → module source`
 * map. Mirrors the on-disk resolver signature so tests can inject barrel
 * contents without touching the filesystem.
 */
function makeReadModule(files: Record<string, string>): (fromFile: string, specifier: string) => string | null {
  return (_fromFile: string, specifier: string) => files[specifier] ?? null;
}

// ── Fixture 1: Drizzle pgTable ──────────────────────────────────────────────

describe('Fixture 1 — Drizzle pgTable via registry', () => {
  const entries: TableSourceEntry[] = [
    { kind: 'callee', name: 'pgTable', arg: 0, description: 'Drizzle PostgreSQL table' },
  ];

  it('extracts table from pgTable call', async () => {
    const source = `import { pgTable } from 'drizzle-orm/pg-core';
export const users = pgTable('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('users');
    expect(result[0].source.tier).toBe('orm-registry');
    expect(result[0].source.description).toBe('Drizzle PostgreSQL table');
    expect(result[0].source.sourceFile).toBe('test.ts');
  });

  it('extracts multiple pgTable calls in one file', async () => {
    const source = `import { pgTable } from 'drizzle-orm/pg-core';
export const users = pgTable('users', { id: serial('id') });
export const posts = pgTable('posts', { id: serial('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(2);
    expect(result.map(r => r.table).sort()).toEqual(['posts', 'users']);
  });

  it('extracts table from mysqlTable call', async () => {
    const mysqlEntries: TableSourceEntry[] = [
      { kind: 'callee', name: 'mysqlTable', arg: 0, description: 'Drizzle MySQL table' },
    ];
    const source = `import { mysqlTable } from 'drizzle-orm/mysql-core';
export const orders = mysqlTable('orders', { id: serial('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, mysqlEntries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('orders');
  });

  it('extracts table from sqliteTable call', async () => {
    const sqliteEntries: TableSourceEntry[] = [
      { kind: 'callee', name: 'sqliteTable', arg: 0, description: 'Drizzle SQLite table' },
    ];
    const source = `import { sqliteTable } from 'drizzle-orm/sqlite-core';
export const items = sqliteTable('items', { id: integer('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, sqliteEntries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('items');
  });
});

// ── Fixture 2: Knex createTable ─────────────────────────────────────────────

describe('Fixture 2 — Knex createTable via registry', () => {
  const entries: TableSourceEntry[] = [
    { kind: 'callee', name: 'createTable', arg: 0, module: 'knex', description: 'Knex table' },
  ];

  it('extracts table from knex.schema.createTable', async () => {
    const source = `import knex from 'knex';
exports.up = function(knex: any) {
  return knex.schema.createTable('orders', (table: any) => { table.increments('id'); });
};`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('orders');
    expect(result[0].source.tier).toBe('orm-registry');
    expect(result[0].source.description).toBe('Knex table');
  });

  it('extracts table from Knex with destructured import', async () => {
    const source = `import knex from 'knex';
const db = knex({});
db.schema.createTable('products', (table: any) => { table.increments('id'); });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    // 'db' is not from a 'knex' import — it's a local variable. Should NOT match.
    // Module filter correctly rejects this because "db" isn't imported from "knex".
    expect(result).toHaveLength(0);
  });
});

// ── Fixture 3: TypeORM @Entity decorator ────────────────────────────────────

describe('Fixture 3 — TypeORM @Entity decorator via registry', () => {
  const entries: TableSourceEntry[] = [
    { kind: 'decorator', name: 'Entity', arg: 0, module: 'typeorm', description: 'TypeORM entity' },
  ];

  it('extracts table from @Entity decorator', async () => {
    const source = `import { Entity } from 'typeorm';
@Entity('customers')
export class Customer { id: number; }`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('customers');
    expect(result[0].source.tier).toBe('orm-registry');
    expect(result[0].source.description).toBe('TypeORM entity');
  });

  it('extracts table from @Entity with template string', async () => {
    const source = "import { Entity } from 'typeorm';\n@Entity(`orders_archive`)\nexport class OrdersArchive { id: number; }";
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('orders_archive');
  });
});

// ── Fixture 4: Near-miss negative ───────────────────────────────────────────

describe('Fixture 4 — Near-miss: no match without DB provenance', () => {
  it('does not match createTable call without DB import', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'createTable', arg: 0, module: 'knex' },
    ];
    const source = `function createTable(name: string) { console.log(name); }
createTable('metrics_table');`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    // No knex import → no match
    expect(result).toHaveLength(0);
  });

  it('does not match similar local function name without module filter', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'createTable', arg: 0 },
    ];
    const source = `function createTable(name: string) { console.log(name); }
createTable('metrics_table');`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    // Without module filter, the function name matches — this is expected
    // behavior. Users should set `module` to avoid false positives.
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('metrics_table');
  });

  it('does not match unrelated decorator', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'decorator', name: 'Entity', arg: 0, module: 'typeorm' },
    ];
    const source = `import { Component } from '@angular/core';
@Component({ selector: 'app-root' })
export class AppComponent { }`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    // Component decorator doesn't match Entity entry
    expect(result).toHaveLength(0);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('empty tableSources returns empty array', async () => {
    const source = `import { pgTable } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {});`;
    const ast = await parseSource(source);
    const result = extract(ast, source, []);

    expect(result).toHaveLength(0);
  });

  it('extracts table from call without import (no module filter)', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0 },
    ];
    const source = `export const users = pgTable('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('users');
  });

  it('handles template string table name', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0 },
    ];
    const source = 'const t = pgTable(`dynamic_table`, {});';
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('dynamic_table');
  });
});

// ── Aliasing edge cases ──────────────────────────────────────────────────

describe('Aliasing — import { pgTable as table }', () => {
  it('without module filter, callee name is matched literally (alias hides original)', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0 },
    ];
    const source = `import { pgTable as table } from 'drizzle-orm/pg-core';
export const users = table('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    // No module filter → callee name is matched literally at the call site.
    // The call site is `table(...)`, not `pgTable(...)`, so no match.
    expect(result).toHaveLength(0);
  });

  it('matches via import map when module filter resolves the alias', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0, module: 'drizzle-orm/pg-core' },
    ];
    const source = `import { pgTable as table } from 'drizzle-orm/pg-core';
export const users = table('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('users');
    expect(result[0].source.tier).toBe('orm-registry');
  });

  it('resolves aliased default import through module filter', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'createTable', arg: 0, module: 'knex' },
    ];
    const source = `import db from 'knex';
db.schema.createTable('orders', (table: any) => { table.increments('id'); });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('orders');
  });
});

describe('Aliasing — barrel re-export', () => {
  it('matches pgTable imported from a local barrel without module filter', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0 },
    ];
    const source = `import { pgTable } from './db';
export const users = pgTable('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    // Without module filter, callee name matches literally — works fine.
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('users');
  });

  it('resolves one-hop barrel re-export when module filter requires the original package', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0, module: 'drizzle-orm/pg-core' },
    ];
    const source = `import { pgTable } from './db';
export const users = pgTable('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    const readModule = makeReadModule({
      './db': `export * from 'drizzle-orm/pg-core';\n`,
    });
    const result = extract(ast, source, entries, 'test.ts', readModule);

    // The barrel (`./db`) star re-exports from drizzle-orm/pg-core, so one hop
    // of resolution recovers the original `pgTable` name and the module filter
    // matches.
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('users');
  });

  it('resolves a named re-export through a local barrel', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0, module: 'drizzle-orm/pg-core' },
    ];
    const source = `import { table } from './db';
export const users = table('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    const readModule = makeReadModule({
      './db': `export { pgTable as table } from 'drizzle-orm/pg-core';\n`,
    });
    const result = extract(ast, source, entries, 'test.ts', readModule);

    // `./db` renames pgTable → table; the import binds `table`, and the named
    // re-export maps it back to the original `pgTable`.
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe('users');
  });

  it('leaves a two-hop barrel (barrel re-exporting from another local module) unresolved', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0, module: 'drizzle-orm/pg-core' },
    ];
    const source = `import { pgTable } from './db';
export const users = pgTable('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    // Depth limit is one hop: ./db re-exports from ./inner, which is where the
    // original package lives. That second hop is NOT traced.
    const readModule = makeReadModule({
      './db': `export * from './inner';\n`,
      './inner': `export * from 'drizzle-orm/pg-core';\n`,
    });
    const result = extract(ast, source, entries, 'test.ts', readModule);

    expect(result).toHaveLength(0);
  });
});

// ── Spec 33 Item 11 — unknown-table false-positive guards ─────────────────

describe('parseSqlTables — table-valued function and module-import guards', () => {
  function tables(sql: string, allTables: Set<string> = new Set(), dialect: 'sqlite' | 'mysql' | 'postgresql' = 'sqlite'): string[] {
    return parseSqlTables(sql, { line: 1, column: 1 }, sql, allTables, dialect, null)
      .references.map(r => r.table);
  }

  it('still extracts a genuine table reference', () => {
    expect(tables('SELECT * FROM users')).toEqual(['users']);
  });

  it('does not flag SQLite json_each table-valued function', () => {
    expect(tables("SELECT * FROM json_each('[1,2]')")).toEqual([]);
  });

  it('does not flag PostgreSQL generate_series table-valued function', () => {
    expect(tables('SELECT * FROM generate_series(1, 10)')).toEqual([]);
  });

  it('does not flag a JS import specifier as an unknown table', () => {
    expect(tables("import { type QueryRunner } from 'typeorm';")).toEqual([]);
  });

  it('does not flag a default import specifier as an unknown table', () => {
    expect(tables("import path from 'path';")).toEqual([]);
  });

  it('does not flag a named import specifier as an unknown table', () => {
    expect(tables("import { config } from 'dotenv';")).toEqual([]);
  });

  it('does not flag a re-export specifier as an unknown table', () => {
    expect(tables("export { pgTable } from 'drizzle-orm/pg-core';")).toEqual([]);
  });

  it('still extracts a table after a module import in the same source', () => {
    expect(tables("import { config } from 'dotenv';\nSELECT * FROM users")).toEqual(['users']);
  });

  it('does not suppress a table named after a SQL comment mentioning import', () => {
    // The `-- import data` comment must not be read as a module statement.
    expect(tables('SELECT * FROM users\n-- import data')).toEqual(['users']);
  });

  it('does not read FOR UPDATE SKIP LOCKED as a table', () => {
    // FOR UPDATE SKIP LOCKED is a row-locking clause, not a relation; the AST
    // walk yields only `users`. node-sql-parser parses the locking clause only
    // under the mysql grammar (its sqlite/postgresql grammars reject it), so pin
    // the Spec 55 fix under the dialect that can read it.
    expect(tables('SELECT * FROM users WHERE id = 1 FOR UPDATE SKIP LOCKED', new Set(), 'mysql')).toEqual(['users']);
  });

  it('does not read FOR UPDATE NOWAIT as a table', () => {
    expect(tables('SELECT * FROM users WHERE id = 1 FOR UPDATE NOWAIT', new Set(), 'mysql')).toEqual(['users']);
  });
});

describe('parseSqlTables — DELETE FROM is a write, not a read (Spec 56 R4)', () => {
  function refs(sql: string): Array<{ table: string; type: string }> {
    return parseSqlTables(sql, { line: 1, column: 1 }, sql, new Set(), 'sqlite', null)
      .references.map(r => ({ table: r.table, type: r.type }))
      .sort((a, b) => a.table.localeCompare(b.table) || a.type.localeCompare(b.type));
  }

  it('classifies DELETE FROM as a write only (positive)', () => {
    expect(refs('DELETE FROM users')).toEqual([{ table: 'users', type: 'delete' }]);
  });

  it('classifies a plain SELECT ... FROM as a read (guard)', () => {
    expect(refs('SELECT * FROM users')).toEqual([{ table: 'users', type: 'select' }]);
  });

  it('classifies a table both selected and deleted as both (near-miss)', () => {
    expect(refs('SELECT * FROM users;\nDELETE FROM users')).toEqual([
      { table: 'users', type: 'delete' },
      { table: 'users', type: 'select' },
    ]);
  });

  it('classifies INSERT INTO ... SELECT ... FROM as both a write and a read', () => {
    expect(refs('INSERT INTO target SELECT * FROM source')).toEqual([
      { table: 'source', type: 'select' },
      { table: 'target', type: 'insert' },
    ]);
  });

  it('handles a newline between DELETE and FROM', () => {
    expect(refs('DELETE\nFROM users')).toEqual([{ table: 'users', type: 'delete' }]);
  });

  it('handles multiple spaces between DELETE and FROM', () => {
    expect(refs('DELETE   FROM users')).toEqual([{ table: 'users', type: 'delete' }]);
  });
});

describe('checkQueryPatterns — ceiling fallback', () => {
  it('uses the analyzer default, not "undefined", when maxQueriesPerFunction is absent', async () => {
    const source = [
      'function f() {',
      '  db.query("SELECT 1");',
      '  db.query("SELECT 2");',
      '  db.query("SELECT 3");',
      '  db.query("SELECT 4");',
      '  db.query("SELECT 5");',
      '  db.query("SELECT 6");',
      '}',
    ].join('\n');
    const ast = await parseSource(source);
    const violations = checkQueryPatterns(ast, getAdapter(), source, {} as any);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('exceeding the maximum of 5');
    expect(violations[0].message).not.toContain('undefined');
  });
});

// ── Spec 58 R1 — SQL held in a variable ──────────────────────────────────────

describe('findTableReferences — SQL assembled in a constant (Spec 58 R1)', () => {
  // Spec 69 §10 — a bare `db` receiver is no longer provenanced by name. Seed it
  // the way the cross-file declaration-resolution pass would, so these tests keep
  // exercising SQL-constant resolution rather than the (deleted) name-list path.
  function seededProvenance(): ProvenanceContext {
    return {
      mode: 'hybrid',
      dbProvenanced: new Map([
        ['db', { identifier: 'db', reason: 'binding', source: 'test seed', chain: [] }],
      ]),
      validatorProvenanced: new Map(),
    };
  }

  async function refs(source: string) {
    const ast = await parseSource(source);
    return findTableReferences(ast, getAdapter(), source, {
      config: { sqlDialect: 'sqlite' },
      provenanceContext: seededProvenance(),
    });
  }

  it('resolves a module-level template-literal constant at a DB call site', async () => {
    // §13 (Spec 70) — the constant's SQL is now parsed under the corpus dialect.
    // The original ON CONFLICT DO UPDATE form is a postgresql-ism node-sql-parser
    // cannot read under sqlite, so the upsert is expressed in the sqlite form
    // (INSERT OR REPLACE) that parses — the resolution contract is unchanged.
    const source = [
      'const UPSERT_SQL = `INSERT OR REPLACE INTO metrics (hour_key, a) VALUES (?, ?)`;',
      'db.prepare(UPSERT_SQL);',
    ].join('\n');
    const { references, unresolved } = await refs(source);
    expect(unresolved).toHaveLength(0);
    expect(references.some(r => r.table === 'metrics' && r.type === 'insert')).toBe(true);
  });

  it('reports an imported constant as unresolved (not silent absence)', async () => {
    const source = [
      'import { UPSERT_SQL } from "./queries";',
      'db.prepare(UPSERT_SQL);',
    ].join('\n');
    const { references, unresolved } = await refs(source);
    expect(references).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].identifier).toBe('UPSERT_SQL');
  });

  it('reports a call-result initializer as unresolved', async () => {
    const source = [
      'const SQL = buildQuery();',
      'db.prepare(SQL);',
    ].join('\n');
    const { references, unresolved } = await refs(source);
    expect(references).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].identifier).toBe('SQL');
  });

  it('skips a structured array-literal first argument — not SQL, not unresolved (Spec 70)', async () => {
    // `db.batch(stmts)` where `stmts` is a local statements array. Before Spec 70
    // this was method-gated by SQL_CARRYING_METHOD_NAMES; now "is this SQL" is
    // answered by the resolved value's shape, so an array literal is skipped
    // rather than reported as an unresolvable query.
    const source = [
      'const stmts = [stmt1, stmt2];',
      'db.batch(stmts);',
    ].join('\n');
    const { references, unresolved } = await refs(source);
    expect(references).toHaveLength(0);
    expect(unresolved).toHaveLength(0);
  });

  it('skips a structured object-literal first argument — not SQL, not unresolved (Spec 70)', async () => {
    const source = [
      'const params = { org_id: 1 };',
      'db.all(params);',
    ].join('\n');
    const { references, unresolved } = await refs(source);
    expect(references).toHaveLength(0);
    expect(unresolved).toHaveLength(0);
  });

  it('still extracts a direct string argument without an unresolved record', async () => {
    const source = 'db.prepare("INSERT INTO users VALUES (?)");';
    const { references, unresolved } = await refs(source);
    expect(unresolved).toHaveLength(0);
    expect(references.some(r => r.table === 'users' && r.type === 'insert')).toBe(true);
  });

  it('builds unresolved-query coverage diagnostics (not violations) with file + line', async () => {
    const v = checkUnresolvedQueries(
      [{ identifier: 'UPSERT_SQL', location: { line: 2, column: 1 } }],
      'src/a.ts',
    );
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('unresolved-query');
    expect(v[0].analyzerName).toBe('schema');
    expect(v[0].file).toBe('src/a.ts');
    expect(v[0].line).toBe(2);
    expect(v[0].message).toContain('UPSERT_SQL');
    expect(v[0].details).toEqual({ identifier: 'UPSERT_SQL' });
  });

  it('builds cannot-fire coverage diagnostics for an unresolvable DB receiver import (Spec 69 §10)', async () => {
    const v = checkUnresolvedReceiverImports(
      [{ source: './db', names: ['db'] }],
      'src/a.ts',
    );
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('cannot-fire');
    expect(v[0].analyzerName).toBe('schema');
    expect(v[0].file).toBe('src/a.ts');
    expect(v[0].line).toBe(0);
    expect(v[0].message).toContain("'db'");
    expect(v[0].message).toContain('./db');
    expect(v[0].message).toContain('unseen');
    expect(v[0].details?.source).toBe('./db');
    expect(v[0].details?.names).toEqual(['db']);
    // Spec 69 §10 — the release bar is that an unproven receiver explains itself.
    // The import-level emission must carry the same `reason` the call-site shape does,
    // so a consumer reading `details.reason` never sees `undefined`.
    expect(v[0].details?.reason).toContain("'db'");
    expect(v[0].details?.reason).toContain('./db');
  });
});

// ── Spec 70 R2 — unparseable SQL in a SQL position is unreadable, not clean ─

describe('findTableReferences — PRAGMA/VACUUM is unreadable, not "no tables" (Spec 70 R2)', () => {
  function seededProvenance(): ProvenanceContext {
    return {
      mode: 'hybrid',
      dbProvenanced: new Map([
        ['db', { identifier: 'db', reason: 'binding', source: 'test seed', chain: [] }],
      ]),
      validatorProvenanced: new Map(),
    };
  }

  async function refs(source: string) {
    const ast = await parseSource(source);
    return findTableReferences(ast, getAdapter(), source, {
      config: { sqlDialect: 'sqlite' },
      provenanceContext: seededProvenance(),
    });
  }

  it('a static PRAGMA argument is reported unparseable, not an empty reference set', async () => {
    const source = 'db.prepare("PRAGMA table_info(stadium_builds)");';
    const { references, unparseable } = await refs(source);
    // The SQL-position argument is read, but the parser cannot answer "which
    // tables" — so it must surface as unreadable, not as "no tables" (which
    // unknown-table / stale-table-reference would read as clean).
    expect(unparseable).toHaveLength(1);
    expect(unparseable[0].sqlText).toBe('PRAGMA table_info(stadium_builds)');
    expect(unparseable[0].location.line).toBe(1);
    expect(unparseable[0].reason.length).toBeGreaterThan(0);
    expect(references).toHaveLength(0);
  });

  it('a static VACUUM argument is reported unparseable', async () => {
    const { unparseable } = await refs('db.run("VACUUM");');
    expect(unparseable).toHaveLength(1);
    expect(unparseable[0].sqlText).toBe('VACUUM');
  });

  it('a static ANALYZE argument is reported unparseable', async () => {
    const { unparseable } = await refs('db.exec("ANALYZE");');
    expect(unparseable).toHaveLength(1);
    expect(unparseable[0].sqlText).toBe('ANALYZE');
  });

  it('a parseable SELECT argument produces no unparseable record', async () => {
    const source = 'db.prepare("SELECT * FROM users WHERE org_id = ?");';
    const { references, unparseable } = await refs(source);
    expect(unparseable).toHaveLength(0);
    expect(references.some(r => r.table === 'users')).toBe(true);
  });

  it('without a dialect, a SQL argument that also fails the default grammar is dialect-undetermined (cannot-fire), not silently empty', async () => {
    const ast = await parseSource('db.prepare("PRAGMA table_info(stadium_builds)");');
    const result = findTableReferences(ast, getAdapter(), 'db.prepare("PRAGMA table_info(stadium_builds)");', {
      config: {},
      provenanceContext: seededProvenance(),
    });
    // No dialect does not skip the parse (Spec 70 R2) — the SQL is attempted
    // under the default sqlite grammar. `PRAGMA table_info(…)` fails there too,
    // so the site abstains *loudly*: a "dialect undetermined" cannot-fire that
    // names both the undetermined dialect and the default-grammar parse failure,
    // and no table facts (never an empty reference set read as clean).
    expect(result.unparseable).toHaveLength(1);
    expect(result.unparseable[0].kind).toBe('dialect-undetermined');
    expect(result.unparseable[0].reason).toContain('dialect undetermined');
    expect(result.unparseable[0].reason).toContain('default sqlite grammar');
    expect(result.references).toHaveLength(0);
  });

  it('without a dialect, a SQL argument that parses under the default grammar still yields table facts (R2 — parse before dialect)', async () => {
    const source = 'db.prepare("SELECT * FROM users WHERE org_id = ?");';
    const ast = await parseSource(source);
    const result = findTableReferences(ast, getAdapter(), source, {
      config: {},
      provenanceContext: seededProvenance(),
    });
    // No dialect does not skip the parse — the SELECT parses under the default
    // sqlite grammar, so the table fact is derived and no cannot-fire record is
    // produced (the dialect gate no longer sits upstream of the parse).
    expect(result.unparseable).toHaveLength(0);
    expect(result.references.some(r => r.table === 'users')).toBe(true);
  });

  it('checkUnparseableSql builds a parse-failure cannot-fire diagnostic with file + line + reason', () => {
    const v = checkUnparseableSql(
      [{ sqlText: 'PRAGMA table_info(stadium_builds)', location: { line: 3, column: 1 }, reason: 'Expected ...', kind: 'parse-failure' }],
      'src/a.ts',
    );
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('cannot-fire');
    expect(v[0].analyzerName).toBe('schema');
    expect(v[0].file).toBe('src/a.ts');
    expect(v[0].line).toBe(3);
    expect(v[0].message).toContain('cannot be parsed');
    expect(v[0].details).toEqual({ sql: 'PRAGMA table_info(stadium_builds)', reason: 'Expected ...', kind: 'parse-failure' });
  });

  it('checkUnparseableSql builds a dialect-undetermined cannot-fire diagnostic naming the reason', () => {
    const v = checkUnparseableSql(
      [{ sqlText: 'PRAGMA table_info(stadium_builds)', location: { line: 3, column: 1 }, reason: 'dialect undetermined (no database driver in package.json or wrangler.toml)', kind: 'dialect-undetermined' }],
      'src/a.ts',
    );
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('cannot-fire');
    expect(v[0].message).toContain('dialect undetermined');
    expect(v[0].details).toEqual({ sql: 'PRAGMA table_info(stadium_builds)', reason: 'dialect undetermined (no database driver in package.json or wrangler.toml)', kind: 'dialect-undetermined' });
  });
});
