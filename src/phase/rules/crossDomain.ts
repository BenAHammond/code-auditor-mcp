/**
 * Spec 68 §3.2 — the cross-domain lifecycle rules, migrated to `analyze(ctx)`.
 *
 * Two of the five `cross-domain` rules are a clean reduction over the
 * `schema-usage` fact: `written-never-read` and `read-never-written`. Both ask
 * "is this table used on one side of the read/write lifecycle but not the
 * other?" — a pure set-difference over the table names in the fact, with the
 * one-sided detector anchored to a single row per table. Their violation logic
 * is re-homed verbatim from `CrossDomainAnalyzer`'s `detectWrittenNeverRead` /
 * `detectReadNeverWritten` (and its `nonQueryBuilderTableFilter` /
 * `usageIdentityLabel` helpers), which were SQL-over-`schema_usage` queries with
 * no other input.
 *
 * The "query-builder" exclusion is the one subtlety: a table whose *every* row
 * carries `origin = 'query-builder'` is a fluent scratch/test table built and
 * consumed through the knex-style builder — not a one-sided lifecycle defect —
 * so both detectors skip it. The read/write *sets* themselves are computed
 * regardless of origin, which is what lets a query-builder read balance a
 * raw-SQL create (cp_test). The filter is therefore: a table participates only
 * if it has at least one non-query-builder row.
 *
 * The anchor line is the first row after sorting, which reproduces the legacy
 * SQL's `SELECT DISTINCT … ORDER BY table_name, file_path` exactly. SQLite sorts
 * a `DISTINCT` result by the ORDER BY columns first, then the remaining SELECT
 * columns in REVERSE order, so the full key is (table_name, file_path,
 * usage_type, line, function_start_column, function_start_line, function_name)
 * with NULLs first. That reverse-column tiebreak is load-bearing: the composite
 * data-access fixture writes `users` with INSERT/UPDATE/DELETE/INSERT/UPDATE,
 * and the DELETE (not the first INSERT) is the anchor.
 *
 * Also here: `multi-table-write` (transaction-boundary risk) — migrated on top
 * of two further facts, `call-graph` (the `functions` + `graph_cache` identity
 * projection, read from the index) and `batch-functions` (the per-file AST
 * projection of the legacy `.batch(` re-parse). Its `analyze(ctx)` reproduces
 * the legacy `detectTransactionBoundaryRisk` / `groupWriterTables` /
 * `expandWrittenTables` / `flagTransactionBoundaryWrites` verbatim over those
 * facts.
 *
 * Also here: `no-validator-reachable` (validation bypass) — migrated on top of
 * the `call-graph` fact (widened with the `functions` table's `used_imports` /
 * `is_exported` columns for validator provenance) plus `schema-usage`. Its
 * `analyze(ctx)` reproduces the legacy `detectValidationBypass` /
 * `buildValidatorIds` / `bfsReachesValidator` / `computeWriterCoverage` /
 * `groupWritersByDirectory` / `flagUnvalidatedWriters` verbatim over those
 * facts, reading the opt-in `validatorBypass` thresholds (validators, modeShare,
 * minCorpus, depth) from `ctx.thresholds`.
 *
 * Also here: `uncovered-risk` (coverage by importance) — migrated on top of the
 * widened `call-graph` (now carrying `lineNumber`), the `hotspot` fact, and the
 * `coverage` fact. Its `analyze(ctx)` reproduces the legacy `detectUncoveredRisk`
 * / `detectMeasuredUncovered` / `detectStaticReachUncovered` /
 * `queryHighRiskFunctions` / `getUntestedTopDecile` / `computeTestReachableIds`
 * verbatim over those facts, reading the opt-in `coverage` thresholds
 * (topRiskDecile, testGlobs, staticReachDepth) from `ctx.thresholds`. Both
 * `no-validator-reachable` and `uncovered-risk` gate on the opt-in config key
 * being present, exactly as the legacy `runDetectors` did (`if (bypass)` /
 * `if (coverage)`).
 */

import * as path from 'node:path';
import type { RuleDefinition, Finding, SchemaUsageFact, CallGraphFact, BatchFunctionFact, HotspotFact, CoverageFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import { VALIDATOR_PACKAGES } from '../../analyzers/provenance.js';

/** The shared declaration for the TS cross-domain rules in this slice. */
type CrossDomainNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['schema-usage'];
};

/** The declared inputs of `multi-table-write`: schema writes + call graph +
 *  batch-function spans. */
type MultiTableWriteNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['schema-usage', 'call-graph', 'batch-functions'];
};

/** The declared inputs of `no-validator-reachable`: schema writes + the
 *  (widened) call graph for validator provenance + BFS reach. */
type ValidatorReachNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['schema-usage', 'call-graph'];
};

/** The declared inputs of `uncovered-risk`: the (widened) call graph + hotspot
 *  scores + coverage data — the ranking and both coverage paths' inputs. */
type UncoveredRiskNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['call-graph', 'hotspot', 'coverage'];
};

const META = RULE_REGISTRY;

/** The write verbs a one-sided write lifecycle treats as "written". */
const WRITE_TYPES = new Set(['insert', 'update', 'delete', 'create']);

