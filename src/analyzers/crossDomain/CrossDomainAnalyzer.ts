/**
 * Cross-Domain Analyzer — Spec 15.
 *
 * Post-analysis analyzer that queries the SQLite database for cross-domain
 * findings no single per-file analyzer can produce:
 *
 *   R1 — Schema Lifecycle:
 *     cross-domain/written-never-read    — Table written but never read
 *     cross-domain/read-never-written    — Table read but never written
 *     cross-domain/multi-table-write     — Function writes to too many tables
 *
 *   R3 — Validation Bypass:
 *     cross-domain/no-validator-reachable — Writer doesn't reach a validator
 *
 *   R4 — Coverage by Importance:
 *     cross-domain/uncovered-risk        — Top-risk function with no test coverage
 *
 * Findings emit at `severe` (read-never-written, no-validator-reachable,
 * written-never-read, multi-table-write) or `high` (uncovered-risk) severity.
 * Higher tiers require Spec 11 R5 recalibration bars (precision ≥ 0.95
 * AND judged-true ≥ 0.90) on real-corpus evidence.
 */

import * as path from 'node:path';
import { readFileSync } from 'node:fs';

import type { AnalyzerResult, Violation, ValidatorBypassConfig, CoverageConfig, IndexHandle } from '../../types.js';
import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { AST, ASTNode } from '../../languages/types.js';
import { parseFile } from '../../languages/adapterBridge.js';
import { VALIDATOR_PACKAGES } from '../provenance.js';
import { makeVisitorStatus } from '../../pipeline.js';

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface SchemaUsageRow {
  table_name: string;
  file_path: string;
  function_name: string | null;
  function_start_line: number | null;
  function_start_column: number | null;
  line: number;
  usage_type: string;
}

/**
 * Amendment A — schema_usage identity is a coordinate, not a name. The display
 * label for a row is the declaration name when present, else a coordinate
 * fallback (`fn:<line>:<column>`) for anonymous handlers, else `top-level`.
 * Mirrors `functionIdentityLabel` in the schema analyzer; kept local here
 * because the cross-domain analyzer is SQL-only and does not import the AST
 * helper.
 *
 * A top-level row carries its own coordinate (`function_name = 'top-level'` and a
 * non-null `function_start_line`/`function_start_column`), so the coordinate —
 * not the `top-level` sentinel — is the label: two top-level usages in the same
 * file stay distinct instead of collapsing into one absent-coordinate bucket.
 */
function usageIdentityLabel(
  functionName: string | null,
  startLine: number | null,
  startColumn: number | null,
): string {
  if (startLine == null) return 'top-level';
  if (functionName === 'top-level') return `fn:${startLine}:${startColumn}`;
  return functionName ?? `fn:${startLine}:${startColumn}`;
}

/** Coordinate key `${file_path}::${function_name}` — the cross-domain identity key. */
function funcTableKey(filePath: string, functionName: string): string {
  return `${filePath}::${functionName}`;
}

/** Chunked IN-clause bound (SQLite max host params, conservative). */
const SQLITE_MAX_VARIABLES = 900;

/**
 * File-scope filter applied to cross-domain queries. Two modes:
 *  - Scoped (diff audit): `column IN (changed files)` — chunked to stay under
 *    SQLite's bind-parameter limit. Absolute paths, matching the absolute
 *    `file_path` columns of schema_usage / functions.
 *  - Unscoped (full audit): `column LIKE '<projectRoot>%'` — bounds the corpus
 *    to the indexed project (test isolation + keeps stale foreign rows out).
 */
interface FileScope {
  apply(column: string): { clause: string; params: string[] };
}

function resolveFileScope(config: any): FileScope {
  const scopedFiles = config.isScoped ? ((config.scopedFiles as string[] | undefined) ?? []) : [];
  if (scopedFiles.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < scopedFiles.length; i += SQLITE_MAX_VARIABLES) {
      chunks.push(scopedFiles.slice(i, i + SQLITE_MAX_VARIABLES));
    }
    return {
      apply: (column) => ({
        clause: `AND (${chunks.map((c) => `${column} IN (${c.map(() => '?').join(', ')})`).join(' OR ')})`,
        params: scopedFiles,
      }),
    };
  }
  const projectRoot = config.projectRoot as string | undefined;
  const resolvedRoot = projectRoot ? path.resolve(projectRoot) : undefined;
  if (!resolvedRoot) {
    return { apply: () => ({ clause: '', params: [] }) };
  }
  return {
    apply: (column) => ({
      clause: `AND ${column} LIKE ?`,
      params: [`${resolvedRoot}%`],
    }),
  };
}

/**
 * Preloaded call-graph data, read once at the top of a run and reused by every
 * detector so the BFS walks and depth-1 expansion never re-query `graph_cache`,
 * `functions`, or `schema_usage` per node/callee (the N+1 this replaces). All
 * fields are populated only when the index has call edges; otherwise the empty
 * structure is returned and each consumer degrades to its no-graph path.
 */
interface CallGraphData {
  hasGraphData: boolean;
  /** function key (`file_path::name`) → id */
  fnIdLookup: Map<string, number>;
  /** function id → { name, file_path } */
  fnInfo: Map<number, { name: string; file_path: string }>;
  /** call-edge adjacency: source node id → neighbor node ids */
  callEdges: Map<number, number[]>;
  /** `${file_path}::${name}` → names of tables that function writes */
  fnWriteTables: Map<string, Set<string>>;
}

/** A function that writes to schema tables, from the schema_usage join. */
interface WriterRow {
  function_name: string;
  file_path: string;
  line: number;
  function_id: number;
}

