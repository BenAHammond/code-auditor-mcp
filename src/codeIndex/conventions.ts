/**
 * Convention mining — mines codebase conventions from the functions table and
 * upserts them into the `conventions` table. Extracted from `CodeIndexDB`;
 * holds only the raw SQLite handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import type { ConventionMiningConfig } from '../types.js';
import { mineConventions, computeMinerInputHash } from '../conventions/conventionMiner.js';

/**
 * Convention mining over the functions table. Recomputes a content hash of the
 * function corpus and re-mines conventions into the `conventions` table only
 * when the hash changed, so repeated syncs skip redundant mining.
 */
export class ConventionsIndex {
  /**
   * Create the index over the shared SQLite handle.
   *
   * @param db The SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Mine codebase conventions from the functions table and upsert into the
   * conventions table. Content-hash-based skip: stored hash avoids re-mining
   * when the function corpus hasn't changed since the last mine.
   *
   * Called both by deepSync() (after indexing) and by audit runs (so the
   * conventions analyzer has data to query even without an explicit sync).
   *
   * @param projectRoot - Optional project root passed to the mining logic.
   * @param getSource - Optional callback to read a file's source content.
   */
  mineAllConventions(projectRoot?: string, getSource?: (filePath: string) => string | undefined): void {
    const miningConfig: ConventionMiningConfig = {
      minCorpus: 20,
      pairConfidence: 0.9,
      modeShare: 0.8,
      maxConventionsPerDomain: 200,
    };
    const newHash = computeMinerInputHash(this.db, miningConfig);
    const oldHashRow = this.db.prepare(
      "SELECT value FROM meta WHERE key = 'conventions_hash'"
    ).get() as { value: string } | undefined;

    if (!oldHashRow || oldHashRow.value !== newHash) {
      const conventions = mineConventions(this.db, miningConfig, projectRoot, getSource);
      const deleteStmt = this.db.prepare('DELETE FROM conventions');
      const insertStmt = this.db.prepare(
        `INSERT INTO conventions
         (domain, rule_id, antecedent, consequent, pattern, directory,
          file_path, line, support, total_cases, confidence,
          exemplar_file, exemplar_line, export_kind, hash)
         VALUES (@domain, @rule_id, @antecedent, @consequent, @pattern,
                 @directory, @file_path, @line, @support, @total_cases,
                 @confidence, @exemplar_file, @exemplar_line, @export_kind, @hash)`
      );

      const upsertAll = this.db.transaction(() => {
        deleteStmt.run();
        for (const c of conventions) {
          insertStmt.run({
            domain: c.domain,
            rule_id: c.rule_id,
            antecedent: c.antecedent ?? null,
            consequent: c.consequent ?? null,
            pattern: c.pattern ?? null,
            directory: c.directory ?? null,
            file_path: c.file_path ?? null,
            line: c.line ?? null,
            support: c.support,
            total_cases: c.total_cases,
            confidence: c.confidence,
            exemplar_file: c.exemplar_file ?? null,
            exemplar_line: c.exemplar_line ?? null,
            export_kind: (c as any).export_kind ?? null,
            hash: c.hash ?? null,
          });
        }
      });
      upsertAll();

      // Only store the hash when conventions were actually produced.
      // Storing it on an empty mine would be a poison pill — the hash
      // would match on every subsequent run, skipping mining forever.
      if (conventions.length > 0) {
        this.db.prepare(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('conventions_hash', ?)"
        ).run(newHash);
      }
    }
  }
}
