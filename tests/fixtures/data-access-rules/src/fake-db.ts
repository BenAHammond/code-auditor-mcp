/**
 * Minimal D1 database handle for the data-access rules fixture.
 *
 * `getDB()` is annotated to return a real `D1Database` handle (Spec 69 §10 S5f,
 * form-5) so `const db = getDB()` resolves `db` to a DB handle and
 * `.prepare()` / `.exec()` / `.query()` fire the data-access rules. A mock with
 * no provenanced client anywhere in its chain would be honestly not-a-handle —
 * the resolver does not learn to accept mocks, so the fixture models a real
 * handle instead.
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
