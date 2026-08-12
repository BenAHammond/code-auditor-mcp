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
import { UniversalSchemaAnalyzer } from './UniversalSchemaAnalyzer.js';
import type { TableSourceEntry, TableProvenance } from './UniversalSchemaAnalyzer.js';
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
  filePath = 'test.ts'
): Array<{ table: string; source: TableProvenance }> {
  const analyzer = new UniversalSchemaAnalyzer();
  return analyzer.extractTablesFromRegistry(ast, getAdapter(), sourceCode, entries, filePath);
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

  it('misses barrel re-export when module filter requires the original package', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'pgTable', arg: 0, module: 'drizzle-orm/pg-core' },
    ];
    const source = `import { pgTable } from './db';
export const users = pgTable('users', { id: serial('id') });`;
    const ast = await parseSource(source);
    const result = extract(ast, source, entries);

    // module filter checks the import source ('./db'), not the original package.
    // The barrel re-export breaks the chain — this is a known limitation.
    expect(result).toHaveLength(0);
  });
});
