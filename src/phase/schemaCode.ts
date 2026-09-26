/**
 * Spec 68 §3.2 — the `schema-code` FileProcessor extraction.
 *
 * Produces the "tables declared in code" half of the known-table catalog:
 * `SchemaDeclaration[]` with `origin: 'code'`, extracted from DDL written in
 * TypeScript/JavaScript source (migration files whose `CREATE TABLE` /
 * `ALTER TABLE` statements live inside string or template literals — the raw
 * source text carries the SQL verbatim, so the regex extraction reads it
 * directly, exactly as the old full-source scan did for `.sql` files).
 *
 * The extraction mirrors the schema reducer's SQL-migration provenance step,
 * but per-file: `parseMigrationOps` + `applyMigrationOps` replay CREATE/DROP/
 * RENAME in statement order to yield the *net* table set (a table that existed
 * and was dropped is not a declared table), then `extractDdlTableColumns`
 * attaches the per-table column names the tenant-scoping question needs.
 * Cross-file ordering (which migration drops a table another file created) is
 * the `table-catalog` corpus processor's job, not this per-file processor's.
 *
 * The ORM half of the old schema-code visitor — the config-driven table-source
 * registry (`extractTablesFromRegistry`) — is §10 (config as input) and is not
 * reachable from a `process(file)` call; the DDL core here is the config-free
 * slice of what the catalog consumes from code.
 */

import type { ParsedFile, SchemaDeclaration } from './types.js';
import {
  parseMigrationOps,
  applyMigrationOps,
  extractDdlTableColumns,
} from '../analyzers/universal/schema/migrations.js';

/** Extract the per-file DDL table declarations from one parsed file. */
export function extractSchemaCode(file: ParsedFile): SchemaDeclaration[] {
  // Net table set after CREATE/DROP/RENAME replay, in statement order.
  const tables = new Set<string>();
  applyMigrationOps(parseMigrationOps(file.source), tables);

  const tableColumns = extractDdlTableColumns(file.source);

  const declarations: SchemaDeclaration[] = [];
  for (const name of tables) {
    declarations.push({
      name,
      file: file.file,
      columns: (tableColumns[name] ?? []).map((c) => ({ name: c })),
      origin: 'code',
    });
  }
  return declarations;
}