/** Per-writer validator-reach result. */
interface WriterCoverage {
  covered: boolean;
  line: number;
  funcName: string;
}

/** Grouped write entries per function key. */
interface FuncWriteEntry {
  filePath: string;
  line: number;
  tables: Set<string>;
}

/** A writer bucketed into a directory group. */
interface DirWriter {
  key: string;
  covered: boolean;
  line: number;
  funcName: string;
  filePath: string;
}

/** A high-risk function from the ranked hotspot query. */
interface HighRiskFn {
  id: number;
  name: string;
  file_path: string;
  line_number: number;
  risk_score: number;
}


// ---------------------------------------------------------------------------
// Call-graph helpers — pure functions with no `this` state, kept off the
// analyzer class to bound its aggregate cyclomatic complexity.
// ---------------------------------------------------------------------------

/**
 * Advance a call-graph BFS frontier by one node: read `funcId`'s call
 * neighbors from the preloaded adjacency map and enqueue any not yet visited.
 * Shared by the two BFS walks. The adjacency read replaced a per-node
 * `graph_cache` query, the BFS N+1.
 */
function enqueueCallNeighbors(
  callEdges: Map<number, number[]>,
  nextLevel: number[],
  funcId: number,
  visited: Set<number>,
): void {
  const callees = callEdges.get(funcId);
  if (!callees) return;
  for (const calleeId of callees) {
    if (!visited.has(calleeId)) {
      nextLevel.push(calleeId);
    }
  }
}

/**
 * BFS through the call graph (graph_cache) up to maxDepth to check if
 * any path from startFuncId reaches a validator function ID.
 */
function bfsReachesValidator(
  callEdges: Map<number, number[]>,
  startFuncId: number,
  validatorIds: Set<number>,
  maxDepth: number,
): boolean {
  const visited = new Set<number>();
  let currentLevel = [startFuncId];

  for (let d = 0; d < maxDepth; d++) {
    const nextLevel: number[] = [];

    for (const funcId of currentLevel) {
      if (validatorIds.has(funcId)) return true;
      if (visited.has(funcId)) continue;
      visited.add(funcId);

      // Get callees from the preloaded call edges
      enqueueCallNeighbors(callEdges, nextLevel, funcId, visited);
    }

    currentLevel = nextLevel;
  }

  // Check any remaining nodes at the final level
  for (const funcId of currentLevel) {
    if (validatorIds.has(funcId)) return true;
  }

  return false;
}

/**
 * Expand a writer's directly-written table set with the tables written by
 * functions it calls (depth-1 callee expansion via graph_cache). Requires the
 * call-graph infrastructure (graph_cache + functions tables, populated by
 * code-audit index sync); without it, returns the direct write set unchanged.
 */
function expandWrittenTables(
  key: string,
  initialTables: Set<string>,
  graph: CallGraphData,
): Set<string> {
  const allTables = new Set(initialTables);
  const { fnIdLookup, hasGraphData, callEdges, fnInfo, fnWriteTables } = graph;

  if (!hasGraphData) return allTables;

  const funcId = fnIdLookup.get(key);
  if (funcId === undefined) return allTables;

  const calleeIds = callEdges.get(funcId);
  if (!calleeIds) return allTables;

  for (const calleeId of calleeIds) {
    const cf = fnInfo.get(calleeId);
    if (!cf) continue;
    const calleeTables = fnWriteTables.get(`${cf.file_path}::${cf.name}`);
    if (!calleeTables) continue;
    for (const tableName of calleeTables) allTables.add(tableName);
  }

  return allTables;
}

/**
 * BFS outward from test-file function IDs through the call graph (graph_cache)
 * up to maxDepth, collecting every function ID reached. Used for the
 * static-reach fallback: a high-risk function not in this set is uncovered.
 */
function collectReachableIds(
  callEdges: Map<number, number[]>,
  startIds: Set<number>,
  maxDepth: number,
): Set<number> {
  const reachableIds = new Set<number>();

  for (const startId of startIds) {
    const visited = new Set<number>();
    let currentLevel = [startId];

    for (let d = 0; d < maxDepth; d++) {
      const nextLevel: number[] = [];
      for (const funcId of currentLevel) {
        if (visited.has(funcId)) continue;
        visited.add(funcId);
        reachableIds.add(funcId);

        enqueueCallNeighbors(callEdges, nextLevel, funcId, visited);
      }
      currentLevel = nextLevel;
    }
    // Check the final level's nodes that never got expanded.
    for (const funcId of currentLevel) {
      if (!reachableIds.has(funcId)) reachableIds.add(funcId);
    }
  }

  return reachableIds;
}


// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

const ANALYZER_NAME = 'cross-domain';

/**
 * Cross domain analyzer.
 */
export class CrossDomainAnalyzer extends UniversalAnalyzer {
  readonly name = ANALYZER_NAME;
  readonly description =
    'Detects cross-domain issues (schema lifecycle, validation bypass, coverage gaps)';
  readonly category = 'architecture';

  /**
   * Full override: query the code index DB for cross-domain findings.
   * The base-class per-file AST loop is bypassed — all detection is
   * post-analysis across the indexed data.
   * @param config
   * @param files
   * @param options
   * @returns
   */
  async analyze(
    files: string[],
    config: any = {},
    options: any = {},
  ): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const indexHandle: IndexHandle | undefined = config.indexHandle;
    if (!indexHandle) {
      return {
        violations: [],
        errors: [{ file: '', error: 'Failed to open code index database' }],
        status: makeVisitorStatus(0),
        executionTime: Date.now() - startTime,
        analyzerName: ANALYZER_NAME,
        metrics: { filesAnalyzed: 0, totalViolations: 0, executionTime: Date.now() - startTime },
      };
    }

