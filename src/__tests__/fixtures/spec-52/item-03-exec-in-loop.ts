/**
 * Spec-52 R1 item 3 — loop-query TRUE positive (oracle: MUST fire).
 *
 * `db.exec(sql)` inside a loop is an eager member call — immediate I/O on every
 * iteration. This is the simplest genuine-N+1 positive arm: the prepare/bind
 * skip must be surgical and leave eager member methods firing.
 */

interface ItemRow {
  id: number;
  name: string;
}

export async function renameAll(db: any, items: ItemRow[]): Promise<void> {
  for (const item of items) {
    db.exec(`UPDATE items SET name = 'renamed' WHERE id = ${item.id}`);
  }
}
