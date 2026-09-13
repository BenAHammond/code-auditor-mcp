/**
 * Corpus-derived fixture — crowd-answer-game report, extractTables clause fix.
 *
 * Source: the "crowd-answer-game" external audit (CHANGELOG 3.9.3, data-access
 * table extraction). A `FOR UPDATE SKIP LOCKED` / `FOR UPDATE NOWAIT` row-locking
 * clause must not be read as additional table names — otherwise `unknown-table`
 * fires on `UPDATE` / `SKIP` / `LOCKED`.
 *
 * The read interface is a function parameter (not a local `const db = …`) so the
 * schema visitor extracts the SQL, matching the composite schema fixture's
 * proven read pattern.
 *
 * Expected: the SELECT extracts only `orders` (declared in the migration), so
 * **no** `unknown-table` fires from the locking clause.
 */

/** Minimal DB read interface — a parameter so the schema visitor extracts the SQL. */
export interface DB {
  query(sql: string): unknown;
}

/** Claim the next row with a row-locking clause. Expected: no unknown-table. */
export function claimNextOrder(db: DB): unknown {
  return db.query('SELECT * FROM orders WHERE id = 1 FOR UPDATE SKIP LOCKED');
}
