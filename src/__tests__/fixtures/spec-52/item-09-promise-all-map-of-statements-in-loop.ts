/**
 * Spec-52 R1 item 9 — Promise.all of a .map() of plain statements (oracle: MUST NOT fire).
 *
 * `Promise.all(rows.map(r => db.prepare(sql).bind(r)))` wraps *statement
 * objects* (no `.run()`/`.all()`/`.first()`), so nothing executes inside the
 * loop. The walk-up must cross the arrow function boundary and still recognise
 * `Promise.all` as the promise combinator, not the eager D1 `.all()`.
 */

interface ItemRow {
  id: number;
}

export async function stageMapped(db: any, rows: ItemRow[]): Promise<void> {
  for (const row of rows) {
    await Promise.all(
      rows.map((r) => db.prepare('SELECT id FROM items WHERE id = ?').bind(r.id)),
    );
  }
}
