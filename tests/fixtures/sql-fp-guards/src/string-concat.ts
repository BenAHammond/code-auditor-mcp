/**
 * Acknowledged FP — mechanism #1 (string concatenation via +)
 * @see docs/sql-injection-fp-defect.md
 *
 * String concatenation with string literals is safe but the analyzer
 * can't resolve the whole expression as a constant.
 */
import { getDB } from './fake-db';

const TABLE = 'users';
const COLUMN = 'id';

export function queryByColumn(): void {
  const db = getDB();
  db.prepare(
    `SELECT * FROM ` + TABLE + ` WHERE ` + COLUMN + ` = ?`
  ).bind('abc').all();
}
