/**
 * Ambient Cloudflare D1 handle surface for the spec-52 loop-query fixtures.
 *
 * The fixtures annotate their `db`/`sql` parameters as `D1Database`; that
 * annotation declares the ambient D1 handle surface the fixtures call, so it
 * must stay. The fixtures are parsed as text by tree-sitter and never
 * executed — but they must still typecheck under `tsc --noEmit` (the
 * `verify:types` gate in `verify:close`): a fixture that fails to typecheck
 * cannot be trusted to model the shape it claims to pin. This file declares the
 * minimal D1 surface the fixtures call, nothing more.
 */

interface D1PreparedStatement {
  bind(...args: unknown[]): D1PreparedStatement;
  run(): unknown;
  all<T>(): T[];
  first<T>(): T | null;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string, ...args: unknown[]): unknown;
  batch(stmts: unknown[]): unknown;
}
