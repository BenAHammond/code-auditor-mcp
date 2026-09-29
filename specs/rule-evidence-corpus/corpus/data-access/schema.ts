/**
 * schema.ts — the Drizzle schema the tenant-scoping read layer queries.
 *
 * This file is the ORM half of the tenant schema. The DDL half lives in
 * `migrations/0001_init.sql`; the two are deliberately parallel so the corpus
 * exercises *both* discovery paths (Tier 3 DDL vs the schema-object alias map)
 * against the same tables.
 *
 * The `pgTable(...)` bindings are what let `.from(teamMembers)` resolve to the
 * catalog entry `team_members`: the `schema-objects` producer reads
 * `const <id> = pgTable('<table>', …)` and builds the identifier → SQL-name
 * alias the `table-catalog` reducer uses. A hand-rolled `{ __table: '…' }`
 * object would NOT register (the producer only matches the three Drizzle
 * builders), which is exactly why this corpus writes real schema code.
 *
 *   orders        → orders        (organization_id)  Tier 3, DDL column
 *   workspaces    → workspaces    (workspace_id)     Tier 3, DDL column
 *   teamMembers   → team_members  (team_id)          Tier 1, config table
 *   projects      → projects      (project_id)       Tier 1, config table
 *   environments  → environments  (environment_id)   Tier 1, config table
 *   apiKeys       → api_keys      (prefix UNIQUE, org_id)  Tier 3 + bootstrap
 */

import { integer, text, pgTable } from 'drizzle-orm/pg-core';

export const orders = pgTable('orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  organizationId: integer('organization_id').notNull(),
  totalCents: integer('total_cents').notNull(),
});

export const workspaces = pgTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id').notNull(),
  name: text('name').notNull(),
});

export const teamMembers = pgTable('team_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  teamId: integer('team_id').notNull(),
  userId: integer('user_id').notNull(),
});

export const projects = pgTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  title: text('title').notNull(),
});

export const environments = pgTable('environments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  environmentId: integer('environment_id').notNull(),
  name: text('name').notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  prefix: text('prefix').notNull().unique(),
  hashedToken: text('hashed_token').notNull(),
  orgId: integer('org_id').notNull(),
});
