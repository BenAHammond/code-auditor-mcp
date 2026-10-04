/**
 * Key-value store over the `meta` table. Extracted from `CodeIndexDB`; holds
 * only the raw SQLite handle. Provenance and inferred-receivers build on this
 * store rather than reaching back into the facade.
 */

import type { SqliteDatabase } from '../sqlite/types.js';

/**
 * Key-value store over the `meta` table, holding string values keyed by name.
 */
export class MetaStore {
  /**
   * Wrap the shared SQLite handle for meta key-value access.
   * @param db the SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Upsert a key-value pair in the meta table.
   * @param key the meta key to write.
   * @param value the string value stored under that key.
   */
  setMeta(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  /**
   * Retrieve a value from the meta table, or null if absent.
   * @param key the meta key to read.
   * @returns the stored value, or null when the key is not present.
   */
  getMeta(key: string): string | null {
    const row = this.db.prepare(
      'SELECT value FROM meta WHERE key = ?'
    ).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
}
