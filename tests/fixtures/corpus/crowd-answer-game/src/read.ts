/**
 * Corpus-derived fixture — crowd-answer-game report, extractTables clause fix.
 *
 * Source: the "crowd-answer-game" external audit (CHANGELOG 3.9.3, data-access
 * table extraction). The original finding was a `FOR UPDATE SKIP LOCKED` /
 * `FOR UPDATE NOWAIT` row-locking clause being regex-read as additional table
 * names (`UPDATE` / `SKIP` / `LOCKED`) and flagged `unknown-table`.
 *
 * Under §13 (SQL as a parsed format) that construct is now parsed, and
 * node-sql-parser's *mysql* grammar is the only one that accepts `FOR UPDATE
 * SKIP LOCKED` — its sqlite grammar rejects the whole statement. Because this
 * fixture is a Cloudflare D1 project (`databaseType: "sqlite"`), a
 * `FOR UPDATE SKIP LOCKED` read would be a parse-failure (cannot-fire), which
 * would *lose the `orders` read* and let `written-never-read` fire on writes.ts
 * — a false positive. So the locking-clause construct is pinned at the unit
 * level under mysql (UniversalSchemaAnalyzer.spec.ts), and this fixture's read
 * uses a plain sqlite read so `orders` remains read-and-written.
 *
 * The read interface is a function parameter (not a local `const db = …`) so the
 * schema visitor extracts the SQL, matching the composite schema fixture's
 * proven read pattern.
 *
 * Expected: the SELECT extracts `orders` (declared in the migration), so no
 * `unknown-table` fires and `orders` counts as read.
 */

/** Minimal DB read interface — a parameter so the schema visitor extracts the SQL. */
export interface D1Database {
  query(sql: string): unknown;
}

/** Read the next order — a plain sqlite read (D1 is SQLite, no row-locking). */
export function claimNextOrder(db: D1Database): unknown {
  return db.query('SELECT * FROM orders WHERE id = 1');
}
