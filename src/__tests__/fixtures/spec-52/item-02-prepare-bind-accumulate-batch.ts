/**
 * Spec-52 R1 item 2 — accumulate-then-batch (oracle: MUST NOT fire).
 *
 * The explicit accumulate-then-batch shape: each loop iteration prepares and
 * binds a statement (statement construction — no I/O), pushes it to an array,
 * and a single `.batch()` after the loop executes them all. The eager call sits
 * outside the loop, so this is not an N+1.
 */

interface ScoreRow {
  id: number;
  score: number;
}

export async function rescoreMany(db: any, items: ScoreRow[]): Promise<void> {
  const stmts: unknown[] = [];
  for (const item of items) {
    const stmt = db.prepare('UPDATE scores SET score = ? WHERE id = ?').bind(item.score, item.id);
    stmts.push(stmt);
  }
  await db.batch(stmts);
}
