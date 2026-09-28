/**
 * Spec 68 §3.2 — parity: the migrated cross-domain lifecycle rules reproduce
 * the old `CrossDomainAnalyzer`'s findings exactly.
 *
 * The cross-domain analyzer is the second migrated analyzer that is *index-
 * backed* (after styles): it queried `schema_usage` from SQLite rather than
 * walking an AST. So the parity test seeds that table in an in-memory
 * `CodeIndexDB`, runs the legacy `analyze(files, { indexHandle, schemaLifecycle:
 * { enableTransactionBoundaryRisk: false } })` (which isolates R1's
 * written-never-read + read-never-written), then re-reads the *same* rows and
 * converts them to the camelCase `SchemaUsageFact` the new rules read. The rule
 * half is what is pinned — same file, line, column, rule, severity — on the full
 * multiset.
 *
 * The seed pins the load-bearing reverse-column `DISTINCT` tiebreak: `users` is
 * written with INSERT/UPDATE/DELETE/INSERT/UPDATE, and the legacy SQL's
 * `ORDER BY table_name, file_path` sorts the remaining SELECT columns in
 * REVERSE order, so `delete` sorts before `insert` and the DELETE (line 38) —
 * not the first INSERT (line 22) — is the anchor. The `logs` table (two
 * INSERTs) pins the line tiebreak within one usage type; the `settings` table
 * (two SELECTs) pins it for reads. The `scratch`/`cp_test` tables pin the
 * query-builder exclusion: an all-builder table is skipped, and a builder read
 * balances a raw-SQL create.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { CrossDomainAnalyzer } from '../analyzers/crossDomain/CrossDomainAnalyzer.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { analyzeCrossDomain } from '../phase/runner.js';
import { multiTableWriteRule, noValidatorReachableRule, uncoveredRiskRule } from '../phase/rules/crossDomain.js';
import type { SchemaUsageFact, CallGraphFact, BatchFunctionFact, HotspotFact, CoverageFact, Finding } from '../phase/types.js';
import type { Violation } from '../types.js';

let db: CodeIndexDB;

beforeAll(async () => {
  db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
}, 30_000);

beforeEach(() => {
  db.exec('DELETE FROM schema_usage');
  db.exec('DELETE FROM graph_cache');
  db.exec('DELETE FROM functions');
  db.exec('DELETE FROM hotspot_scores');
  db.exec('DELETE FROM coverage_data');
});

afterAll(async () => {
  await CodeIndexDB.getInstance().close();
});

/** A schema_usage seed — the camelCase fact and the snake_case DB row derive from it. */
interface Seed {
  tableName: string;
  filePath: string;
  functionName: string | null;
  functionStartLine: number | null;
  functionStartColumn: number | null;
  usageType: 'select' | 'insert' | 'update' | 'delete' | 'create';
  line: number;
  origin?: 'query-builder';
}

