/**
 * better-sqlite3 backend (Spec 51 fallback).
 *
 * A thin pass-through over better-sqlite3 for Node versions without the
 * `node:sqlite` builtin. The native module is loaded lazily (via `createRequire`)
 * at construction time, so a `node:sqlite`-capable install never touches it —
 * better-sqlite3 moves to `optionalDependencies`, and this file is the only place
 * that `require`s it.
 *
 * The missing-native-binding detection (the "install script was blocked" error
 * that motivated Spec 51) lives here, since only the fallback backend can hit it.
 */

import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import type {
  OpenSqliteOptions,
  SqliteDatabase,
  SqliteStatement,
  SqliteTransaction,
} from './types.js';

const require = createRequire(import.meta.url);

const MISSING_BINDING_PATTERNS: RegExp[] = [
  /could not locate the bindings file/i, // `bindings` package: no .node anywhere
  /no native build was found/i, // node-gyp fallback failed outright
];

/** True when `msg` indicates better-sqlite3's native binding was never built. */
export function isMissingBetterSqlite3Binding(message: string): boolean {
  return MISSING_BINDING_PATTERNS.some((re) => re.test(message));
}

/** Clear, actionable cause + fix for a missing better-sqlite3 native binding. */
function missingBindingMessage(original: string): string {
  return (
    'better-sqlite3 could not load its native SQLite binding. This usually means ' +
    'the package manager blocked better-sqlite3\'s install script, so its prebuilt ' +
    'binary was never downloaded (npm 11.2+ and npm 12 block install scripts by default).\n' +
    'Fix — approve the build once, then rebuild:\n' +
    '  npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3\n' +
    '  # with pnpm, instead:\n' +
    '  pnpm approve-builds        # select better-sqlite3\n' +
    '  pnpm rebuild better-sqlite3\n' +
    `Underlying error: ${original}`
  );
}

function loadBetterSqlite3(): typeof Database {
  try {
    return require('better-sqlite3') as typeof Database;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isMissingBetterSqlite3Binding(msg)) {
      throw new Error(missingBindingMessage(msg));
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Capability probe: can this process load better-sqlite3 (binding included)? */
export function isBetterSqlite3Available(): boolean {
  try {
    loadBetterSqlite3();
    return true;
  } catch {
    return false;
  }
}

export class BetterSqlite3Database implements SqliteDatabase {
  private readonly db: Database.Database;

  constructor(dbPath: string, opts: OpenSqliteOptions) {
    const DatabaseCtor = loadBetterSqlite3();
    this.db = new DatabaseCtor(dbPath, { timeout: opts.timeoutMs });
  }

  prepare(sql: string): SqliteStatement {
    return this.db.prepare(sql) as SqliteStatement;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(pragmaSql: string): unknown {
    return this.db.pragma(pragmaSql);
  }

  transaction<Args extends unknown[] = unknown[], R = unknown>(
    fn: (...args: Args) => R
  ): SqliteTransaction<Args, R> {
    return this.db.transaction(fn) as SqliteTransaction<Args, R>;
  }

  close(): void {
    this.db.close();
  }
}
