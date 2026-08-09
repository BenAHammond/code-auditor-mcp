/**
 * unfiltered-query rule — true positive + near-miss negative
 *
 * True positive: SELECT from a table without WHERE or LIMIT clause.
 * Near-miss negative: SELECT with WHERE clause — should NOT trigger.
 */
import { getDB } from './fake-db';

// TRUE POSITIVE — no WHERE/LIMIT clause
export function getAllUsers(): void {
  const db = getDB();
  db.prepare(`SELECT * FROM users`).all();
}

// NEAR-MISS NEGATIVE — uses org_id filter pattern, which satisfies
// both unfiltered-query (has filter) and missing-org-filter (has org column).
// Uses a table NOT in the org filter fallback to avoid cross-contamination.
export function getTagsByOrg(orgId: string): void {
  const db = getDB();
  db.prepare(`SELECT * FROM tags WHERE org_id = ?`).bind(orgId).all();
}
