/**
 * logEvent — NEAR-MISS NEGATIVE for cross-domain violations.
 *
 * Writes to and reads from a single table (events). This function should
 * produce ZERO cross-domain violations:
 *   - No transaction-boundary (only 1 table written)
 *   - No written-never-read (events is also SELECTed)
 */

import { db } from './db.js';

export function logEvent(event: string): void {
  db.exec(`INSERT INTO events (name) VALUES ('${event}')`);
}

export function getEvents(): Array<{ name: string }> {
  const rows = db.prepare('SELECT name FROM events').all();
  return rows as Array<{ name: string }>;
}
