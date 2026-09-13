/**
 * Corpus-derived fixture — D1/Workers report, Spec 52 R2.
 *
 * Source: the "D1/Workers" external audit (CHANGELOG 3.9.1), which found the
 * write classifier missing the upsert forms. `INSERT … ON CONFLICT … DO UPDATE`
 * is a write keyed by its conflict target — not an unfiltered mass-write.
 *
 * Expected: **no** `unfiltered-query` (the R1 fix — an upsert is keyed by its
 * conflict target, not an unfiltered write), and the statement is classified
 * as a write so the table never reads as "read, never written".
 */
import { getDB } from './db';

/** Upsert a single user — keyed by its conflict target. Expected: no unfiltered-query. */
export function upsertUser(): void {
  const db = getDB();
  db.exec(
    `INSERT INTO users (id, name) VALUES (1, 'seed') ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  );
}
