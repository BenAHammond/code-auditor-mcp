/**
 * Minimal DB handle for the crowd-answer-game corpus fixture.
 * `exec()` runs an eager statement; `prepare()`/`bind()` build one.
 */

export interface PreparedStatement {
  bind(...params: any[]): PreparedStatement;
  run(): void;
}

export interface MockDB {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  query(sql: string): unknown;
}

/** Build a fresh in-memory DB handle. */
export function getDB(): MockDB {
  return {
    prepare(_sql: string): PreparedStatement {
      const stmt: PreparedStatement = {
        bind(..._params: any[]): PreparedStatement {
          return stmt;
        },
        run(): void {},
      };
      return stmt;
    },
    exec(_sql: string): void {},
    query(_sql: string): unknown {
      return [];
    },
  };
}
