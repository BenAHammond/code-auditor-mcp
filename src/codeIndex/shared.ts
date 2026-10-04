/**
 * Shared helpers for the `codeIndex` modules. Kept dependency-free (imports
 * nothing from `codeIndexDB.ts`) so every extracted concern can depend on it
 * without forming an import cycle back into the facade.
 */

export const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ASSERT_TABLE_NAME = 'table name';
export const ASSERT_COLUMN_NAME = 'column name';

/** Reject a value that is not a plain SQL identifier. Table and column names are
 *  interpolated into SQL (SQLite cannot parameterize identifiers), so a value that
 *  fails this check is a would-be injection surface and is refused, never run.
 *  @param name - The identifier value to validate.
 *  @param context - The SQL context (e.g. "table name") used in the error message. */
export function assertSqlIdentifier(name: string, context: string): void {
  if (!SQL_IDENTIFIER_RE.test(name)) {
    throw new Error(`invalid SQL identifier in ${context}: ${JSON.stringify(name)}`);
  }
}

/**
 * Escape regex metacharacters so a string matches itself literally.
 * @param s The string to escape for safe use inside a regular expression.
 * @returns The string with every regex metacharacter backslash-escaped.
 */
export function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a JSON value if it is a string; pass through objects and non-strings.
 * @param val The value to normalize, typically a JSON-serialized column read back from SQLite.
 * @returns The parsed object/array/primitive, or the original value when it is not JSON.
 */
export function tryParseJson(val: any): any {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val;
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}
