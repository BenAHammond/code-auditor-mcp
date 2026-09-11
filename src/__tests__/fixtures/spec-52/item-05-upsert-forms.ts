/**
 * Spec-52 R2 — the four SQLite/Postgres upsert write forms (oracle: all MUST be
 * classified as `insert` writes).
 *
 * `INSERT OR IGNORE INTO`, `INSERT OR REPLACE INTO`, `REPLACE INTO`, and
 * `INSERT INTO ... ON CONFLICT ... DO UPDATE` all mutate the target table; the
 * write classifier previously only matched `INSERT INTO`, so every rule reading
 * the write set (written-never-read, multi-table-write) missed them.
 *
 * This fixture is exercised by the spec-52 test through `parseSqlTables`, which
 * is the table-extraction path that feeds `schema_usage.usage_type`.
 */

export const UPSERT_QUERIES = {
  insertOrIgnore:
    'INSERT OR IGNORE INTO feature_flags (key, enabled) VALUES (?, ?)',
  insertOrReplace:
    'INSERT OR REPLACE INTO feature_flags (key, enabled) VALUES (?, ?)',
  replaceInto:
    'REPLACE INTO feature_flags (key, enabled) VALUES (?, ?)',
  onConflictDoUpdate:
    'INSERT INTO feature_flags (key, enabled) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled',
} as const;
