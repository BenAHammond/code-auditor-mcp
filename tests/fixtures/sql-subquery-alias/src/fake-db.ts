/**
 * fake-db — D1 database handle for the sql-subquery-alias fixture.
 *
 * `getDB()` is annotated to return a real `D1Database` handle (Spec 69 §10 S5f,
 * form-5), and `export const db = getDB()` carries that provenance to the
 * importing file. `db.exec()` is then a DB call whose SQL string is extracted
 * for table references.
 */

export interface D1Result<T = unknown> {
  results?: T[];
  meta?: unknown;
}

export interface D1Database {
  exec(sql: string): Promise<D1Result>;
}

export function getDB(): D1Database {
  // In-memory stand-in. The resolver reads the declared return type, not this body.
  return {} as D1Database;
}

export const db = getDB();
