/**
 * Cross-Domain Analyzer Unit Tests — Spec 15 R1
 *
 * Tests the three schema-lifecycle detectors:
 *   - written-never-read
 *   - read-never-written
 *   - transaction-boundary-risk
 *
 * Each test populates the in-memory CodeIndexDB singleton with
 * controlled schema_usage / functions / graph_cache rows, then runs
 * the CrossDomainAnalyzer and asserts the findings.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeIndexDB } from '../../../codeIndexDB.js';
import { CrossDomainAnalyzer } from '../CrossDomainAnalyzer.js';
import { getFilesProcessed } from '../../../pipeline.js';
import { initializeLanguages } from '../../../languages/index.js';
import { initParsers } from '../../../languages/tree-sitter/parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset DB singleton and get a fresh in-memory instance. */
async function freshDb(): Promise<CodeIndexDB> {
  CodeIndexDB.resetInstance();
  const db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
  return db;
}

interface SeedUsage {
  table_name: string;
  file_path: string;
  function_name: string;
  usage_type: string;
  line: number;
}

/** Directly insert schema_usage rows via raw SQL. */
function seedSchemaUsage(db: CodeIndexDB, rows: SeedUsage[]): void {
  for (const r of rows) {
    db.run(
      `INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
       VALUES (?, ?, ?, ?, ?)`,
      [r.table_name, r.file_path, r.function_name, r.usage_type, r.line],
    );
  }
}

/** Directly insert function rows via raw SQL. Return the assigned ID. */
function seedFunction(db: CodeIndexDB, name: string, filePath: string, line: number): number {
  const info = db.run(
    `INSERT INTO functions (name, file_path, line_number, entity_type, language)
     VALUES (?, ?, ?, 'function', 'typescript')`, [name, filePath, line]);
  return Number(info.lastInsertRowid);
}

interface SeedFuncOpts {
  isExported?: boolean;
  usedImports?: string[];
}

/** Seed a function with optional extra fields (is_exported, used_imports). */
function seedFunctionEx(
  db: CodeIndexDB,
  name: string,
  filePath: string,
  line: number,
  opts: SeedFuncOpts = {},
): number {
  const { isExported = false, usedImports } = opts;
  const info = db.run(`INSERT INTO functions (name, file_path, line_number, entity_type, language,
       is_exported, used_imports)
     VALUES (?, ?, ?, 'function', 'typescript', ?, ?)`, [name,
    filePath,
    line,
    isExported ? 1 : 0,
    usedImports ? JSON.stringify(usedImports) : null
  ]);
  return Number(info.lastInsertRowid);
}

