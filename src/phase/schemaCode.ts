/**
 * Spec 68 §3.2 — the `ddl-declarations` FileProcessor extraction.
 *
 * Produces the "DDL declared in code" half of the known-table catalog:
 * `SchemaDeclaration[]`, one entry per file that contains DDL written in
 * TypeScript/JavaScript source (migration files whose `CREATE TABLE` /
 * `ALTER TABLE` statements live inside string or template literals — the raw
 * source text carries the SQL verbatim, so the regex extraction reads it
 * directly, exactly as the old full-source scan did for `.sql` files).
 *
 * The extraction is a pure per-file projection: `parseMigrationOps` emits the
 * ordered CREATE/DROP/RENAME ops and `extractDdlTableColumns` the per-table
 * column names. There is NO net-table replay here — a file whose only effect
 * is a DROP still yields one declaration carrying its DROP op, because the
 * cross-file replay (a table dropped in a later migration is a stale
 * reference, not a declaration) is the `table-catalog` / `migration-history`
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
} from '../analyzers/universal/schema/migrations.js';

/** Extract the per-file DDL declaration from one parsed file. Returns a single
 *  entry whenever the file contains any DDL — even a migration whose only
 *  effect is a DROP (zero surviving tables) — so the corpus processors can
 *  replay the ops across files. A file with no DDL returns `[]`.
 *
 *  @param file - The parsed file whose source is scanned for DDL.
 *  @returns A single-element fact when the file declares DDL, otherwise `[]`. */
export function extractSchemaCode(file: ParsedFile): SchemaDeclaration[] {
  const ops = parseMigrationOps(file.source);
  const tableColumns = extractDdlTableColumns(file.source);
  const uniqueColumns = extractDdlUniqueColumns(file.source);
  if (ops.length === 0 && Object.keys(tableColumns).length === 0) return [];
  return [{ file: file.file, ops, tableColumns, uniqueColumns }];
}
