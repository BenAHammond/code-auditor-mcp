/**
 * Minimal D1-style binding for the D1/Workers corpus fixture.
 *
 * `prepare()` / `bind()` build a statement object (no I/O); execution happens
 * only at `.run()` / `.all()` / `.batch()`. This mirrors the Cloudflare D1 API
 * that the Spec 52 report was auditing.
 */

export interface PreparedStatement {
  bind(...params: any[]): PreparedStatement;
  all(): any[];
  run(): void;
}

export interface MockD1 {
  prepare(sql: string): PreparedStatement;
  batch(stmts: PreparedStatement[]): void;
  exec(sql: string): void;
}

/** Build a fresh in-memory D1 handle. */
export function getDB(): MockD1 {
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
  };
}