/** Directly insert a graph_cache call edge via raw SQL. */
function seedCallEdge(db: CodeIndexDB, callerFuncId: number, calleeFuncId: number): void {
  db.run(`INSERT INTO graph_cache (graph_type, node_key, neighbor_key, weight)
     VALUES (?, ?, ?, ?)`, ['call', String(callerFuncId), String(calleeFuncId), 1.0]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossDomainAnalyzer — R1 Schema Lifecycle', () => {
  let db: CodeIndexDB;
  let analyzer: CrossDomainAnalyzer;

  beforeAll(async () => {
    // batch()-recognition tests re-parse real files on disk to find the
    // enclosing function's commit scope.
    initializeLanguages();
    await initParsers();
  });

  beforeEach(async () => {
    db = await freshDb();
    analyzer = new CrossDomainAnalyzer();
  });

  afterEach(() => {
    CodeIndexDB.resetInstance();
  });

  // ── Written-Never-Read ──────────────────────────────────────────────────

  describe('detectWrittenNeverRead', () => {
    it('flags a table that is inserted but never selected', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        {
          table_name: 'logs',
          file_path: `${projectRoot}/src/app.ts`,
          function_name: 'writeLog',
          usage_type: 'insert',
          line: 10,
        },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/app.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/written-never-read',
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toContain('logs');
      expect(violations[0].message).toContain('written');
      expect(violations[0].message).toContain('never read');
      expect(violations[0].severity).toBe('high');
    });

    it('does NOT flag a table that is both inserted and selected', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        {
          table_name: 'users',
          file_path: `${projectRoot}/src/app.ts`,
          function_name: 'createUser',
          usage_type: 'insert',
          line: 5,
        },
        {
          table_name: 'users',
          file_path: `${projectRoot}/src/queries.ts`,
          function_name: 'getUser',
          usage_type: 'select',
          line: 20,
        },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/app.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/written-never-read',
      );
      expect(violations).toHaveLength(0);
    });

    it('flags tables written via update/delete/create', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        {
          table_name: 'queue',
          file_path: `${projectRoot}/src/worker.ts`,
          function_name: 'enqueue',
          usage_type: 'update',
          line: 8,
        },
        {
          table_name: 'archive',
          file_path: `${projectRoot}/src/worker.ts`,
          function_name: 'purge',
          usage_type: 'delete',
          line: 12,
        },
        {
          table_name: 'metrics',
          file_path: `${projectRoot}/src/init.ts`,
          function_name: 'ensureMetrics',
          usage_type: 'create',
          line: 3,
        },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/worker.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/written-never-read',
      );
      // All three tables are written but never read
      expect(violations).toHaveLength(3);
      const tables = violations.map(v => v.message.match(/Table '([^']+)'/)?.[1]).sort();
      expect(tables).toEqual(['archive', 'metrics', 'queue']);
    });

    it('deduplicates multiple writes to the same table', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        {
          table_name: 'cache',
          file_path: `${projectRoot}/src/cache.ts`,
          function_name: 'warmCache',
          usage_type: 'insert',
          line: 10,
        },
        {
          table_name: 'cache',
          file_path: `${projectRoot}/src/cache.ts`,
          function_name: 'refreshCache',
          usage_type: 'update',
          line: 30,
        },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/cache.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/written-never-read',
      );
      expect(violations).toHaveLength(1);
    });

    it('is scoped to project root (no cross-project contamination)', async () => {
      seedSchemaUsage(db, [
        // Table in project A
        {
          table_name: 'orphaned_writes',
          file_path: '/project-a/src/app.ts',
          function_name: 'write',
          usage_type: 'insert',
          line: 1,
        },
        // Table in project B — same table name but different project
        {
          table_name: 'shared_table',
          file_path: '/project-b/src/app.ts',
          function_name: 'doInsert',
          usage_type: 'insert',
          line: 1,
        },
        {
          table_name: 'shared_table',
          file_path: '/project-b/src/queries.ts',
          function_name: 'doSelect',
          usage_type: 'select',
          line: 10,
        },
      ]);

      // Run for project A only
      const result = await analyzer.analyze(
        ['/project-a/src/app.ts'],
        { indexHandle: db, projectRoot: '/project-a' },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/written-never-read',
      );
      // Only orphaned_writes from project-a should be flagged
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toContain('orphaned_writes');
    });
  });

  // ── Read-Never-Written ──────────────────────────────────────────────────

  describe('detectReadNeverWritten', () => {
    it('flags a table that is selected but never written', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        {
          table_name: 'external_analytics',
          file_path: `${projectRoot}/src/reports.ts`,
          function_name: 'pullReport',
          usage_type: 'select',
          line: 15,
        },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/reports.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/read-never-written',
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toContain('external_analytics');
      expect(violations[0].message).toContain('read');
      expect(violations[0].message).toContain('never written');
      expect(violations[0].severity).toBe('severe');
    });

    it('does NOT flag a table that is both selected and inserted', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        {
          table_name: 'products',
          file_path: `${projectRoot}/src/catalog.ts`,
          function_name: 'listProducts',
          usage_type: 'select',
          line: 40,
        },
        {
          table_name: 'products',
          file_path: `${projectRoot}/src/catalog.ts`,
          function_name: 'addProduct',
          usage_type: 'insert',
          line: 60,
        },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/catalog.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/read-never-written',
      );
      expect(violations).toHaveLength(0);
    });

    it('deduplicates multiple reads of the same table', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        {
          table_name: 'view_counts',
          file_path: `${projectRoot}/src/dash.ts`,
          function_name: 'loadDashboard',
          usage_type: 'select',
          line: 5,
        },
        {
          table_name: 'view_counts',
          file_path: `${projectRoot}/src/api.ts`,
          function_name: 'getViews',
          usage_type: 'select',
          line: 25,
        },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/dash.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/read-never-written',
      );
      expect(violations).toHaveLength(1);
    });
  });

  // ── Transaction-Boundary Risk ───────────────────────────────────────────

  describe('detectTransactionBoundaryRisk', () => {
    it('flags a function writing to ≥ threshold distinct tables', async () => {
      const projectRoot = '/test/project';
      const funcId = seedFunction(db, 'migrateAll', `${projectRoot}/src/migrate.ts`, 1);

      seedSchemaUsage(db, [
        { table_name: 'accounts', file_path: `${projectRoot}/src/migrate.ts`, function_name: 'migrateAll', usage_type: 'insert', line: 2 },
        { table_name: 'profiles', file_path: `${projectRoot}/src/migrate.ts`, function_name: 'migrateAll', usage_type: 'insert', line: 3 },
        { table_name: 'orders', file_path: `${projectRoot}/src/migrate.ts`, function_name: 'migrateAll', usage_type: 'update', line: 4 },
        { table_name: 'shipments', file_path: `${projectRoot}/src/migrate.ts`, function_name: 'migrateAll', usage_type: 'insert', line: 5 },
      ]);

      // Default threshold is 4
      const result = await analyzer.analyze(
        [`${projectRoot}/src/migrate.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].functionName).toBe('migrateAll');
      expect(violations[0].message).toContain('4 distinct tables');
      expect(violations[0].severity).toBe('high');
    });

    it('does NOT flag function writing to fewer than threshold tables', async () => {
      const projectRoot = '/test/project';
      seedFunction(db, 'updateUser', `${projectRoot}/src/user.ts`, 1);

      seedSchemaUsage(db, [
        { table_name: 'users', file_path: `${projectRoot}/src/user.ts`, function_name: 'updateUser', usage_type: 'update', line: 10 },
        { table_name: 'audit_log', file_path: `${projectRoot}/src/user.ts`, function_name: 'updateUser', usage_type: 'insert', line: 11 },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/user.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(violations).toHaveLength(0);
    });

    it('respects custom txnTableMax threshold', async () => {
      const projectRoot = '/test/project';
      seedFunction(db, 'batchProcess', `${projectRoot}/src/batch.ts`, 1);

      seedSchemaUsage(db, [
        { table_name: 'a', file_path: `${projectRoot}/src/batch.ts`, function_name: 'batchProcess', usage_type: 'insert', line: 2 },
        { table_name: 'b', file_path: `${projectRoot}/src/batch.ts`, function_name: 'batchProcess', usage_type: 'insert', line: 3 },
        { table_name: 'c', file_path: `${projectRoot}/src/batch.ts`, function_name: 'batchProcess', usage_type: 'update', line: 4 },
      ]);

      // With txnTableMax=3, 3 tables should flag. With default 4, it wouldn't.
      const result = await analyzer.analyze(
        [`${projectRoot}/src/batch.ts`],
        { indexHandle: db, projectRoot, schemaLifecycle: { txnTableMax: 3 } },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toContain('threshold: 3');
    });

    it('includes tables from depth-1 callees via graph_cache', async () => {
      const projectRoot = '/test/project';

      const callerId = seedFunction(db, 'orchestrator', `${projectRoot}/src/main.ts`, 1);
      const callee1Id = seedFunction(db, 'writeOrders', `${projectRoot}/src/orders.ts`, 10);
      const callee2Id = seedFunction(db, 'writeLogs', `${projectRoot}/src/logs.ts`, 20);

      seedCallEdge(db, callerId, callee1Id);
      seedCallEdge(db, callerId, callee2Id);

      // Caller writes to one table directly
      seedSchemaUsage(db, [
        { table_name: 'sessions', file_path: `${projectRoot}/src/main.ts`, function_name: 'orchestrator', usage_type: 'insert', line: 2 },
        // Callee 1 writes to two tables
        { table_name: 'orders', file_path: `${projectRoot}/src/orders.ts`, function_name: 'writeOrders', usage_type: 'insert', line: 11 },
        { table_name: 'order_items', file_path: `${projectRoot}/src/orders.ts`, function_name: 'writeOrders', usage_type: 'insert', line: 12 },
        // Callee 2 writes to one table
        { table_name: 'logs', file_path: `${projectRoot}/src/logs.ts`, function_name: 'writeLogs', usage_type: 'insert', line: 21 },
      ]);

      // orchestrator directly writes 1 table, callees add 3 more = 4 total
      // txnTableMax=4 should flag
      const result = await analyzer.analyze(
        [`${projectRoot}/src/main.ts`],
        { indexHandle: db, projectRoot, schemaLifecycle: { txnTableMax: 4 } },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].functionName).toBe('orchestrator');
      // All 4 tables should appear in sorted order
      expect(violations[0].message).toContain('logs, order_items, orders, sessions');
    });

    it('does NOT double-count tables shared between caller and callee', async () => {
      const projectRoot = '/test/project';

      const callerId = seedFunction(db, 'coordinator', `${projectRoot}/src/coord.ts`, 1);
      const calleeId = seedFunction(db, 'writeCommon', `${projectRoot}/src/common.ts`, 10);

      seedCallEdge(db, callerId, calleeId);

      seedSchemaUsage(db, [
        // Caller writes to users and orders
        { table_name: 'users', file_path: `${projectRoot}/src/coord.ts`, function_name: 'coordinator', usage_type: 'insert', line: 2 },
        { table_name: 'orders', file_path: `${projectRoot}/src/coord.ts`, function_name: 'coordinator', usage_type: 'insert', line: 3 },
        // Callee also writes to users (should be deduped) plus logs
        { table_name: 'users', file_path: `${projectRoot}/src/common.ts`, function_name: 'writeCommon', usage_type: 'update', line: 11 },
        { table_name: 'logs', file_path: `${projectRoot}/src/common.ts`, function_name: 'writeCommon', usage_type: 'insert', line: 12 },
      ]);

      // Distinct tables: users, orders, logs = 3. Threshold 3 should flag.
      const result = await analyzer.analyze(
        [`${projectRoot}/src/coord.ts`],
        { indexHandle: db, projectRoot, schemaLifecycle: { txnTableMax: 3 } },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toContain('3 distinct tables');
    });

    it('gracefully handles functions with zero graph_cache entries', async () => {
      const projectRoot = '/test/project';
      seedFunction(db, 'simpleFn', `${projectRoot}/src/simple.ts`, 1);

      seedSchemaUsage(db, [
        { table_name: 'a', file_path: `${projectRoot}/src/simple.ts`, function_name: 'simpleFn', usage_type: 'insert', line: 2 },
        { table_name: 'b', file_path: `${projectRoot}/src/simple.ts`, function_name: 'simpleFn', usage_type: 'insert', line: 3 },
      ]);

      // 2 tables < 4 threshold, no callees → no violation
      const result = await analyzer.analyze(
        [`${projectRoot}/src/simple.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(violations).toHaveLength(0);
    });

    it('does NOT flag a function whose writes are committed via a single batch()', async () => {
      // Write a real file so enclosingFunctionBatches can re-parse it and see
      // the `.batch(` inside the enclosing function (D1 atomic commit).
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ca-mtw-batch-'));
      const filePath = path.join(dir, 'flush.ts');
      writeFileSync(
        filePath,
        [
          'export class Store {',
          '  async flush(env: any) {',
          '    const stmts: any[] = [];',
          "    stmts.push(env.DB.prepare('INSERT INTO a VALUES (?)').bind(1));",
          "    stmts.push(env.DB.prepare('INSERT INTO b VALUES (?)').bind(1));",
          "    stmts.push(env.DB.prepare('INSERT INTO c VALUES (?)').bind(1));",
          "    stmts.push(env.DB.prepare('INSERT INTO d VALUES (?)').bind(1));",
          '    await env.DB.batch(stmts);',
          '  }',
          '}',
        ].join('\n'),
      );

      seedSchemaUsage(db, [
        { table_name: 'a', file_path: filePath, function_name: 'flush', usage_type: 'insert', line: 4 },
        { table_name: 'b', file_path: filePath, function_name: 'flush', usage_type: 'insert', line: 5 },
        { table_name: 'c', file_path: filePath, function_name: 'flush', usage_type: 'insert', line: 6 },
        { table_name: 'd', file_path: filePath, function_name: 'flush', usage_type: 'insert', line: 7 },
      ]);

      const result = await analyzer.analyze([filePath], { indexHandle: db, projectRoot: dir });

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(violations).toHaveLength(0);

      rmSync(dir, { recursive: true, force: true });
    });

    it('still flags a function writing 4 tables without a batch() commit', async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ca-mtw-nobatch-'));
      const filePath = path.join(dir, 'flush.ts');
      writeFileSync(
        filePath,
        [
          'export class Store {',
          '  async flush(env: any) {',
          "    await env.DB.prepare('INSERT INTO a VALUES (?)').bind(1).run();",
          "    await env.DB.prepare('INSERT INTO b VALUES (?)').bind(1).run();",
          "    await env.DB.prepare('INSERT INTO c VALUES (?)').bind(1).run();",
          "    await env.DB.prepare('INSERT INTO d VALUES (?)').bind(1).run();",
          '  }',
          '}',
        ].join('\n'),
      );

      seedSchemaUsage(db, [
        { table_name: 'a', file_path: filePath, function_name: 'flush', usage_type: 'insert', line: 3 },
        { table_name: 'b', file_path: filePath, function_name: 'flush', usage_type: 'insert', line: 4 },
        { table_name: 'c', file_path: filePath, function_name: 'flush', usage_type: 'insert', line: 5 },
        { table_name: 'd', file_path: filePath, function_name: 'flush', usage_type: 'insert', line: 6 },
      ]);

      const result = await analyzer.analyze([filePath], { indexHandle: db, projectRoot: dir });

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].functionName).toBe('flush');

      rmSync(dir, { recursive: true, force: true });
    });
  });

  // ── Config control ──────────────────────────────────────────────────────

  describe('config toggles', () => {
    it('disables written-never-read when enableWrittenNeverRead is false', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        { table_name: 'dead_writes', file_path: `${projectRoot}/src/app.ts`, function_name: 'f', usage_type: 'insert', line: 1 },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/app.ts`],
        { indexHandle: db, projectRoot, schemaLifecycle: { enableWrittenNeverRead: false } },
      );

      expect(result.errors).toHaveLength(0);
      expect(result.violations).toHaveLength(0);
    });

    it('disables read-never-written when enableReadNeverWritten is false', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        { table_name: 'external_data', file_path: `${projectRoot}/src/app.ts`, function_name: 'f', usage_type: 'select', line: 1 },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/app.ts`],
        { indexHandle: db, projectRoot, schemaLifecycle: { enableReadNeverWritten: false } },
      );

      expect(result.errors).toHaveLength(0);
      expect(result.violations).toHaveLength(0);
    });

    it('disables transaction-boundary when enableTransactionBoundaryRisk is false', async () => {
      const projectRoot = '/test/project';
      seedFunction(db, 'bigTx', `${projectRoot}/src/tx.ts`, 1);
      seedSchemaUsage(db, [
        { table_name: 'a', file_path: `${projectRoot}/src/tx.ts`, function_name: 'bigTx', usage_type: 'insert', line: 2 },
        { table_name: 'b', file_path: `${projectRoot}/src/tx.ts`, function_name: 'bigTx', usage_type: 'insert', line: 3 },
        { table_name: 'c', file_path: `${projectRoot}/src/tx.ts`, function_name: 'bigTx', usage_type: 'insert', line: 4 },
        { table_name: 'd', file_path: `${projectRoot}/src/tx.ts`, function_name: 'bigTx', usage_type: 'insert', line: 5 },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/tx.ts`],
        { indexHandle: db, projectRoot, schemaLifecycle: { enableTransactionBoundaryRisk: false } },
      );

      expect(result.errors).toHaveLength(0);
      // Only written-never-read and read-never-written should be enabled
      // (but txn-boundary should be disabled)
      const txnViolations = result.violations.filter(
        v => v.rule === 'cross-domain/multi-table-write',
      );
      expect(txnViolations).toHaveLength(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty results when DB is empty', async () => {
      const result = await analyzer.analyze(
        ['/some/file.ts'],
        { indexHandle: db, projectRoot: '/some' },
      );

      expect(result.violations).toHaveLength(0);
      // No schema_usage rows → reports input file count (ran correctly, found nothing)
      expect(getFilesProcessed(result.status)).toBe(1);
    });

    it('returns empty results when schema_usage is empty but DB is active', async () => {
      const projectRoot = '/test/project';
      // DB is initialized (from beforeEach) but no schema_usage rows exist
      const result = await analyzer.analyze(
        [`${projectRoot}/src/app.ts`],
        { indexHandle: db, projectRoot },
      );

      expect(result.violations).toHaveLength(0);
      // No schema_usage rows exist — reports input file count (ran correctly, found nothing)
      expect(getFilesProcessed(result.status)).toBe(1);
    });

    it('includes function name and file path in violation metadata', async () => {
      const projectRoot = '/test/project';
      seedSchemaUsage(db, [
        { table_name: 'stale', file_path: `${projectRoot}/src/writer.ts`, function_name: 'writeStale', usage_type: 'insert', line: 42 },
      ]);

      const result = await analyzer.analyze(
        [`${projectRoot}/src/writer.ts`],
        { indexHandle: db, projectRoot },
      );

      const violations = result.violations.filter(
        v => v.rule === 'cross-domain/written-never-read',
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].file).toContain('writer.ts');
      expect(violations[0].functionName).toBe('writeStale');
      expect(violations[0].line).toBe(42);
    });
  });

  // ── R3: Validation-Bypass ─────────────────────────────────────────────────

  describe('R3: no-validator-reachable (was validation-bypass)', () => {
    const projectRoot = '/test/project';
    const writerDir = `${projectRoot}/src/handlers`;

    /** Convenience: returns result for an analyze call with validatorBypass config.
     *  Disables R1 detectors so only R3 violations are produced. */
    async function runAnalyze(
      db: CodeIndexDB,
      config: Record<string, any>,
    ): Promise<AnalyzerResult> {
      return analyzer.analyze(
        [`${projectRoot}/src/handlers/create.ts`],
        {
          indexHandle: db,
          projectRoot,
          schemaLifecycle: {
            enableWrittenNeverRead: false,
            enableReadNeverWritten: false,
            enableTransactionBoundaryRisk: false,
          },
          ...config,
        },
      );
    }

    beforeEach(async () => {
      // Use a fresh DB for each test to avoid singleton contamination
      CodeIndexDB.resetInstance();
      db = CodeIndexDB.getInstance(':memory:');
      await db.initialize();
    });

    afterEach(() => {
      CodeIndexDB.resetInstance();
    });

    // ── Validator identification ──────────────────────────────────────────

    describe('validator identification', () => {
      it('detects validators via user-configured names', async () => {
        // Writer writes to a table
        const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // Validator configured by user
        seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5);

        // Add validator to the BFS graph so the BFS can reach it
        seedCallEdge(db, wId, 2); // writer → validator (validateOrder is ID 2)

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: ['validateOrder'],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        // Writer reaches validator via graph_cache — should NOT be flagged
        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('detects validators via provenanced imports (VALIDATOR_PACKAGES)', async () => {
        // Writer
        const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // Validator: exported function from file that imports zod
        const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        seedCallEdge(db, wId, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('falls back to heuristic name matching (validate*) when provenance is silent', async () => {
        // Writer
        const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // Validator: exported function named validate* (no validator package imports)
        const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: [],
        });

        seedCallEdge(db, wId, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('falls back to heuristic name matching (assert*)', async () => {
        const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        const vId = seedFunctionEx(db, 'assertValid', `${writerDir}/assertValid.ts`, 3, {
          isExported: true,
        });

        seedCallEdge(db, wId, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('heuristic runs when user validators list is empty (not suppressed)', async () => {
        // Writer
        const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // Second writer that reaches the heuristic validator → establishes modeShare
        const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 15);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 15)`, [`${writerDir}/saveOrder.ts`]);

        // Exported function matching heuristic pattern — WILL be picked up
        // because user provided validators: [] (length 0), so heuristic runs
        const vId = seedFunctionEx(db, 'validateInput', `${writerDir}/validateInput.ts`, 5, {
          isExported: true,
        });

        seedCallEdge(db, w2Id, vId); // saveOrder → validateInput

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],  // length 0, triggers heuristic fallback
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3,
          },
        });

        // saveOrder reaches heuristic validator, createOrder does not
        // 1/2 = 0.5 ≥ 0.5 modeShare → flag createOrder
        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
        expect(bypass[0].functionName).toBe('createOrder');
      });

      it('does NOT use heuristic when provenance finds validators', async () => {
        // Writer 1: reaches heuristic validator but NOT provenance validator
        const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // Provenance validator (zod import → priority 1b)
        const zvId = seedFunctionEx(db, 'zodValidator', `${writerDir}/zodValidator.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        // Heuristic-only validator — should be ignored because provenance found validators
        const hvId = seedFunctionEx(db, 'validateHeuristic', `${writerDir}/validateHeuristic.ts`, 5, {
          isExported: true,
          usedImports: [],
        });

        // Writer 1 reaches heuristic validator but NOT provenance validator
        seedCallEdge(db, wId, hvId);

        // Writer 2: reaches provenance validator → establishes modeShare
        const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 15);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 15)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w2Id, zvId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3,
          },
        });

        // Provenance validator is in the validator set, heuristic is excluded.
        // Writer 1 reaches heuristic-only → NOT covered.
        // Writer 2 reaches provenance validator → covered.
        // 1/2 = 0.5 ≥ 0.5 modeShare → flag Writer 1
        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
        expect(bypass[0].functionName).toBe('createOrder');
      });

      it('detects user-configured validators by path#functionName', async () => {
        const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // Validator with specific path#name
        const vId = seedFunctionEx(db, 'validate', `${writerDir}/lib/validators.ts`, 7, {
          isExported: true,
        });

        seedCallEdge(db, wId, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [`${writerDir}/lib/validators.ts#validate`],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });
    });

    // ── BFS reach ─────────────────────────────────────────────────────────

    describe('BFS reach', () => {
      beforeEach(() => {
        // Seed a writer that we'll connect/disconnect from validators
        seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // Validator (provenanced)
        seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });
      });

      it('flags writer that has no path to any validator', async () => {
        // Writer 1: no path to validator — already seeded by beforeEach

        // Writer 2: reaches validator (establishes modeShare)
        const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 15);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 15)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w2Id, 2); // saveOrder → validateOrder (ID 2)

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
        expect(bypass[0].functionName).toBe('createOrder');
        expect(bypass[0].severity).toBe('severe');
      });

      it('does NOT flag writer that reaches validator directly (depth 0)', async () => {
        // Writer IS the validator
        const wId = 1; // createOrder inserted first
        const vId = 2; // validateOrder inserted second

        // Make the writer function exported with zod import → it IS a validator
        db.run(`UPDATE functions SET is_exported = 1, used_imports = ? WHERE id = ?`, [JSON.stringify(['zod']), wId]);

        seedCallEdge(db, wId, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        // Writer reaches validator (at depth 0 because writer IS a validator)
        expect(bypass).toHaveLength(0);
      });

      it('does NOT flag writer that reaches validator via depth-1 callee', async () => {
        const wId = 1; // createOrder
        const vId = 2; // validateOrder
        seedCallEdge(db, wId, vId); // createOrder → validateOrder

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('does NOT flag writer that reaches validator via depth-2 callee', async () => {
        const wId = 1; // createOrder

        // Intermediate function
        const midId = seedFunctionEx(db, 'saveEntity', `${writerDir}/saveEntity.ts`, 20);
        seedCallEdge(db, wId, midId); // createOrder → saveEntity

        const vId = 2; // validateOrder
        seedCallEdge(db, midId, vId); // saveEntity → validateOrder

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('does NOT flag writer that reaches validator via depth-3 callee', async () => {
        const wId = 1; // createOrder

        const mid1Id = seedFunctionEx(db, 'saveEntity', `${writerDir}/saveEntity.ts`, 20);
        const mid2Id = seedFunctionEx(db, 'persistData', `${writerDir}/persistData.ts`, 30);

        seedCallEdge(db, wId, mid1Id);   // createOrder → saveEntity
        seedCallEdge(db, mid1Id, mid2Id); // saveEntity → persistData

        const vId = 2; // validateOrder
        seedCallEdge(db, mid2Id, vId);   // persistData → validateOrder

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('flags writer when validator is beyond max depth', async () => {
        const wId = 1; // createOrder

        const mid1Id = seedFunctionEx(db, 'saveEntity', `${writerDir}/saveEntity.ts`, 20);
        const mid2Id = seedFunctionEx(db, 'persistData', `${writerDir}/persistData.ts`, 30);
        const mid3Id = seedFunctionEx(db, 'commitTransaction', `${writerDir}/commitTransaction.ts`, 40);

        seedCallEdge(db, wId, mid1Id);
        seedCallEdge(db, mid1Id, mid2Id);
        seedCallEdge(db, mid2Id, mid3Id);

        const vId = 2; // validateOrder
        seedCallEdge(db, mid3Id, vId); // depth 4 → beyond limit

        // Second writer that reaches validator at depth 1 → establishes modeShare
        const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 15);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 15)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w2Id, vId); // saveOrder → validator at depth 1

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3, // max depth 3, validator at depth 4 for createOrder
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        // saveOrder reaches validator, createOrder does not (beyond depth 3)
        expect(bypass).toHaveLength(1);
        expect(bypass[0].functionName).toBe('createOrder');
      });

      it('handles cycles in call graph without infinite loop', async () => {
        const wId = 1;
        const vId = 2;

        // Cycle: createOrder ↔ saveEntity
        const midId = seedFunctionEx(db, 'saveEntity', `${writerDir}/saveEntity.ts`, 20);
        seedCallEdge(db, wId, midId);
        seedCallEdge(db, midId, wId); // back-edge creates cycle
        seedCallEdge(db, midId, vId); // saveEntity → validateOrder

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        // Despite cycle, writer reaches validator at depth 2 (createOrder → saveEntity → validateOrder)
        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });
    });

    // ── Directory grouping & thresholds ────────────────────────────────────

    describe('directory grouping & thresholds', () => {
      it('does NOT flag when directory has fewer writers than minCorpus', async () => {
        // Only 2 writers, minCorpus = 3 → skip detection
        for (let i = 1; i <= 2; i++) {
          const fnName = `save${i}`;
          const fnId = seedFunctionEx(db, fnName, `${writerDir}/save${i}.ts`, i * 10);
          db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
             VALUES (?, ?, ?, 'insert', ?)`, [`t${i}`, `${writerDir}/save${i}.ts`, fnName, i * 10]);
        }

        // Validator exists but minCorpus not met
        seedFunctionEx(db, 'validate', `${writerDir}/validate.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 3,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('flags uncovered writer when modeShare threshold is met', async () => {
        // 3 writers: 2 reach validator, 1 doesn't → ratio 0.67 ≥ 0.5 modeShare
        // Writer 1: reaches validator
        const w1Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 10)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w1Id, 4); // saveOrder → validator

        // Writer 2: reaches validator
        const w2Id = seedFunctionEx(db, 'updateOrder', `${writerDir}/updateOrder.ts`, 20);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'updateOrder', 'update', 20)`, [`${writerDir}/updateOrder.ts`]);
        seedCallEdge(db, w2Id, 4); // updateOrder → validator

        // Writer 3: does NOT reach validator (no call edge)
        seedFunctionEx(db, 'deleteOrder', `${writerDir}/deleteOrder.ts`, 30);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'deleteOrder', 'delete', 30)`, [`${writerDir}/deleteOrder.ts`]);

        // Validator
        seedFunctionEx(db, 'validateInput', `${writerDir}/validateInput.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 3,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
        expect(bypass[0].functionName).toBe('deleteOrder');
      });

      it('does NOT flag anyone when modeShare threshold is NOT met', async () => {
        // 3 writers: 1 reaches validator, 2 don't → ratio 0.33 < 0.5 modeShare
        // Writer 1: reaches validator
        const w1Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 10)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w1Id, 4);

        // Writer 2: no reach
        seedFunctionEx(db, 'updateOrder', `${writerDir}/updateOrder.ts`, 20);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'updateOrder', 'update', 20)`, [`${writerDir}/updateOrder.ts`]);

        // Writer 3: no reach
        seedFunctionEx(db, 'deleteOrder', `${writerDir}/deleteOrder.ts`, 30);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'deleteOrder', 'delete', 30)`, [`${writerDir}/deleteOrder.ts`]);

        // Validator
        seedFunctionEx(db, 'validateInput', `${writerDir}/validateInput.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 3,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('groups writers by directory independently', async () => {
        const otherDir = `${projectRoot}/src/other`;

        // Writers in writerDir: 2 writers, neither reaches validator
        seedFunctionEx(db, 'saveA', `${writerDir}/saveA.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('a', ?, 'saveA', 'insert', 10)`, [`${writerDir}/saveA.ts`]);

        seedFunctionEx(db, 'saveB', `${writerDir}/saveB.ts`, 20);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('b', ?, 'saveB', 'insert', 20)`, [`${writerDir}/saveB.ts`]);

        // Writer in otherDir: 1 writer, reaches validator
        const w3Id = seedFunctionEx(db, 'saveC', `${otherDir}/saveC.ts`, 30);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('c', ?, 'saveC', 'insert', 30)`, [`${otherDir}/saveC.ts`]);
        seedCallEdge(db, w3Id, 4); // saveC → validator

        // Validator
        seedFunctionEx(db, 'validateInput', `${writerDir}/validateInput.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');

        // writerDir: 2 writers, 0 covered → ratio 0.0 < 0.5 → NOT flagged
        // otherDir: 1 writer < minCorpus 2 → NOT flagged
        expect(bypass).toHaveLength(0);
      });
    });

    // ── Config behavior ───────────────────────────────────────────────────

    describe('config behavior', () => {
      it('skips detection when no validatorBypass config is provided', async () => {
        seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // No validatorBypass in config → detection skipped entirely
        const result = await runAnalyze(db, { indexHandle: db, projectRoot });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(0);
      });

      it('skips detection when no validators are found', async () => {
        // Writer without any validators in the DB
        seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        expect(result.violations).toHaveLength(0);
      });

      it('skips detection when no writers exist in schema_usage', async () => {
        // Validator exists but no writers
        seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 1,
            depth: 3,
          },
        });

        expect(result.violations).toHaveLength(0);
      });

      it('respects custom depth configuration', async () => {
        const wId = 1;
        // Writer
        seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);

        // Intermediate
        const midId = seedFunctionEx(db, 'saveEntity', `${writerDir}/saveEntity.ts`, 20);
        seedCallEdge(db, wId, midId);

        // Validator at depth 2 from createOrder
        const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });
        seedCallEdge(db, midId, vId);

        // Second writer that reaches validator directly at depth 1
        const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 15);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 15)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w2Id, vId);

        // depth=1: validator at depth 2 for createOrder → NOT reached
        // saveOrder reaches at depth 1 → covered
        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 1,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
        expect(bypass[0].functionName).toBe('createOrder');
      });

      it('deduplicates writers that appear in multiple schema_usage rows', async () => {
        // Same function writes to two tables — should only be checked once
        const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 10);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 10)`, [`${writerDir}/createOrder.ts`]);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('order_items', ?, 'createOrder', 'insert', 12)`, [`${writerDir}/createOrder.ts`]);

        // Validator (not reachable from createOrder)
        const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        // Second writer that reaches validator → establishes modeShare
        const w2Id = seedFunctionEx(db, 'saveItems', `${writerDir}/saveItems.ts`, 20);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('items', ?, 'saveItems', 'insert', 20)`, [`${writerDir}/saveItems.ts`]);
        seedCallEdge(db, w2Id, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3,
          },
        });

        // createOrder should only be flagged once
        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
      });
    });

    // ── Violation structure ────────────────────────────────────────────────

    describe('violation structure', () => {
      it('emits violations at severe severity', async () => {
        seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 42)`, [`${writerDir}/createOrder.ts`]);

        const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        // Second writer that reaches validator → establishes modeShare
        const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 51)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w2Id, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
        expect(bypass[0].severity).toBe('severe');
      });

      it('includes rule, analyzer, and functionName in violation', async () => {
        seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 42)`, [`${writerDir}/createOrder.ts`]);

        const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        // Second writer that reaches validator → establishes modeShare
        const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 51)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w2Id, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
        expect(bypass[0].rule).toBe('cross-domain/no-validator-reachable');
        expect(bypass[0].analyzer).toBe('cross-domain');
        expect(bypass[0].functionName).toBe('createOrder');
        expect(bypass[0].line).toBe(42);
      });

      it('message reports validator reachability, not a validation verdict', async () => {
        seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'createOrder', 'insert', 42)`, [`${writerDir}/createOrder.ts`]);

        const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
          isExported: true,
          usedImports: ['zod'],
        });

        // Also add a second writer that reaches validator so modeShare is met
        const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
        db.run(`INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
           VALUES ('orders', ?, 'saveOrder', 'insert', 51)`, [`${writerDir}/saveOrder.ts`]);
        seedCallEdge(db, w2Id, vId);

        const result = await runAnalyze(db, {
          validatorBypass: {
            validators: [],
            modeShare: 0.5,
            minCorpus: 2,
            depth: 3,
          },
        });

        const bypass = result.violations.filter(v => v.rule === 'cross-domain/no-validator-reachable');
        expect(bypass).toHaveLength(1);
        expect(bypass[0].message).toContain('does not reach a validator');
        expect(bypass[0].message).toContain('createOrder');
        expect(bypass[0].message).not.toContain('is not validated');
      });
    });
  });
});
