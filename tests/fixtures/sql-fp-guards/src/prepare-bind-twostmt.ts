/**
 * Safe pattern — two-statement .prepare() → .bind() chain
 * Guard: isInPrepareBindChain (via isPrepareAssignedToVariable)
 *
 * The `.prepare()` result is assigned to a variable, then `.bind()` is called.
 * Must produce 0 sql-injection-risk violations.
 */
import Database from 'better-sqlite3';

export function getUsersByRole(role: string): void {
  const db = new Database(':memory:');
  const stmt = db.prepare(`SELECT * FROM users WHERE role = ?`);
  stmt.bind(role).all();
}
