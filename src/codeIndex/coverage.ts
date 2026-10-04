/**
 * Coverage-data access (Spec 15) — the `coverage_data` table backing the
 * cross-domain coverage report. Extracted from `CodeIndexDB`; holds only the
 * raw SQLite handle, so it carries no lifecycle or adapter state.
 */

import type { SqliteDatabase } from '../sqlite/types.js';

/**
 * Data access for the `coverage_data` table: import, query, and clear the
 * cross-domain coverage report (Spec 15).
 */
export class CoverageIndex {
  /**
   * Wrap the shared SQLite handle for coverage-data access.
   * @param db the SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Replace coverage rows for the entries' bases, then insert the new set.
   * @param entries coverage records to import; rows for each distinct `basis` are cleared before these are written.
   */
  importCoverageData(entries: Array<{
    functionName: string;
    filePath: string;
    lineNumber: number;
    basis: 'static-reach' | 'measured';
    covered: boolean;
    source?: string;
  }>): void {
    // Group by basis so we only clear one basis at a time
    const bases = new Set(entries.map(e => e.basis));
    const clearStmt = this.db.prepare('DELETE FROM coverage_data WHERE basis = ?');
    for (const basis of bases) {
      clearStmt.run(basis);
    }

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO coverage_data (function_name, file_path, line_number, basis, covered, source, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    const tx = this.db.transaction((items: typeof entries) => {
      for (const e of items) {
        insert.run(e.functionName, e.filePath, e.lineNumber, e.basis, e.covered ? 1 : 0, e.source ?? null);
      }
    });
    tx(entries);
  }

  /**
   * Return all coverage rows for a single basis.
   * @param basis the coverage basis to filter on (`static-reach` or `measured`).
   * @returns the matching rows, with `covered` decoded from the stored 0/1 flag.
   */
  getCoverageByBasis(basis: 'static-reach' | 'measured'): Array<{
    functionName: string;
    filePath: string;
    lineNumber: number;
    basis: string;
    covered: boolean;
    source: string | null;
    importedAt: string | null;
  }> {
    const rows = this.db.prepare(
      'SELECT * FROM coverage_data WHERE basis = ?'
    ).all(basis) as any[];
    return rows.map((r: any) => ({
      functionName: r.function_name,
      filePath: r.file_path,
      lineNumber: r.line_number,
      basis: r.basis,
      covered: r.covered === 1,
      source: r.source,
      importedAt: r.imported_at,
    }));
  }

  /**
   * Delete coverage rows, for a single basis or the whole table.
   * @param basis when given, delete only that basis; otherwise clear all coverage data.
   */
  clearCoverageData(basis?: 'static-reach' | 'measured'): void {
    if (basis) {
      this.db.prepare('DELETE FROM coverage_data WHERE basis = ?').run(basis);
    } else {
      this.db.prepare('DELETE FROM coverage_data').run();
    }
  }

  /**
   * Check if measured coverage predates the last full sync.
   * @returns true when any measured row was imported before the last full sync timestamp.
   */
  isCoverageStale(): boolean {
    const lastSync = this.db.prepare(
      "SELECT value FROM meta WHERE key = 'last_full_sync_timestamp'"
    ).get() as { value: string } | undefined;
    if (!lastSync) return false;
    const staleRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM coverage_data
       WHERE basis = 'measured' AND imported_at < ?`
    ).get(lastSync.value) as any;
    return (staleRow?.cnt ?? 0) > 0;
  }

  /**
   * Bucket exported functions into risk deciles and report per-decile coverage.
   * @param decileCount the number of deciles to split functions into.
   * @returns one entry per decile with the covered and total function counts and the coverage rate.
   */
  getCoverageByRiskDecile(decileCount: number = 10): Array<{
    decile: number;
    covered: number;
    total: number;
    rate: number;
  }> {
    // Rank functions by risk score from hotspot_scores, join with coverage_data
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT
          f.name,
          f.file_path,
          f.line_number,
          COALESCE(hs.score, 0.0) as risk_score,
          NTILE(?) OVER (ORDER BY COALESCE(hs.score, 0.0) DESC) as decile
        FROM functions f
        LEFT JOIN hotspot_scores hs ON hs.target = (f.file_path || ':' || f.name)
          AND hs.type = 'function'
        WHERE f.is_exported = 1
      ),
      coverage AS (
        SELECT DISTINCT function_name, file_path FROM coverage_data
        WHERE covered = 1
      )
      SELECT
        r.decile,
        COUNT(*) as total,
        SUM(CASE WHEN c.function_name IS NOT NULL THEN 1 ELSE 0 END) as covered
      FROM ranked r
      LEFT JOIN coverage c ON c.function_name = r.name AND c.file_path = r.file_path
      GROUP BY r.decile
      ORDER BY r.decile
    `).all(decileCount) as any[];

    return rows.map((r: any) => ({
      decile: r.decile,
      covered: r.covered,
      total: r.total,
      rate: r.total > 0 ? r.covered / r.total : 0,
    }));
  }

  /**
   * Return the highest-risk exported functions that have no measured coverage.
   * @param topDecile the percentile cutoff (0..1) selecting the top risk slice.
   * @returns the untested functions in that top slice, ordered by descending risk score.
   */
  getUntestedTopDecile(topDecile: number = 0.1): Array<{
    functionName: string;
    filePath: string;
    lineNumber: number;
    riskScore: number;
    basis: string;
  }> {
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT
          f.name,
          f.file_path,
          f.line_number,
          COALESCE(hs.score, 0.0) as risk_score,
          PERCENT_RANK() OVER (ORDER BY COALESCE(hs.score, 0.0) DESC) as pct
        FROM functions f
        LEFT JOIN hotspot_scores hs ON hs.target = (f.file_path || ':' || f.name)
          AND hs.type = 'function'
        WHERE f.is_exported = 1
      ),
      best_coverage AS (
        SELECT DISTINCT function_name, file_path, basis FROM coverage_data
        WHERE covered = 1
      )
      SELECT
        r.name,
        r.file_path,
        r.line_number,
        r.risk_score,
        COALESCE(bc.basis, 'static-reach') as basis
      FROM ranked r
      LEFT JOIN best_coverage bc ON bc.function_name = r.name AND bc.file_path = r.file_path
      WHERE r.pct <= ?
        AND bc.basis IS NULL
      ORDER BY r.risk_score DESC
    `).all(topDecile) as any[];

    return rows.map((r: any) => ({
      functionName: r.name,
      filePath: r.file_path,
      lineNumber: r.line_number ?? 1,
      riskScore: r.risk_score,
      basis: r.basis,
    }));
  }
}
