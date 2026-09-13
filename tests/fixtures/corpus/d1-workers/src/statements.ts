/**
 * Corpus-derived fixture — D1/Workers report, Spec 52 R1.
 *
 * Source: the "D1/Workers" external audit (CHANGELOG 3.9.1), which found
 * `loop-query` treating statement construction as execution. Each construct
 * here is the minimal shape from that report, pinned to its expected result:
 *
 *  - `accumulateBatch`  — prepare()/bind() in a loop, one .batch() after.
 *                         Construction, not N+1 → **no** loop-query.
 *  - `promiseAllStatements` — Promise.all of prepared statements. The
 *                         Promise.all combinator is not D1's eager .all() →
 *                         **no** loop-query.
 *  - `eagerRun`         — genuine N+1 (eager .run() per input row) →
 *                         **loop-query** (positive control proving the rule
 *                         still fires here).
 *
 * All SQL is parameterized so `sql-injection-risk` (not a target) stays quiet.
 */
import { getDB } from './db';

/** Prepare into a batch — one round-trip, not N+1. Expected: no loop-query. */
export function accumulateBatch(rows: { id: number; name: string }[]): void {
  const db = getDB();
  const stmts: unknown[] = [];
  for (const row of rows) {
    stmts.push(db.prepare(`INSERT INTO users (id, name) VALUES (?, ?)`).bind(row.id, row.name));
  }
  db.batch(stmts as never);
}

/** Promise.all of prepared statements — a combinator, not eager execution. */
export async function promiseAllStatements(rows: { id: number; name: string }[]): Promise<void> {
  const db = getDB();
  await Promise.all(
    rows.map((row) => db.prepare(`INSERT INTO users (id, name) VALUES (?, ?)`).bind(row.id, row.name)),
  );
}

/** Genuine N+1 — eager `.run()` executes inside the loop. Expected: loop-query. */
export function eagerRun(ids: number[]): void {
  const db = getDB();
  for (const id of ids) {
    db.prepare(`UPDATE users SET name = 'eager' WHERE id = ?`).bind(id).run();
  }
}
