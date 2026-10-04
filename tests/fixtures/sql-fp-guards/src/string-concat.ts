/**
 * Acknowledged FP — mechanism #1 (string concatenation via +)
 * @see docs/sql-injection-fp-defect.md
 *
 * String concatenation with string literals is safe but the analyzer
 * can't resolve the whole expression as a constant.
 */
import Database from 'better-sqlite3';

const TABLE = 'users';
const COLUMN = 'id';

export function queryByColumn(): void {
  const db = new Database(':memory:');
  db.prepare(
    `SELECT * FROM ` + TABLE + ` WHERE ` + COLUMN + ` = ?`
  ).bind('abc').all();
}