/**
 * The "data flows in" verbs a `written-never-read` table must have at least one
 * of to qualify. `create` (DDL) defines a schema rather than populating it — a
 * table that is only ever `CREATE TABLE`-ed is "defined but never populated",
 * not "written and never read". `delete` — especially the no-`WHERE` truncate
 * form (`DELETE FROM t`) that `unfiltered-query` already flags — clears data
 * rather than writing it in, so a `delete`-only table (a cache cleared between
 * runs, whose `insert`/`select` live in a file the extractor does not scan) is
 * not a dead write path either. `insert` and `update` are the unambiguous "data
 * flows in" verbs, so a table with at least one of them *is* a write path.
 *
 * Note this is a *qualification* gate, not the anchor set: the anchor still
 * sorts the full `WRITE_TYPES` set, so a `users` table written
 * INSERT/UPDATE/DELETE/INSERT/UPDATE still anchors on the `delete` (byte-order
 * `delete` < `insert`), preserving the legacy tiebreak. `read-never-written` is
 * deliberately *not* narrowed the same way: its `writeTables` still counts
 * `create` and `delete`, so a `create`+`select` table stays "written" and does
 * not flip to `read-never-written`.
 */
const DATA_WRITE_TYPES = new Set(['insert', 'update']);

/** FTS5 virtual tables (conventional `_fts` suffix) are read via `MATCH`, not a
 *  statically-visible `SELECT`, and their INSERTs are trigger maintenance. A
 *  "written never read" flag on one is almost always the dynamic-SQL read being
 *  invisible to the extractor, not a dead write path. */
function isFts5Table(name: string): boolean {
  return name.endsWith('_fts');
}

// ── Ordering (re-homes the SQL DISTINCT + ORDER BY tiebreak) ────────────────

/**
 * Compare two nullable strings with SQLite's BINARY collation semantics:
 * NULL sorts first, then byte order (JS `<`/`>` coincides for the ASCII
 * table/file/function names these rules see).
 */
function cmpNullableString(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two nullable numbers: NULL first, then numeric order. */
function cmpNullableNumber(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The full sort key of the legacy `SELECT DISTINCT … ORDER BY table_name,
 * file_path`: ORDER BY columns first, then the remaining SELECT columns in
 * reverse order — (table_name, file_path, usage_type, line,
 * function_start_column, function_start_line, function_name).
 */
function cmpUsage(a: SchemaUsageFact, b: SchemaUsageFact): number {
  return (
    cmpNullableString(a.tableName, b.tableName) ||
    cmpNullableString(a.filePath, b.filePath) ||
    cmpNullableString(a.usageType, b.usageType) ||
    cmpNullableNumber(a.line, b.line) ||
    cmpNullableNumber(a.functionStartColumn, b.functionStartColumn) ||
    cmpNullableNumber(a.functionStartLine, b.functionStartLine) ||
    cmpNullableString(a.functionName, b.functionName)
  );
}

// ── Identity label (re-homed from CrossDomainAnalyzer) ──────────────────────

/**
 * The display label for a usage row: the declaration name when present, else a
 * coordinate fallback (`fn:<line>:<column>`) for anonymous handlers, else
 * `top-level`. A top-level row carries its own coordinate (`functionName =
 * 'top-level'` + a non-null start line/column), so the coordinate — not the
 * `top-level` sentinel — is the label.
 */
function usageIdentityLabel(
  functionName: string | null,
  startLine: number | null | undefined,
  startColumn: number | null | undefined,
): string {
  if (startLine == null) return 'top-level';
  if (functionName === 'top-level') return `fn:${startLine}:${startColumn}`;
  return functionName ?? `fn:${startLine}:${startColumn}`;
}

// ── Detectors (re-homed from CrossDomainAnalyzer, SQL → fact-array) ─────────

/** The tables with at least one non-query-builder row. */
function nonQueryBuilderTables(usages: SchemaUsageFact[]): Set<string> {
  const tables = new Set<string>();
  for (const u of usages) {
    if (u.origin !== 'query-builder') tables.add(u.tableName);
  }
  return tables;
}

/** The tables referenced by at least one `select` usage (origin-agnostic). */
function selectTables(usages: SchemaUsageFact[]): Set<string> {
  const tables = new Set<string>();
  for (const u of usages) {
    if (u.usageType === 'select') tables.add(u.tableName);
  }
  return tables;
}

/** The tables referenced by at least one write usage (origin-agnostic). */
function writeTables(usages: SchemaUsageFact[]): Set<string> {
  const tables = new Set<string>();
  for (const u of usages) {
    if (WRITE_TYPES.has(u.usageType)) tables.add(u.tableName);
  }
  return tables;
}

/** The tables with at least one "data flows in" usage — an `insert` or `update`
 *  (origin-agnostic). A `written-never-read` flag requires one of these; a table
 *  whose only visible writes are `create` (DDL) or `delete` (truncate) is not a
 *  dead write path, because its `insert`/`select` live in a file the extractor
 *  does not scan (out-of-scope receiver) or a dynamic-SQL read. */
function dataWrittenTables(usages: SchemaUsageFact[]): Set<string> {
  const tables = new Set<string>();
  for (const u of usages) {
    if (DATA_WRITE_TYPES.has(u.usageType)) tables.add(u.tableName);
  }
  return tables;
}

/** Tables written (INSERT/UPDATE/DELETE) but never read (SELECT). */
function detectWrittenNeverRead(usages: SchemaUsageFact[]): Finding[] {
  const nonQb = nonQueryBuilderTables(usages);
  const selects = selectTables(usages);
  const dataWritten = dataWrittenTables(usages);

  const candidates = usages
    .filter(
      (u) =>
        WRITE_TYPES.has(u.usageType) &&
        nonQb.has(u.tableName) &&
        !selects.has(u.tableName) &&
        dataWritten.has(u.tableName) &&
        !isFts5Table(u.tableName),
    )
    .sort(cmpUsage);

  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const u of candidates) {
    if (seen.has(u.tableName)) continue;
    seen.add(u.tableName);
    out.push({
      ruleId: 'cross-domain/written-never-read',
      severity: 'high',
      message: `Table '${u.tableName}' is written (${u.usageType}) but never read (SELECT). Consider removing unused writes or adding read paths.`,
      file: u.filePath,
      line: u.line,
      column: 0,
      symbol: usageIdentityLabel(u.functionName, u.functionStartLine, u.functionStartColumn),
    });
  }
  return out;
}

/** Tables read (SELECT) but never written (INSERT/UPDATE/DELETE/CREATE). */
function detectReadNeverWritten(usages: SchemaUsageFact[]): Finding[] {
  const nonQb = nonQueryBuilderTables(usages);
  const writes = writeTables(usages);

  const candidates = usages
    .filter((u) => u.usageType === 'select' && nonQb.has(u.tableName) && !writes.has(u.tableName))
    .sort(cmpUsage);

  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const u of candidates) {
    if (seen.has(u.tableName)) continue;
    seen.add(u.tableName);
    out.push({
      ruleId: 'cross-domain/read-never-written',
      severity: 'severe',
      message: `Table '${u.tableName}' is read (SELECT) but never written (INSERT/UPDATE/DELETE). This may be an external/managed table, or indicate missing write coverage.`,
      file: u.filePath,
      line: u.line,
      column: 0,
      symbol: usageIdentityLabel(u.functionName, u.functionStartLine, u.functionStartColumn),
    });
  }
  return out;
}

