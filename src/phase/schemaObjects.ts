/**
 * Spec 68 §3.2 — the `schema-objects` FileProcessor extraction.
 *
 * Produces the ORM schema-object half of the known-table catalog: the
 * identifier → SQL-name binding a Drizzle schema file declares
 * (`export const sampleOwnership = pgTable('sample_ownership', …)`). The DDL
 * half (`ddl-declarations`) records the SQL `CREATE TABLE` names; this fact
 * records the JS binding that names them, so the `resolution` corpus reducer
 * can build the alias map that lets `.from(sampleOwnership)` resolve to the
 * catalog entry `sample_ownership`.
 *
 * It also records each declaration's *natural* UNIQUE columns — the `.unique()`
 * marker Drizzle carries on a column builder — so `missing-org-filter` can
 * recognise a query whose predicate names one of them as a structurally-scoped
 * (bootstrap) lookup: a natural-unique-key filter is a lookup by that key, not
 * an unscoped tenant read. `.primaryKey()` is deliberately excluded: a
 * surrogate primary key is the IDOR surface, not a bootstrap-lookup signal.
 * Both the JS field name (`prefix`) and, when it differs, the SQL column name
 * (`hashed_token`) are captured, because a Drizzle filter writes the JS name
 * (`eq(apiKey.prefix, …)`) while a raw-SQL filter writes the SQL name
 * (`WHERE hashed_token = ?`).
 *
 * It is a pure per-file regex projection over source text — no AST, no config.
 * The same heuristic shape as the legacy `discoverTablesFromOrmSchemas`
 * `builderRegex`, extended to capture the binding identifier in front of the
 * builder and the UNIQUE markers inside the columns object. `pgTable` /
 * `mysqlTable` / `sqliteTable` are the three Drizzle dialect builders; a file
 * with none yields `[]`.
 */

import type { ParsedFile, SchemaObject } from './types.js';

/** `const <identifier> = <pgTable|mysqlTable|sqliteTable>('<table>', …)`. The
 *  `\b` before the keyword keeps `deconst`/`reconst` from matching; the optional
 *  `export` covers the idiomatic top-level `export const` schema module. */
const ORM_OBJECT_RE =
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * Find the columns-object body that follows a declaration header. The columns
 * object is the second argument: `("table", { … }, …)`. After the table-name
 * string comes a comma, then the `{ … }` literal. Brace-matching (honouring
 * nested objects in `.default({…})` / `.references(() => x, {…})` and string/
 * template literals) returns the text between the braces, or null when the
 * object cannot be located (empty `{}` body is `''`, not null).
 */
function columnsBodyAfter(source: string, afterName: number): string | null {
  let i = afterName;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] === ',') {
    i++;
    while (i < source.length && /\s/.test(source[i])) i++;
  }
  if (source[i] !== '{') return null;
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(i + 1, j);
    }
  }
  return null;
}

/**
 * One Drizzle column field carrying a `.unique()` marker:
 * `fieldName: <type>("sqlName")… .unique()`. `.primaryKey()` is deliberately
 * *not* matched — a surrogate primary key is the IDOR surface, not a
 * bootstrap-lookup signal. The lazy span between the SQL name and the marker is
 * bounded by a negative lookahead that refuses to cross into the *next* field
 * header (`ident : word ( "`) — without it a non-unique field would lazily
 * stretch to the next field's `.unique()` and steal its marker. `word(` for the
 * column type is deliberately generic: a Drizzle columns object holds only
 * column builders.
 */
const UNIQUE_FIELD_RE =
  /([A-Za-z_$][\w$]*)\s*:\s*\w+\s*\(\s*['"]([^'"]+)['"]\s*(?:(?!\s*[A-Za-z_$][\w$]*\s*:\s*\w+\s*\()[^])*?\.unique\s*\(/g;

/** One Drizzle column field carrying a `.primaryKey()` marker — the surrogate-
 *  key signal recorded *separately* from natural UNIQUE (Spec 69 R3, criterion
 *  8). `.primaryKey()` on a column builder (`id: uuid('id').primaryKey()`)
 *  mirrors `.unique()`; a table-level `primaryKey({ columns: [...] })` is not
 *  matched here (the DDL `PRIMARY KEY` extraction covers the SQL spelling). */
const PRIMARY_KEY_FIELD_RE =
  /([A-Za-z_$][\w$]*)\s*:\s*\w+\s*\(\s*['"]([^'"]+)['"]\s*(?:(?!\s*[A-Za-z_$][\w$]*\s*:\s*\w+\s*\()[^])*?\.primaryKey\s*\(/g;

/** The natural-UNIQUE column names in a columns-object body: each field's
 *  JS name plus, when different, its SQL name. */
function uniqueColumnsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(UNIQUE_FIELD_RE)) {
    const jsName = m[1];
    const sqlName = m[2];
    out.push(jsName);
    if (sqlName !== jsName) out.push(sqlName);
  }
  return out;
}

/** The PRIMARY-KEY column names in a columns-object body (surrogate keys only —
 *  `.primaryKey()` markers). PK and natural UNIQUE are kept separate so the
 *  quiet set can stay natural-UNIQUE-only. */
function primaryKeyColumnsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PRIMARY_KEY_FIELD_RE)) {
    const jsName = m[1];
    const sqlName = m[2];
    out.push(jsName);
    if (sqlName !== jsName) out.push(sqlName);
  }
  return out;
}

/** Extract the per-file ORM schema-object declarations from one parsed file.
 *
 * @param file The parsed file to extract from.
 * @returns The schema-object declarations found in the file.
 */
export function extractSchemaObjects(file: ParsedFile): SchemaObject[] {
  const out: SchemaObject[] = [];
  for (const match of file.source.matchAll(ORM_OBJECT_RE)) {
    const identifier = match[1];
    const table = match[2];
    const afterName = match.index + match[0].length;
    const body = columnsBodyAfter(file.source, afterName);
    const uniqueColumns = body === null ? [] : uniqueColumnsIn(body);
    const primaryKeyColumns = body === null ? [] : primaryKeyColumnsIn(body);
    out.push({ file: file.file, identifier, table, uniqueColumns, primaryKeyColumns });
  }
  return out;
}
