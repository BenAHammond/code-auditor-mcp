/**
 * unfiltered-query rule — true positive + near-miss negative
 *
 * True positive: DELETE from a table with no WHERE/HAVING/LIMIT clause —
 * a mass-mutation foot-gun.
 * Near-miss negative: DELETE with a WHERE clause — should NOT trigger.
 */
import { getDB } from './fake-db';

// TRUE POSITIVE — unfiltered DELETE, no row-limiting clause
export function deleteAllLogs(): void {
  const db = getDB();
  db.exec(`DELETE FROM audit_log`);
}

// NEAR-MISS NEGATIVE — filtered DELETE, should NOT trigger
export function deleteOneLog(id: number): void {
  const db = getDB();
  db.exec(`DELETE FROM audit_log WHERE id = ?`);
}
