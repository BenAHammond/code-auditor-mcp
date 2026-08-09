/**
 * Fixture: INSERT-only and DELETE-only table references.
 *
 * These tables are ONLY referenced in INSERT/DELETE statements — never in SELECT.
 * Before the INSERT/DELETE patterns were added to extractTables, they were invisible
 * to the data-access analyzer. Also tests locally-defined DB wrapper function provenance.
 */

import { getDB } from './fake-db';

// ── INSERT-only table ────────────────────────────────────────────────────────
// `audit_log` is only ever INSERTed into — no SELECT, UPDATE, or DELETE.
// Without the INSERT INTO pattern, extractTables would never see this table name.

export function logAuditEvent(event: string): void {
  const db = getDB();
  db.prepare(
    `INSERT INTO audit_log (event, timestamp) VALUES (?, datetime('now'))`
  ).bind(event).run();
}

// ── DELETE-only table ────────────────────────────────────────────────────────
// `expired_sessions` is only ever DELETEd from — no SELECT, INSERT, or UPDATE.
// Without the DELETE FROM pattern, extractTables would never see this table name.

export function cleanExpiredSessions(): void {
  const db = getDB();
  db.prepare(
    `DELETE FROM expired_sessions WHERE created_at < datetime('now', '-7 days')`
  ).bind().run();
}

// ── Locally-defined DB wrapper function ──────────────────────────────────────
// `d1Exec` is a local wrapper — NOT imported from a DB library.
// Before the dbWrapperNames provenance fix, buildProvenanceContext wouldn't
// recognize it as a DB wrapper because propagateProvenance doesn't handle
// function declarations, and addNameListFallbacks didn't receive dbWrapperNames.

export function d1Exec(flags: string[], sql: string): void {
  const db = getDB();
  db.exec(sql);
}

export function runMigration(): void {
  d1Exec([], `INSERT INTO migration_log (name, applied_at) VALUES ('init', datetime('now'))`);
  d1Exec(['--dry-run'], `DELETE FROM migration_log WHERE name = 'rollback'`);
}
