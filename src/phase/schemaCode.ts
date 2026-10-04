/**
 * Spec 68 §3.2 — the `ddl-declarations` FileProcessor extraction.
 *
 * Produces the "DDL declared in code" half of the known-table catalog:
 * `SchemaDeclaration[]`, one entry per file that contains DDL written in
 * TypeScript/JavaScript source (migration files whose `CREATE TABLE` /
 * `ALTER TABLE` statements live inside string or template literals — the raw
 * source text carries the SQL verbatim, so {@link extractDdlSqlFromSource}
 * names the DDL-bearing literals, then the AST extractors parse the pure SQL
 * exactly as the `.sql` path does).
 *
 * The extraction is a pure per-file projection: `parseMigrationOps` emits the
 * ordered CREATE/DROP/RENAME ops and `extractDdlTableColumns` the per-table
 * column names. There is NO net-table replay here — a file whose only effect
 * is a DROP still yields one declaration carrying its DROP op, because the
 * cross-file replay (a table dropped in a later migration is a stale
 * reference, not a declaration) is the `resolution` / `migration-history`
 * corpus processors' job, not this per-file processor's.
 *
 * The ORM half of the old schema-code visitor — the config-driven table-source
 * registry (`extractTablesFromRegistry`) — is §10 (config as input) and is not
 * reachable from a `process(file)` call; the DDL core here is the config-free
 * slice of what the catalog consumes from code.
 */

import type { ParsedFile, SchemaDeclaration } from './types.js';
import {
  parseMigrationOps,
  extractDdlTableColumns,
  extractDdlUniqueColumns,
  extractDdlPrimaryKeyColumns,
  extractDdlNotNullColumns,
  extractDdlForeignKeys,
  extractDdlSqlFromSource,
} from '../analyzers/universal/schema/migrations.js';

/** Extract the per-file DDL declaration from one parsed file. Returns a single
 *  entry whenever the file contains any DDL — even a migration whose only
 *  effect is a DROP (zero surviving tables) — so the corpus processors can
 *  replay the ops across files. A file with no DDL returns `[]`.
 *
 *  @param file - The parsed file whose source is scanned for DDL.
 *  @returns A single-element fact when the file declares DDL, otherwise `[]`. */
export function extractSchemaCode(file: ParsedFile): SchemaDeclaration[] {
  const dialect = file.sqlDialect ?? null;
  // The `sql` format is pure SQL, so parse it directly. TS/JS migration files
  // carry their DDL verbatim inside string/template literals, so those must be
  // pulled out first — the AST extractors require pure SQL, and feeding them raw
  // TS source would silently parse nothing (the old regex scan read the SQL
  // through the literals; the AST cannot).
  const sql = file.format === 'sql' ? file.source : extractDdlSqlFromSource(file.source);
  if (sql === null) return [];
  const ops = parseMigrationOps(sql, dialect);
  const tableColumns = extractDdlTableColumns(sql, dialect);
  const uniqueColumns = extractDdlUniqueColumns(sql, dialect);
  const primaryKeyColumns = extractDdlPrimaryKeyColumns(sql, dialect);
  const notNullColumns = extractDdlNotNullColumns(sql, dialect);
  const foreignKeys = extractDdlForeignKeys(sql, dialect);
  if (ops.length === 0 && Object.keys(tableColumns).length === 0) return [];
  return [{ file: file.file, ops, tableColumns, uniqueColumns, primaryKeyColumns, notNullColumns, foreignKeys }];
}
