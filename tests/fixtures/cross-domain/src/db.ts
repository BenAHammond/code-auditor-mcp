/**
 * Shared mock DB interface for cross-domain fixture.
 *
 * Provides .exec() and .prepare()/.bind()/.run()/get() patterns that the
 * schema analyzer recognizes as DB operations (dbReceiverNames includes 'db').
 */

export interface PreparedStatement {
  bind(...params: any[]): PreparedStatement;
  run(): void;
  get(): any;
  all(): any[];
}

export interface MockDB {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
}

export function getDB(): MockDB {
  const stmt = {
    bind(..._params: any[]): PreparedStatement { return stmt; },
    run(): void {},
    get(): any { return null; },
    all(): any[] { return []; },
  };

  return {
    exec(_sql: string): void {},
    prepare(_sql: string): PreparedStatement { return stmt; },
  };
}

export const db = getDB();