    const scope = resolveFileScope(config);
    const violations = this.runDetectors(indexHandle, config, scope);
    const uniqueFiles = this.countDistinctFiles(indexHandle, scope);

    return {
      violations,
      errors: [],
      status: makeVisitorStatus(uniqueFiles || files.length),
      executionTime: Date.now() - startTime,
      analyzerName: ANALYZER_NAME,
      metrics: {
        filesAnalyzed: uniqueFiles || files.length,
        totalViolations: violations.length,
        executionTime: Date.now() - startTime,
      },
    };
  }

  /** Run the R1/R3/R4 detectors and collect their violations. */
  private runDetectors(indexHandle: IndexHandle, config: any, scope: FileScope): Violation[] {
    const violations: Violation[] = [];

    // Preload the call-graph adjacency, function identity, and per-function write
    // tables once and share across every detector that walks the graph. Each
    // detector previously re-queried `graph_cache` (and, for callee expansion,
    // `functions` + `schema_usage`) once per BFS node / callee — the N+1 that
    // dominated cross-domain time on full audits.
    const graph = loadCallGraphData(indexHandle);

    // R1 — Schema lifecycle detectors
    const lifecycle = config.schemaLifecycle ?? {};
    if (lifecycle.enableWrittenNeverRead !== false) {
      violations.push(...detectWrittenNeverRead(indexHandle, scope));
    }
    if (lifecycle.enableReadNeverWritten !== false) {
      violations.push(...detectReadNeverWritten(indexHandle, scope));
    }
    if (lifecycle.enableTransactionBoundaryRisk !== false) {
      const txnTableMax = lifecycle.txnTableMax ?? 4;
      violations.push(...detectTransactionBoundaryRisk(indexHandle, txnTableMax, scope, graph));
    }

    // R3 — Validation-bypass detection
    const bypass = config.validatorBypass as ValidatorBypassConfig | undefined;
    if (bypass) {
      violations.push(...detectValidationBypass(indexHandle, bypass, scope, graph));
    }

    // R4 — Coverage by importance
    const coverage = config.coverage as CoverageConfig | undefined;
    if (coverage) {
      violations.push(...detectUncoveredRisk(indexHandle, coverage, scope, graph));
    }

    return violations;
  }

  /** Count distinct files with schema_usage entries. */
  private countDistinctFiles(indexHandle: IndexHandle, scope: FileScope): number {
    const fp = scope.apply('file_path');
    const rows = indexHandle
      .query(
        `SELECT COUNT(DISTINCT file_path) as cnt FROM schema_usage WHERE 1=1 ${fp.clause}`,
        fp.params,
      ) as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  }

  /** No-op — all detection is DB-based. */
  async analyzeAST(): Promise<any[]> {
    return [];
  }
}

// ── R1: Written-Never-Read ──────────────────────────────────────────────

/**
 * SQL fragment excluding tables whose `schema_usage` is *entirely* query-builder
 * (`origin = 'query-builder'` on every row). A fluent scratch/test table built
 * and consumed through the knex query-builder is not a one-sided lifecycle
 * defect, so the R1 one-sided detectors skip it. A table with even one
 * non-builder row (raw SQL, tagged template, .sql, ORM) is still considered —
 * that is what lets a query-builder *read* balance a raw-SQL `create` (cp_test).
 */
function nonQueryBuilderTableFilter(fp: { clause: string; params: string[] }): { clause: string; params: string[] } {
  return {
    clause: `AND table_name IN (
        SELECT DISTINCT table_name FROM schema_usage
        WHERE (origin IS NULL OR origin != 'query-builder') ${fp.clause}
      )`,
    params: fp.params,
  };
}

/** Deduplicate query rows by table and emit one violation per unique table,
 *  anchored to the first row encountered. The two read/write-mismatch detectors
 *  share this tail: their SQL and message/severity/rule differ, but the
 *  dedup + violation construction is identical. */
function emitTableViolations(
  rows: SchemaUsageRow[],
  rule: string,
  severity: Violation['severity'],
  message: (row: SchemaUsageRow) => string,
): Violation[] {
  const seen = new Set<string>();
  const violations: Violation[] = [];
  for (const row of rows) {
    if (seen.has(row.table_name)) continue;
    seen.add(row.table_name);

    violations.push({
      file: row.file_path,
      line: row.line,
      column: 0,
      severity,
      message: message(row),
      rule,
      analyzer: ANALYZER_NAME,
      symbol: usageIdentityLabel(row.function_name, row.function_start_line, row.function_start_column),
    });
  }

  return violations;
}

/** One direction of the one-sided lifecycle check: the write-side usage types,
 *  the read-side usage types (the `NOT IN` exclusion), an optional further
 *  `IN` requirement, and the rule/severity/message for the violation. */
interface DirectionCheck {
  writeTypes: readonly string[];
  readTypes: readonly string[];
  requireTypes?: readonly string[];
  rule: string;
  severity: Violation['severity'];
  message: (row: SchemaUsageRow) => string;
}

/** Run one usage-direction check: tables used with `writeTypes` but never with
 *  `readTypes` (optionally requiring membership in `requireTypes`), emitted as
 *  per-table violations. Written-never-read and read-never-written are this one
 *  shape with the two type sets swapped, so the shared SELECT list, scope/QB
 *  filters, ORDER BY, dedup, and emit live here once. `usage_type IN ('select')`
 *  is equivalent to `usage_type = 'select'`, so one IN path covers both. */
