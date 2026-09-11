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
 * All findings enter at suggestion severity per the entry rule.
 * Higher tiers require Spec 11 R5 recalibration bars (precision ≥ 0.95
 * AND judged-true ≥ 0.90) on real-corpus evidence.
 */

import * as path from 'node:path';

import type { AnalyzerResult, Violation, ValidatorBypassConfig, CoverageConfig } from '../../types.js';
import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { IndexHandle } from '../../types.js';
import { VALIDATOR_PACKAGES } from '../provenance.js';
import { makeVisitorStatus } from '../../pipeline.js';

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface SchemaUsageRow {
  table_name: string;
  file_path: string;
  function_name: string;
  line: number;
  usage_type: string;
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

/** Call-graph infrastructure availability for depth-1 callee expansion. */
interface CallGraphContext {
  hasGraphData: boolean;
  fnIdLookup: Map<string, number> | null;
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
 * Advance a call-graph BFS frontier by one node: query `funcId`'s call
 * neighbors and enqueue any not yet visited. Shared by the two BFS walks.
 */
function enqueueCallNeighbors(
  indexHandle: IndexHandle,
  nextLevel: number[],
  funcId: number,
  visited: Set<number>,
): void {
  const callees = indexHandle
    .query(`SELECT neighbor_key FROM graph_cache
       WHERE graph_type = 'call' AND node_key = ?`, [String(funcId)]) as Array<{ neighbor_key: string }>;
  for (const callee of callees) {
    const calleeId = parseInt(callee.neighbor_key, 10);
    if (!isNaN(calleeId) && !visited.has(calleeId)) {
      nextLevel.push(calleeId);
    }
  }
}

/**
 * BFS through the call graph (graph_cache) up to maxDepth to check if
 * any path from startFuncId reaches a validator function ID.
 */
function bfsReachesValidator(
  indexHandle: IndexHandle,
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

      // Get callees from graph_cache call edges
      enqueueCallNeighbors(indexHandle, nextLevel, funcId, visited);
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
  indexHandle: IndexHandle,
  key: string,
  initialTables: Set<string>,
  graph: CallGraphContext,
): Set<string> {
  const allTables = new Set(initialTables);
  const { fnIdLookup, hasGraphData } = graph;

  if (!fnIdLookup || !hasGraphData) return allTables;

  const funcId = fnIdLookup.get(key);
  if (funcId === undefined) return allTables;

  const calleeRows = indexHandle
    .query(`SELECT neighbor_key FROM graph_cache
       WHERE graph_type = 'call' AND node_key = ?`, [String(funcId)]) as Array<{ neighbor_key: string }>;

  for (const callee of calleeRows) {
    const calleeFuncs = indexHandle
      .query(`SELECT name, file_path FROM functions WHERE id = ?`, [parseInt(callee.neighbor_key, 10)]) as Array<{
      name: string;
      file_path: string;
    }>;

    for (const cf of calleeFuncs) {
      const calleeTables = indexHandle
        .query(`SELECT DISTINCT table_name FROM schema_usage
           WHERE usage_type IN ('insert', 'update', 'delete', 'create')
             AND function_name = ? AND file_path = ?`, [cf.name, cf.file_path]) as Array<{ table_name: string }>;

      for (const ct of calleeTables) {
        allTables.add(ct.table_name);
      }
    }
  }

  return allTables;
}

/**
 * BFS outward from test-file function IDs through the call graph (graph_cache)
 * up to maxDepth, collecting every function ID reached. Used for the
 * static-reach fallback: a high-risk function not in this set is uncovered.
 */
function collectReachableIds(
  indexHandle: IndexHandle,
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

        enqueueCallNeighbors(indexHandle, nextLevel, funcId, visited);
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
      violations.push(...detectTransactionBoundaryRisk(indexHandle, txnTableMax, scope));
    }

    // R3 — Validation-bypass detection
    const bypass = config.validatorBypass as ValidatorBypassConfig | undefined;
    if (bypass) {
      violations.push(...detectValidationBypass(indexHandle, bypass, scope));
    }

    // R4 — Coverage by importance
    const coverage = config.coverage as CoverageConfig | undefined;
    if (coverage) {
      violations.push(...detectUncoveredRisk(indexHandle, coverage, scope));
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
 * Detect tables that are written to (INSERT/UPDATE/DELETE/CREATE) but
 * never read from (SELECT). These might be dead writes or missed read paths.
 */
function detectWrittenNeverRead(indexHandle: IndexHandle, scope: FileScope): Violation[] {
  const violations: Violation[] = [];

  const fp = scope.apply('file_path');

  const rows = indexHandle
    .query(`SELECT DISTINCT table_name, file_path, function_name, line, usage_type
       FROM schema_usage
       WHERE usage_type IN ('insert', 'update', 'delete', 'create')
         ${fp.clause}
         AND table_name NOT IN (
           SELECT DISTINCT table_name FROM schema_usage WHERE usage_type = 'select' ${fp.clause}
         )
       ORDER BY table_name, file_path`, [...fp.params, ...fp.params]) as SchemaUsageRow[];

  // Deduplicate by table_name — one violation per table, anchored to
  // the first writing file encountered.
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.table_name)) continue;
    seen.add(row.table_name);

    violations.push({
      file: row.file_path,
      line: row.line,
      column: 0,
      severity: 'suggestion',
      message: `Table '${row.table_name}' is written (${row.usage_type}) but never read (SELECT). Consider removing unused writes or adding read paths.`,
      rule: 'cross-domain/written-never-read',
      analyzer: ANALYZER_NAME,
      functionName: row.function_name,
    });
  }

  return violations;
}

