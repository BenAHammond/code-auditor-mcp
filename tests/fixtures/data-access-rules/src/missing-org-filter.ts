/**
 * missing-org-filter rule — true positive + near-miss negative
 *
 * True positive: SELECT from projects without org_id filter (tenant isolation).
 * Near-miss negative: SELECT from projects with org_id WHERE clause — should NOT trigger.
 */
import { getDB } from './fake-db';

// TRUE POSITIVE — query on 'projects' table missing organization filter
export function getAllProjects(): void {
  const db = getDB();
  db.prepare(`SELECT * FROM projects`).all();
}

// NEAR-MISS NEGATIVE — has org_id filter, should NOT trigger missing-org-filter
export function getProjectsByOrg(orgId: string): void {
  const db = getDB();
  db.prepare(`SELECT * FROM projects WHERE org_id = ?`).bind(orgId).all();
}