function insertUsage(s: Seed): void {
  db.run(
    `INSERT INTO schema_usage
      (table_name, file_path, function_name, function_start_line, function_start_column, usage_type, line, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.tableName,
      s.filePath,
      s.functionName,
      s.functionStartLine,
      s.functionStartColumn,
      s.usageType,
      s.line,
      s.origin ?? null,
    ],
  );
}

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

/** Run the legacy analyzer and the new `analyzeCrossDomain`, return per-rule multisets. */
async function parity(seeds: Seed[]): Promise<Record<string, string[]>> {
  for (const s of seeds) insertUsage(s);

  const analyzer = new CrossDomainAnalyzer();
  const legacy = await analyzer.analyze(['a.ts'], {
    indexHandle: db,
    schemaLifecycle: { enableTransactionBoundaryRisk: false },
  });

  // Re-read the SAME rows (the legacy path's only input) and convert to facts.
  const rows = db.query(
    'SELECT table_name, file_path, function_name, function_start_line, function_start_column, usage_type, line, origin FROM schema_usage',
  ) as Array<{
    table_name: string;
    file_path: string;
    function_name: string | null;
    function_start_line: number | null;
    function_start_column: number | null;
    usage_type: string;
    line: number;
    origin: string | null;
  }>;

  const facts: SchemaUsageFact[] = rows.map((r) => ({
    tableName: r.table_name,
    filePath: r.file_path,
    functionName: r.function_name,
    functionStartLine: r.function_start_line,
    functionStartColumn: r.function_start_column,
    usageType: r.usage_type as SchemaUsageFact['usageType'],
    line: r.line,
    origin: r.origin === 'query-builder' ? 'query-builder' : undefined,
  }));

  const fresh = await analyzeCrossDomain(facts, {});

  const perRule: Record<string, string[]> = {};
  for (const ruleId of ['cross-domain/written-never-read', 'cross-domain/read-never-written']) {
    const old = legacy.violations
      .filter((v: Violation) => v.rule === ruleId)
      .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
      .sort();
    const nu = fresh
      .filter((f) => f.ruleId === ruleId)
      .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
      .sort();
    perRule[ruleId] = nu;
    expect(nu, `rule ${ruleId}`).toEqual(old);
  }
  return perRule;
}

describe('Spec 68 cross-domain parity (new analyze(ctx) === old CrossDomainAnalyzer)', () => {
  it('covers exactly the two migrated cross-domain rules', async () => {
    const perRule = await parity([]);
    expect(Object.keys(perRule).sort()).toEqual([
      'cross-domain/read-never-written',
      'cross-domain/written-never-read',
    ]);
  });

  it('both rules fire and match the legacy multiset on a full seed', async () => {
    // written-never-read: `users` written five ways, never read. The DELETE
    // (line 38) anchors, not the first INSERT (line 22) — the reverse-column
    // DISTINCT tiebreak sorts `delete` before `insert`.
    const usersWrites: Seed[] = [
      { tableName: 'users', filePath: '/p/src/mixed.ts', functionName: 'batchUpsertUsers', functionStartLine: 20, functionStartColumn: 1, usageType: 'insert', line: 22 },
      { tableName: 'users', filePath: '/p/src/mixed.ts', functionName: 'backfillNames', functionStartLine: 29, functionStartColumn: 1, usageType: 'update', line: 31 },
      { tableName: 'users', filePath: '/p/src/mixed.ts', functionName: 'purgeUsers', functionStartLine: 37, functionStartColumn: 1, usageType: 'delete', line: 38 },
      { tableName: 'users', filePath: '/p/src/mixed.ts', functionName: 'touchUser', functionStartLine: 43, functionStartColumn: 1, usageType: 'insert', line: 44 },
      { tableName: 'users', filePath: '/p/src/mixed.ts', functionName: 'renameUser', functionStartLine: 49, functionStartColumn: 1, usageType: 'update', line: 50 },
    ];

    // written-never-read: `logs` two INSERTs (same usage type) — the lower line anchors.
    const logsWrites: Seed[] = [
      { tableName: 'logs', filePath: '/p/src/logs.ts', functionName: 'a', functionStartLine: 9, functionStartColumn: 1, usageType: 'insert', line: 10 },
      { tableName: 'logs', filePath: '/p/src/logs.ts', functionName: 'b', functionStartLine: 19, functionStartColumn: 1, usageType: 'insert', line: 20 },
    ];

    // read-never-written: two SELECT-only tables (one row each) and `settings`
    // with two SELECTs (line tiebreak).
    const reads: Seed[] = [
      { tableName: 'audit_logs', filePath: '/p/src/queries.ts', functionName: 'q1', functionStartLine: 7, functionStartColumn: 1, usageType: 'select', line: 8 },
      { tableName: 'userProfiles', filePath: '/p/src/queries.ts', functionName: 'q2', functionStartLine: 12, functionStartColumn: 1, usageType: 'select', line: 13 },
      { tableName: 'settings', filePath: '/p/src/queries.ts', functionName: 'q3', functionStartLine: 4, functionStartColumn: 1, usageType: 'select', line: 5 },
      { tableName: 'settings', filePath: '/p/src/queries.ts', functionName: 'q4', functionStartLine: 8, functionStartColumn: 1, usageType: 'select', line: 9 },
    ];

    // Excluded — all query-builder rows (a fluent scratch/test table).
    const scratch: Seed[] = [
      { tableName: 'scratch', filePath: '/p/src/x.ts', functionName: 'f', functionStartLine: 1, functionStartColumn: 1, usageType: 'select', line: 2, origin: 'query-builder' },
      { tableName: 'scratch', filePath: '/p/src/x.ts', functionName: 'f', functionStartLine: 1, functionStartColumn: 1, usageType: 'insert', line: 3, origin: 'query-builder' },
    ];

    // Excluded — a raw-SQL create balanced by a query-builder read (cp_test).
    const cpTest: Seed[] = [
      { tableName: 'cp_test', filePath: '/p/src/y.ts', functionName: 'f', functionStartLine: 1, functionStartColumn: 1, usageType: 'create', line: 2 },
      { tableName: 'cp_test', filePath: '/p/src/y.ts', functionName: 'f', functionStartLine: 1, functionStartColumn: 1, usageType: 'select', line: 3, origin: 'query-builder' },
    ];

    const perRule = await parity([
      ...usersWrites,
      ...logsWrites,
      ...reads,
      ...scratch,
      ...cpTest,
    ]);

    expect(perRule['cross-domain/written-never-read']).toEqual([
      '/p/src/logs.ts:10:0:cross-domain/written-never-read:high',
      '/p/src/mixed.ts:38:0:cross-domain/written-never-read:high',
    ].sort());
    expect(perRule['cross-domain/read-never-written']).toEqual([
      '/p/src/queries.ts:5:0:cross-domain/read-never-written:severe',
      '/p/src/queries.ts:8:0:cross-domain/read-never-written:severe',
      '/p/src/queries.ts:13:0:cross-domain/read-never-written:severe',
    ].sort());
  });

  it('written-never-read does NOT fire on a create-only or delete-only table', async () => {
    // A table whose only visible writes are DDL (`create`) or a truncate
    // (`delete`) has no "data flows in" (`insert`/`update`) usage — its
    // `insert`/`select` live in a file the extractor does not scan (an
    // out-of-scope receiver) or a dynamic-SQL read, so it is not a dead write
    // path. Both the legacy detector and the new rule skip it.
    const perRule = await parity([
      { tableName: 'phase_facts', filePath: '/p/src/migrate.ts', functionName: 'migrate', functionStartLine: 1, functionStartColumn: 1, usageType: 'create', line: 2 },
      { tableName: 'file_churn', filePath: '/p/src/index.ts', functionName: 'clearIndex', functionStartLine: 1, functionStartColumn: 1, usageType: 'delete', line: 2549 },
    ]);
    expect(perRule['cross-domain/written-never-read']).toEqual([]);
    expect(perRule['cross-domain/read-never-written']).toEqual([]);
  });

  it('written-never-read does NOT fire when a write is balanced by a read', async () => {
    const perRule = await parity([
      { tableName: 'users', filePath: '/p/src/x.ts', functionName: 'f', functionStartLine: 1, functionStartColumn: 1, usageType: 'insert', line: 2 },
      { tableName: 'users', filePath: '/p/src/x.ts', functionName: 'f', functionStartLine: 1, functionStartColumn: 1, usageType: 'select', line: 4 },
    ]);
    expect(perRule['cross-domain/written-never-read']).toEqual([]);
    expect(perRule['cross-domain/read-never-written']).toEqual([]);
  });

  it('neither rule fires on an all-query-builder table', async () => {
    const perRule = await parity([
      { tableName: 'scratch', filePath: '/p/src/x.ts', functionName: 'f', functionStartLine: 1, functionStartColumn: 1, usageType: 'select', line: 2, origin: 'query-builder' },
      { tableName: 'scratch', filePath: '/p/src/x.ts', functionName: 'f', functionStartLine: 1, functionStartColumn: 1, usageType: 'insert', line: 3, origin: 'query-builder' },
    ]);
    expect(perRule['cross-domain/written-never-read']).toEqual([]);
    expect(perRule['cross-domain/read-never-written']).toEqual([]);
  });
});

// ── multi-table-write (transaction-boundary risk) ───────────────────────────

/** Insert one `functions` row (id is explicit so call-graph edges resolve).
 *  `usedImports` (raw JSON string) and `isExported` (0/1) feed the
 *  `no-validator-reachable` provenance check. */
function insertFunction(
  id: number,
  name: string,
  filePath: string,
  usedImports: string | null = null,
  isExported: number = 0,
): void {
  db.run(
    'INSERT INTO functions (id, name, file_path, used_imports, is_exported) VALUES (?, ?, ?, ?, ?)',
    [id, name, filePath, usedImports, isExported],
  );
}

/** Insert one `graph_cache` `call` edge (node_key → neighbor_key, both id strings). */
function insertCallEdge(fromId: number, toId: number): void {
  db.run(
    "INSERT INTO graph_cache (graph_type, node_key, neighbor_key, weight) VALUES ('call', ?, ?, 1.0)",
    [String(fromId), String(toId)],
  );
}

/** Re-read the `functions` + `graph_cache` rows into the `call-graph` fact the
 *  rule reads — the same two tables the legacy `resolveCallGraphContext` +
 *  `expandWrittenTables` queried. */
function readCallGraph(): CallGraphFact {
  const funcs = db.query('SELECT id, name, file_path, line_number, used_imports, is_exported FROM functions') as Array<{ id: number; name: string; file_path: string; line_number: number | null; used_imports: string | null; is_exported: number }>;
  const edges = db.query("SELECT node_key, neighbor_key FROM graph_cache WHERE graph_type = 'call'") as Array<{ node_key: string; neighbor_key: string }>;
  const callEdges: Array<{ fromId: number; toId: number }> = [];
  for (const e of edges) {
    const fromId = parseInt(e.node_key, 10);
    const toId = parseInt(e.neighbor_key, 10);
    if (!isNaN(fromId) && !isNaN(toId)) callEdges.push({ fromId, toId });
  }
  return {
    functions: funcs.map((f) => ({
      id: f.id,
      name: f.name,
      filePath: f.file_path,
      lineNumber: f.line_number ?? null,
      usedImports: f.used_imports ?? null,
      isExported: f.is_exported === 1,
    })),
    callEdges,
  };
}

/** Run the legacy multi-table-write detector and the new rule over the same seed,
 *  assert the `(file, line, column, rule, severity)` multiset matches, and return it. */
async function parityMultiTableWrite(seeds: Seed[], txnTableMax: number): Promise<string[]> {
  for (const s of seeds) insertUsage(s);

  const analyzer = new CrossDomainAnalyzer();
  const legacy = await analyzer.analyze(['a.ts'], {
    indexHandle: db,
    schemaLifecycle: {
      enableWrittenNeverRead: false,
      enableReadNeverWritten: false,
      enableTransactionBoundaryRisk: true,
      txnTableMax,
    },
  });

  const rows = db.query(
    'SELECT table_name, file_path, function_name, function_start_line, function_start_column, usage_type, line, origin FROM schema_usage',
  ) as Array<{
    table_name: string;
    file_path: string;
    function_name: string | null;
    function_start_line: number | null;
    function_start_column: number | null;
    usage_type: string;
    line: number;
    origin: string | null;
  }>;

  const facts: SchemaUsageFact[] = rows.map((r) => ({
    tableName: r.table_name,
    filePath: r.file_path,
    functionName: r.function_name,
    functionStartLine: r.function_start_line,
    functionStartColumn: r.function_start_column,
    usageType: r.usage_type as SchemaUsageFact['usageType'],
    line: r.line,
    origin: r.origin === 'query-builder' ? 'query-builder' : undefined,
  }));

  const fresh = multiTableWriteRule.analyze({
    facts: { 'schema-usage': facts, 'call-graph': readCallGraph(), 'batch-functions': [] },
    formats: ['typescript', 'tsx', 'javascript'],
    thresholds: { schemaLifecycle: { txnTableMax } },
  }) as Finding[];

  const old = legacy.violations
    .filter((v: Violation) => v.rule === 'cross-domain/multi-table-write')
    .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();
  const nu = fresh
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();
  expect(nu).toEqual(old);
  return nu;
}

describe('Spec 68 cross-domain parity — multi-table-write', () => {
  it('fires when a function writes ≥ txnTableMax distinct tables', async () => {
    const nu = await parityMultiTableWrite(
      ['a', 'b', 'c', 'd'].map((tableName) => ({
        tableName,
        filePath: '/p/src/migrate.ts',
        functionName: 'migrate',
        functionStartLine: 1,
        functionStartColumn: 1,
        usageType: 'insert',
        line: 10,
      })),
      4,
    );
    expect(nu).toEqual(['/p/src/migrate.ts:10:0:cross-domain/multi-table-write:high']);
  });

  it('does not fire below the threshold', async () => {
    const nu = await parityMultiTableWrite(
      ['a', 'b', 'c'].map((tableName) => ({
        tableName,
        filePath: '/p/src/migrate.ts',
        functionName: 'migrate',
        functionStartLine: 1,
        functionStartColumn: 1,
        usageType: 'insert',
        line: 10,
      })),
      4,
    );
    expect(nu).toEqual([]);
  });

  it('expands depth-1 callee writes through the call graph', async () => {
    insertFunction(1, 'main', '/p/src/migrate.ts');
    insertFunction(2, 'saveUser', '/p/src/migrate.ts');
    insertCallEdge(1, 2);

    const seeds: Seed[] = [
      { tableName: 'a', filePath: '/p/src/migrate.ts', functionName: 'main', functionStartLine: 1, functionStartColumn: 1, usageType: 'insert', line: 10 },
      { tableName: 'b', filePath: '/p/src/migrate.ts', functionName: 'main', functionStartLine: 1, functionStartColumn: 1, usageType: 'insert', line: 11 },
      { tableName: 'c', filePath: '/p/src/migrate.ts', functionName: 'saveUser', functionStartLine: 5, functionStartColumn: 1, usageType: 'insert', line: 20 },
      { tableName: 'd', filePath: '/p/src/migrate.ts', functionName: 'saveUser', functionStartLine: 5, functionStartColumn: 1, usageType: 'insert', line: 21 },
    ];

    const nu = await parityMultiTableWrite(seeds, 4);
    expect(nu).toEqual(['/p/src/migrate.ts:10:0:cross-domain/multi-table-write:high']);
  });

  it('degrades to direct writes when the call graph is absent', async () => {
    // No functions/graph_cache rows: the callee expansion degrades, so `main`
    // writing 2 tables (below the 4-table threshold) does not fire even though
    // a hypothetical callee would push it over.
    const nu = await parityMultiTableWrite(
      ['a', 'b'].map((tableName) => ({
        tableName,
        filePath: '/p/src/migrate.ts',
        functionName: 'main',
        functionStartLine: 1,
        functionStartColumn: 1,
        usageType: 'insert',
        line: 10,
      })),
      4,
    );
    expect(nu).toEqual([]);
  });

  it('skips a write whose enclosing function commits via a single .batch()', () => {
    const facts: SchemaUsageFact[] = ['a', 'b', 'c', 'd'].map((tableName) => ({
      tableName,
      filePath: '/p/src/migrate.ts',
      functionName: 'migrate',
      functionStartLine: 1,
      functionStartColumn: 1,
      usageType: 'insert',
      line: 10,
    }));
    const batches: BatchFunctionFact[] = [{ file: '/p/src/migrate.ts', startLine: 1, endLine: 100 }];
    const fresh = multiTableWriteRule.analyze({
      facts: {
        'schema-usage': facts,
        'call-graph': { functions: [], callEdges: [] },
        'batch-functions': batches,
      },
      formats: ['typescript', 'tsx', 'javascript'],
      thresholds: { schemaLifecycle: { txnTableMax: 4 } },
    }) as Finding[];
    expect(fresh.map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))).toEqual([]);
  });
});

// ── no-validator-reachable (validation bypass) ──────────────────────────────

/** A `functions` seed for the no-validator-reachable parity tests — carries
 *  `used_imports` (raw JSON string) and `is_exported` for validator provenance. */
interface FuncSeed {
  id: number;
  name: string;
  filePath: string;
  usedImports?: string | null;
  isExported?: number;
}

/** Run the legacy validation-bypass detector and the new rule over the same
 *  seed (schema_usage + functions + call edges), assert the
 *  `(file, line, column, rule, severity)` multiset matches, and return it. */
async function parityNoValidatorReachable(
  seeds: Seed[],
  vb: { validators?: string[]; modeShare?: number; minCorpus?: number; depth?: number },
  funcs: FuncSeed[],
  edges: Array<[number, number]>,
): Promise<string[]> {
  for (const s of seeds) insertUsage(s);
  for (const f of funcs) insertFunction(f.id, f.name, f.filePath, f.usedImports ?? null, f.isExported ?? 0);
  for (const [a, b] of edges) insertCallEdge(a, b);

  const analyzer = new CrossDomainAnalyzer();
  const legacy = await analyzer.analyze(['a.ts'], {
    indexHandle: db,
    schemaLifecycle: {
      enableWrittenNeverRead: false,
      enableReadNeverWritten: false,
      enableTransactionBoundaryRisk: false,
    },
    validatorBypass: vb,
  });

  const rows = db.query(
    'SELECT table_name, file_path, function_name, function_start_line, function_start_column, usage_type, line, origin FROM schema_usage',
  ) as Array<{
    table_name: string;
    file_path: string;
    function_name: string | null;
    function_start_line: number | null;
    function_start_column: number | null;
    usage_type: string;
    line: number;
    origin: string | null;
  }>;
  const facts: SchemaUsageFact[] = rows.map((r) => ({
    tableName: r.table_name,
    filePath: r.file_path,
    functionName: r.function_name,
    functionStartLine: r.function_start_line,
    functionStartColumn: r.function_start_column,
    usageType: r.usage_type as SchemaUsageFact['usageType'],
    line: r.line,
    origin: r.origin === 'query-builder' ? 'query-builder' : undefined,
  }));

  const fresh = noValidatorReachableRule.analyze({
    facts: { 'schema-usage': facts, 'call-graph': readCallGraph() },
    formats: ['typescript', 'tsx', 'javascript'],
    thresholds: { validatorBypass: vb },
  }) as Finding[];

  const old = legacy.violations
    .filter((v: Violation) => v.rule === 'cross-domain/no-validator-reachable')
    .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();
  const nu = fresh
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();
  expect(nu).toEqual(old);
  return nu;
}

describe('Spec 68 cross-domain parity — no-validator-reachable', () => {
  // Shared seed: two writers in one directory, one validated (saveUser reaches
  // validateInput), one not (saveOrder). validateInput is provenanced via its
  // own `used_imports` (zod) + export.
  const funcs: FuncSeed[] = [
    { id: 1, name: 'saveUser', filePath: '/p/src/users.ts' },
    { id: 2, name: 'saveOrder', filePath: '/p/src/orders.ts' },
    { id: 3, name: 'validateInput', filePath: '/p/src/validators.ts', usedImports: '["zod"]', isExported: 1 },
  ];
  const writes: Seed[] = [
    { tableName: 'users', filePath: '/p/src/users.ts', functionName: 'saveUser', functionStartLine: 1, functionStartColumn: 1, usageType: 'insert', line: 10 },
    { tableName: 'orders', filePath: '/p/src/orders.ts', functionName: 'saveOrder', functionStartLine: 1, functionStartColumn: 1, usageType: 'insert', line: 20 },
  ];

  it('fires when a writer does not reach a validator in a validator-dense directory', async () => {
    const nu = await parityNoValidatorReachable(
      writes,
      { validators: [], modeShare: 0.5, minCorpus: 2, depth: 3 },
      funcs,
      [[1, 3]],
    );
    expect(nu).toEqual(['/p/src/orders.ts:20:0:cross-domain/no-validator-reachable:severe']);
  });

  it('does not fire when every writer reaches a validator', async () => {
    const nu = await parityNoValidatorReachable(
      writes,
      { validators: [], modeShare: 0.5, minCorpus: 2, depth: 3 },
      funcs,
      [[1, 3], [2, 3]],
    );
    expect(nu).toEqual([]);
  });

  it('does not fire below minCorpus', async () => {
    const nu = await parityNoValidatorReachable(
      writes,
      { validators: [], modeShare: 0.5, minCorpus: 3, depth: 3 },
      funcs,
      [[1, 3]],
    );
    expect(nu).toEqual([]);
  });

  it('honors user-configured validators by name (provenance silent)', async () => {
    // validateInput is not exported and imports nothing, so provenance finds
    // nothing — the user-configured name is the only validator source.
    const plainFuncs: FuncSeed[] = [
      { id: 1, name: 'saveUser', filePath: '/p/src/users.ts' },
      { id: 2, name: 'saveOrder', filePath: '/p/src/orders.ts' },
      { id: 3, name: 'validateInput', filePath: '/p/src/validators.ts' },
    ];
    const nu = await parityNoValidatorReachable(
      writes,
      { validators: ['validateInput'], modeShare: 0.5, minCorpus: 2, depth: 3 },
      plainFuncs,
      [[1, 3]],
    );
    expect(nu).toEqual(['/p/src/orders.ts:20:0:cross-domain/no-validator-reachable:severe']);
  });

  it('falls back to the name heuristic when provenance is silent', async () => {
    // validateInput is exported but imports no validator package: the `validate*`
    // name heuristic is the fallback.
    const heuristicFuncs: FuncSeed[] = [
      { id: 1, name: 'saveUser', filePath: '/p/src/users.ts' },
      { id: 2, name: 'saveOrder', filePath: '/p/src/orders.ts' },
      { id: 3, name: 'validateInput', filePath: '/p/src/validators.ts', isExported: 1 },
    ];
    const nu = await parityNoValidatorReachable(
      writes,
      { validators: [], modeShare: 0.5, minCorpus: 2, depth: 3 },
      heuristicFuncs,
      [[1, 3]],
    );
    expect(nu).toEqual(['/p/src/orders.ts:20:0:cross-domain/no-validator-reachable:severe']);
  });

  it('drops a write whose function has no index row (inner join)', async () => {
    // saveOrder has no `functions` row, so the INNER JOIN drops it: only saveUser
    // is a writer, and it is covered — nothing fires even at minCorpus 1.
    const partialFuncs: FuncSeed[] = [
      { id: 1, name: 'saveUser', filePath: '/p/src/users.ts' },
      { id: 3, name: 'validateInput', filePath: '/p/src/validators.ts', usedImports: '["zod"]', isExported: 1 },
    ];
    const nu = await parityNoValidatorReachable(
      writes,
      { validators: [], modeShare: 0.5, minCorpus: 1, depth: 3 },
      partialFuncs,
      [[1, 3]],
    );
    expect(nu).toEqual([]);
  });

  it('returns nothing when no validator exists at all', async () => {
    // No user validators, no provenance, no heuristic match → empty validator
    // set → the detector short-circuits before touching writers.
    const noValidatorFuncs: FuncSeed[] = [
      { id: 1, name: 'saveUser', filePath: '/p/src/users.ts' },
      { id: 2, name: 'saveOrder', filePath: '/p/src/orders.ts' },
    ];
    const nu = await parityNoValidatorReachable(
      writes,
      { validators: [], modeShare: 0.5, minCorpus: 1, depth: 3 },
      noValidatorFuncs,
      [],
    );
    expect(nu).toEqual([]);
  });
});

// ── uncovered-risk (coverage by importance) ────────────────────────────────

/** Insert one `functions` row with an explicit `line_number` — the static-reach
 *  and measured paths both anchor the finding on it. */
function insertFunctionWithLine(
  id: number,
  name: string,
  filePath: string,
  lineNumber: number,
  usedImports: string | null = null,
  isExported: number = 0,
): void {
  db.run(
    'INSERT INTO functions (id, name, file_path, line_number, used_imports, is_exported) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, filePath, lineNumber, usedImports, isExported],
  );
}

/** Insert one `hotspot_scores` row (the `target` is the legacy join key
 *  `file_path || ':' || name`). */
function insertHotspot(target: string, type: string, score: number): void {
  db.run('INSERT INTO hotspot_scores (target, type, score) VALUES (?, ?, ?)', [target, type, score]);
}

/** Insert one `coverage_data` row (line_number required by the UNIQUE key). */
function insertCoverage(
  functionName: string,
  filePath: string,
  lineNumber: number,
  basis: string,
  covered: number,
  source: string | null = null,
  importedAt: string | null = null,
): void {
  db.run(
    'INSERT INTO coverage_data (function_name, file_path, line_number, basis, covered, source, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [functionName, filePath, lineNumber, basis, covered, source, importedAt],
  );
}

/** Re-read the `hotspot_scores` rows into the `hotspot` fact the rule reads. */
function readHotspot(): HotspotFact[] {
  const rows = db.query('SELECT target, type, score FROM hotspot_scores') as Array<{ target: string; type: string; score: number }>;
  return rows.map((r) => ({ target: r.target, type: r.type, score: r.score }));
}

/** Re-read the `coverage_data` rows (plus the measured-count/source metadata the
 *  legacy `detectUncoveredRisk` read) into the `coverage` fact the rule reads. */
function readCoverage(): CoverageFact {
  const measuredRow = db.query("SELECT COUNT(*) AS cnt FROM coverage_data WHERE basis = 'measured'")[0] as { cnt: number } | undefined;
  const sourceRow = db.query("SELECT source, imported_at FROM coverage_data WHERE basis = 'measured' LIMIT 1")[0] as { source: string | null; imported_at: string | null } | undefined;
  const entries = db.query('SELECT function_name, file_path, covered FROM coverage_data') as Array<{ function_name: string; file_path: string; covered: number }>;
  return {
    measuredCount: measuredRow?.cnt ?? 0,
    source: sourceRow?.source ?? null,
    importedAt: sourceRow?.imported_at ?? null,
    lastFullSync: db.getMeta('last_full_sync_timestamp'),
    entries: entries.map((e) => ({ functionName: e.function_name, filePath: e.file_path, covered: e.covered === 1 })),
  };
}

/** Run the legacy uncovered-risk detector and the new rule over the same seed,
 *  assert the `(file, line, column, rule, severity)` multiset matches, and
 *  return it. The `coverage` config is the rule's opt-in key — it is passed to
 *  the legacy `analyze` AND as the rule's `thresholds.coverage`. */
async function parityUncoveredRisk(
  coverage: { topRiskDecile?: number; testGlobs?: string[]; staticReachDepth?: number },
): Promise<string[]> {
  const analyzer = new CrossDomainAnalyzer();
  const legacy = await analyzer.analyze(['a.ts'], {
    indexHandle: db,
    schemaLifecycle: {
      enableWrittenNeverRead: false,
      enableReadNeverWritten: false,
      enableTransactionBoundaryRisk: false,
    },
    coverage,
  });

  const fresh = uncoveredRiskRule.analyze({
    facts: { 'call-graph': readCallGraph(), 'hotspot': readHotspot(), 'coverage': readCoverage() },
    formats: ['typescript', 'tsx', 'javascript'],
    thresholds: { coverage },
  }) as Finding[];

  const old = legacy.violations
    .filter((v: Violation) => v.rule === 'cross-domain/uncovered-risk')
    .map((v: Violation) => key({ file: v.file, line: v.line, column: v.column, rule: v.rule, severity: v.severity }))
    .sort();
  const nu = fresh
    .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
    .sort();
  expect(nu).toEqual(old);
  return nu;
}

describe('Spec 68 cross-domain parity — uncovered-risk', () => {
  it('measured path: flags top-decile exported functions with no measured coverage', async () => {
    // Four exported functions, scores 300/200/100/50. PERCENT_RANK over the
    // DESC list gives pct 0 / 0.333 / 0.667 / 1.0, so topRiskDecile 0.5 keeps
    // `a` (300) and `b` (200). `b` has a covered=1 measured row, so only `a`
    // is untested and flagged.
    insertFunctionWithLine(1, 'a', '/p/a.ts', 10, null, 1);
    insertFunctionWithLine(2, 'b', '/p/b.ts', 20, null, 1);
    insertFunctionWithLine(3, 'c', '/p/c.ts', 30, null, 1);
    insertFunctionWithLine(4, 'd', '/p/d.ts', 40, null, 1);
    insertHotspot('/p/a.ts:a', 'function', 300);
    insertHotspot('/p/b.ts:b', 'function', 200);
    insertHotspot('/p/c.ts:c', 'function', 100);
    insertHotspot('/p/d.ts:d', 'function', 50);
    // The one measured row both drives measuredCount > 0 and covers `b`.
    insertCoverage('b', '/p/b.ts', 20, 'measured', 1, 'lcov', '2026-01-01T00:00:00Z');

    const nu = await parityUncoveredRisk({ topRiskDecile: 0.5 });
    expect(nu).toEqual(['/p/a.ts:10:0:cross-domain/uncovered-risk:high']);
  });

  it('measured path: a covered top-decile function is not flagged', async () => {
    // Every exported function is covered → the untested set is empty.
    insertFunctionWithLine(1, 'a', '/p/a.ts', 10, null, 1);
    insertHotspot('/p/a.ts:a', 'function', 300);
    insertCoverage('a', '/p/a.ts', 10, 'measured', 1, 'lcov', '2026-01-01T00:00:00Z');

    const nu = await parityUncoveredRisk({ topRiskDecile: 0.5 });
    expect(nu).toEqual([]);
  });

  it('static-reach path: flags top-decile functions unreachable from test files', async () => {
    // Two exported functions (risk 100 / 1): topRiskDecile 0.1 keeps only
    // `highRisk` (pct 0). `testFn` lives in `*.test.ts`, so BFS starts from it;
    // with no edges, `highRisk` is unreachable → flagged.
    insertFunctionWithLine(1, 'highRisk', '/p/src/impl.ts', 10, null, 1);
    insertFunctionWithLine(2, 'lowRisk', '/p/src/impl2.ts', 20, null, 1);
    insertFunctionWithLine(3, 'testFn', '/p/src/impl.test.ts', 5, null, 0);
    insertHotspot('/p/src/impl.ts:highRisk', 'function', 100);
    insertHotspot('/p/src/impl2.ts:lowRisk', 'function', 1);
    // No coverage_data → measuredCount 0 → the static-reach fallback runs.

    const nu = await parityUncoveredRisk({ topRiskDecile: 0.1, testGlobs: ['**/*.test.*', '**/*.spec.*'], staticReachDepth: 2 });
    expect(nu).toEqual(['/p/src/impl.ts:10:0:cross-domain/uncovered-risk:high']);
  });

  it('static-reach path: a top-decile function reachable from a test file is not flagged', async () => {
    // `highRisk` is called from `testFn` (edge 3 → 1), so BFS reaches it.
    insertFunctionWithLine(1, 'highRisk', '/p/src/impl.ts', 10, null, 1);
    insertFunctionWithLine(2, 'lowRisk', '/p/src/impl2.ts', 20, null, 1);
    insertFunctionWithLine(3, 'testFn', '/p/src/impl.test.ts', 5, null, 0);
    insertHotspot('/p/src/impl.ts:highRisk', 'function', 100);
    insertHotspot('/p/src/impl2.ts:lowRisk', 'function', 1);
    insertCallEdge(3, 1);

    const nu = await parityUncoveredRisk({ topRiskDecile: 0.1, testGlobs: ['**/*.test.*', '**/*.spec.*'], staticReachDepth: 2 });
    expect(nu).toEqual([]);
  });

  it('returns nothing when the opt-in coverage key is absent', () => {
    // The opt-in gate: with no `coverage` threshold the rule short-circuits,
    // matching the legacy `if (coverage)` in `runDetectors`.
    const fresh = uncoveredRiskRule.analyze({
      facts: { 'call-graph': readCallGraph(), 'hotspot': readHotspot(), 'coverage': readCoverage() },
      formats: ['typescript', 'tsx', 'javascript'],
      thresholds: {},
    }) as Finding[];
    expect(fresh).toEqual([]);
  });
});
