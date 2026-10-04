/**
 * D1 database handle for the insert-delete-tables fixture.
 *
 * `getDB()` is annotated to return a real `D1Database` handle. Spec 69 §10 S5f
 * (form-5) resolves a call to an in-repo function to its *declared return type*,
 * so `const db = getDB()` resolves `db` to a DB handle and `db.prepare(...)` /
 * `db.exec(...)` fire the data-access rules. A mock object with no provenanced
 * client anywhere in its chain would be honestly not-a-handle — the resolver does
 * not learn to accept mocks, so the fixture models a real handle instead.
 */

export interface D1Result<T = unknown> {
  results?: T[];
  meta?: unknown;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all(): Promise<D1Result>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1Result>;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export function getDB(): D1Database {
  // In-memory stand-in. The resolver reads the declared return type, not this body.
  return {} as D1Database;
}
