/**
 * node:sqlite backend (Spec 51).
 *
 * Uses the Node built-in `node:sqlite` (`DatabaseSync`/`StatementSync`), which
 * needs no native install — the whole point of Spec 51. node:sqlite has no
 * `.transaction()` or `.pragma()` methods, so this adapter wraps them:
 * transactions become explicit `BEGIN`/`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`,
 * and pragmas go through `exec('PRAGMA …')`.
 *
 * The native module is loaded lazily (via `createRequire`) at construction time
 * rather than imported at the top, so importing this file on a Node version that
 * lacks `node:sqlite` does not itself throw — selection is a runtime capability
 * check in `driver.ts`.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type {
  OpenSqliteOptions,
  SqliteDatabase,
  SqliteRunResult,
  SqliteStatement,
  SqliteTransaction,
} from './types.js';

const require = createRequire(import.meta.url);

/**
 * SQLite primary result codes → the string `code` better-sqlite3 uses on its
 * `SqliteError`. node:sqlite throws plain `Error`s carrying a numeric `errcode`
 * (e.g. 5 = SQLITE_BUSY), so callers that branch on `.code === 'SQLITE_BUSY'`
 * (the lease loop's `isBusyError`) need the error normalized to the same shape.
 */
const SQLITE_PRIMARY_RESULT_CODES: Record<number, string> = {
  1: 'SQLITE_ERROR', 2: 'SQLITE_INTERNAL', 3: 'SQLITE_PERM', 4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 7: 'SQLITE_NOMEM', 8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN', 15: 'SQLITE_PROTOCOL', 16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA', 18: 'SQLITE_TOOBIG', 19: 'SQLITE_CONSTRAINT', 20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE', 22: 'SQLITE_NOLFS', 23: 'SQLITE_AUTH', 24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE', 26: 'SQLITE_NOTADB', 27: 'SQLITE_NOTICE', 28: 'SQLITE_WARNING',
  29: 'SQLITE_ROW', 30: 'SQLITE_DONE',
};

/** Map a node:sqlite error to better-sqlite3's `SqliteError`-like shape. */
function normalizeSqliteError(e: unknown): Error {
  if (e instanceof Error) {
    const errcode = (e as Error & { errcode?: unknown }).errcode;
    if (typeof errcode === 'number') {
      const primary = errcode & 0xff;
      const codeName = SQLITE_PRIMARY_RESULT_CODES[primary];
      if (codeName) {
        (e as Error & { code?: string }).code = codeName;
        e.name = 'SqliteError';
      }
    }
    return e;
  }
  return new Error(String(e));
}

function loadDatabaseSync(): typeof DatabaseSync {
  const mod = require('node:sqlite') as { DatabaseSync?: typeof DatabaseSync };
  if (typeof mod.DatabaseSync !== 'function') {
    throw new Error('node:sqlite is available but does not expose DatabaseSync');
  }
  return mod.DatabaseSync;
}

/** Capability probe: can this Node load the `node:sqlite` builtin? */
export function isNodeSqliteAvailable(): boolean {
  try {
    loadDatabaseSync();
    return true;
  } catch {
    return false;
  }
}

class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly stmt: StatementSync) {
    // node:sqlite rejects a bind object that carries keys not referenced by the
    // SQL ("Unknown named parameter 'x'"), while better-sqlite3 silently ignores
    // them. The codebase's idiom is to pass a full row object to a statement that
    // binds only a subset of its columns (e.g. `INSERT INTO functions (name, ...)
    // VALUES (@name, ...)` with a row that also has `body`, `line_number`, …), so
    // allow unknown named parameters to match better-sqlite3 (R3 parity).
    stmt.setAllowUnknownNamedParameters(true);
  }

  run(...params: unknown[]): SqliteRunResult {
    try {
      return this.stmt.run(...(params as SQLInputValue[])) as SqliteRunResult;
    } catch (e) {
      throw normalizeSqliteError(e);
    }
  }

  get(...params: unknown[]): unknown | undefined {
    try {
      return this.stmt.get(...(params as SQLInputValue[]));
    } catch (e) {
      throw normalizeSqliteError(e);
    }
  }

  all(...params: unknown[]): unknown[] {
    try {
      return this.stmt.all(...(params as SQLInputValue[]));
    } catch (e) {
      throw normalizeSqliteError(e);
    }
  }
}

export class NodeSqliteDatabase implements SqliteDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, opts: OpenSqliteOptions) {
    const DatabaseSyncCtor = loadDatabaseSync();
    this.db = new DatabaseSyncCtor(dbPath);
    // node:sqlite has no `timeout` constructor option; busy timeout is a PRAGMA.
    this.db.exec(`PRAGMA busy_timeout = ${opts.timeoutMs}`);
  }

  prepare(sql: string): SqliteStatement {
    try {
      return new NodeSqliteStatement(this.db.prepare(sql));
    } catch (e) {
      throw normalizeSqliteError(e);
    }
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (e) {
      throw normalizeSqliteError(e);
    }
  }

  pragma(pragmaSql: string): unknown {
    try {
      this.db.exec(`PRAGMA ${pragmaSql}`);
    } catch (e) {
      throw normalizeSqliteError(e);
    }
    return undefined;
  }

  transaction<Args extends unknown[] = unknown[], R = unknown>(
    fn: (...args: Args) => R
  ): SqliteTransaction<Args, R> {
    const run = (mode: 'deferred' | 'immediate', args: Args): R => {
      try {
        this.db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      } catch (e) {
        throw normalizeSqliteError(e);
      }
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (e) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* already rolled back / no transaction active */
        }
        throw normalizeSqliteError(e);
      }
    };

    const txn = (...args: Args): R => run('deferred', args);
    txn.immediate = (...args: Args): R => run('immediate', args);
    txn.deferred = (...args: Args): R => run('deferred', args);
    return txn;
  }

  close(): void {
    this.db.close();
  }
}
