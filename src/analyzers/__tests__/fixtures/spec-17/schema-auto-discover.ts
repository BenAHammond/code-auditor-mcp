/**
 * Spec 22 Item 2 — Fixture that references auto-discovered tables from .sql migration files.
 *
 * When no config.schemas is provided, discoverTablesFromMigrations() scans .sql files
 * for CREATE TABLE statements and feeds those table names into allTables.
 * This fixture references "heroes" (discovered from migration-create-table.sql).
 * Zero unknown-table findings expected.
 */

import { sql } from "drizzle-orm";

export function getHeroes(): string {
  return sql`SELECT id, name, class, level FROM heroes WHERE level > 5`;
}

export function getQuests(): string {
  return sql`SELECT q.id, q.title, q.hero_id FROM quests q JOIN heroes h ON h.id = q.hero_id`;
}