function runUsageDirectionCheck(indexHandle: IndexHandle, scope: FileScope, check: DirectionCheck): Violation[] {
  const fp = scope.apply('file_path');
  const qb = nonQueryBuilderTableFilter(fp);
  const inList = (types: readonly string[]) => types.map((t) => `'${t}'`).join(', ');
  const requireClause = check.requireTypes
    ? `\n         AND table_name IN (\n           SELECT DISTINCT table_name FROM schema_usage WHERE usage_type IN (${inList(check.requireTypes)}) ${fp.clause}\n         )`
    : '';

  const rows = indexHandle
    .query(`SELECT DISTINCT table_name, file_path, function_name, function_start_line, function_start_column, line, usage_type
       FROM schema_usage
       WHERE usage_type IN (${inList(check.writeTypes)})
         ${fp.clause}
         ${qb.clause}
         AND table_name NOT IN (
           SELECT DISTINCT table_name FROM schema_usage WHERE usage_type IN (${inList(check.readTypes)}) ${fp.clause}
         )${requireClause}
       ORDER BY table_name, file_path`, [...fp.params, ...qb.params, ...fp.params, ...(check.requireTypes ? fp.params : [])]) as SchemaUsageRow[];

  return emitTableViolations(rows, check.rule, check.severity, check.message);
}

/**
 * Detect tables that are written to (INSERT/UPDATE/DELETE/CREATE) but
 * never read from (SELECT). These might be dead writes or missed read paths.
 *
 * A table must have at least one `insert`/`update` ("data flows in") usage to
 * qualify — a table whose only visible writes are `create` (DDL) or `delete`
 * (truncate) is not a dead write path, because its `insert`/`select` live in a
 * file the extractor does not scan (an out-of-scope receiver) or a dynamic-SQL
 * read. The anchor still sorts the full write set, so `delete` keeps its
 * byte-order edge over `insert` and a mixed write table anchors on the `delete`.
 */
function detectWrittenNeverRead(indexHandle: IndexHandle, scope: FileScope): Violation[] {
  return runUsageDirectionCheck(indexHandle, scope, {
    writeTypes: ['insert', 'update', 'delete', 'create'],
    readTypes: ['select'],
    requireTypes: ['insert', 'update'],
    rule: 'cross-domain/written-never-read',
    severity: 'high',
    message: (row) => `Table '${row.table_name}' is written (${row.usage_type}) but never read (SELECT). Consider removing unused writes or adding read paths.`,
  });
}

// ── R1: Read-Never-Written ──────────────────────────────────────────────

/**
 * Detect tables that are read from (SELECT) but never written to
 * (INSERT/UPDATE/DELETE/CREATE). These may be external/managed tables
 * or indicate missing write coverage.
 */
function detectReadNeverWritten(indexHandle: IndexHandle, scope: FileScope): Violation[] {
  return runUsageDirectionCheck(indexHandle, scope, {
    writeTypes: ['select'],
    readTypes: ['insert', 'update', 'delete', 'create'],
    rule: 'cross-domain/read-never-written',
    severity: 'severe',
    message: (row) => `Table '${row.table_name}' is read (SELECT) but never written (INSERT/UPDATE/DELETE). This may be an external/managed table, or indicate missing write coverage.`,
  });
}

// ── R1: Transaction-Boundary Risk ───────────────────────────────────────

/**
 * Detect functions that write to ≥ txnTableMax distinct tables, including
 * tables written by depth-1 callees via the call graph (graph_cache).
 *
 * This surfaces functions that may have transaction-boundary risk:
 * writing to too many tables in a single logical operation can lead to
 * long-running transactions, lock contention, and partial-failure complexity.
 */
function detectTransactionBoundaryRisk(
  indexHandle: IndexHandle,
  txnTableMax: number,
  scope: FileScope,
  graph: CallGraphData,
): Violation[] {
  const fp = scope.apply('su.file_path');

  // Query schema_usage directly (no JOIN on functions) so this detector
  // works whether or not deepSync has populated the functions table.
  // Amendment A — group by the coordinate identity, not the display name, so
  // distinct anonymous handlers on the same line (or different lines) do not
  // collapse into one pseudo-function.
  const writerRows = indexHandle
    .query(`SELECT su.function_name, su.function_start_line, su.function_start_column, su.file_path, su.table_name, MIN(su.line) as line
       FROM schema_usage su
       WHERE su.usage_type IN ('insert', 'update', 'delete', 'create')
       ${fp.clause}
       GROUP BY su.file_path, su.function_start_line, su.function_start_column, su.table_name
       ORDER BY su.file_path, su.function_start_line, su.function_start_column`, fp.params) as Array<{
    function_name: string | null;
    function_start_line: number | null;
    function_start_column: number | null;
    file_path: string;
    table_name: string;
    line: number;
  }>;

  if (writerRows.length === 0) return [];

  const funcWrites = groupWriterTables(writerRows);
  return flagTransactionBoundaryWrites(funcWrites, graph, txnTableMax);
}

