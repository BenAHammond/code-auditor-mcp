/**
 * tenant-scoping.ts — `missing-org-filter` (rule 25) at production scale.
 *
 * A realistic multi-tenant read layer. Every way a team actually writes the
 * tenant predicate appears here — inline `eq`, a conditions array built across
 * statements, a conditional push, a ternary, a generic scoping wrapper, raw SQL
 * relying on Postgres RLS, an options-object key, a tagged template, Kysely, and
 * Prisma object form — against tenant columns named organizationId, workspaceId,
 * teamId, projectId and environmentId as well as organization_id / tenant_id.
 *
 * The tenant schema is declared three ways (see ./schema.ts, ./migrations/0001_init.sql,
 * and ../.codeauditor.json):
 *   Tier 3 (DDL)      orders (organization_id), workspaces (workspace_id),
 *                     users (org_id), accounts (tenant_id), api_keys (org_id).
 *   Tier 1 (config)   team_members (team_id), projects (project_id),
 *                     environments (environment_id).
 *   Tier 2 (config)   audit_events (tenant_id) — schema-declared, no DDL file.
 *
 * `projects_v2` is the trap: its tenant column is camelCase (`"organizationId"`),
 * which `extractDdlTableColumns` lowercases to one token (`organizationid`, not
 * `organization_id`), so Tier 3 never sees it and it is NOT declared in Tier 1.
 * A query against it with no predicate is a genuine miss the corpus pins.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @quiet missing-org-filter 71 — inline eq on a non-dotted value is scoped
 *   @quiet missing-org-filter 79 — dotted value is STILL scoped, but the helper detector rejects a dotted 2nd arg → false positive
 *   @quiet missing-org-filter 90 — conditions array built across statements is scoped, but the candidate node's text lacks the predicate → false positive
 *   @fires missing-org-filter 102 — conditional push: the predicate is not on every path, so the query is genuinely unscoped on some branch
 *   @quiet missing-org-filter 114 — generic scoping wrapper: scoped, but the wrapper lives in another statement → false positive
 *   @fires missing-org-filter 120 — RLS with no predicate at all: no in-code tenant predicate to verify
 *   @quiet missing-org-filter 125 — options-object key: where({ tenant_id }) is a recognized object filter
 *   @quiet missing-org-filter 133 — tagged template: org_id = is a recognized comparison
 *   @quiet missing-org-filter 138 — Kysely: where('organization_id', …) is a recognized positional filter
 *   @quiet missing-org-filter 145 — workspace_id predicate is scoped, but workspace_id is outside the org-pattern vocabulary → false positive
 *   @quiet missing-org-filter 153 — teamId predicate is scoped, but teamId is outside the vocabulary → false positive
 *   @quiet missing-org-filter 161 — projectId predicate is scoped, but projectId is outside the vocabulary → false positive
 *   @quiet missing-org-filter 169 — environmentId predicate is scoped, but environmentId is outside the vocabulary → false positive
 *   @fires missing-org-filter 177 — camelCase DDL table (projects_v2): its "organizationId" column lowercases to one token, so Tier 3 never sees the table → false negative
 *   @quiet missing-org-filter 182 — Prisma object form: where: { organizationId } is a recognized object filter
 *   @quiet missing-org-filter 189 — bootstrap lookup by natural UNIQUE prefix on api_keys is structurally scoped
 */

import { eq, and, sql } from 'drizzle-orm';
import { PrismaClient } from '@prisma/client';
import {
  orders,
  workspaces,
  teamMembers,
  projects,
  environments,
  apiKeys,
} from './schema';

const prisma = new PrismaClient();

/** A session-scoped tenant context. Production shape, no framework. */
interface Session {
  orgId: string;
  organizationId: string;
  workspaceId: string;
  teamId: string;
  projectId: string;
  environmentId: string;
  isOrgAdmin: boolean;
}

declare const db: any;

/** Inline eq on a non-dotted value — the recognized happy path. */
export async function listOrdersForOrg(orgId: string) {
  return db
    .select()
    .from(orders)
    .where(eq(orders.organizationId, orgId));
}

/** Inline eq on a *dotted* value — the helper detector rejects the 2nd arg. */
export async function listOrdersForSession(session: Session) {
  return db
    .select()
    .from(orders)
    .where(eq(orders.organizationId, session.orgId));
}

/** A conditions array pushed unconditionally, then applied in one .where(). */
export async function listOrdersFromConditions(session: Session) {
  const conditions = [];
  conditions.push(eq(orders.organizationId, session.orgId));
  conditions.push(eq(orders.id, session.orgId));
  return db
    .select()
    .from(orders)
    .where(and(...conditions));
}

/** A conditions array where the tenant predicate is pushed inside an `if`. */
export async function listOrdersConditional(session: Session) {
  const conditions = [];
  if (session.isOrgAdmin) {
    conditions.push(eq(orders.organizationId, session.orgId));
  }
  return db
    .select()
    .from(orders)
    .where(and(...conditions));
}

/** A generic scoping wrapper — the predicate is applied in another statement. */
function withOrgScope<T>(qb: T, session: Session): T {
  return (qb as any).where(eq(orders.organizationId, session.orgId));
}

export async function listOrdersViaWrapper(session: Session) {
  const base = db.select().from(orders);
  return withOrgScope(base, session);
}

/** Raw SQL relying on Postgres RLS — no in-code tenant predicate. */
export async function listOrdersWithRls() {
  return db.execute('SELECT * FROM orders'); // RLS enforces tenancy at the DB
}

/** Options-object key: where({ tenant_id }) is the recognized object filter form. */
export async function listAccountsByOrg(orgId: string) {
  return db
    .select()
    .from('accounts')
    .where({ tenant_id: orgId });
}

/** Tagged template with an inline comparison — a recognized predicate. */
export async function listUsersTagged(orgId: string) {
  return db.execute(sql`SELECT * FROM users WHERE org_id = ${orgId}`);
}

/** Kysely positional where — a recognized predicate. */
export async function listOrdersKysely(orgId: string) {
  return db
    .selectFrom('orders')
    .where('organization_id', '=', orgId);
}

/** workspace_id predicate — scoped, but outside the org-pattern vocabulary. */
export async function listWorkspaceScoped(session: Session) {
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.workspaceId, session.workspaceId));
}

/** teamId predicate — scoped, outside the vocabulary. */
export async function listTeamMembers(session: Session) {
  return db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.teamId, session.teamId));
}

/** projectId predicate — scoped, outside the vocabulary. */
export async function listProjects(session: Session) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.projectId, session.projectId));
}

/** environmentId predicate — scoped, outside the vocabulary. */
export async function listEnvironments(session: Session) {
  return db
    .select()
    .from(environments)
    .where(eq(environments.environmentId, session.environmentId));
}

/** camelCase DDL table — Tier 3 never discovers "organizationId". */
export async function listProjectsV2() {
  return db.execute('SELECT * FROM projects_v2');
}

/** Prisma object form — where: { organizationId } is a recognized filter. */
export async function listOrdersPrisma(session: Session) {
  return prisma.order.findMany({
    where: { organizationId: session.organizationId },
  });
}

/** Bootstrap lookup by natural UNIQUE prefix — structurally scoped. */
export async function findApiKeyByPrefix(prefix: string) {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.prefix, prefix));
}
