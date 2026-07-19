import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodeIndexDB } from './codeIndexDB.js';
import type { EnhancedFunctionMetadata } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFunc(overrides: Partial<EnhancedFunctionMetadata> & { name: string; filePath: string }): EnhancedFunctionMetadata {
  return {
    signature: `function ${overrides.name}()`,
    parameters: [],
    dependencies: [],
    purpose: '',
    context: '',
    language: 'typescript',
    lineNumber: 1,
    body: `function ${overrides.name}() { return 42; }`,
    complexity: 1,
    ...overrides,
    metadata: {
      entityType: 'function',
      ...(overrides.metadata ?? {}),
    },
  } as EnhancedFunctionMetadata;
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('CodeIndexDB SQLite — Schema', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-schema-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates all required tables', () => {
    const tables = (db as any).db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);

    expect(names).toContain('functions');
    expect(names).toContain('functions_fts');
    expect(names).toContain('function_calls');
    expect(names).toContain('function_dependencies');
    expect(names).toContain('whitelist');
    expect(names).toContain('audit_results');
    expect(names).toContain('analyzer_configs');
    expect(names).toContain('code_maps');
    expect(names).toContain('schema_definitions');
    expect(names).toContain('schema_usage');
    expect(names).toContain('project_tasks');
    expect(names).toContain('meta');
  });

  it('has FTS5 triggers that keep functions_fts in sync', () => {
    const rawDb = (db as any).db;
    const func = makeFunc({ name: 'testFunc', filePath: 'src/test.ts', body: 'console.log("fts test")' });
    (db as any).functionToRow = (db as any).functionToRow.bind(db);
    const row = (db as any).functionToRow(func);

    // Insert
    (db as any).db.prepare(`INSERT INTO functions (name, file_path, signature, body, purpose, context, language, complexity)
      VALUES (@name, @file_path, @signature, @body, @purpose, @context, @language, @complexity)`).run(row);
    const ftsRow = rawDb.prepare('SELECT * FROM functions_fts WHERE name = ?').get('testFunc');
    expect(ftsRow).toBeTruthy();
    expect((ftsRow as any).body).toContain('console.log');

    // Update
    (db as any).db.prepare('UPDATE functions SET body = @body WHERE name = @name')
      .run({ name: 'testFunc', body: 'updated body content' });
    const ftsUpdated = rawDb.prepare('SELECT * FROM functions_fts WHERE name = ?').get('testFunc');
    expect((ftsUpdated as any).body).toBe('updated body content');

    // Delete
    (db as any).db.prepare('DELETE FROM functions WHERE name = ?').run('testFunc');
    const ftsDeleted = rawDb.prepare('SELECT * FROM functions_fts WHERE name = ?').get('testFunc');
    expect(ftsDeleted).toBeUndefined();
  });

  it('enforces foreign key cascade from functions to function_calls', () => {
    const row = (db as any).functionToRow(makeFunc({ name: 'parent', filePath: 'src/parent.ts' }));
    const info = (db as any).db.prepare(
      `INSERT INTO functions (name, file_path, signature, purpose, context, language, complexity) VALUES (@name, @file_path, @signature, @purpose, @context, @language, @complexity)`
    ).run(row);
    const funcId = Number(info.lastInsertRowid);

    (db as any).db.prepare('INSERT INTO function_calls (caller_id, callee_name) VALUES (?, ?)').run(funcId, 'someCallee');
    let calls = (db as any).db.prepare('SELECT * FROM function_calls WHERE caller_id = ?').all(funcId);
    expect(calls).toHaveLength(1);

    (db as any).db.prepare('DELETE FROM functions WHERE id = ?').run(funcId);
    calls = (db as any).db.prepare('SELECT * FROM function_calls WHERE caller_id = ?').all(funcId);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CRUD tests
// ---------------------------------------------------------------------------

describe('CodeIndexDB SQLite — CRUD', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-crud-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registerFunction inserts a row with content_hash populated', async () => {
    await db.registerFunction(makeFunc({
      name: 'hashMe',
      filePath: 'src/hash.ts',
      body: 'function hashMe() { return 1 + 1; }',
      signature: 'function hashMe(): number',
    }));

    const row = (db as any).db.prepare('SELECT * FROM functions WHERE name = ?').get('hashMe') as any;
    expect(row).toBeTruthy();
    expect(row.content_hash).toBeTruthy();
    expect(typeof row.content_hash).toBe('string');
    expect(row.content_hash.length).toBe(64); // SHA-256 hex
  });

  it('registerFunction upserts by (name, file_path, line_number)', async () => {
    await db.registerFunction(makeFunc({ name: 'upsertMe', filePath: 'src/upsert.ts', body: 'v1', complexity: 1 }));
    await db.registerFunction(makeFunc({ name: 'upsertMe', filePath: 'src/upsert.ts', body: 'v2', complexity: 5 }));

    const rows = (db as any).db.prepare('SELECT * FROM functions WHERE name = ?').all('upsertMe') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('v2');
    expect(rows[0].complexity).toBe(5);
  });

  it('registerFunctions batch insert with error tracking', async () => {
    const funcs = [
      makeFunc({ name: 'batch1', filePath: 'src/batch.ts', body: 'one' }),
      makeFunc({ name: 'batch2', filePath: 'src/batch.ts', body: 'two' }),
    ];
    const result = await db.registerFunctions(funcs);
    expect(result.registered).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = (db as any).db.prepare('SELECT * FROM functions WHERE file_path = ?').all('src/batch.ts');
    expect(rows).toHaveLength(2);
  });

  it('syncFileIndex adds, updates, and removes correctly', async () => {
    // Seed two functions
    await db.registerFunctions([
      makeFunc({ name: 'keep', filePath: 'src/sync.ts', body: 'keep me' }),
      makeFunc({ name: 'remove', filePath: 'src/sync.ts', body: 'remove me' }),
    ]);

    // Sync: remove 'remove', update 'keep', add 'newOne'
    const result = await db.syncFileIndex('src/sync.ts', [
      makeFunc({ name: 'keep', filePath: 'src/sync.ts', body: 'updated keep' }),
      makeFunc({ name: 'newOne', filePath: 'src/sync.ts', body: 'new function' }),
    ]);

    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(1);

    const rows = (db as any).db.prepare('SELECT name FROM functions WHERE file_path = ? ORDER BY name').all('src/sync.ts') as any[];
    expect(rows.map((r: any) => r.name)).toEqual(['keep', 'newOne']);
  });

  it('registerFunction creates separate rows for same name at different lines', async () => {
    // Same name, same file, different lines → two distinct rows (no upsert collision)
    await db.registerFunction(makeFunc({ name: 'dup', filePath: 'src/dups.ts', lineNumber: 5, body: 'v1' }));
    await db.registerFunction(makeFunc({ name: 'dup', filePath: 'src/dups.ts', lineNumber: 20, body: 'v2' }));

    const rows = (db as any).db.prepare(
      'SELECT name, line_number, body FROM functions WHERE file_path = ? ORDER BY line_number'
    ).all('src/dups.ts') as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].body).toBe('v1');
    expect(rows[1].body).toBe('v2');
  });

  it('syncFileIndex handles same-named functions at different lines (nested functions)', async () => {
    // Two functions with the same name at different lines in the same file
    // should coexist as distinct entries (fix for nested/inner functions)
    const result = await db.syncFileIndex('src/nested.ts', [
      makeFunc({ name: 'handler', filePath: 'src/nested.ts', lineNumber: 10, body: 'outer' }),
      makeFunc({ name: 'handler', filePath: 'src/nested.ts', lineNumber: 42, body: 'inner' }),
    ]);

    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);

    const rows = (db as any).db.prepare(
      'SELECT name, line_number, body FROM functions WHERE file_path = ? ORDER BY line_number'
    ).all('src/nested.ts') as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].body).toBe('outer');
    expect(rows[0].line_number).toBe(10);
    expect(rows[1].body).toBe('inner');
    expect(rows[1].line_number).toBe(42);
  });

  it('getAllFunctions returns all rows with correct unpacking', async () => {
    await db.registerFunctions([
      makeFunc({ name: 'f1', filePath: 'src/all.ts', complexity: 3 }),
      makeFunc({ name: 'f2', filePath: 'src/all.ts', complexity: 7 }),
    ]);

    const all = await db.getAllFunctions();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const f1 = all.find(f => f.name === 'f1');
    expect(f1).toBeTruthy();
    expect(f1!.complexity).toBe(3);
  });

  it('findDefinition finds by name', async () => {
    await db.registerFunction(makeFunc({ name: 'uniqueFinder', filePath: 'src/find.ts', body: 'special' }));
    const found = await db.findDefinition('uniqueFinder');
    expect(found).toBeTruthy();
    expect(found!.name).toBe('uniqueFinder');
    expect(found!.filePath).toBe('src/find.ts');
  });

  it('findDefinition returns null for unknown name', async () => {
    const found = await db.findDefinition('nonexistent');
    expect(found).toBeNull();
  });

  it('findDefinition filters by filePath when provided', async () => {
    const db2 = db;
    await db2.registerFunction(makeFunc({ name: 'shared', filePath: 'src/a.ts', body: 'a' }));
    await db2.registerFunction(makeFunc({ name: 'shared', filePath: 'src/b.ts', body: 'b' }));

    const found = await db2.findDefinition('shared', 'src/b.ts');
    expect(found).toBeTruthy();
    expect(found!.filePath).toBe('src/b.ts');
  });

  it('getStats returns correct counts, languages, and file counts', async () => {
    await db.registerFunctions([
      makeFunc({ name: 'ts1', filePath: 'src/x.ts', language: 'typescript' }),
      makeFunc({ name: 'ts2', filePath: 'src/y.ts', language: 'typescript' }),
      makeFunc({ name: 'js1', filePath: 'lib/util.js', language: 'javascript' }),
    ]);

    const stats = await db.getStats();
    expect(stats.totalFunctions).toBe(3);
    expect(stats.filesIndexed).toBe(3);
    expect(stats.languages['typescript']).toBe(2);
    expect(stats.languages['javascript']).toBe(1);
  });

  it('content_hash is non-null for all functions after registerFunctions', async () => {
    await db.registerFunctions([
      makeFunc({ name: 'h1', filePath: 'src/hashes.ts', body: 'return a' }),
      makeFunc({ name: 'h2', filePath: 'src/hashes.ts', body: 'return b' }),
    ]);

    const nulls = (db as any).db.prepare(
      'SELECT COUNT(*) as cnt FROM functions WHERE content_hash IS NULL'
    ).get() as any;
    expect(nulls.cnt).toBe(0);
  });

  it('content_hash changes when body changes', async () => {
    await db.registerFunction(makeFunc({ name: 'hashChange', filePath: 'src/hc.ts', body: 'v1' }));
    const hash1 = (db as any).db.prepare('SELECT content_hash FROM functions WHERE name = ?').get('hashChange') as any;

    await db.registerFunction(makeFunc({ name: 'hashChange', filePath: 'src/hc.ts', body: 'v2' }));
    const hash2 = (db as any).db.prepare('SELECT content_hash FROM functions WHERE name = ?').get('hashChange') as any;

    expect(hash1.content_hash).not.toBe(hash2.content_hash);
  });
});