/** Group written tables by coordinate-identity key (display name is the label). */
function groupWriterTables(
  writerRows: Array<{
    function_name: string | null;
    function_start_line: number | null;
    function_start_column: number | null;
    file_path: string;
    table_name: string;
    line: number;
  }>,
): Map<string, FuncWriteEntry> {
  const funcWrites = new Map<string, FuncWriteEntry>();
  for (const row of writerRows) {
    const label = usageIdentityLabel(row.function_name, row.function_start_line, row.function_start_column);
    const key = `${row.file_path}::${label}`;
    const entry = funcWrites.get(key);
    if (entry) {
      entry.tables.add(row.table_name);
    } else {
      funcWrites.set(key, {
        filePath: row.file_path,
        line: row.line,
        tables: new Set([row.table_name]),
      });
    }
  }
  return funcWrites;
}

/**
 * Whether the function enclosing `writeLine` commits its writes atomically via a
 * single `.batch()` call (Cloudflare D1 / SQLite transaction batching). When the
 * writes are accumulated into prepared statements and committed in one batch,
 * the multi-table shape carries no transaction-boundary risk, so the rule must
 * not flag it.
 *
 * Resolved by re-parsing the file and walking the ancestor chain of the write
 * line for an enclosing function whose source span contains `.batch(`. This is
 * precise (function-scoped, not file-scoped) and only runs for the rare files
 * whose write set already reached the multi-table threshold.
 */
function enclosingFunctionBatches(filePath: string, writeLine: number): boolean {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  let ast: AST | null = null;
  try {
    ast = parseFile(filePath, source);
  } catch {
    return false;
  }
  if (!ast) return false;

  const FUNCTION_NODE_TYPES = new Set([
    'function_declaration',
    'method_definition',
    'arrow_function',
    'function_expression',
    'generator_function_declaration',
    'generator_function_expression',
  ]);

  // Collect the enclosing function nodes (outermost first) that span the write
  // line. Checking any ancestor handles the accumulate-in-an-inner-callback /
  // commit-in-the-outer-function shape.
  const chain: ASTNode[] = [];
  const walk = (node: ASTNode): void => {
    const loc = node.location;
    if (loc && loc.start.line <= writeLine && writeLine <= loc.end.line) {
      if (FUNCTION_NODE_TYPES.has(node.type)) chain.push(node);
      for (const child of node.children ?? []) walk(child);
    }
  };
  walk(ast.root);
  ast.dispose?.();

  for (const fn of chain) {
    const range = fn.range;
    if (!range) continue;
    if (source.slice(range[0], range[1]).includes('.batch(')) return true;
  }
  return false;
}

/**
 * Flag functions whose depth-1-expanded write set reaches txnTableMax.
 * When graph_cache is unpopulated, expandWrittenTables degrades gracefully
 * to reporting direct writes only.
 */
function flagTransactionBoundaryWrites(
  funcWrites: Map<string, FuncWriteEntry>,
  graph: CallGraphData,
  txnTableMax: number,
): Violation[] {
  const violations: Violation[] = [];

  for (const [key, funcData] of funcWrites) {
    const allTables = expandWrittenTables(key, funcData.tables, graph);

    if (allTables.size >= txnTableMax) {
      // A single `.batch()` commit is the transaction scope — no risk to flag.
      if (enclosingFunctionBatches(funcData.filePath, funcData.line)) continue;

      const tableList = [...allTables].sort().join(', ');
      violations.push({
        file: funcData.filePath,
        line: funcData.line,
        column: 0,
        severity: 'high',
        message: `Function writes to ${allTables.size} distinct tables (threshold: ${txnTableMax}): ${tableList}. This may indicate transaction-boundary risk — consider splitting writes across smaller transactional scopes.`,
        rule: 'cross-domain/multi-table-write',
        analyzer: ANALYZER_NAME,
        symbol: key.split('::')[1],
      });
    }
  }

  return violations;
}

/**
 * Load the call-graph infrastructure in three reads, reused by every detector
 * that walks the graph. Previously each BFS node re-queried `graph_cache`, and
 * depth-1 callee expansion re-queried `functions` + `schema_usage` per callee —
 * an N+1 on full audits. One read each of the edge list, the function identity,
 * and the per-function write tables collapses that to a constant number of
 * queries. Any failure (or an empty graph) returns the empty structure and each
 * consumer degrades to its no-graph path.
 */
function loadCallGraphData(indexHandle: IndexHandle): CallGraphData {
  const empty: CallGraphData = {
    hasGraphData: false,
    fnIdLookup: new Map(),
    fnInfo: new Map(),
    callEdges: new Map(),
    fnWriteTables: new Map(),
  };

  let edgeRows: Array<{ node_key: string; neighbor_key: string }>;
  try {
    edgeRows = indexHandle.query(
      "SELECT node_key, neighbor_key FROM graph_cache WHERE graph_type = 'call'",
    ) as Array<{ node_key: string; neighbor_key: string }>;
  } catch {
    return empty;
  }
  if (edgeRows.length === 0) return empty;

  const callEdges = new Map<number, number[]>();
  for (const e of edgeRows) {
    const src = parseInt(e.node_key, 10);
    const dst = parseInt(e.neighbor_key, 10);
    if (isNaN(src) || isNaN(dst)) continue;
    const list = callEdges.get(src);
    if (list) list.push(dst);
    else callEdges.set(src, [dst]);
  }

  let fnRows: Array<{ id: number; name: string; file_path: string }>;
  try {
    fnRows = indexHandle.query('SELECT id, name, file_path FROM functions',) as Array<{ id: number; name: string; file_path: string }>;
  } catch {
    fnRows = [];
  }

  const fnIdLookup = new Map<string, number>();
  const fnInfo = new Map<number, { name: string; file_path: string }>();
  for (const r of fnRows) {
    fnIdLookup.set(`${r.file_path}::${r.name}`, r.id);
    fnInfo.set(r.id, { name: r.name, file_path: r.file_path });
  }

  let writeRows: Array<{ file_path: string; function_name: string | null; table_name: string }>;
  try {
    writeRows = indexHandle.query(
      `SELECT DISTINCT file_path, function_name, table_name FROM schema_usage
       WHERE usage_type IN ('insert', 'update', 'delete', 'create')`,
    ) as Array<{ file_path: string; function_name: string | null; table_name: string }>;
  } catch {
    writeRows = [];
  }

  const fnWriteTables = new Map<string, Set<string>>();
  for (const w of writeRows) {
    if (w.function_name == null) continue;
    const key = funcTableKey(w.file_path, w.function_name);
    const set = fnWriteTables.get(key);
    if (set) set.add(w.table_name);
    else fnWriteTables.set(key, new Set([w.table_name]));
  }

  return { hasGraphData: true, fnIdLookup, fnInfo, callEdges, fnWriteTables };
}

