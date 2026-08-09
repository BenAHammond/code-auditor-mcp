/**
 * Fake DB module for the sql-fp-guards fixture.
 * Provides mock DB interface with all methods needed to exercise
 * each SQL-injection guard mechanism.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface QueryResult<T = unknown> {
  all(): T[];
  run(): void;
  first(): T | null;
}

export interface PreparedStatement {
  bind(...params: unknown[]): QueryResult;
}

export interface MockDB {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
}

// ── Mock singleton ──────────────────────────────────────────────────────────

const mockResult: QueryResult = {
  all: () => [],
  run: () => { /* no-op */ },
  first: () => null,
};

const mockPrepared: PreparedStatement = {
  bind: (..._params: unknown[]) => mockResult,
};

const mockDB: MockDB = {
  prepare: (_sql: string) => mockPrepared,
  exec: (_sql: string) => { /* no-op */ },
};

export function getDB(): MockDB {
  return mockDB;
}

// ── DB wrapper functions (configured in .codeauditor.json as dbWrapperNames) ─

/**
 * d1Query is a convenience wrapper: `d1Query(sql, param1, param2, ...)`.
 * Recognized as a DB wrapper via dbWrapperNames + isWrapperFunctionWithBindParams.
 */
export function d1Query(sql: string, ...params: unknown[]): QueryResult {
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
export function buildQuery(sql: string, params: Record<string, unknown>): QueryResult {
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
