/**
 * Spec-52 R1 item 4 — loop-query TRUE positive (oracle: MUST fire).
 *
 * The `Leaderboard.ts:113` discriminating positive: `this.ctx.storage.sql.exec(...)`
 * inside a loop. `.exec()` is an eager method (immediate I/O), so this is a real
 * N+1 that must keep firing — the two-direction proof's positive arm.
 */

interface RankRow {
  id: number;
  rank: number;
}

export class Leaderboard {
  private sql: D1Database;

  constructor(sql: D1Database) {
    this.sql = sql;
  }

  async applyRanks(rows: RankRow[]): Promise<void> {
    for (const row of rows) {
      this.sql.exec('UPDATE leaderboard SET rank = ? WHERE id = ?', row.rank, row.id);
    }
  }
}
