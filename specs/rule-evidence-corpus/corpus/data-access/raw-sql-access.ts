/**
 * raw-sql-access.ts — `unfiltered-query` (27) + `missing-org-filter` (25) on
 * raw SQL against a driver handle (`better-sqlite3`-shaped `db`).
 *
 * The read case of `unfiltered-query` is config-only (Tiers 1–2): it reads
 * `orgFilterTables` / `schemas`, NOT Tier 3 DDL. `missing-org-filter` reads all
 * three. That split is the disagreement this file pins: a DDL-only tenant table
 * (`orders`) fires `missing-org-filter` but not the `unfiltered-query` read case.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires unfiltered-query 40 — mass UPDATE, no WHERE
 *   @fires missing-org-filter 40 — mass UPDATE carries no tenant predicate
 *   @fires missing-org-filter 45 — UPDATE scoped by PK only, not tenant
 *   @quiet unfiltered-query 45 — WHERE id = ? is a real filter, not a mass write
 *   @fires missing-org-filter 50 — filterless read of a DDL-only tenant table
 *   @fires unfiltered-query 50 — filterless read of a tenant table, but the read case is config-only and misses Tier-3 → false negative
 *   @fires unfiltered-query 55 — filterless read of a Tier-1 tenant table
 *   @fires missing-org-filter 55 — same table, no tenant predicate
 *   @fires unfiltered-query 60 — filterless read of a Tier-2 schema table
 *   @fires missing-org-filter 60 — same table, no tenant predicate
 *   @quiet unfiltered-query 65 — filterless read of a NON-tenant table
 *   @quiet missing-org-filter 65 — organizations carries no tenant column
 *   @fires unfiltered-query 70 — mass UPDATE on a non-tenant table still fires
 *   @quiet missing-org-filter 70 — organizations is not a tenant table
 *   @fires missing-org-filter 75 — bare DELETE FROM tenant table, no predicate
 *   @quiet unfiltered-query 75 — bare DELETE is whole-table maintenance (exempt)
 *   @fires missing-org-filter 80 — INSERT omits the tenant column
 *   @quiet unfiltered-query 80 — INSERT is row-adding, not a mass write
 *   @quiet missing-org-filter 85 — INSERT sets the tenant column
 *   @quiet missing-org-filter 93 — WHERE organization_id = ? is a recognized comparison
 *   @quiet unfiltered-query 93 — the query carries a real WHERE
 *   @quiet unfiltered-query 98 — upsert (ON CONFLICT) is excluded from the write set
 *   @quiet missing-org-filter 98 — upsert sets the tenant column
 */

declare const db: any;

/** Mass UPDATE with no row-limiting clause. */
export function resetAllOrderTotals() {
  return db.execute('UPDATE orders SET total_cents = 0');
}

/** UPDATE scoped by primary key only — not by tenant. */
export function zeroOneOrder(orderId: number) {
  return db.execute('UPDATE orders SET total_cents = 0 WHERE id = ?', [orderId]);
}

/** Filterless read of a DDL-only tenant table (Tier 3). */
export function dumpAllOrders() {
  return db.all('SELECT * FROM orders');
}

/** Filterless read of a Tier-1 tenant table (config-declared). */
export function dumpAllTeamMembers() {
  return db.all('SELECT * FROM team_members');
}

/** Filterless read of a Tier-2 schema table (config-declared, no DDL). */
export function dumpAllAuditEvents() {
  return db.all('SELECT * FROM audit_events');
}

/** Filterless read of a NON-tenant table — nothing to scope. */
export function listAllOrganizations() {
  return db.all('SELECT * FROM organizations');
}

/** Mass UPDATE on a non-tenant table — still a mass write. */
export function renameAllOrganizations() {
  return db.execute('UPDATE organizations SET name = name');
}

/** Bare DELETE FROM a tenant table — whole-table maintenance, but tenant-blind. */
export function purgeOrders() {
  return db.execute('DELETE FROM orders');
}

/** INSERT that omits the tenant column. */
export function insertOrderNoTenant(totalCents: number) {
  return db.execute('INSERT INTO orders (id, total_cents) VALUES (?, ?)', [0, totalCents]);
}

/** INSERT that sets the tenant column. */
export function insertOrderScoped(orgId: number, totalCents: number) {
  return db.execute(
    'INSERT INTO orders (id, organization_id, total_cents) VALUES (?, ?, ?)',
    [0, orgId, totalCents],
  );
}

/** Scoped read — a real comparison predicate. */
export function listOrdersByOrganization(orgId: number) {
  return db.all('SELECT * FROM orders WHERE organization_id = ?', [orgId]);
}

/** Upsert — excluded from the unfiltered write set; sets the tenant column. */
export function upsertOrder(orgId: number, totalCents: number) {
  return db.execute(
    `INSERT INTO orders (id, organization_id, total_cents)
     VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET total_cents = excluded.total_cents`,
    [0, orgId, totalCents],
  );
}
