/**
 * Safe pattern — for-of loop variable resolved by resolveLocalConstant
 * Guard: resolveLocalConstant for-of fix
 *
 * `resolveLocalConstant` traces through `for...of` loop variable declarations.
 * Constants declared in for-of loops are resolved as compile-time constants.
 * Must produce 0 sql-injection-risk violations.
 */
import { getDB } from './fake-db';

const TABLES = ['users', 'projects'] as const;

export function queryAllTables(): void {
  const db = getDB();
  for (const table of TABLES) {
    db.prepare(
      `SELECT COUNT(*) FROM ${table}`
    ).bind().all();
  }
}
