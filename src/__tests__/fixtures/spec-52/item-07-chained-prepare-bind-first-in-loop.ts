/**
 * Spec-52 R1 item 7 — chained prepare→bind→first<Row>() in a loop (oracle: MUST fire).
 *
 * The typed-read N+1: `.first<Row>()` (and `.all<Row>()`) is the D1 read idiom.
 * The generic type argument must not hide the eager method from detection — the
 * same gap that bit `too-many-queries`'s text regex. The AST path reads the
 * property name directly, so `first` is visible regardless of `<Row>`.
 */

interface HeroRow {
  id: number;
  name: string;
}

// Minimal typed D1 surface so the `.first<HeroRow>()` generic call compiles
// under tsc (an `any` receiver rejects type arguments, TS2347).
interface Statement {
  bind(...args: unknown[]): Statement;
  first<T>(): T | null;
  all<T>(): T[];
  run(): unknown;
}
interface Db {
  prepare(sql: string): Statement;
  batch(stmts: unknown[]): unknown;
}

export async function fetchHeroById(db: Db, ids: number[]): Promise<HeroRow[]> {
  const out: HeroRow[] = [];
  for (const id of ids) {
    const row = await db
      .prepare('SELECT id, name FROM heroes WHERE id = ?')
      .bind(id)
      .first<HeroRow>();
    if (row) out.push(row);
  }
  return out;
}
