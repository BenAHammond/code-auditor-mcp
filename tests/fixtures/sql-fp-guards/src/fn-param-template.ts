/**
 * Acknowledged FP — mechanism #5 (function parameter in SQL template)
 * @see docs/sql-injection-fp-defect.md
 *
 * Function parameter `${table}` in SQL template is safe when the caller
 * passes compile-time constants, but the analyzer sees a non-constant
 * reference flowing into SQL.
 */
import { getDB } from './fake-db';

export function queryTable(table: string): void {
  const db = getDB();
  db.prepare(
    `SELECT * FROM ${table} WHERE active = 1`
  ).bind().all();
}