// ── Multi-table-write (transaction-boundary risk) ───────────────────────────

/** One grouped write row — the MIN(line) of a (file, coordinate, table) group. */
interface WriterGroup {
  functionName: string | null;
  functionStartLine: number | null;
  functionStartColumn: number | null;
  filePath: string;
  tableName: string;
  line: number;
}

/** A function's direct write set, keyed by coordinate identity. */
interface FuncWriteEntry {
  filePath: string;
  line: number;
  tables: Set<string>;
}

/**
 * Sort key of the legacy `GROUP BY … ORDER BY file_path, function_start_line,
 * function_start_column`: the ORDER BY columns, then the remaining GROUP BY
 * column (`table_name`) as the tiebreak. NULLs first, matching SQLite's BINARY
 * collation. The `table_name` tiebreak is the one place SQLite's group ordering
 * is observable — a function writing to several tables at *different* lines
 * anchors to the first table's MIN(line).
 */
function cmpWriterGroup(a: WriterGroup, b: WriterGroup): number {
  return (
    cmpNullableString(a.filePath, b.filePath) ||
    cmpNullableNumber(a.functionStartLine, b.functionStartLine) ||
    cmpNullableNumber(a.functionStartColumn, b.functionStartColumn) ||
    cmpNullableString(a.tableName, b.tableName)
  );
}

/**
 * Re-homes the legacy SQL: group write usages by (file, coordinate, table),
 * taking MIN(line) per group, ordered by (file, coordinate, table).
 */
function groupWriteRows(usages: SchemaUsageFact[]): WriterGroup[] {
  const grouped = new Map<string, WriterGroup>();
  for (const u of usages) {
    if (!WRITE_TYPES.has(u.usageType)) continue;
    const gkey = JSON.stringify([u.filePath, u.functionStartLine ?? null, u.functionStartColumn ?? null, u.tableName]);
    const existing = grouped.get(gkey);
    if (existing) {
      if (u.line < existing.line) existing.line = u.line;
    } else {
      grouped.set(gkey, {
        functionName: u.functionName ?? null,
        functionStartLine: u.functionStartLine ?? null,
        functionStartColumn: u.functionStartColumn ?? null,
        filePath: u.filePath,
        tableName: u.tableName,
        line: u.line,
      });
    }
  }
  return [...grouped.values()].sort(cmpWriterGroup);
}

/** Group write rows by coordinate-identity key (the display name is the label). */
function groupWriterTables(rows: WriterGroup[]): Map<string, FuncWriteEntry> {
  const funcWrites = new Map<string, FuncWriteEntry>();
  for (const row of rows) {
    const label = usageIdentityLabel(row.functionName, row.functionStartLine, row.functionStartColumn);
    const key = `${row.filePath}::${label}`;
    const entry = funcWrites.get(key);
    if (entry) {
      entry.tables.add(row.tableName);
    } else {
      funcWrites.set(key, { filePath: row.filePath, line: row.line, tables: new Set([row.tableName]) });
    }
  }
  return funcWrites;
}

/**
 * Depth-1 callee expansion over the `call-graph` fact: the writer's callees
 * (graph_cache `call` edges) contribute their own direct write tables. Degrades
 * to the direct write set when the graph is absent or the key is not a known
 * function id — exactly the legacy `expandWrittenTables` graceful degradation.
 */
