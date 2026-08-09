/**
 * loop-query rule — true positive + near-miss negative
 *
 * True positive: database query executed inside a for loop (N+1 risk).
 * Near-miss negative: database query defined as function, called from loop
 *   but the query execution itself is NOT syntactically inside the loop.
 */
import { getDB } from './fake-db';

const ids = [1, 2, 3, 4, 5];

// TRUE POSITIVE — db.prepare() inside for loop body
export function queryUsersInLoop(): void {
  const db = getDB();
  for (const id of ids) {
    db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).all();
  }
}

// NEAR-MISS NEGATIVE — query function defined outside loop, called within
function fetchUser(db: ReturnType<typeof getDB>, id: number): void {
  db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).all();
}

export function queryUsersWithFunction(): void {
  const db = getDB();
  for (const id of ids) {
    fetchUser(db, id);  // query happens inside fetchUser, not directly in loop
  }
}