// ── R3: Validation-Bypass ────────────────────────────────────────────────

/**
 * Detect write functions that don't reach a validator, when a majority of
 * peer writers in the same directory do (BFS ≤ configurable depth).
 *
 * Validator identification (priority order):
 *   1. User-configured validators list
 *   2. Provenanced: exported functions in files importing VALIDATOR_PACKAGES
 *   3. Heuristic fallback: name GLOB 'validate*' OR 'assert*' (when both
 *      above are silent)
 */
function detectValidationBypass(
  indexHandle: IndexHandle,
  config: ValidatorBypassConfig,
  scope: FileScope,
  graph: CallGraphData,
): Violation[] {
  const violations: Violation[] = [];
  const {
    validators: userValidators = [],
    modeShare = 0.8,
    minCorpus = 20,
    depth = 3,
  } = config;

  const validatorIds = buildValidatorIds(indexHandle, userValidators);
  if (validatorIds.size === 0) return violations;

  const fp = scope.apply('su.file_path');

  const writers = indexHandle
    .query(`SELECT DISTINCT su.function_name, su.file_path, su.line, f.id as function_id
       FROM schema_usage su
       JOIN functions f ON f.name = su.function_name
                        AND f.file_path = su.file_path
       WHERE su.usage_type IN ('insert', 'update', 'delete', 'create')
       ${fp.clause}
       ORDER BY su.file_path, su.function_name`, fp.params) as WriterRow[];

  if (writers.length === 0) return violations;

  const writerCoverage = computeWriterCoverage(writers, validatorIds, graph.callEdges, depth);
  violations.push(...flagUncoveredWriters(writers, writerCoverage, { minCorpus, modeShare, depth }));

  return violations;
}

/** BFS from each writer to check validator reach, deduplicated by key. */
function computeWriterCoverage(
  writers: WriterRow[],
  validatorIds: Set<number>,
  callEdges: Map<number, number[]>,
  depth: number,
): Map<string, WriterCoverage> {
  const writerCoverage = new Map<string, WriterCoverage>();

  for (const w of writers) {
    const key = funcTableKey(w.file_path, w.function_name);
    if (writerCoverage.has(key)) continue; // deduplicate
    const covered = bfsReachesValidator(callEdges, w.function_id, validatorIds, depth);
    writerCoverage.set(key, {
      covered,
      line: w.line,
      funcName: w.function_name,
    });
  }

  return writerCoverage;
}

/**
 * Build the validator function ID set in priority order: user-configured
 * validators, then provenanced validators (exported functions whose own
 * used_imports includes a validator package), then a name-based heuristic
 * fallback only when both prior sources are silent.
 */
