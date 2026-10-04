/**
 * Minimal D1 database handle for the schema corpus (Spec 69 §10 S4 mirror).
 *
 * `getDB()` is annotated to return a real `D1Database` handle so
 * `const db = getDB()` resolves `db` to a DB handle and `db.exec('SELECT …')`
 * passes the schema file gate (`passesFileGate` → `dbProvenanced`) and its SQL
 * string is extracted as a table reference. A bare mock `{ exec() {} }` has no
 * provenanced client anywhere in its chain, so it is honestly not-a-handle and
 * the gate rejects the file — the resolver does not learn to accept mocks, so
 * the fixture models a real handle instead (same shape as the data-access
 * corpus's S4 fix in `tests/fixtures/data-access-rules/src/fake-db.ts`).
 */

export interface D1Result<T = unknown> {
  results?: T[];
  meta?: unknown;
}

export interface D1PreparedStatement {
  bind(...params: unknown[]): D1PreparedStatement;
  all(): Promise<D1Result>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<D1Result>;
  query(sql: string): Promise<D1Result>;
}

export function getDB(): D1Database {
  // In-memory stand-in. The resolver reads the declared return type, not this body.
  return {} as D1Database;
}