// ── R1: Read-Never-Written ──────────────────────────────────────────────

/**
 * Detect tables that are read from (SELECT) but never written to
 * (INSERT/UPDATE/DELETE/CREATE). These may be external/managed tables
 * or indicate missing write coverage.
 */
function detectReadNeverWritten(indexHandle: IndexHandle, scope: FileScope): Violation[] {
  const violations: Violation[] = [];

  const fp = scope.apply('file_path');

  const rows = indexHandle
    .query(`SELECT DISTINCT table_name, file_path, function_name, line, usage_type
       FROM schema_usage
       WHERE usage_type = 'select'
         ${fp.clause}
         AND table_name NOT IN (
           SELECT DISTINCT table_name FROM schema_usage
           WHERE usage_type IN ('insert', 'update', 'delete', 'create') ${fp.clause}
         )
       ORDER BY table_name, file_path`, [...fp.params, ...fp.params]) as SchemaUsageRow[];

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.table_name)) continue;
    seen.add(row.table_name);

    violations.push({
      file: row.file_path,
      line: row.line,
      column: 0,
      severity: 'suggestion',
      message: `Table '${row.table_name}' is read (SELECT) but never written (INSERT/UPDATE/DELETE). This may be an external/managed table, or indicate missing write coverage.`,
      rule: 'cross-domain/read-never-written',
      analyzer: ANALYZER_NAME,
      functionName: row.function_name,
    });
  }

  return violations;
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
): Violation[] {
  const fp = scope.apply('su.file_path');

  // Query schema_usage directly (no JOIN on functions) so this detector
  // works whether or not deepSync has populated the functions table.
  const writerRows = indexHandle
    .query(`SELECT su.function_name, su.file_path, su.table_name, MIN(su.line) as line
       FROM schema_usage su
       WHERE su.usage_type IN ('insert', 'update', 'delete', 'create')
       ${fp.clause}
       GROUP BY su.function_name, su.file_path, su.table_name
       ORDER BY su.function_name, su.file_path`, fp.params) as Array<{
    function_name: string;
    file_path: string;
    table_name: string;
    line: number;
  }>;

  if (writerRows.length === 0) return [];

  const funcWrites = groupWriterTables(writerRows);
  const graph = resolveCallGraphContext(indexHandle);
  return flagTransactionBoundaryWrites(funcWrites, indexHandle, graph, txnTableMax);
}

