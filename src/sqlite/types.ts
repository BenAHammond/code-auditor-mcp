/**
 * Backend-neutral SQLite interface (Spec 51).
 *
 * The code index runs on either the Node built-in `node:sqlite` (no native
 * install) or `better-sqlite3` (fallback for Node versions without
 * `node:sqlite`). Everything outside `src/sqlite/` talks to this interface, so
 * the rest of the codebase is agnostic to which driver is active.
 *
 * The surface mirrors the better-sqlite3 API that the codebase already uses:
 * `prepare`/`run`/`get`/`all`, `exec`, `pragma` (set-only), `transaction`
 * (with `.immediate`/`.deferred`), and `close`. `iterate`/`pluck`/`function`/
 * `aggregate`/`loadExtension` are deliberately absent — they are unused.
 */

/**
 * Result of `run(...)`. `lastInsertRowid` is `number` in both drivers' default
 * config — exact below 2^53, and the schema's AUTOINCREMENT ids are always
 * below that, so it is always exact in practice. The `| bigint` is defensive
 * for a future bigint-read mode; call sites wrap it in `Number()`.
 */
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  /** Accepts positional `?` args (spread) or a leading named-bind object. */
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown | undefined;
  all(...params: unknown[]): unknown[];
}

/**
 * A transaction function. Calling it runs the wrapped function inside `BEGIN`
 * (deferred); `.immediate(...)` runs it inside `BEGIN IMMEDIATE` (used by the
 * lease-acquisition paths), `.deferred(...)` inside `BEGIN`.
 */
export interface SqliteTransaction<Args extends unknown[] = unknown[], R = unknown> {
  (...args: Args): R;
  immediate(...args: Args): R;
  deferred(...args: Args): R;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** Set-style pragma (`'journal_mode = WAL'`). Reads go through `prepare`. */
  pragma(pragmaSql: string): unknown;
  transaction<Args extends unknown[] = unknown[], R = unknown>(
    fn: (...args: Args) => R
  ): SqliteTransaction<Args, R>;
  close(): void;
}

export type SqliteBackend = 'node-sqlite' | 'better-sqlite3';

export interface OpenSqliteOptions {
  timeoutMs: number;
}
