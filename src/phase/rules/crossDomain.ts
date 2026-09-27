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
 * Not here, by design:
 *   - `no-validator-reachable` — BFS over the call graph + validator provenance.
 *   - `uncovered-risk` — coverage data + hotspot ranking.
 * These two stay on the legacy path (their validator/coverage inputs have no
 * phase-model producer yet).
 */

import type { RuleDefinition, Finding, SchemaUsageFact, CallGraphFact, BatchFunctionFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

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

const META = RULE_REGISTRY;

/** The write verbs a one-sided write lifecycle treats as "written". */
const WRITE_TYPES = new Set(['insert', 'update', 'delete', 'create']);

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

/** Tables written (INSERT/UPDATE/DELETE/CREATE) but never read (SELECT). */
function detectWrittenNeverRead(usages: SchemaUsageFact[]): Finding[] {
  const nonQb = nonQueryBuilderTables(usages);
  const selects = selectTables(usages);

  const candidates = usages
    .filter((u) => WRITE_TYPES.has(u.usageType) && nonQb.has(u.tableName) && !selects.has(u.tableName))
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

// ── Rule definitions ────────────────────────────────────────────────────────

const writtenNeverRead: RuleDefinition<CrossDomainNeeds> = {
  id: 'cross-domain/written-never-read',
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

/** The two TypeScript cross-domain rules this slice migrates, in registry order. */
export const crossDomainRules: readonly RuleDefinition<CrossDomainNeeds>[] = [
  writtenNeverRead,
  readNeverWritten,
];

/** `multi-table-write` — the index-backed sibling (call-graph + batch-functions
 *  facts) registered alongside `crossDomainRules` but typed separately. */
export const multiTableWriteRule: RuleDefinition<MultiTableWriteNeeds> = multiTableWrite;
