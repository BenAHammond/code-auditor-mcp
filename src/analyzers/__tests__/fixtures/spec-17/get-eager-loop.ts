/**
 * Spec-17 R8 Fixture 15b: get-eager-loop
 * Report section: R4.1 — Loop-query findings with correct locations
 *
 * `db.prepare(…).get(…)` is a single-row eager read (better-sqlite3,
 * node:sqlite, bun:sqlite). §69 Fix 5 added `.get()` to the eager-method set,
 * so a per-item `.prepare().get()` inside a loop is a genuine N+1 and must
 * fire — before the fix it was misread as statement construction and skipped.
 */

export function loadNames(
  ids: number[],
  db: {
    prepare(sql: string): { get(id: number): { name: string } | undefined };
  },
): string[] {
  const names: string[] = [];
  for (const id of ids) {
    const row = db.prepare('SELECT name FROM products WHERE id = ?').get(id);
    if (row) names.push(row.name);
  }
  return names;
}
