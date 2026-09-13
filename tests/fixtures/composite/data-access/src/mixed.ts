/**
 * Composite data-access fixture — six constructs that historically interact,
 * in one file. The declared finding set is asserted by equality elsewhere.
 *
 *  1. loop accumulating `prepare()` into a `batch()` — one round-trip, not N+1.
 *  2. genuine N+1 — eager execution inside a loop over input.
 *  3. bare `DELETE` with no WHERE — a mass-mutation foot-gun.
 *  4. `INSERT … ON CONFLICT` upsert — keyed by construction, not unfiltered.
 *  5. filtered write — `WHERE` scopes the mutation, not unfiltered.
 *  6. non-SQL method named `update()` — no table, not unfiltered.
 *
 * All SQL is parameterized so `sql-injection-risk` stays silent (it is not the
 * target rule here).
 */
import { getDB } from './db';

/** 1. Accumulated prepares, committed in one batch() — NOT an N+1. */
export function batchUpsertUsers(rows: { id: number; name: string }[]): void {
  const db = getDB();
  const stmts = [];
  for (const row of rows) {
    stmts.push(db.prepare(`INSERT INTO users (id, name) VALUES (?, ?)`).bind(row.id, row.name));
  }
  db.batch(stmts);
}

/** 2. Genuine N+1 — eager execution per input row. */
export function backfillNames(ids: number[]): void {
  const db = getDB();
  for (const id of ids) {
    db.prepare(`UPDATE users SET touched = 1 WHERE id = ?`).bind(id).run();
  }
}

/** 3. Bare DELETE — mass mutation, no row-limiting clause. */
export function purgeUsers(): void {
  const db = getDB();
  db.exec(`DELETE FROM users`);
}

/** 4. Upsert — keyed by its conflict target, not an unfiltered write. */
export function touchUser(id: number): void {
  const db = getDB();
  db.exec(`INSERT INTO users (id, name) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET name = excluded.name`);
}

/** 5. Filtered write — WHERE scopes the mutation. */
export function renameUser(id: number, name: string): void {
  const db = getDB();
  db.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(name, id).run();
}

/** 6. Non-SQL method named `update()` — in-memory, no table target. */
export class Profile {
  private data: Record<string, unknown> = {};

  /** In-memory update; the name shadows the DB verb but is not SQL. */
  update(patch: Record<string, unknown>): void {
    this.data = { ...this.data, ...patch };
  }
}
