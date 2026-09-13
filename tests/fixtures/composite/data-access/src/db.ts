/**
 * Minimal mock DB interface for the composite data-access fixture.
 * Mirrors a D1-style binding: `prepare()`/`bind()` build a statement,
 * `batch()` executes many statements in one round-trip, `exec()` executes
 * one statement eagerly.
 */

export interface PreparedStatement {
  bind(...params: any[]): PreparedStatement;
  all(): any[];
  run(): void;
}

export interface MockDB {
  prepare(sql: string): PreparedStatement;
  batch(stmts: PreparedStatement[]): void;
  exec(sql: string): void;
  query(sql: string): any[];
}

/** Build the mock DB — every call returns a fresh in-memory instance. */
export function getDB(): MockDB {
  return {
    prepare(_sql: string): PreparedStatement {
      const stmt: PreparedStatement = {
        bind(..._params: any[]): PreparedStatement {
          return stmt;
        },
        all(): any[] {
          return [];
        },
        run(): void {},
      };
      return stmt;
    },
    batch(_stmts: PreparedStatement[]): void {},
    exec(_sql: string): void {},
    query(_sql: string): any[] {
      return [];
    },
  };
}
