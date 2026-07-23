/**
 * Spec-19 Item 2 — "hero-repo.ts:83" shape reproduction.
 *
 * A repository-class method with a single db.query() + .map() transform.
 * Cyclomatic complexity is 1 (zero branches). Before the Spec-19 R1
 * per-node-shape fix, method-complexity miscomputed this as high complexity
 * because the old walking strategy counted AST nodes inside .map() callbacks.
 *
 * Verdict: method-complexity MUST NOT fire — complexity is 1.
 */

declare const db: { query: (sql: string) => Promise<Array<Record<string, unknown>>> };

interface Hero {
  id: number;
  name: string;
  class: string;
  level: number;
  guild: string;
}

export class HeroRepository {
  private pool: typeof db;

  constructor(pool: typeof db) {
    this.pool = pool;
  }

  /**
   * Returns all heroes in the given guild, sorted by level descending.
   * The .map() is a pure data-normalization pass over an already-fetched
   * result set — it adds zero branching complexity.
   */
  async findByGuild(guildName: string): Promise<Hero[]> {
    const rows = await this.pool.query(
      `SELECT h.id, h.name, h.class, h.level, g.name as guild
       FROM heroes h
       JOIN guilds g ON h.guild_id = g.id
       WHERE g.name = $1
       ORDER BY h.level DESC`,
    );

    return rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      name: String(row.name),
      class: String(row.class),
      level: Number(row.level),
      guild: String(row.guild),
    }));
  }
}
