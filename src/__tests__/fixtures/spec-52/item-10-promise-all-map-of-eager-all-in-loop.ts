/**
 * Spec-52 R1 item 10 — Promise.all of a .map() of eager `.all()` calls (oracle: MUST fire).
 *
 * The discriminating positive for the Promise.all guard: `Promise.all` is a
 * promise combinator and must be *skipped*, but the eager D1 `.all()` on each
 * mapped statement still executes per row — a genuine N+1. Crossing the arrow
 * function to reach the eager method (and skip the combinator on the way) is
 * exactly what the guard must get right.
 */

interface ItemRow {
  id: number;
}

export async function fetchMapped(db: any, rows: ItemRow[]): Promise<unknown[]> {
  for (const row of rows) {
    await Promise.all(
      rows.map((r) => db.prepare('SELECT id FROM items WHERE id = ?').bind(r.id).all()),
    );
  }
  return [];
}
