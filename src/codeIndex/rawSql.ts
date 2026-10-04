/**
 * Raw SQL passthrough — the escape hatch external surfaces (ledger writes,
 * schema setup) use when no typed concern owns the statement. Extracted from
 * `CodeIndexDB`; holds only the raw SQLite handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { assertSqlIdentifier, ASSERT_TABLE_NAME } from './shared.js';

/**
 * Raw SQL passthrough over the shared SQLite handle. Wraps `prepare`/`run`/
 * `exec` so external surfaces (ledger writes, schema setup) can issue
 * statements directly when no typed index owns them.
 */
export class RawSqlIndex {
  /**
   * Hold the raw SQLite handle used by every passthrough method.
   * @param db The SQLite database handle to execute raw SQL against.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Execute a parameterized query and return all rows.
   * @param sql The SQL query to prepare and run.
   * @param params Positional bind parameters passed through to the statement.
   * @returns Every row the query produces.
   */
  query(sql: string, params?: any[]): any[] {
    return params?.length
      ? this.db.prepare(sql).all(...params)
      : this.db.prepare(sql).all();
  }

  /**
   * Count rows in a table (validated as a SQL identifier).
   * @param table The table name to count, interpolated after identifier validation.
   * @returns The number of rows in the table.
   */
  count(table: string): number {
    assertSqlIdentifier(table, ASSERT_TABLE_NAME);
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Check if a table has any rows (validated as a SQL identifier).
   * @param table The table name to probe, interpolated after identifier validation.
   * @returns True when the table contains at least one row.
   */
  tableHasRows(table: string): boolean {
    assertSqlIdentifier(table, ASSERT_TABLE_NAME);
    const row = this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return row !== undefined;
  }

  /**
   * Execute a DML statement (INSERT/UPDATE/DELETE) and return its result.
   * @param sql The DML statement to run.
   * @param params Positional bind parameters passed through to the statement.
   * @returns The affected-row count and last inserted row id.
   */
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return params?.length
      ? this.db.prepare(sql).run(...params)
      : this.db.prepare(sql).run();
  }

  /**
   * Execute raw SQL (multi-statement) — for schema setup / bulk operations.
   * @param sql One or more SQL statements to execute back-to-back.
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }
}
