/**
 * Spec-52 R1 item 1 — loop-query FALSE positive (oracle: MUST NOT fire).
 *
 * `db.prepare(sql)` inside a loop builds a statement object; it performs no I/O.
 * The statements are accumulated and executed once by a single `.batch()` after
 * the loop. This is the `mod.ts:213/218/223/266` shape — not an N+1.
 */

interface Row {
  id: number;
  name: string;
}

export async function insertMany(db: any, rows: Row[]): Promise<void> {
  const stmts: unknown[] = [];
  for (const row of rows) {
    const stmt = db.prepare('INSERT INTO items (id, name) VALUES (?, ?)');
    stmts.push(stmt);
  }
  await db.batch(stmts);
}
