/**
 * Corpus-derived fixture — D1/Workers report, Spec 52 R2.
 *
 * Source: the "D1/Workers" external audit (CHANGELOG 3.9.1), which found the
 * write classifier missing the upsert forms. An upsert is a write keyed by its
 * conflict target — not an unfiltered mass-write.
 *
 * Under §13 (SQL as a parsed format) the fixture must use a form its dialect
 * parses. node-sql-parser's sqlite grammar parses `INSERT OR REPLACE INTO`
 * (D1 is SQLite), but rejects `INSERT … ON CONFLICT … DO UPDATE` — a real
 * SQLite construct the parser cannot parse. That form is pinned at the unit
 * level as a cannot-fire parse-failure (spec-52.test.ts), not silently clean
 * here.
 *
 * Expected: **no** `unfiltered-query` (an upsert is keyed by its conflict
 * target, not an unfiltered write), and the statement is classified as a write
 * so the table never reads as "read, never written".
 */
import { getDB } from './db';

/** Upsert a single user — keyed by its conflict target. Expected: no unfiltered-query. */
export function upsertUser(): void {
  const db: D1Database = getDB();
  db.exec(`INSERT OR REPLACE INTO users (id, name) VALUES (1, 'seed')`);
}