function expandWrittenTablesFact(
  key: string,
  initialTables: Set<string>,
  graph: CallGraphFact,
  usages: SchemaUsageFact[],
  fnIdLookup: Map<string, number> | null,
): Set<string> {
  const allTables = new Set(initialTables);
  if (!fnIdLookup) return allTables;
  const funcId = fnIdLookup.get(key);
  if (funcId === undefined) return allTables;

  for (const edge of graph.callEdges) {
    if (edge.fromId !== funcId) continue;
    for (const cf of graph.functions) {
      if (cf.id !== edge.toId) continue;
      for (const u of usages) {
        if (WRITE_TYPES.has(u.usageType) && u.functionName === cf.name && u.filePath === cf.filePath) {
          allTables.add(u.tableName);
        }
      }
    }
  }
  return allTables;
}

/**
 * Whether any `batch-functions` span (same file) encloses the write line. A
 * single `.batch(` commit is the transaction scope, so the multi-table shape
 * carries no boundary risk — the legacy `enclosingFunctionBatches` re-parse
 * re-homed as location containment over the fact.
 */
function enclosingFunctionBatchesFact(batches: BatchFunctionFact[], filePath: string, writeLine: number): boolean {
  for (const b of batches) {
    if (b.file === filePath && b.startLine <= writeLine && writeLine <= b.endLine) return true;
  }
  return false;
}

/** The `filePath::name` → id lookup, built from the call-graph fact's functions
 *  only when call edges exist (matching `resolveCallGraphContext`). */
function resolveCallGraphContext(graph: CallGraphFact): { fnIdLookup: Map<string, number> | null } {
  if (graph.callEdges.length === 0 || graph.functions.length === 0) return { fnIdLookup: null };
  const fnIdLookup = new Map<string, number>();
  for (const f of graph.functions) fnIdLookup.set(`${f.filePath}::${f.name}`, f.id);
  return { fnIdLookup };
}

/** Flag functions whose depth-1-expanded write set reaches txnTableMax. */
function flagTransactionBoundaryWrites(
  funcWrites: Map<string, FuncWriteEntry>,
  usages: SchemaUsageFact[],
  graph: CallGraphFact,
  fnIdLookup: Map<string, number> | null,
  batches: BatchFunctionFact[],
  txnTableMax: number,
): Finding[] {
  const findings: Finding[] = [];
  for (const [key, funcData] of funcWrites) {
    const allTables = expandWrittenTablesFact(key, funcData.tables, graph, usages, fnIdLookup);
    if (allTables.size < txnTableMax) continue;
    if (enclosingFunctionBatchesFact(batches, funcData.filePath, funcData.line)) continue;

    const tableList = [...allTables].sort().join(', ');
    findings.push({
      ruleId: 'cross-domain/multi-table-write',
      severity: 'high',
      message: `Function writes to ${allTables.size} distinct tables (threshold: ${txnTableMax}): ${tableList}. This may indicate transaction-boundary risk — consider splitting writes across smaller transactional scopes.`,
      file: funcData.filePath,
      line: funcData.line,
      column: 0,
      symbol: key.split('::')[1],
    });
  }
  return findings;
}

/** The fact-based detector: group writes, expand depth-1 callees, skip batches. */
function detectTransactionBoundaryRisk(
  usages: SchemaUsageFact[],
  graph: CallGraphFact,
  batches: BatchFunctionFact[],
  txnTableMax: number,
): Finding[] {
  const writerRows = groupWriteRows(usages);
  if (writerRows.length === 0) return [];
  const funcWrites = groupWriterTables(writerRows);
  const { fnIdLookup } = resolveCallGraphContext(graph);
  return flagTransactionBoundaryWrites(funcWrites, usages, graph, fnIdLookup, batches, txnTableMax);
}

// ── No-validator-reachable (validation bypass) ──────────────────────────────

/** One writer row — the schema_usage ⋈ functions join the legacy SQL built. */
interface WriterRow {
  function_name: string;
  file_path: string;
  line: number;
  function_id: number;
}

/** A writer bucketed into a directory group, with its reach verdict. */
interface DirWriter {
  key: string;
  covered: boolean;
  line: number;
  funcName: string;
  filePath: string;
}

/**
 * Re-home the legacy writer query: the schema_usage write rows INNER-JOINed to
 * `functions` on (name, file_path) — a write whose function has no index row is
 * dropped by the join — then DISTINCT on (name, file, line) and ORDER BY
 * (file_path, function_name). The `function_id` resolves through the call-graph
 * fact's `functions` catalog.
 */
function collectWriters(usages: SchemaUsageFact[], graph: CallGraphFact): WriterRow[] {
  const fnIdByNamePath = new Map<string, number>();
  for (const f of graph.functions) {
    const k = `${f.filePath}::${f.name}`;
    if (!fnIdByNamePath.has(k)) fnIdByNamePath.set(k, f.id);
  }
  const seen = new Set<string>();
  const writers: WriterRow[] = [];
  for (const u of usages) {
    if (!WRITE_TYPES.has(u.usageType)) continue;
    if (u.functionName == null) continue;
    const fnId = fnIdByNamePath.get(`${u.filePath}::${u.functionName}`);
    if (fnId === undefined) continue; // inner JOIN drops rows with no function row
    const dkey = `${u.functionName}::${u.filePath}::${u.line}`;
    if (seen.has(dkey)) continue;
    seen.add(dkey);
    writers.push({ function_name: u.functionName, file_path: u.filePath, line: u.line, function_id: fnId });
  }
  writers.sort(
    (a, b) => cmpNullableString(a.file_path, b.file_path) || cmpNullableString(a.function_name, b.function_name),
  );
  return writers;
}

