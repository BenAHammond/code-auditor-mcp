/**
 * Safe pattern — .prepare().bind() direct chain
 * Guard: isInPrepareBindChain
 *
 * The `.prepare(sql).bind(val).all()` chain guarantees parameterized SQL.
 * Must produce 0 sql-injection-risk violations.
 */
import { getDB } from './fake-db';

export function getActiveUsers(): void {
  const db = getDB();
  db.prepare(`SELECT * FROM users WHERE active = ?`)
    .bind(1)
    .all();
}
