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
import { parseSqlTables, checkQueryPatterns } from './schema/codeAnalysis.js';
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
  function tables(sql: string, allTables: Set<string> = new Set()): string[] {
    return parseSqlTables(sql, { line: 1, column: 1 }, sql, allTables)
      .map(r => r.table);
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
    // `UPDATE` inside a locking clause must not capture `SKIP`/`LOCKED` as a
    // table name (isSqlKeyword covers them).
    expect(tables('SELECT * FROM users WHERE id = 1 FOR UPDATE SKIP LOCKED')).toEqual(['users']);
  });

  it('does not read FOR UPDATE NOWAIT as a table', () => {
    expect(tables('SELECT * FROM users WHERE id = 1 FOR UPDATE NOWAIT')).toEqual(['users']);
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
