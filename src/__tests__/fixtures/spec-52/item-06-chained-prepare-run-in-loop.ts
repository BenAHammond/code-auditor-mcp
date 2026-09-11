/**
 * Spec-52 R1 item 6 — chained prepare→bind→run in a loop (oracle: MUST fire).
 *
 * `db.prepare(sql).bind(x).run()` executes I/O on every iteration. Unlike the
 * accumulate-then-batch shape (where the statement is pushed to an array and a
 * single `.batch()` runs after the loop), the eager `.run()` sits *inside* the
 * loop here, so this is a genuine N+1. The prepare/bind skip must be surgical:
 * it skips standalone construction but leaves a prepare/bind that is chained
 * into an eager call firing.
 */

interface SyncJob {
  id: number;
  slug: string;
}

export async function syncBuildsForHeroes(db: any, jobs: SyncJob[]): Promise<void> {
  for (const job of jobs) {
    await db
      .prepare(
        `UPDATE sync_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?`,
      )
      .bind(job.id)
      .run();
  }
}
