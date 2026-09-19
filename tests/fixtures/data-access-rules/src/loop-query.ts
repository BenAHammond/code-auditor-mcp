/**
 * loop-query rule — true positives + near-miss negative
 *
 * True positive 1: database query executed directly inside a for loop (N+1 risk).
 * True positive 2: a loop calling a local helper that queries per iteration —
 *   the helper existing does not make it not a loop query (still an N+1).
 * Near-miss negative: a batched query — one query issued outside the loop, with
 *   the loop only accumulating results (no per-iteration query).
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

// TRUE POSITIVE — loop calls a local helper that queries per iteration
function fetchUser(db: ReturnType<typeof getDB>, id: number): void {
  db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).all();
}

export function queryUsersWithFunction(): void {
  const db = getDB();
  for (const id of ids) {
    fetchUser(db, id);  // helper queries per iteration → still an N+1
  }
}

// NEAR-MISS NEGATIVE — batched query: one query outside the loop, loop only
// accumulates (mirrors a `WHERE id IN (…)` fan-in like recall's validateSlugs)
export function findMissingIds(): number[] {
  const db = getDB();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id FROM items WHERE id IN (${placeholders})`).bind(...ids).all();
  const present = new Set(rows.map((r) => r.id));
  const missing: number[] = [];
  for (const id of ids) {
    if (!present.has(id)) missing.push(id);  // no query in the loop body
  }
  return missing;
}
