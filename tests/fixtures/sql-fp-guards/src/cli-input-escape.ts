/**
 * Acknowledged FP — mechanism #2 (`.replace()` SQL escaping on config input)
 * @see docs/sql-injection-fp-defect.md
 *
 * Config input sanitized via .replace(/'/g, "''") is safe, but the analyzer
 * sees a non-constant value flowing into SQL and flags it.
 */
import { getDB } from './fake-db';

const CONFIG = { tableName: "users" };

export function queryFromConfig(): void {
  const db = getDB();
  const safeName = CONFIG.tableName.replace(/'/g, "''");
  db.prepare(
    `SELECT * FROM ${safeName} WHERE active = 1`
  ).bind().all();
}
