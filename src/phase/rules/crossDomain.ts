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
 * Not here, by design:
 *   - `multi-table-write` — needs depth-1 callee expansion through the call
 *     graph (`graph_cache`) and re-parses files for `.batch(` detection; not a
 *     `schema-usage`-only fact.
 *   - `no-validator-reachable` — BFS over the call graph + validator provenance.
 *   - `uncovered-risk` — coverage data + hotspot ranking.
 * These three stay on the legacy path (their DB/coverage inputs have no
 * phase-model producer yet).
 */

import type { RuleDefinition, Finding, SchemaUsageFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

/** The shared declaration for the TS cross-domain rules in this slice. */
type CrossDomainNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['schema-usage'];
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

/** The two TypeScript cross-domain rules this slice migrates, in registry order. */
export const crossDomainRules: readonly RuleDefinition<CrossDomainNeeds>[] = [
  writtenNeverRead,
  readNeverWritten,
];