/**
 * Build the validator function-ID set in priority order (re-homed from
 * `buildValidatorIds`): user-configured validators, then provenanced validators
 * (exported functions whose own `used_imports` JSON includes a validator
 * package), then a name-based heuristic fallback only when both prior sources
 * are silent. The provenance LIKE test runs over the raw `used_imports` JSON
 * string — `used_imports LIKE '%"zod"%'` — so the widened call-graph fact
 * carries it verbatim rather than re-parsed.
 */
function buildValidatorIdsFact(graph: CallGraphFact, userValidators: string[]): Set<number> {
  const validatorIds = new Set<number>();
  const byName = new Map<string, number[]>();
  const byPathName = new Map<string, number[]>();
  for (const f of graph.functions) {
    const names = byName.get(f.name);
    if (names) names.push(f.id);
    else byName.set(f.name, [f.id]);
    const k = `${f.filePath}#${f.name}`;
    const pathNames = byPathName.get(k);
    if (pathNames) pathNames.push(f.id);
    else byPathName.set(k, [f.id]);
  }

  // 1a. User-configured validators (format: "funcName" or "path#funcName").
  for (const v of userValidators) {
    const hashIdx = v.indexOf('#');
    if (hashIdx >= 0) {
      const vPath = v.substring(0, hashIdx);
      const vName = v.substring(hashIdx + 1);
      for (const id of byPathName.get(`${vPath}#${vName}`) ?? []) validatorIds.add(id);
    } else {
      for (const id of byName.get(v) ?? []) validatorIds.add(id);
    }
  }

  // 1b. Provenanced validators.
  if (validatorIds.size === 0) {
    for (const f of graph.functions) {
      if (f.usedImports == null || !f.isExported) continue;
      for (const pkg of VALIDATOR_PACKAGES) {
        if (f.usedImports.includes(`"${pkg}"`)) {
          validatorIds.add(f.id);
          break;
        }
      }
    }
  }

  // 1c. Heuristic fallback (only when provenance found nothing AND no
  //     user-configured validators exist).
  if (validatorIds.size === 0 && userValidators.length === 0) {
    for (const f of graph.functions) {
      if (!f.isExported) continue;
      if (f.name.startsWith('validate') || f.name.startsWith('assert')) validatorIds.add(f.id);
    }
  }

  return validatorIds;
}

/**
 * BFS through the call graph up to maxDepth, checking whether any path from
 * `startFuncId` reaches a validator id (re-homed from `bfsReachesValidator`).
 */
function bfsReachesValidatorFact(
  graph: CallGraphFact,
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
      for (const edge of graph.callEdges) {
        if (edge.fromId !== funcId) continue;
        if (!visited.has(edge.toId)) nextLevel.push(edge.toId);
      }
    }
    currentLevel = nextLevel;
  }
  for (const funcId of currentLevel) {
    if (validatorIds.has(funcId)) return true;
  }
  return false;
}

/** BFS from each writer to check validator reach, deduplicated by key. */
function computeWriterCoverageFact(
  writers: WriterRow[],
  validatorIds: Set<number>,
  graph: CallGraphFact,
  depth: number,
): Map<string, { covered: boolean; line: number; funcName: string }> {
  const writerCoverage = new Map<string, { covered: boolean; line: number; funcName: string }>();
  for (const w of writers) {
    const key = `${w.file_path}::${w.function_name}`;
    if (writerCoverage.has(key)) continue; // deduplicate
    const covered = bfsReachesValidatorFact(graph, w.function_id, validatorIds, depth);
    writerCoverage.set(key, { covered, line: w.line, funcName: w.function_name });
  }
  return writerCoverage;
}