function buildValidatorIds(indexHandle: IndexHandle, userValidators: string[]): Set<number> {
  const validatorIds = new Set<number>();

  // 1a. User-configured validators (format: "funcName" or "path#funcName").
  //     Batched into chunked `IN`/composite-OR reads instead of one query per
  //     entry (the per-validator query was an N+1 on the small user list).
  const plainNames: string[] = [];
  const namePathPairs: Array<[string, string]> = [];
  for (const v of userValidators) {
    const hashIdx = v.indexOf('#');
    if (hashIdx >= 0) {
      namePathPairs.push([v.substring(hashIdx + 1), v.substring(0, hashIdx)]);
    } else {
      plainNames.push(v);
    }
  }

  for (let i = 0; i < plainNames.length; i += SQLITE_MAX_VARIABLES) {
    const chunk = plainNames.slice(i, i + SQLITE_MAX_VARIABLES);
    const rows = indexHandle.query(
      `SELECT id FROM functions WHERE name IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    ) as Array<{ id: number }>;
    for (const r of rows) validatorIds.add(r.id);
  }

  for (let i = 0; i < namePathPairs.length; i += Math.floor(SQLITE_MAX_VARIABLES / 2)) {
    const chunk = namePathPairs.slice(i, i + Math.floor(SQLITE_MAX_VARIABLES / 2));
    const rows = indexHandle.query(
      `SELECT id FROM functions WHERE ${chunk.map(() => '(name = ? AND file_path = ?)').join(' OR ')}`,
      chunk.flatMap(([n, p]) => [n, p]),
    ) as Array<{ id: number }>;
    for (const r of rows) validatorIds.add(r.id);
  }

  // 1b. Provenanced validators: exported functions whose OWN used_imports
  //     includes a validator package. Per-identifier check — a function in
  //     a zod-importing file only qualifies if its own body uses the
  //     validator package, not just because it cohabits the file.
  if (validatorIds.size === 0) {
    const likeClauses = [...VALIDATOR_PACKAGES].map(() => 'used_imports LIKE ?');
    const likeParams = [...VALIDATOR_PACKAGES].map((pkg) => `%"${pkg}"%`);

    const validatorFuncs = indexHandle
      .query(`SELECT id FROM functions
         WHERE used_imports IS NOT NULL
           AND (${likeClauses.join(' OR ')})
           AND is_exported = 1`, likeParams) as Array<{ id: number }>;
    for (const f of validatorFuncs) validatorIds.add(f.id);
  }

  // 1c. Heuristic fallback: name-based matching (only when provenance
  //     found nothing AND no user-configured validators exist).
  if (validatorIds.size === 0 && userValidators.length === 0) {
    const heuristicFuncs = indexHandle
      .query(`SELECT id FROM functions
         WHERE (name GLOB 'validate*' OR name GLOB 'assert*')
           AND is_exported = 1`,) as Array<{ id: number }>;
    for (const f of heuristicFuncs) validatorIds.add(f.id);
  }

  return validatorIds;
}

/**
 * Group writers by directory, then flag uncovered writers only in
 * directories where a mode-share of peers reach a validator.
 */
function flagUncoveredWriters(
  writers: WriterRow[],
  writerCoverage: Map<string, WriterCoverage>,
  opts: { minCorpus: number; modeShare: number; depth: number },
): Violation[] {
  const { minCorpus, modeShare, depth } = opts;
  const dirWriters = groupWritersByDirectory(writers, writerCoverage);
  return flagUnvalidatedWriters(dirWriters, minCorpus, modeShare, depth);
}

/** Group writers by directory, deduplicating multi-row schema_usage entries. */
function groupWritersByDirectory(
  writers: WriterRow[],
  writerCoverage: Map<string, WriterCoverage>,
): Map<string, DirWriter[]> {
  const dirWriters = new Map<string, DirWriter[]>();
  const dirSeen = new Set<string>();

  for (const w of writers) {
    const dir = path.dirname(w.file_path);
    const key = funcTableKey(w.file_path, w.function_name);
    const dirKey = `${dir}::${key}`;
    if (dirSeen.has(dirKey)) continue;
    dirSeen.add(dirKey);

    const cov = writerCoverage.get(key);
    if (!cov) continue;
    if (!dirWriters.has(dir)) dirWriters.set(dir, []);
    dirWriters.get(dir)!.push({
      key,
      covered: cov.covered,
      line: cov.line,
      funcName: cov.funcName,
      filePath: w.file_path,
    });
  }

  return dirWriters;
}

/** Flag uncovered writers in validator-dense directories. */
function flagUnvalidatedWriters(
  dirWriters: Map<string, DirWriter[]>,
  minCorpus: number,
  modeShare: number,
  depth: number,
): Violation[] {
  const violations: Violation[] = [];

  for (const [dir, dirWriterList] of dirWriters) {
    if (dirWriterList.length < minCorpus) continue;

    const coveredCount = dirWriterList.filter((w) => w.covered).length;
    const ratio = coveredCount / dirWriterList.length;

    if (ratio >= modeShare) {
      for (const w of dirWriterList) {
        if (w.covered) continue;
        violations.push({
          file: w.filePath,
          line: w.line,
          column: 0,
          severity: 'severe',
          message:
            `Function '${w.funcName}' does not reach a validator within BFS depth ≤ ${depth}. ` +
            `${coveredCount}/${dirWriterList.length} peer writers in '${dir}' do. ` +
            `Consider adding input validation.`,
          rule: 'cross-domain/no-validator-reachable',
          analyzer: ANALYZER_NAME,
          symbol: w.funcName,
        });
      }
    }
  }

  return violations;
}

// ── R4: Coverage by Importance ──────────────────────────────────────────

/**
 * Detect exported, high-risk functions with no test coverage.
 * Uses the getUntestedTopDecile() query that joins functions with
 * hotspot_scores and coverage_data to find untested high-risk functions.
 *
 * Static-reach fallback: when no measured coverage exists, falls back
 * to static reach analysis from test files (BFS from test-file functions
 * into the call graph).
 */
function detectUncoveredRisk(
  indexHandle: IndexHandle,
  coverage: CoverageConfig,
  scope: FileScope,
  graph: CallGraphData,
): Violation[] {
  const topRiskDecile = coverage.topRiskDecile ?? 0.1;

  // Check if any measured coverage exists
  const measuredCount = (
    indexHandle
      .query("SELECT COUNT(*) AS cnt FROM coverage_data WHERE basis = 'measured'")[0] as { cnt: number }
  ).cnt;

  if (measuredCount > 0) {
    return detectMeasuredUncovered(indexHandle, topRiskDecile);
  }
  return detectStaticReachUncovered(indexHandle, coverage, scope, graph);
}

/**
 * Flag exported high-risk functions with no measured test coverage, using
 * lcov/istanbul-imported data with stale-import detection.
 */
function detectMeasuredUncovered(indexHandle: IndexHandle, topRiskDecile: number): Violation[] {
  const violations: Violation[] = [];

  const untested = indexHandle.getUntestedTopDecile(topRiskDecile) as Array<{
    functionName: string; filePath: string; lineNumber: number | null;
    riskScore: number; basis: string;
  }>;

  // Determine source format from existing coverage entries
  const sourceRow = indexHandle
    .query("SELECT source, imported_at FROM coverage_data WHERE basis = 'measured' LIMIT 1",)[0] as { source: string | null; imported_at: string | null } | undefined;
  const sourceFormat = sourceRow?.source ?? 'unknown';
  const importedAt = sourceRow?.imported_at ?? null;

  // Stale-import detection: measured coverage predates last full index sync
  let staleWarning: string | null = null;
  if (importedAt) {
    const lastSync = indexHandle.getMeta?.('last_full_sync_timestamp') ?? null;
    if (lastSync && importedAt < lastSync) {
      staleWarning =
        ` — WARNING: this coverage data may be stale (imported ${importedAt}, ` +
        `last index sync was ${lastSync}). ` +
        `Re-import with 'code-audit coverage --import <path>' for accurate results.`;
    }
  }

  for (const fn of untested) {
    violations.push({
      file: fn.filePath,
      line: fn.lineNumber ?? 1,
      column: 0,
      severity: 'high',
      message:
        `Exported function '${fn.functionName}' (risk ${fn.riskScore.toFixed(3)}) has no measured test coverage. ` +
        `Top imported functions should have test coverage. Import coverage data with 'code-audit coverage --import <path>'.` +
        (staleWarning ?? ''),
      rule: 'cross-domain/uncovered-risk',
      analyzer: ANALYZER_NAME,
      symbol: fn.functionName,
      basis: fn.basis,
      sourceFormat,
      ...(staleWarning ? { staleImport: true } : {}),
    });
  }

  return violations;
}

/**
 * Static-reach fallback: flag exported high-risk functions that are not
 * reachable from known test files via BFS through the call graph.
 */
function detectStaticReachUncovered(
  indexHandle: IndexHandle,
  coverage: CoverageConfig,
  scope: FileScope,
  graph: CallGraphData,
): Violation[] {
  const topRiskDecile = coverage.topRiskDecile ?? 0.1;
  const highRiskFns = queryHighRiskFunctions(indexHandle, topRiskDecile, scope);

  if (highRiskFns.length === 0) return [];

  const reachableIds = computeTestReachableIds(indexHandle, coverage, graph.callEdges);
  return flagUnreachedHighRisk(highRiskFns, reachableIds);
}

/** Rank exported functions by hotspot score and take the top decile. */
function queryHighRiskFunctions(
  indexHandle: IndexHandle,
  topRiskDecile: number,
  scope: FileScope,
): HighRiskFn[] {
  const fp = scope.apply('f.file_path');

  // Param order matters: the CTE's `f.file_path` scope binds first (it appears
  // first in the SQL text), then the outer `pct <= ?` binds topRiskDecile.
  return indexHandle.query(
      `WITH ranked AS (
        SELECT
          f.name,
          f.file_path,
          f.line_number,
          f.id,
          COALESCE(hs.score, 0.0) as risk_score,
          PERCENT_RANK() OVER (ORDER BY COALESCE(hs.score, 0.0) DESC) as pct
        FROM functions f
        LEFT JOIN hotspot_scores hs ON hs.target = (f.file_path || ':' || f.name)
          AND hs.type = 'function'
        WHERE f.is_exported = 1
          ${fp.clause}
      )
      SELECT id, name, file_path, line_number, risk_score
      FROM ranked
      WHERE pct <= ?
      ORDER BY risk_score DESC`, [...fp.params, topRiskDecile]) as HighRiskFn[];
}

/** Flag high-risk functions not in the reachable set. */
function flagUnreachedHighRisk(highRiskFns: HighRiskFn[], reachableIds: Set<number>): Violation[] {
  const violations: Violation[] = [];

  for (const fn of highRiskFns) {
    if (reachableIds.has(fn.id)) continue;
    violations.push({
      file: fn.file_path,
      line: fn.line_number,
      column: 0,
      severity: 'high',
      message:
        `Exported function '${fn.name}' (risk ${fn.risk_score.toFixed(3)}) is not reachable from known test files. ` +
        `Add test coverage or import measured coverage with 'code-audit coverage --import <path>'.`,
      rule: 'cross-domain/uncovered-risk',
      analyzer: ANALYZER_NAME,
      symbol: fn.name,
      basis: 'static-reach',
    });
  }

  return violations;
}

/**
 * Compute the set of function IDs reachable from test-file functions via
 * BFS through the call graph (reverse direction: test → code under test).
 */
function computeTestReachableIds(
  indexHandle: IndexHandle,
  coverage: CoverageConfig,
  callEdges: Map<number, number[]>,
): Set<number> {
  const testFuncIds = collectTestFuncIds(indexHandle, coverage);
  if (testFuncIds.size === 0) return new Set<number>();

  const maxDepth = coverage.staticReachDepth ?? 2;
  return collectReachableIds(callEdges, testFuncIds, maxDepth);
}

/** Find test-file function IDs to use as BFS starting points. */
function collectTestFuncIds(indexHandle: IndexHandle, coverage: CoverageConfig): Set<number> {
  const testGlobs = coverage.testGlobs ?? ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'];
  const testGlobPatterns = testGlobs.map((g: string) =>
    g.replace(/\*\*/g, '%').replace(/\*/g, '%'),
  );

  if (testGlobPatterns.length === 0) return new Set<number>();

  const testFileClause = testGlobPatterns
    .map(() => `file_path LIKE ?`)
    .join(' OR ');
  const testFileParams = [...testGlobPatterns];

  const testFuncIds = new Set<number>();
  const testFunctions = indexHandle
    .query(`SELECT id FROM functions WHERE ${testFileClause}`, testFileParams) as Array<{ id: number }>;
  for (const tf of testFunctions) testFuncIds.add(tf.id);

  return testFuncIds;
}
