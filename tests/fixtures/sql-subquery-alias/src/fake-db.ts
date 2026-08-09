/**
 * fake-db — Minimal mock database interface for the sql-subquery-alias fixture.
 *
 * Provides db.exec() so the schema analyzer recognizes db as a DB receiver
 * with exec as a DB call method, extracting tables from SQL strings.
 */

export interface MockDB {
  exec(sql: string): void;
}

export function getDB(): MockDB {
  let instance: MockDB | null = null;

  if (!instance) {
    instance = {
      exec(_sql: string): void {
        // no-op mock
      },
    };
  }

  return instance as MockDB;
}

export const db = getDB();