/** Group writers by directory, deduplicating multi-row schema_usage entries. */
function groupWritersByDirectoryFact(
  writers: WriterRow[],
  writerCoverage: Map<string, { covered: boolean; line: number; funcName: string }>,
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

/** Flag uncovered writers in validator-dense directories (re-homed verbatim). */
function flagUnvalidatedWritersFact(
  dirWriters: Map<string, DirWriter[]>,
  minCorpus: number,
  modeShare: number,
  depth: number,
): Finding[] {
  const violations: Finding[] = [];
  for (const [dir, dirWriterList] of dirWriters) {
    if (dirWriterList.length < minCorpus) continue;

    const coveredCount = dirWriterList.filter((w) => w.covered).length;
    const ratio = coveredCount / dirWriterList.length;

    if (ratio >= modeShare) {
      for (const w of dirWriterList) {
        if (w.covered) continue;
        violations.push({
          ruleId: 'cross-domain/no-validator-reachable',
          severity: 'severe',
          message:
            `Function '${w.funcName}' does not reach a validator within BFS depth ≤ ${depth}. ` +
            `${coveredCount}/${dirWriterList.length} peer writers in '${dir}' do. ` +
            `Consider adding input validation.`,
          file: w.filePath,
          line: w.line,
          column: 0,
          symbol: w.funcName,
        });
      }
    }
  }
  return violations;
}

/** The fact-based validation-bypass detector (re-homes `detectValidationBypass`). */
function detectValidationBypass(
  usages: SchemaUsageFact[],
  graph: CallGraphFact,
  userValidators: string[],
  modeShare: number,
  minCorpus: number,
  depth: number,
): Finding[] {
  const validatorIds = buildValidatorIdsFact(graph, userValidators);
  if (validatorIds.size === 0) return [];

  const writers = collectWriters(usages, graph);
  if (writers.length === 0) return [];

  const writerCoverage = computeWriterCoverageFact(writers, validatorIds, graph, depth);
  const dirWriters = groupWritersByDirectoryFact(writers, writerCoverage);
  return flagUnvalidatedWritersFact(dirWriters, minCorpus, modeShare, depth);
}

// ── R4: Coverage by importance (re-homes detectUncoveredRisk) ──────────────

/** The opt-in `coverage` config surface the rule reads from `ctx.thresholds`. */
type CoverageThresholds = {
  testGlobs?: string[];
  staticReachDepth?: number;
  topRiskDecile?: number;
};

/** A high-risk function from the ranked hotspot query (legacy `HighRiskFn`). */
interface HighRiskFn {
  id: number;
  name: string;
  file_path: string;
  line_number: number | null;
  risk_score: number;
}

/** The untested-top-decile row `getUntestedTopDecile` returns. */
interface UntestedFn {
  functionName: string;
  filePath: string;
  lineNumber: number;
  riskScore: number;
  basis: string;
}

/** SQLite `PERCENT_RANK` over a DESC-sorted score list. Ranks use RANK() semantics
 *  (ties share a rank — the rank is `1 + count of strictly-greater`), so the
 *  result is independent of tie order; `pct = (rank-1)/(n-1)` for n > 1, else 0. */
function percentRanks(scores: readonly number[]): number[] {
  const n = scores.length;
  const pcts = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let rank = 1;
    for (let j = 0; j < n; j++) {
      if (scores[j] > scores[i]) rank++;
    }
    pcts[i] = n <= 1 ? 0 : (rank - 1) / (n - 1);
  }
  return pcts;
}

/** The `COALESCE(hs.score, 0.0)` risk-score map over the `call-graph` identity,
 *  for `hs.type = 'function'` (legacy LEFT JOIN key `file_path || ':' || name`). */
function functionRiskScores(graph: CallGraphFact, hotspot: readonly HotspotFact[]): Map<string, number> {
  const byTarget = new Map<string, number>();
  for (const h of hotspot) {
    if (h.type === 'function') byTarget.set(h.target, h.score);
  }
  return byTarget;
}

/** Rank the exported functions by hotspot score and take the top decile
 *  (re-homes `queryHighRiskFunctions`, unscoped — the scope filter is a §12
 *  corpus-scope concern, not a rule input). */
function queryHighRiskFunctionsFact(
  graph: CallGraphFact,
  hotspot: readonly HotspotFact[],
  topRiskDecile: number,
): HighRiskFn[] {
  const byTarget = functionRiskScores(graph, hotspot);
  const exported = graph.functions.filter((f) => f.isExported);
  const riskScores = exported.map((f) => byTarget.get(`${f.filePath}:${f.name}`) ?? 0.0);
  const pcts = percentRanks(riskScores);
  const ranked: HighRiskFn[] = [];
  for (let i = 0; i < exported.length; i++) {
    if (pcts[i] <= topRiskDecile) {
      ranked.push({
        id: exported[i].id,
        name: exported[i].name,
        file_path: exported[i].filePath,
        line_number: exported[i].lineNumber,
        risk_score: riskScores[i],
      });
    }
  }
  ranked.sort((a, b) => b.risk_score - a.risk_score);
  return ranked;
}

/** The measured path's `getUntestedTopDecile`: exported top-decile functions with
 *  no `covered=1` coverage row. `basis` is always `'static-reach'` — the legacy
 *  SQL's `COALESCE(bc.basis, 'static-reach')` is filtered by `bc.basis IS NULL`,
 *  so the measured path inherits the static-reach label. */
function getUntestedTopDecileFact(
  graph: CallGraphFact,
  hotspot: readonly HotspotFact[],
  coverage: CoverageFact,
  topRiskDecile: number,
): UntestedFn[] {
  const byTarget = functionRiskScores(graph, hotspot);
  const exported = graph.functions.filter((f) => f.isExported);
  const riskScores = exported.map((f) => byTarget.get(`${f.filePath}:${f.name}`) ?? 0.0);
  const pcts = percentRanks(riskScores);
  const covered = new Set<string>();
  for (const e of coverage.entries) {
    if (e.covered) covered.add(`${e.functionName} ${e.filePath}`);
  }
  const out: UntestedFn[] = [];
  for (let i = 0; i < exported.length; i++) {
    if (pcts[i] > topRiskDecile) continue;
    if (covered.has(`${exported[i].name} ${exported[i].filePath}`)) continue;
    out.push({
      functionName: exported[i].name,
      filePath: exported[i].filePath,
      lineNumber: exported[i].lineNumber ?? 1,
      riskScore: riskScores[i],
      basis: 'static-reach',
    });
  }
  out.sort((a, b) => b.riskScore - a.riskScore);
  return out;
}

