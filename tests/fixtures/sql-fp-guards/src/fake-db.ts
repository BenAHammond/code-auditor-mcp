/**
 * D1 database handle for the sql-fp-guards fixture.
 *
 * `getDB()` is annotated to return a real `D1Database` handle. Spec 69 §10 S5f
 * (form-5) resolves a call to an in-repo function to its *declared return type*,
 * so `const db = getDB()` resolves `db` to a DB handle and `db.prepare(...)` /
 * `db.exec(...)` fire the data-access rules. A mock object with no provenanced
 * client anywhere in its chain would be honestly not-a-handle — the resolver
 * does not learn to accept mocks, so the fixture models a real handle instead.
 */

// ── D1 types ────────────────────────────────────────────────────────────────

export interface D1Result<T = unknown> {
  results?: T[];
  meta?: unknown;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all(...values: unknown[]): Promise<D1Result>;
  first<T = unknown>(...values: unknown[]): Promise<T | null>;
  run(...values: unknown[]): Promise<D1Result>;
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

// ── DB wrapper functions (configured in .codeauditor.json as dbWrapperNames) ──

/**
 * d1Query is a convenience wrapper: `d1Query(sql, param1, param2, ...)`.
 * Recognized as a DB wrapper via dbWrapperNames + isWrapperFunctionWithBindParams.
 */
export function d1Query(sql: string, ...params: unknown[]): D1PreparedStatement {
  return getDB().prepare(sql).bind(...params);
}

/**
 * d1Exec is a convenience wrapper: `d1Exec(flags, sql)`.
 * Recognized as a DB wrapper via dbWrapperNames.
 */
export function d1Exec(flags: string[], sql: string): void {
  getDB().exec(sql);
}

/**
 * buildQuery is a convenience wrapper: `buildQuery(sql, params)`.
 * Recognized as a DB wrapper via dbWrapperNames.
 */
export function buildQuery(
  sql: string,
  params: Record<string, unknown>,
): D1PreparedStatement {
  const values = Object.values(params);
  return getDB().prepare(sql).bind(...values);
}

// ── Sanitizer functions (configured in .codeauditor.json as sanitizerNames) ──

/**
 * escapeSql is a sanitizer: `escapeSql(x)` in a template literal
 * means the value is sanitized, not raw user input.
 */
export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
