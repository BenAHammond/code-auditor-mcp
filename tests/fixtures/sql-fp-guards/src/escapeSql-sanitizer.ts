/**
 * Safe pattern — escapeSql() sanitizer wrapping
 * Guard: sanitizerNames (Guard 9)
 *
 * `escapeSql(tableName)` in a template literal means the value is sanitized.
 * Must produce 0 sql-injection-risk violations.
 */
import { getDB, escapeSql } from './fake-db';

export function querySanitized(tableName: string): void {
  const db = getDB();
  db.prepare(
    `SELECT * FROM ${escapeSql(tableName)} WHERE active = 1`
  ).bind().all();
}