/** SQLite `LIKE` matcher (default case-insensitive, `%`/`_` wildcards) — the test
 *  globs are translated to `%`-patterns and matched with `LIKE` in the legacy. */
function sqlLike(value: string, pattern: string): boolean {
  let re = '';
  for (const ch of pattern) {
    if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(value);
}

/** Function IDs in test files (re-homes `collectTestFuncIds`). */
function collectTestFuncIdsFact(graph: CallGraphFact, testGlobs: readonly string[]): Set<number> {
  const patterns = testGlobs.map((g) => g.replace(/\*\*/g, '%').replace(/\*/g, '%'));
  if (patterns.length === 0) return new Set<number>();
  const ids = new Set<number>();
  for (const f of graph.functions) {
    for (const p of patterns) {
      if (sqlLike(f.filePath, p)) {
        ids.add(f.id);
        break;
      }
    }
  }
  return ids;
}

/** BFS outward from test-file function IDs through the call graph (re-homes
 *  `collectReachableIds`). */
function collectReachableIdsFact(
  graph: CallGraphFact,
  startIds: Set<number>,
  maxDepth: number,
): Set<number> {
  const adjacency = new Map<number, number[]>();
  for (const e of graph.callEdges) {
    const list = adjacency.get(e.fromId) ?? [];
    list.push(e.toId);
    adjacency.set(e.fromId, list);
  }
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
        for (const toId of adjacency.get(funcId) ?? []) {
          if (!visited.has(toId)) nextLevel.push(toId);
        }
      }
      currentLevel = nextLevel;
    }
    for (const funcId of currentLevel) {
      if (!reachableIds.has(funcId)) reachableIds.add(funcId);
    }
  }
  return reachableIds;
}

/** Flag high-risk functions not in the reachable set (re-homes
 *  `flagUnreachedHighRisk`). */
function flagUnreachedHighRiskFact(highRiskFns: readonly HighRiskFn[], reachableIds: Set<number>): Finding[] {
  const findings: Finding[] = [];
  for (const fn of highRiskFns) {
    if (reachableIds.has(fn.id)) continue;
    findings.push({
      file: fn.file_path,
      line: fn.line_number ?? 1,
      column: 0,
      severity: 'high',
      message:
        `Exported function '${fn.name}' (risk ${fn.risk_score.toFixed(3)}) is not reachable from known test files. ` +
        `Add test coverage or import measured coverage with 'code-audit coverage --import <path>'.`,
      ruleId: 'cross-domain/uncovered-risk',
      symbol: fn.name,
    });
  }
  return findings;
}

/** The measured path (re-homes `detectMeasuredUncovered`): flag exported top-decile
 *  functions with no measured coverage, with stale-import detection. */
function detectMeasuredUncoveredFact(
  graph: CallGraphFact,
  hotspot: readonly HotspotFact[],
  coverage: CoverageFact,
  topRiskDecile: number,
): Finding[] {
  const untested = getUntestedTopDecileFact(graph, hotspot, coverage, topRiskDecile);
  const sourceFormat = coverage.source ?? 'unknown';
  const importedAt = coverage.importedAt;
  let staleWarning: string | null = null;
  if (importedAt) {
    const lastSync = coverage.lastFullSync;
    if (lastSync && importedAt < lastSync) {
      staleWarning =
        ` — WARNING: this coverage data may be stale (imported ${importedAt}, ` +
        `last index sync was ${lastSync}). ` +
        `Re-import with 'code-audit coverage --import <path>' for accurate results.`;
    }
  }
  const findings: Finding[] = [];
  for (const fn of untested) {
    findings.push({
      file: fn.filePath,
      line: fn.lineNumber,
      column: 0,
      severity: 'high',
      message:
        `Exported function '${fn.functionName}' (risk ${fn.riskScore.toFixed(3)}) has no measured test coverage. ` +
        `Top imported functions should have test coverage. Import coverage data with 'code-audit coverage --import <path>'.` +
        (staleWarning ?? ''),
      ruleId: 'cross-domain/uncovered-risk',
      symbol: fn.functionName,
    });
  }
  return findings;
}

/** The static-reach fallback (re-homes `detectStaticReachUncovered`). */
function detectStaticReachUncoveredFact(
  graph: CallGraphFact,
  hotspot: readonly HotspotFact[],
  coverage: CoverageFact,
  topRiskDecile: number,
  testGlobs: readonly string[],
  staticReachDepth: number,
): Finding[] {
  const highRiskFns = queryHighRiskFunctionsFact(graph, hotspot, topRiskDecile);
  if (highRiskFns.length === 0) return [];
  const reachableIds = collectReachableIdsFact(
    graph,
    collectTestFuncIdsFact(graph, testGlobs),
    staticReachDepth,
  );
  return flagUnreachedHighRiskFact(highRiskFns, reachableIds);
}

/** The fact-based uncovered-risk detector (re-homes `detectUncoveredRisk`). */
function detectUncoveredRiskFact(
  graph: CallGraphFact,
  hotspot: readonly HotspotFact[],
  coverage: CoverageFact,
  c: CoverageThresholds,
): Finding[] {
  const topRiskDecile = c.topRiskDecile ?? 0.1;
  if (coverage.measuredCount > 0) {
    return detectMeasuredUncoveredFact(graph, hotspot, coverage, topRiskDecile);
  }
  const testGlobs = c.testGlobs ?? ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'];
  const staticReachDepth = c.staticReachDepth ?? 2;
  return detectStaticReachUncoveredFact(graph, hotspot, coverage, topRiskDecile, testGlobs, staticReachDepth);
}

