/**
 * ORM Adapter Unit Tests — Spec 15 R2
 *
 * Tests Drizzle + Prisma table-reference extraction and schema-definition
 * extraction using mock AST nodes and adapter stubs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DrizzleAdapter } from '../drizzleAdapter.js';
import { PrismaAdapter } from '../prismaAdapter.js';
import { OrmAdapterRegistry } from '../adapterRegistry.js';
import type { OrmAdapter, OrmTableReference, OrmSchemaDefinition } from '../types.js';
import type { AST, ASTNode, LanguageAdapter } from '../../../languages/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock AST node at a given line/column. */
function makeNode(type: string, line: number, column: number): ASTNode {
  return {
    type,
    range: [0, 0],
    location: {
      start: { line, column },
      end: { line: line + 1, column },
    },
    raw: null,
  };
}

/**
 * Spec 22 R4.2: Create an import-statement mock node that causes the
 * Drizzle adapter's file-level gate to pass. Without this, every file
 * is rejected before reaching the expression-level checks.
 */
function makeDrizzleImport(line = 1, column = 0): ASTNode {
  return makeNode('import_statement', line, column);
}

/** Create a minimal mock AST with the given file path and nodes. */
function makeAST(filePath: string, nodes: ASTNode[]): AST {
  return {
    language: 'typescript',
    filePath,
    root: makeNode('program', 0, 0),
    errors: [],
  };
}

/**
 * Create an AST that includes a drizzle-orm import, so the file-level
 * import gate passes for Drizzle table-reference tests.
 */
function makeDrizzleAST(filePath: string, nodes: ASTNode[]): AST {
  const ast = makeAST(filePath, nodes);
  const importNode = makeDrizzleImport();
  (ast as any).__imports = [importNode];
  return ast;
}

/**
 * Create a mock LanguageAdapter.
 *
 * @param nodeTexts  Map from synthetic node keys to the source text the
 *                   adapter should return for that node via getNodeText.
 *                   Keys are built as `${line}:${column}`.
 */
function makeAdapter(
  nodeTexts: Map<string, string>,
): LanguageAdapter {
  return {
    // Required members
    findNodes: (ast: AST, pattern: any) => {
      // Spec 22 R4.2: The Drizzle adapter's file-level gate uses
      // findNodes({ type: 'import_statement' }) to detect drizzle-orm imports.
      // Return __imports when searching for import statements, __nodes otherwise.
      if (pattern?.type === 'import_statement') {
        return (ast as any).__imports ?? [];
      }
      return (ast as any).__nodes ?? [];
    },
    getNodeText: (node: ASTNode, _sourceCode: string) => {
      // Spec 22 R4.2: import_statement nodes always return drizzle-orm text
      // so the file-level import gate passes for Drizzle table-reference tests.
      if (node.type === 'import_statement') {
        return 'import { eq } from "drizzle-orm";';
      }
      const key = `${node.location.start.line}:${node.location.start.column}`;
      return nodeTexts.get(key) ?? '';
    },
    name: 'mock',
    language: 'typescript',
    fileExtensions: ['.ts'],
    parse: () => { throw new Error('not implemented'); },
    extractFunctions: () => [],
    extractClasses: () => [],
    extractImports: () => [],
    extractExports: () => [],
    extractCallExpressions: () => [],
    extractComments: () => [],
    getComplexity: () => 1,
    getLineCount: () => 1,
    findPattern: () => [],
    findChild: () => null,
    findParent: () => null,
    getJsDoc: () => null,
    hasAnnotation: () => false,
    getParameters: () => [],
    getReturnType: () => null,
    isAsync: () => false,
    isExported: () => false,
    isMethod: () => false,
    getClassName: () => null,
  } as unknown as LanguageAdapter;
}

// ---------------------------------------------------------------------------
// Drizzle Adapter
// ---------------------------------------------------------------------------

