/**
 * logAudit — TRUE POSITIVE for written-never-read.
 *
 * Writes to audit_log via db.prepare().bind().run() pattern. audit_log is
 * also written by transfer.ts but never SELECTed anywhere in the fixture.
 * This should trigger:
 *   cross-domain/written-never-read
 */

import { db } from './db.js';

export function logAudit(event: string): void {
  db.prepare(
    `INSERT INTO audit_log (event, ts) VALUES (?, datetime('now'))`,
  )
    .bind(event)
    .run();
}