// ── Rule definitions ────────────────────────────────────────────────────────

const writtenNeverRead: RuleDefinition<CrossDomainNeeds> = {
  id: 'cross-domain/written-never-read',
  analyzer: 'cross-domain',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['schema-usage'] },
  severity: 'high',
  message: META['cross-domain/written-never-read'].message,
  docs: META['cross-domain/written-never-read'].docs,
  thresholds: META['cross-domain/written-never-read'].thresholds,
  samples: META['cross-domain/written-never-read'].samples,
  analyze(ctx): Finding[] {
    return detectWrittenNeverRead(ctx.facts['schema-usage']);
  },
};

const readNeverWritten: RuleDefinition<CrossDomainNeeds> = {
  id: 'cross-domain/read-never-written',
  analyzer: 'cross-domain',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['schema-usage'] },
  severity: 'severe',
  message: META['cross-domain/read-never-written'].message,
  docs: META['cross-domain/read-never-written'].docs,
  thresholds: META['cross-domain/read-never-written'].thresholds,
  samples: META['cross-domain/read-never-written'].samples,
  analyze(ctx): Finding[] {
    return detectReadNeverWritten(ctx.facts['schema-usage']);
  },
};

const multiTableWrite: RuleDefinition<MultiTableWriteNeeds> = {
  id: 'cross-domain/multi-table-write',
  analyzer: 'cross-domain',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['schema-usage', 'call-graph', 'batch-functions'] },
  severity: 'high',
  message: META['cross-domain/multi-table-write'].message,
  docs: META['cross-domain/multi-table-write'].docs,
  thresholds: META['cross-domain/multi-table-write'].thresholds,
  samples: META['cross-domain/multi-table-write'].samples,
  analyze(ctx): Finding[] {
    const sc = ctx.thresholds['schemaLifecycle'] as { txnTableMax?: number } | undefined;
    const txnTableMax = sc?.txnTableMax ?? 4;
    return detectTransactionBoundaryRisk(
      ctx.facts['schema-usage'],
      ctx.facts['call-graph'],
      ctx.facts['batch-functions'],
      txnTableMax,
    );
  },
};

const noValidatorReachable: RuleDefinition<ValidatorReachNeeds> = {
  id: 'cross-domain/no-validator-reachable',
  analyzer: 'cross-domain',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['schema-usage', 'call-graph'] },
  severity: 'severe',
  message: META['cross-domain/no-validator-reachable'].message,
  docs: META['cross-domain/no-validator-reachable'].docs,
  thresholds: META['cross-domain/no-validator-reachable'].thresholds,
  samples: META['cross-domain/no-validator-reachable'].samples,
  analyze(ctx): Finding[] {
    const vb = ctx.thresholds['validatorBypass'] as
      | { validators?: string[]; modeShare?: number; minCorpus?: number; depth?: number }
      | undefined;
    if (!vb) return [];
    const userValidators = vb.validators ?? [];
    const modeShare = vb.modeShare ?? 0.8;
    const minCorpus = vb.minCorpus ?? 20;
    const depth = vb.depth ?? 3;
    return detectValidationBypass(
      ctx.facts['schema-usage'],
      ctx.facts['call-graph'],
      userValidators,
      modeShare,
      minCorpus,
      depth,
    );
  },
};

const uncoveredRisk: RuleDefinition<UncoveredRiskNeeds> = {
  id: 'cross-domain/uncovered-risk',
  analyzer: 'cross-domain',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['call-graph', 'hotspot', 'coverage'] },
  severity: 'high',
  message: META['cross-domain/uncovered-risk'].message,
  docs: META['cross-domain/uncovered-risk'].docs,
  thresholds: META['cross-domain/uncovered-risk'].thresholds,
  samples: META['cross-domain/uncovered-risk'].samples,
  analyze(ctx): Finding[] {
    const c = ctx.thresholds['coverage'] as CoverageThresholds | undefined;
    if (!c) return [];
    return detectUncoveredRiskFact(
      ctx.facts['call-graph'],
      ctx.facts['hotspot'],
      ctx.facts['coverage'],
      c,
    );
  },
};

/** The two TypeScript cross-domain rules this slice migrates, in registry order. */
export const crossDomainRules: readonly RuleDefinition<CrossDomainNeeds>[] = [
  writtenNeverRead,
  readNeverWritten,
];

/** `multi-table-write` — the index-backed sibling (call-graph + batch-functions
 *  facts) registered alongside `crossDomainRules` but typed separately. */
export const multiTableWriteRule: RuleDefinition<MultiTableWriteNeeds> = multiTableWrite;

/** `no-validator-reachable` — the validation-bypass sibling (call-graph
 *  validator provenance + BFS reach) registered alongside the other
 *  cross-domain rules but typed separately. */
export const noValidatorReachableRule: RuleDefinition<ValidatorReachNeeds> = noValidatorReachable;

/** `uncovered-risk` — the coverage-by-importance sibling (call-graph + hotspot +
 *  coverage facts) registered alongside the other cross-domain rules but typed
 *  separately. */
export const uncoveredRiskRule: RuleDefinition<UncoveredRiskNeeds> = uncoveredRisk;
