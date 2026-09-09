/**
 * Backend selection (Spec 51).
 *
 * This is the ONLY place conditional logic about which SQLite driver is active
 * may live (R1). Selection is a runtime capability check, not a version-string
 * comparison (R2): prefer the Node built-in `node:sqlite` when it can actually
 * open a database, otherwise fall back to `better-sqlite3`; if neither works,
 * fail loudly with the cause and the fix.
 *
 * `CODE_AUDITOR_SQLITE_BACKEND` (`node-sqlite` | `better-sqlite3`) forces a
 * backend for the parity test suite; an invalid value is an error.
 */

import type {
  OpenSqliteOptions,
  SqliteBackend,
  SqliteDatabase,
} from './types.js';
import { NodeSqliteDatabase, isNodeSqliteAvailable } from './nodeSqlite.js';
import { BetterSqlite3Database, isBetterSqlite3Available } from './betterSqlite3.js';

let activeBackend: SqliteBackend | undefined;

/** The backend selected by the most recent {@link openSqlite} call. */
export function getActiveBackend(): SqliteBackend | undefined {
  return activeBackend;
}

/**
 * Human-readable backend for `--version`. Reports the forced override when set,
 * otherwise the last backend an {@link openSqlite} selected, otherwise a
 * capability probe (which builtin is actually loadable on this Node). "none"
 * when neither backend can load.
 */
export function describeSqliteBackend(): string {
  const override = process.env.CODE_AUDITOR_SQLITE_BACKEND;
  if (override === 'node-sqlite' || override === 'better-sqlite3') return override;
  if (activeBackend !== undefined) return activeBackend;
  if (isNodeSqliteAvailable()) return 'node-sqlite';
  if (isBetterSqlite3Available()) return 'better-sqlite3';
  return 'none';
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function loudFailure(tried: SqliteBackend[], errors: string[]): Error {
  const detail = errors.map((m) => `  - ${m}`).join('\n');
  return new Error(
    'Could not open a SQLite database: no usable backend is available.\n' +
    `Tried: ${tried.join(', ')}.\n${detail}\n` +
    'Fix — run on Node 23.4+ (uses the built-in node:sqlite, no native install), ' +
    "or approve better-sqlite3's install script and rebuild:\n" +
    '  npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3\n' +
    '  # with pnpm, instead:\n' +
    '  pnpm approve-builds        # select better-sqlite3\n' +
    '  pnpm rebuild better-sqlite3'
  );
}

export function openSqlite(dbPath: string, opts: OpenSqliteOptions): SqliteDatabase {
  const override = process.env.CODE_AUDITOR_SQLITE_BACKEND;
  if (override !== undefined && override !== 'node-sqlite' && override !== 'better-sqlite3') {
    throw new Error(
      `Invalid CODE_AUDITOR_SQLITE_BACKEND: "${override}" (expected "node-sqlite" or "better-sqlite3")`
    );
  }

  const construct = (backend: SqliteBackend): SqliteDatabase =>
    backend === 'node-sqlite'
      ? new NodeSqliteDatabase(dbPath, opts)
      : new BetterSqlite3Database(dbPath, opts);

  if (override !== undefined) {
    try {
      const db = construct(override);
      activeBackend = override;
      return db;
    } catch (e) {
      throw loudFailure([override], [messageOf(e)]);
    }
  }

  // Default: prefer node:sqlite (capability check), fall back to better-sqlite3.
  const errors: string[] = [];
  try {
    const db = construct('node-sqlite');
    activeBackend = 'node-sqlite';
    return db;
  } catch (e) {
    errors.push(`node:sqlite: ${messageOf(e)}`);
  }
  try {
    const db = construct('better-sqlite3');
    activeBackend = 'better-sqlite3';
    return db;
  } catch (e) {
    errors.push(`better-sqlite3: ${messageOf(e)}`);
  }

  throw loudFailure(['node-sqlite', 'better-sqlite3'], errors);
}
