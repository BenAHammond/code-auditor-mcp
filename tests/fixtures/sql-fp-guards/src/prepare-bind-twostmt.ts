/**
 * Safe pattern — two-statement .prepare() → .bind() chain
 * Guard: isInPrepareBindChain (via isPrepareAssignedToVariable)
 *
 * The `.prepare()` result is assigned to a variable, then `.bind()` is called.
 * Must produce 0 sql-injection-risk violations.
 */
import { getDB } from './fake-db';

export function getUsersByRole(role: string): void {
  const db = getDB();
  const stmt = db.prepare(`SELECT * FROM users WHERE role = ?`);
  stmt.bind(role).all();
}