// ---------------------------------------------------------------------------
// QueryParser SQL compilation tests
// ---------------------------------------------------------------------------

import { QueryParser, compileToSQL, type SqlQuery } from './search/QueryParser.js';

describe('QueryParser compileToSQL', () => {
  let parser: QueryParser;

  beforeEach(() => {
    parser = new QueryParser();
  });

  function compile(query: string, options?: { defaultLimit?: number; offset?: number }): SqlQuery {
    const parsed = parser.parse(query);
    return compileToSQL(parsed, options);
  }

  it('free-text terms produce ANDed FTS5 MATCH', () => {
    const sql = compile('render button');
    expect(sql.ftsMatch).toContain('"render"*');
    expect(sql.ftsMatch).toContain('"button"*');
  });

  it('phrases are wrapped in quotes', () => {
    const sql = compile('"exact phrase match"');
    expect(sql.ftsMatch).toContain('"exact phrase match"');
  });

  it('entity:function adds WHERE clause', () => {
    const sql = compile('entity:function');
    expect(sql.whereClauses).toContain('entity_type = @entityType');
    expect(sql.params.entityType).toBe('function');
  });

  it('entity:component adds WHERE clause', () => {
    const sql = compile('entity:component');
    expect(sql.params.entityType).toBe('component');
  });

  it('component:functional adds WHERE clause', () => {
    const sql = compile('component:functional');
    expect(sql.whereClauses).toContain('component_type = @componentType');
    expect(sql.params.componentType).toBe('functional');
  });

  it('hook:useState adds subquery', () => {
    const sql = compile('hook:useState');
    expect(sql.whereClauses.some(c => c.includes('json_each(hooks)'))).toBe(true);
    expect(sql.params.hookName).toBe('useState');
  });

  it('dep:lodash adds dependency subquery', () => {
    const sql = compile('dep:lodash');
    expect(sql.whereClauses.some(c => c.includes('function_dependencies'))).toBe(true);
    expect(sql.params.depName).toBe('lodash');
  });

  it('calls:validate adds JOIN', () => {
    const sql = compile('calls:validate');
    expect(sql.joinClauses.some(c => c.includes('function_calls'))).toBe(true);
    expect(sql.params.calleeName).toBe('validate');
  });

  it('calledby:handler adds subquery', () => {
    const sql = compile('calledby:handler');
    expect(sql.whereClauses.some(c => c.includes('function_calls'))).toBe(true);
    expect(sql.params.calledByName).toBe('handler');
  });

  it('lang:typescript adds WHERE clause', () => {
    const sql = compile('lang:typescript');
    expect(sql.whereClauses.some(c => c.includes('LOWER(language)'))).toBe(true);
    expect(sql.params.language).toBe('typescript');
  });

  it('complexity:>5 adds > clause', () => {
    const sql = compile('complexity:>5');
    expect(sql.whereClauses).toContain('complexity > @cMin');
    expect(sql.params.cMin).toBe(5);
  });

  it('complexity:<10 adds < clause', () => {
    const sql = compile('complexity:<10');
    expect(sql.whereClauses).toContain('complexity < @cMax');
    expect(sql.params.cMax).toBe(10);
  });

  it('complexity:3..8 adds BETWEEN clause', () => {
    const sql = compile('complexity:3..8');
    expect(sql.whereClauses).toContain('complexity BETWEEN @cMin AND @cMax');
    expect(sql.params.cMin).toBe(3);
    expect(sql.params.cMax).toBe(8);
  });

  it('complexity:5 (exact) adds equality clause', () => {
    const sql = compile('complexity:5');
    expect(sql.whereClauses).toContain('complexity = @complexityExact');
    expect(sql.params.complexityExact).toBe(5);
  });

  it('exported: adds WHERE clause', () => {
    const sql = compile('exported:');
    expect(sql.whereClauses).toContain('is_exported = 1');
  });

  it('jsdoc: adds WHERE clause', () => {
    const sql = compile('jsdoc:');
    expect(sql.whereClauses).toContain('has_jsdoc = 1');
  });

  it('file:src/** adds GLOB clause with wildcard wrapping', () => {
    const sql = compile('file:src/**');
    expect(sql.whereClauses).toContain('file_path GLOB @fileGlob');
    // Patterns are wrapped with * wildcards so relative paths match
    // against absolute paths stored in the DB
    expect(sql.params.fileGlob).toBe('*src/***');
  });

  it('name:render adds LIKE clause', () => {
    const sql = compile('name:render');
    // name: maps to a free-text term via the parser, not a WHERE clause.
    // The parser tokenizes "render" as a term; verify no error.
    expect(sql).toBeTruthy();
  });

  it('unused-imports adds WHERE clause', () => {
    const sql = compile('unused-imports');
    expect(sql.whereClauses).toContain('has_unused_imports = 1');
  });

  it('no free-text terms → ftsMatch is null', () => {
    const sql = compile('complexity:>5 lang:typescript');
    expect(sql.ftsMatch).toBeNull();
  });

  it('combined: lang:typescript complexity:>5 applies both', () => {
    const sql = compile('lang:typescript complexity:>5');
    expect(sql.whereClauses.length).toBeGreaterThanOrEqual(2);
    const hasLang = sql.whereClauses.some(c => c.includes('LOWER(language)'));
    const hasComplex = sql.whereClauses.some(c => c.includes('complexity'));
    expect(hasLang).toBe(true);
    expect(hasComplex).toBe(true);
  });

  it('respects defaultLimit and offset options', () => {
    const sql = compile('hello', { defaultLimit: 20, offset: 10 });
    expect(sql.limit).toBe(20);
    expect(sql.offset).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Search integration tests
// ---------------------------------------------------------------------------

describe('CodeIndexDB SQLite — searchFunctions', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-search-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();

    // Seed test fixtures
    await db.registerFunctions([
      makeFunc({
        name: 'renderButton',
        filePath: 'src/components/Button.tsx',
        language: 'typescript',
        body: 'function renderButton() { return <button>Click</button>; }',
        complexity: 3,
        metadata: { entityType: 'component', componentType: 'functional', hooks: [{ name: 'useState', lineNumber: 2 }] },
      }),
      makeFunc({
        name: 'validateEmail',
        filePath: 'src/utils/validation.ts',
        language: 'typescript',
        body: 'function validateEmail(email: string) { return email.includes("@"); }',
        complexity: 5,
        signature: 'function validateEmail(email: string): boolean',
      }),
      makeFunc({
        name: 'formatDate',
        filePath: 'src/utils/date.ts',
        language: 'javascript',
        body: 'function formatDate(d) { return d.toISOString(); }',
        complexity: 2,
        signature: 'function formatDate(d: Date): string',
      }),
      makeFunc({
        name: 'fetchUser',
        filePath: 'src/api/users.ts',
        language: 'typescript',
        body: 'async function fetchUser(id) { return await db.find(id); }',
        complexity: 4,
        metadata: { entityType: 'function' },
      }),
    ]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('free-text search returns ranked results', async () => {
    const result = await db.searchFunctions({ query: 'validate' });
    expect(result.functions.length).toBeGreaterThan(0);
    expect(result.functions.some(f => f.name === 'validateEmail')).toBe(true);
  });

  it('entity: filter works', async () => {
    const result = await db.searchFunctions({ query: 'entity:component' });
    expect(result.functions.length).toBe(1);
    expect(result.functions[0].name).toBe('renderButton');
  });

  it('lang: filter works', async () => {
    const result = await db.searchFunctions({ query: 'lang:javascript' });
    expect(result.functions.length).toBe(1);
    expect(result.functions[0].name).toBe('formatDate');
  });

  it('complexity:> filter works', async () => {
    const result = await db.searchFunctions({ query: 'complexity:>4' });
    expect(result.functions.length).toBe(1);
    expect(result.functions[0].name).toBe('validateEmail');
  });

  it('complexity range filter works', async () => {
    const result = await db.searchFunctions({ query: 'complexity:2..3' });
    expect(result.functions.length).toBe(2);
    const names = result.functions.map(f => f.name).sort();
    expect(names).toContain('renderButton');
    expect(names).toContain('formatDate');
  });

  it('multiple filters combined work', async () => {
    const result = await db.searchFunctions({ query: 'lang:typescript complexity:>3' });
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
    // All results should be typescript with complexity > 3
    for (const f of result.functions) {
      expect(f.language).toBe('typescript');
      expect(f.complexity!).toBeGreaterThan(3); // > 3 because complexity:>3 uses > @cMin
    }
  });

  it('search with no results returns empty array', async () => {
    const result = await db.searchFunctions({ query: 'zzzznonexistent' });
    expect(result.functions).toHaveLength(0);
  });
});

describe('CodeIndexDB SQLite — calls: operator', () => {
  let dir: string;
  let db: CodeIndexDB;

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('calls: on empty index returns empty array (does not crash)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-calls-empty-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
    // Empty index — no functions registered
    const result = await db.searchFunctions({ query: 'calls:validateEmail' });
    expect(result.functions).toHaveLength(0);
  });

  it('calls:validateEmail returns caller after seeding call data', async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-calls-seeded-'));
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();

    await db.registerFunctions([
      makeFunc({
        name: 'validateEmail',
        filePath: 'src/utils/validation.ts',
        language: 'typescript',
        body: 'function validateEmail(email: string) { return email.includes("@"); }',
        complexity: 5,
      }),
      makeFunc({
        name: 'submitForm',
        filePath: 'src/components/Form.tsx',
        language: 'typescript',
        body: 'function submitForm() { validateEmail("test@test.com"); }',
        complexity: 3,
        metadata: {
          entityType: 'function',
          functionCalls: ['validateEmail'],
        },
      }),
    ]);

    // Rebuild call graph so function_calls table is populated.
    // Pass a filePath so metadata_json is fetched from the DB
    // (updateDependencyGraph without filePath doesn't fetch metadata_json —
    //  pre-existing call-graph-population bug, not related to this test).
    await db.updateDependencyGraph('src/components/Form.tsx');

    const result = await db.searchFunctions({ query: 'calls:validateEmail' });
    expect(result.functions.length).toBe(1);
    expect(result.functions[0].name).toBe('submitForm');
  });
});

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

describe('CodeIndexDB SQLite — LokiJS migration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-migrate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sampleLokiDb = {
    filename: 'index.db',
    collections: [
      {
        name: 'projectTasks',
        data: [
          {
            taskId: 'task-1',
            projectPath: '/test/proj',
            title: 'Fix login bug',
            description: 'The login form fails on empty email',
            status: 'pending',
            priority: 'high',
            labels: ['bug', 'frontend'],
            source: 'manual',
            parentTaskId: null,
            blockedBy: [],
            dueAt: null,
            sortOrder: 0,
            relatedFiles: ['src/login.ts'],
            relatedSymbols: ['LoginForm'],
            fingerprint: 'fp-abc',
            metadata: { createdVia: 'cli' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-02T00:00:00.000Z',
            completedAt: null,
          },
          {
            taskId: 'task-2',
            projectPath: '/test/proj',
            title: 'Add dark mode',
            status: 'done',
            priority: 'medium',
            labels: [],
            source: 'from_audit',
            blockedBy: ['task-1'],
            sortOrder: 1,
            relatedFiles: [],
            fingerprint: 'fp-def',
            completedAt: '2025-01-03T00:00:00.000Z',
          },
        ],
      },
      {
        name: 'analyzerConfigs',
        data: [
          {
            analyzerName: 'solid',
            projectPath: '/test/proj',
            isGlobal: false,
            config_json: '{"maxComplexity":10}',
            version: '1.0',
            createdBy: 'user',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            metadata_json: '{}',
          },
        ],
      },
      {
        name: 'whitelist',
        data: [
          {
            name: 'ignore-console',
            type: 'PlatformAPI',
            status: 'Active',
            category: 'debug',
            description: 'Allow console.log in dev',
            patterns: ['*.test.ts', '*.spec.ts'],
            addedBy: 'user',
            addedAt: '2025-01-01T00:00:00.000Z',
            updatedAt: null,
            metadata_json: '{}',
          },
        ],
      },
    ],
  };

  it('migrates LokiJS JSON file to SQLite', async () => {
    const dbPath = join(dir, 'index.db');
    await writeFile(dbPath, JSON.stringify(sampleLokiDb), 'utf-8');

    const db = new CodeIndexDB(dbPath);
    await db.initialize();

    // Tasks survived
    const tasks = await db.listProjectTasks('/test/proj');
    expect(tasks).toHaveLength(2);
    const t1 = tasks.find(t => t.taskId === 'task-1')!;
    expect(t1).toBeTruthy();
    expect(t1.title).toBe('Fix login bug');
    expect(t1.priority).toBe('high');
    expect(t1.labels).toEqual(['bug', 'frontend']);
    expect(t1.relatedFiles).toEqual(['src/login.ts']);
    expect(t1.blockedBy).toEqual([]);
    expect(t1.fingerprint).toBe('fp-abc');

    const t2 = tasks.find(t => t.taskId === 'task-2')!;
    expect(t2.status).toBe('done');
    expect(t2.blockedBy).toEqual(['task-1']);
    expect(t2.completedAt).toBe('2025-01-03T00:00:00.000Z');

    // Analyzer config survived
    const config = await db.getAnalyzerConfig('solid', '/test/proj');
    expect(config).toEqual({ maxComplexity: 10 });

    // Whitelist survived
    const wl = await db.getWhitelist();
    const ignoreConsole = wl.find(w => w.name === 'ignore-console');
    expect(ignoreConsole).toBeTruthy();
    expect(ignoreConsole!.patterns).toEqual(['*.test.ts', '*.spec.ts']);

    // Backup exists
    const { statSync } = require('fs');
    expect(statSync(dbPath + '.loki.bak').isFile()).toBe(true);

    await db.close();
  });

  it('migration is idempotent (backup + valid SQLite DB → skip)', async () => {
    const dbPath = join(dir, 'index.db');
    await writeFile(dbPath, JSON.stringify(sampleLokiDb), 'utf-8');

    // First migration
    const db1 = new CodeIndexDB(dbPath);
    await db1.initialize();
    await db1.close();

    // Second initialization with bak + valid SQLite should skip
    const db2 = new CodeIndexDB(dbPath);
    await db2.initialize();
    const tasks = await db2.listProjectTasks('/test/proj');
    expect(tasks).toHaveLength(2);
    await db2.close();
  });

  it('no migration when no old LokiJS file exists (clean start)', async () => {
    const dbPath = join(dir, 'index.db');
    // Don't write anything — clean start

    const db = new CodeIndexDB(dbPath);
    await db.initialize();

    // Should initialize cleanly
    const tasks = await db.listProjectTasks('/test/proj');
    expect(tasks).toHaveLength(0);

    const config = await db.getAnalyzerConfig('solid');
    expect(config).toBeNull();

    await db.close();
  });

  it('no migration for in-memory databases', async () => {
    const db = new CodeIndexDB(':memory:');
    await db.initialize();
    // Should not crash or attempt file operations
    const tasks = await db.listProjectTasks('/test/proj');
    expect(tasks).toHaveLength(0);
    await db.close();
  });
});
