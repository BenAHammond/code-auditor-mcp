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

// NEAR-MISS NEGATIVE — the exact hhra-org spelling that fooled the old 2-tier
// predicate: `organization_id = $n` (positional param). The Stage-4 tenant
// predicate must recognize this spelling as "has a tenant predicate" and not
// fire, pinning the guard to the shape that actually produced the false clean.
export function getProjectsByOrganization(orgId: string): void {
  const db = getDB();
  db.prepare(`SELECT * FROM projects WHERE organization_id = $1`).bind(orgId).all();
}
