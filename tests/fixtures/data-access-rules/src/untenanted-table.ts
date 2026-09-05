/**
 * missing-org-filter rule — fallback-name near-miss negative.
 *
 * `teams` is a table whose name appears in the old (dishonest) English fallback
 * list, but it is NOT tenant-scoped: it has no org/tenant column in the
 * migration and is not declared in `orgFilterTables`. A query on it must NOT
 * trigger missing-org-filter, even though it lacks an org predicate — the old
 * proxy would have accused it purely because its name was in the word list.
 */
import { getDB } from './fake-db';

export function getTeamById(id: string): void {
  const db = getDB();
  db.prepare(`SELECT * FROM teams WHERE id = ?`).bind(id).all();
}