/** Group written tables by (file_path, function_name) key. */
function groupWriterTables(
  writerRows: Array<{ function_name: string; file_path: string; table_name: string; line: number }>,
): Map<string, FuncWriteEntry> {
  const funcWrites = new Map<string, FuncWriteEntry>();
  for (const row of writerRows) {
    const key = `${row.file_path}::${row.function_name}`;
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
 * Flag functions whose depth-1-expanded write set reaches txnTableMax.
 * When graph_cache is unpopulated, expandWrittenTables degrades gracefully
 * to reporting direct writes only.
 */
function flagTransactionBoundaryWrites(
  funcWrites: Map<string, FuncWriteEntry>,
  indexHandle: IndexHandle,
  graph: CallGraphContext,
  txnTableMax: number,
): Violation[] {
  const violations: Violation[] = [];

  for (const [key, funcData] of funcWrites) {
    const allTables = expandWrittenTables(indexHandle, key, funcData.tables, graph);

    if (allTables.size >= txnTableMax) {
      const tableList = [...allTables].sort().join(', ');
      violations.push({
        file: funcData.filePath,
        line: funcData.line,
        column: 0,
        severity: 'suggestion',
        message: `Function writes to ${allTables.size} distinct tables (threshold: ${txnTableMax}): ${tableList}. This may indicate transaction-boundary risk — consider splitting writes across smaller transactional scopes.`,
        rule: 'cross-domain/multi-table-write',
        analyzer: ANALYZER_NAME,
        functionName: key.split('::')[1],
      });
    }
  }

  return violations;
}

/**
 * Resolve the call-graph infrastructure available for callee expansion:
 * whether graph_cache has any 'call' edges, and a function key → id lookup
 * built from the functions table (populated only by deepSync). Any failure
 * degrades gracefully to direct-write-only detection.
 */
function resolveCallGraphContext(indexHandle: IndexHandle): CallGraphContext {
  let hasGraphData = false;
  try {
    const row = indexHandle.query("SELECT COUNT(*) AS n FROM graph_cache WHERE graph_type = 'call'",
    ) as Array<{ n: number }>;
    const cnt = row[0] as { n: number } | undefined;
    hasGraphData = (cnt?.n ?? 0) > 0;
  } catch {
    hasGraphData = false;
  }

  let fnIdLookup: Map<string, number> | null = null;
  if (hasGraphData) {
    try {
      const fnRows = indexHandle.query('SELECT id, name, file_path FROM functions',) as Array<{ id: number; name: string; file_path: string }>;
      if (fnRows.length > 0) {
        fnIdLookup = new Map();
        for (const r of fnRows) {
          fnIdLookup.set(`${r.file_path}::${r.name}`, r.id);
        }
      }
    } catch {
      // functions table might not exist or be unpopulated
    }
  }

  return { hasGraphData, fnIdLookup };
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

  const writerCoverage = computeWriterCoverage(writers, validatorIds, indexHandle, depth);
  violations.push(...flagUncoveredWriters(writers, writerCoverage, { minCorpus, modeShare, depth }));

  return violations;
}

/** BFS from each writer to check validator reach, deduplicated by key. */
function computeWriterCoverage(
  writers: WriterRow[],
  validatorIds: Set<number>,
  indexHandle: IndexHandle,
  depth: number,
): Map<string, WriterCoverage> {
  const writerCoverage = new Map<string, WriterCoverage>();

  for (const w of writers) {
    const key = `${w.file_path}::${w.function_name}`;
    if (writerCoverage.has(key)) continue; // deduplicate
    const covered = bfsReachesValidator(indexHandle, w.function_id, validatorIds, depth);
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

  // 1a. User-configured validators (format: "funcName" or "path#funcName")
  for (const v of userValidators) {
    const hashIdx = v.indexOf('#');
    if (hashIdx >= 0) {
      const vPath = v.substring(0, hashIdx);
      const vName = v.substring(hashIdx + 1);
      const rows = indexHandle
        .query('SELECT id FROM functions WHERE name = ? AND file_path = ?', [vName, vPath]) as Array<{ id: number }>;
      for (const r of rows) validatorIds.add(r.id);
    } else {
      const rows = indexHandle
        .query('SELECT id FROM functions WHERE name = ?', [v]) as Array<{ id: number }>;
      for (const r of rows) validatorIds.add(r.id);
    }
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
    const key = `${w.file_path}::${w.function_name}`;
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
          severity: 'suggestion',
          message:
            `Function '${w.funcName}' does not reach a validator within BFS depth ≤ ${depth}. ` +
            `${coveredCount}/${dirWriterList.length} peer writers in '${dir}' do. ` +
            `Consider adding input validation.`,
          rule: 'cross-domain/no-validator-reachable',
          analyzer: ANALYZER_NAME,
          functionName: w.funcName,
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
  return detectStaticReachUncovered(indexHandle, coverage, scope);
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
      severity: 'suggestion',
      message:
        `Exported function '${fn.functionName}' (risk ${fn.riskScore.toFixed(3)}) has no measured test coverage. ` +
        `Top imported functions should have test coverage. Import coverage data with 'code-audit coverage --import <path>'.` +
        (staleWarning ?? ''),
      rule: 'cross-domain/uncovered-risk',
      analyzer: ANALYZER_NAME,
      functionName: fn.functionName,
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
): Violation[] {
  const topRiskDecile = coverage.topRiskDecile ?? 0.1;
  const highRiskFns = queryHighRiskFunctions(indexHandle, topRiskDecile, scope);

  if (highRiskFns.length === 0) return [];

  const reachableIds = computeTestReachableIds(indexHandle, coverage);
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
      severity: 'suggestion',
      message:
        `Exported function '${fn.name}' (risk ${fn.risk_score.toFixed(3)}) is not reachable from known test files. ` +
        `Add test coverage or import measured coverage with 'code-audit coverage --import <path>'.`,
      rule: 'cross-domain/uncovered-risk',
      analyzer: ANALYZER_NAME,
      functionName: fn.name,
      basis: 'static-reach',
    });
  }

  return violations;
}

/**
 * Compute the set of function IDs reachable from test-file functions via
 * BFS through the call graph (reverse direction: test → code under test).
 */
function computeTestReachableIds(indexHandle: IndexHandle, coverage: CoverageConfig): Set<number> {
  const testFuncIds = collectTestFuncIds(indexHandle, coverage);
  if (testFuncIds.size === 0) return new Set<number>();

  const maxDepth = coverage.staticReachDepth ?? 2;
  return collectReachableIds(indexHandle, testFuncIds, maxDepth);
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
