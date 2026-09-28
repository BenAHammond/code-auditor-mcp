/**
 * Spec 68 §3.2 — the `schema-objects` FileProcessor extraction.
 *
 * Produces the ORM schema-object half of the known-table catalog: the
 * identifier → SQL-name binding a Drizzle schema file declares
 * (`export const sampleOwnership = pgTable('sample_ownership', …)`). The DDL
 * half (`ddl-declarations`) records the SQL `CREATE TABLE` names; this fact
 * records the JS binding that names them, so the `table-catalog` corpus reducer
 * can build the alias map that lets `.from(sampleOwnership)` resolve to the
 * catalog entry `sample_ownership`.
 *
 * It is a pure per-file regex projection over source text — no AST, no config.
 * The same heuristic shape as the legacy `discoverTablesFromOrmSchemas`
 * `builderRegex`, extended to capture the binding identifier in front of the
 * builder. `pgTable` / `mysqlTable` / `sqliteTable` are the three Drizzle
 * dialect builders; a file with none yields `[]`.
 */

import type { ParsedFile, SchemaObject } from './types.js';

/** `const <identifier> = <pgTable|mysqlTable|sqliteTable>('<table>', …)`. The
 *  `\b` before the keyword keeps `deconst`/`reconst` from matching; the optional
 *  `export` covers the idiomatic top-level `export const` schema module. */
const ORM_OBJECT_RE =
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g;

/** Extract the per-file ORM schema-object declarations from one parsed file. */
export function extractSchemaObjects(file: ParsedFile): SchemaObject[] {
  const out: SchemaObject[] = [];
  for (const match of file.source.matchAll(ORM_OBJECT_RE)) {
    out.push({ file: file.file, identifier: match[1], table: match[2] });
  }
  return out;
}