describe('DrizzleAdapter', () => {
  let adapter: DrizzleAdapter;

  beforeEach(() => {
    adapter = new DrizzleAdapter();
  });

  // ── supportsFile ────────────────────────────────────────────────────────

  describe('supportsFile', () => {
    it('returns true for .ts files', () => {
      expect(adapter.supportsFile('src/db/schema.ts')).toBe(true);
    });

    it('returns true for .tsx files', () => {
      expect(adapter.supportsFile('components/queries.tsx')).toBe(true);
    });

    it('returns false for unsupported extensions', () => {
      expect(adapter.supportsFile('src/schema.prisma')).toBe(false);
      expect(adapter.supportsFile('src/data.py')).toBe(false);
    });
  });

  // ── extractTableReferences ──────────────────────────────────────────────

  describe('extractTableReferences', () => {
    it('extracts select + from pattern: db.select().from(users)', () => {
      const node = makeNode('call_expression', 10, 4);
      const ast = makeDrizzleAST('src/queries.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['10:4', 'db.select().from(users)'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'users', type: 'select' });
    });

    it('extracts select from with chained .where(): db.select().from(posts).where(...)', () => {
      const node = makeNode('call_expression', 12, 2);
      const ast = makeDrizzleAST('src/queries.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['12:2', 'db.select().from(posts).where(eq(posts.id, 1))'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'posts', type: 'select' });
    });

    it('extracts insert pattern: db.insert(users).values(...)', () => {
      const node = makeNode('call_expression', 20, 4);
      const ast = makeDrizzleAST('src/queries.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['20:4', 'db.insert(users).values({ name: "alice" })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'users', type: 'insert' });
    });

    it('extracts update pattern: db.update(users).set(...)', () => {
      const node = makeNode('call_expression', 25, 4);
      const ast = makeDrizzleAST('src/queries.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['25:4', 'db.update(users).set({ name: "bob" }).where(...)'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'users', type: 'update' });
    });

    it('extracts delete pattern: db.delete(users).where(...)', () => {
      const node = makeNode('call_expression', 30, 4);
      const ast = makeDrizzleAST('src/queries.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['30:4', 'db.delete(users).where(eq(users.id, 1))'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'users', type: 'delete' });
    });

    it('returns empty for non-Drizzle query calls', () => {
      const node = makeNode('call_expression', 40, 4);
      const ast = makeDrizzleAST('src/queries.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['40:4', 'console.log("hello")'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(0);
    });

    it('handles multiple references in one file', () => {
      const node1 = makeNode('call_expression', 5, 2);
      const node2 = makeNode('call_expression', 15, 2);
      const ast = makeDrizzleAST('src/queries.ts', [node1, node2]);
      (ast as any).__nodes = [node1, node2];

      const texts = new Map([
        ['5:2', 'db.select().from(users)'],
        ['15:2', 'db.insert(profiles).values({})'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(2);
      expect(refs[0].table).toBe('users');
      expect(refs[1].table).toBe('profiles');
    });

    // Spec 22 R4.2: File-level gate — no drizzle-orm import → empty
    it('returns empty when file does not import drizzle-orm', () => {
      const node = makeNode('call_expression', 10, 4);
      // Use makeAST (NOT makeDrizzleAST) — no import statement provided
      const ast = makeAST('src/utils.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['10:4', 'db.select().from(users)'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(0);
    });

    // Spec 22 R4.2: Array.from(map) is NOT a SQL query — no .select() companion
    it('does not match Array.from(map) — requires .select() companion', () => {
      const node = makeNode('call_expression', 42, 4);
      const ast = makeDrizzleAST('src/queries.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['42:4', 'const arr = Array.from(map)'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(0);
    });
  });

  // ── extractSchemaDefinitions ────────────────────────────────────────────

  describe('extractSchemaDefinitions', () => {
    it('extracts pgTable definition with columns', () => {
      const node = makeNode('call_expression', 3, 0);
      const ast = makeAST('src/schema.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['3:0', `pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: varchar('email', { length: 255 }),
})`],
      ]);

      const defs = adapter.extractSchemaDefinitions(ast, makeAdapter(texts), '');
      expect(defs).toHaveLength(1);
      expect(defs[0].tableName).toBe('users');
      expect(defs[0].columns.length).toBeGreaterThanOrEqual(3);
    });

    it('extracts mysqlTable definition', () => {
      const node = makeNode('call_expression', 1, 0);
      const ast = makeAST('src/schema.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['1:0', "mysqlTable('products', { id: int('id').primaryKey() })"],
      ]);

      const defs = adapter.extractSchemaDefinitions(ast, makeAdapter(texts), '');
      expect(defs).toHaveLength(1);
      expect(defs[0].tableName).toBe('products');
    });

    it('extracts sqliteTable definition', () => {
      const node = makeNode('call_expression', 5, 0);
      const ast = makeAST('src/schema.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['5:0', "sqliteTable('cache', { key: text('key').primaryKey() })"],
      ]);

      const defs = adapter.extractSchemaDefinitions(ast, makeAdapter(texts), '');
      expect(defs).toHaveLength(1);
      expect(defs[0].tableName).toBe('cache');
    });

    it('returns empty for non-table-builder calls', () => {
      const node = makeNode('call_expression', 10, 0);
      const ast = makeAST('src/schema.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['10:0', "someOtherFn('name', {})"],
      ]);

      const defs = adapter.extractSchemaDefinitions(ast, makeAdapter(texts), '');
      expect(defs).toHaveLength(0);
    });

    it('records location info from the AST node', () => {
      const node = makeNode('call_expression', 42, 8);
      const ast = makeAST('src/schema.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['42:8', `pgTable('t', { id: int('id').primaryKey() })`],
      ]);

      const defs = adapter.extractSchemaDefinitions(ast, makeAdapter(texts), '');
      expect(defs).toHaveLength(1);
      expect(defs[0].location).toEqual({ line: 42, column: 8 });
    });
  });
});

// ---------------------------------------------------------------------------
// Prisma Adapter
// ---------------------------------------------------------------------------

describe('PrismaAdapter', () => {
  let adapter: PrismaAdapter;

  beforeEach(() => {
    adapter = new PrismaAdapter();
  });

  // ── supportsFile ────────────────────────────────────────────────────────

  describe('supportsFile', () => {
    it('returns true for .prisma files', () => {
      expect(adapter.supportsFile('prisma/schema.prisma')).toBe(true);
    });

    it('returns true for files named schema.prisma', () => {
      expect(adapter.supportsFile('db/schema.prisma')).toBe(true);
    });

    it('returns true for JS/TS files (for Prisma client calls)', () => {
      expect(adapter.supportsFile('src/services/user.service.ts')).toBe(true);
    });

    it('returns false for unsupported extensions', () => {
      expect(adapter.supportsFile('src/data.py')).toBe(false);
      expect(adapter.supportsFile('src/schema.graphql')).toBe(false);
    });
  });

  // ── extractTableReferences ──────────────────────────────────────────────

  describe('extractTableReferences', () => {
    it('extracts findMany → select', () => {
      const node = makeNode('call_expression', 10, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['10:4', 'prisma.user.findMany({ where: { active: true } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'user', type: 'select' });
    });

    it('extracts findUnique → select', () => {
      const node = makeNode('call_expression', 12, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['12:4', 'prisma.user.findUnique({ where: { id: 1 } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('select');
    });

    it('extracts create → insert', () => {
      const node = makeNode('call_expression', 20, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['20:4', 'prisma.user.create({ data: { name: "alice" } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'user', type: 'insert' });
    });

    it('extracts createMany → insert', () => {
      const node = makeNode('call_expression', 22, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['22:4', 'prisma.user.createMany({ data: [{ name: "a" }, { name: "b" }] })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('insert');
    });

    it('extracts upsert → insert', () => {
      const node = makeNode('call_expression', 24, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['24:4', 'prisma.user.upsert({ where: { id: 1 }, update: {}, create: {} })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('insert');
    });

    it('extracts update → update', () => {
      const node = makeNode('call_expression', 30, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['30:4', 'prisma.user.update({ where: { id: 1 }, data: { name: "new" } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'user', type: 'update' });
    });

    it('extracts updateMany → update', () => {
      const node = makeNode('call_expression', 32, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['32:4', 'prisma.user.updateMany({ where: {}, data: { active: false } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('update');
    });

    it('extracts delete → delete', () => {
      const node = makeNode('call_expression', 40, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['40:4', 'prisma.user.delete({ where: { id: 1 } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'user', type: 'delete' });
    });

    it('extracts deleteMany → delete', () => {
      const node = makeNode('call_expression', 42, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['42:4', 'prisma.user.deleteMany({ where: { active: false } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('delete');
    });

    it('extracts count → select', () => {
      const node = makeNode('call_expression', 50, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['50:4', 'prisma.user.count({ where: { active: true } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'user', type: 'select' });
    });

    it('extracts aggregate → select', () => {
      const node = makeNode('call_expression', 52, 4);
      const ast = makeAST('src/user.service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['52:4', 'prisma.user.aggregate({ _count: { id: true } })'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ table: 'user', type: 'select' });
    });

    it('skips .prisma schema files (no query calls)', () => {
      const node = makeNode('call_expression', 1, 0);
      const ast = makeAST('prisma/schema.prisma', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['1:0', 'model User { }'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(0);
    });

    it('skips unknown operations (not in PRISMA_OPERATIONS map)', () => {
      const node = makeNode('call_expression', 60, 4);
      const ast = makeAST('src/service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['60:4', 'prisma.$transaction([...])'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(0);
    });

    it('skips non-prisma calls', () => {
      const node = makeNode('call_expression', 70, 4);
      const ast = makeAST('src/service.ts', [node]);
      (ast as any).__nodes = [node];

      const texts = new Map([
        ['70:4', 'userService.findMany()'],
      ]);

      const refs = adapter.extractTableReferences(ast, makeAdapter(texts), '');
      expect(refs).toHaveLength(0);
    });
  });

  // ── extractSchemaDefinitions ────────────────────────────────────────────

  describe('extractSchemaDefinitions', () => {
    it('skips non-prisma files for schema extraction', () => {
      const node = makeNode('call_expression', 1, 0);
      const ast = makeAST('src/service.ts', [node]);
      (ast as any).__nodes = [node];

      const defs = adapter.extractSchemaDefinitions(ast, makeAdapter(new Map()), '');
      expect(defs).toHaveLength(0);
    });

    it('extracts model blocks from .prisma schema', () => {
      const source = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  authorId  Int
  author    User     @relation(fields: [authorId], references: [id])
}
`;

      const node = makeNode('generator', 0, 0);
      const ast = { ...makeAST('prisma/schema.prisma', [node]), filePath: 'prisma/schema.prisma' };
      (ast as any).__nodes = [node];

      const defs = adapter.extractSchemaDefinitions(ast, makeAdapter(new Map()), source);
      expect(defs).toHaveLength(2);
      expect(defs[0].tableName).toBe('User');
      expect(defs[1].tableName).toBe('Post');

      // User columns: id, email, name, createdAt
      expect(defs[0].columns.length).toBeGreaterThanOrEqual(4);
      const colNames = defs[0].columns.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('email');
      expect(colNames).toContain('name');
      expect(colNames).toContain('createdAt');
    });

    it('handles optional field types', () => {
      const source = `model Profile {
  id     Int     @id
  bio    String?
  avatar String?
}`;

      const defs = adapter.extractSchemaDefinitions(
        { ...makeAST('schema.prisma', [makeNode('model', 0, 0)]), filePath: 'schema.prisma' },
        makeAdapter(new Map()),
        source,
      );

      expect(defs).toHaveLength(1);
      const types = defs[0].columns.map(c => c.type);
      expect(types).toEqual(['Int', 'String?', 'String?']);
    });

    it('skips @@attribute lines and comments', () => {
      const source = `model Config {
  id   Int   @id
  // This is a comment line
  key  String
  @@unique([key])
  value String
}`;

      const defs = adapter.extractSchemaDefinitions(
        { ...makeAST('schema.prisma', [makeNode('model', 0, 0)]), filePath: 'schema.prisma' },
        makeAdapter(new Map()),
        source,
      );

      expect(defs).toHaveLength(1);
      // Should only have id, key, value — no @@unique or comment
      const names = defs[0].columns.map(c => c.name);
      expect(names).toEqual(['id', 'key', 'value']);
    });

    it('computes correct line numbers from source', () => {
      const source = [
        '// file header',
        '// another comment',
        '',
        'model Alpha {',
        '  id Int @id',
        '}',
        '',
        'model Beta {',
        '  id Int @id',
        '}',
      ].join('\n');

      const defs = adapter.extractSchemaDefinitions(
        { ...makeAST('schema.prisma', [makeNode('model', 0, 0)]), filePath: 'schema.prisma' },
        makeAdapter(new Map()),
        source,
      );

      expect(defs).toHaveLength(2);
      expect(defs[0].location.line).toBe(4); // "model Alpha" is on line 4 (1-indexed)
      expect(defs[1].location.line).toBe(8); // "model Beta" is on line 8
    });
  });
});

// ---------------------------------------------------------------------------
// OrmAdapterRegistry
// ---------------------------------------------------------------------------

describe('OrmAdapterRegistry', () => {
  let registry: OrmAdapterRegistry;

  beforeEach(() => {
    // Get fresh singleton to avoid cross-test state
    registry = OrmAdapterRegistry.getInstance();
    registry.clear();
  });

  it('registers and retrieves adapter by name', () => {
    const drizzle = new DrizzleAdapter();
    registry.registerAdapter(drizzle);
    expect(registry.getAdapter('drizzle')).toBe(drizzle);
  });

  it('registers and retrieves adapter by file extension', () => {
    const drizzle = new DrizzleAdapter();
    registry.registerAdapter(drizzle);
    expect(registry.getAdapterForFile('src/schema.ts')).toBe(drizzle);
    expect(registry.getAdapterForFile('src/schema.js')).toBe(drizzle);
  });

  it('returns null for unregistered extensions', () => {
    expect(registry.getAdapterForFile('script.py')).toBeNull();
  });

  it('uses content-based detection for .prisma files', () => {
    const prisma = new PrismaAdapter();
    registry.registerAdapter(prisma);
    expect(registry.getAdapterForFile('prisma/schema.prisma')).toBe(prisma);
  });

  it('returns all registered adapters', () => {
    const drizzle = new DrizzleAdapter();
    const prisma = new PrismaAdapter();
    registry.registerAdapter(drizzle);
    registry.registerAdapter(prisma);

    const all = registry.getAllAdapters();
    expect(all).toHaveLength(2);
    expect(all.map(a => a.name).sort()).toEqual(['drizzle', 'prisma']);
  });

  it('hasAdapterForFile returns boolean correctly', () => {
    expect(registry.hasAdapterForFile('src/data.ts')).toBe(false);

    registry.registerAdapter(new DrizzleAdapter());
    expect(registry.hasAdapterForFile('src/data.ts')).toBe(true);
  });

  it('clear() removes all adapters', () => {
    registry.registerAdapter(new DrizzleAdapter());
    registry.registerAdapter(new PrismaAdapter());
    registry.clear();

    expect(registry.getAllAdapters()).toHaveLength(0);
    expect(registry.getAdapter('drizzle')).toBeNull();
    expect(registry.getAdapterForFile('schema.ts')).toBeNull();
  });
});
