/**
 * Spec-52 R1 item 8 — Promise.all of plain statements in a loop (oracle: MUST NOT fire).
 *
 * `Promise.all([db.prepare(sql).bind(x), …])` wraps *statement objects* (no
 * `.run()`/`.all()`/`.first()`), so nothing executes inside the loop. This is
 * construction, not an N+1. `Promise.all` must not be misread as the eager D1
 * `.all()` method just because its property name is "all".
 */

interface ItemRow {
  id: number;
  name: string;
}

export async function stageMany(db: any, items: ItemRow[]): Promise<unknown[]> {
  const staged: unknown[] = [];
  for (const item of items) {
    staged.push(
      await Promise.all([
        db.prepare('SELECT id FROM items WHERE id = ?').bind(item.id),
        db.prepare('SELECT name FROM items WHERE id = ?').bind(item.id),
      ]),
    );
  }
  return staged;
}
