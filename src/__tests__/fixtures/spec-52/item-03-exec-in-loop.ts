/**
 * Spec-52 R1 item 3 — loop-query TRUE positive (oracle: MUST fire).
 *
 * `db.exec(sql)` inside a loop is an eager member call — immediate I/O on every
 * iteration. This is the simplest genuine-N+1 positive arm: the prepare/bind
 * skip must be surgical and leave eager member methods firing.
 */

import Database from 'better-sqlite3';

interface ItemRow {
  id: number;
  name: string;
}

// Spec 70 R4 — the handle is proven by the manifest-package import
// (`better-sqlite3`), not a `D1Database` type annotation. `db.exec(sql)` with a
// dynamic (interpolated) argument has no static SQL for R3, so the import is the
// proof; the `D1Database` binding would read `unproven` (cannot-fire).
const db = new Database(':memory:');

export async function renameAll(items: ItemRow[]): Promise<void> {
  for (const item of items) {
    db.exec(`UPDATE items SET name = 'renamed' WHERE id = ${item.id}`);
  }
}
