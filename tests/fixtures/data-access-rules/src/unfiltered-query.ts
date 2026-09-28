/**
 * unfiltered-query rule — true positive + near-miss negative
 *
 * True positive: UPDATE a table with no WHERE/HAVING/LIMIT clause —
 * a mass-mutation foot-gun.
 * Near-miss negative: UPDATE with a WHERE clause — should NOT trigger.
 *
 * (A bare `DELETE FROM t` with no WHERE is whole-table maintenance — the
 * clear-and-rebuild idiom — and is exempt per Spec 68 disposition (a).)
 */
import { getDB } from './fake-db';

// TRUE POSITIVE — unfiltered UPDATE, no row-limiting clause
export function archiveAllLogs(): void {
  const db = getDB();
  db.exec(`UPDATE audit_log SET archived = 1`);
}

// NEAR-MISS NEGATIVE — filtered UPDATE, should NOT trigger
export function archiveOneLog(id: number): void {
  const db = getDB();
  db.exec(`UPDATE audit_log SET archived = 1 WHERE id = ?`);
}
