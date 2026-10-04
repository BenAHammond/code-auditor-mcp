/**
 * D1 database handle for the cross-domain fixture.
 *
 * `getDB()` is annotated to return a real `D1Database` handle (Spec 69 §10 S5f,
 * form-5), and `export const db = getDB()` carries that provenance to the
 * importing files (`transfer.ts`, `audit-log.ts`, …). A mock with no provenanced
 * client anywhere in its chain would be honestly not-a-handle — the resolver
 * does not learn to accept mocks, so the fixture models a real handle instead.
 */

export interface D1Result<T = unknown> {
  results?: T[];
  meta?: unknown;
}

export interface D1PreparedStatement {
  bind(...params: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  get(): unknown;
  all(): Promise<D1Result>;
}

export interface D1Database {
  exec(sql: string): Promise<D1Result>;
  prepare(sql: string): D1PreparedStatement;
}

export function getDB(): D1Database {
  // In-memory stand-in. The resolver reads the declared return type, not this body.
  return {} as D1Database;
}

export const db = getDB();
