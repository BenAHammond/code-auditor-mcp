/**
 * Minimal mock DB interface for data-access rules fixture.
 * Provides .prepare(), .bind(), .all(), .exec(), .query() for testing
 * data-access rule triggers.
 */

export interface PreparedStatement {
  bind(...params: any[]): PreparedStatement;
  all(): any[];
  run(): void;
}

export interface MockDB {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  query(sql: string): any[];
}

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
    exec(_sql: string): void {},
    query(_sql: string): any[] {
      return [];
    },
  };
}
