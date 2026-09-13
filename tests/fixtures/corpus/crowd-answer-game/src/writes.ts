/**
 * Corpus-derived fixture — crowd-answer-game report, Spec 55 R5.
 *
 * Source: the "crowd-answer-game" external audit (CHANGELOG 3.9.3), which found
 * `unfiltered-query` targeting reads instead of writes. The rule now fires on an
 * unfiltered *write* (DELETE/UPDATE with no WHERE/HAVING/LIMIT), not a read.
 *
 *  - `purgeOrders` — bare DELETE, no row-limiting clause → **unfiltered-query**
 *    (positive control).
 *  - `shipOrder`   — UPDATE scoped by `WHERE id = ?` → **no** unfiltered-query.
 *
 * (The Drizzle/Prisma/knex `.where()`-chain ORM case is a separate pre-existing
 * gap — keyword-only `hasQueryFilter` cannot read a method-chain filter — and is
 * pinned at the unit level, not here.)
 */
import { getDB } from './db';

/** Bare DELETE — deletes every row, the foot-gun. Expected: unfiltered-query. */
export function purgeOrders(): void {
  const db = getDB();
  db.exec(`DELETE FROM orders`);
}

/** Filtered UPDATE — WHERE scopes the mutation. Expected: no unfiltered-query. */
export function shipOrder(id: number): void {
  const db = getDB();
  db.prepare(`UPDATE orders SET status = 'shipped' WHERE id = ?`).bind(id).run();
}
