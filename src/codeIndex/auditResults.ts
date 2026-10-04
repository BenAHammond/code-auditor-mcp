/**
 * Audit-result storage — the `audit_results` table (full-audit payloads with
 * expiry). Extracted from `CodeIndexDB`; holds only the raw SQLite handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { tryParseJson } from './shared.js';

/**
 * Data access for the `audit_results` table: store full-audit payloads with a
 * 24-hour expiry, and retrieve them by id or most-recent.
 */
export class AuditResultsIndex {
  /**
   * Wrap the shared SQLite handle for audit-result storage.
   * @param db the SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Persist a full audit result and return its generated audit ID.
   * @param auditResult the full audit payload (summary, per-analyzer results, violations, recommendations, metadata).
   * @param projectPath the project the audit ran against, stored for scoped retrieval.
   * @returns the generated audit ID, unique per stored result.
   */
  async storeAuditResults(auditResult: any, projectPath: string): Promise<string> {
    const auditId = `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.db.prepare(`INSERT INTO audit_results (audit_id, timestamp, project_path, summary_json, analyzer_results_json, violations_json, recommendations_json, metadata_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      auditId,
      new Date().toISOString(),
      projectPath,
      JSON.stringify(auditResult.summary ?? {}),
      JSON.stringify(auditResult.analyzerResults ?? auditResult.results ?? {}),
      JSON.stringify(auditResult.violations ?? null),
      JSON.stringify(auditResult.recommendations ?? null),
      JSON.stringify(auditResult.metadata ?? {}),
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    );

    this.cleanupExpiredAudits();
    return auditId;
  }

  /**
   * Retrieve a stored audit result by ID, returning null when expired or absent.
   * @param auditId the audit ID previously returned by `storeAuditResults`.
   * @returns the parsed audit result, or null when the ID is unknown or the row has expired.
   */
  async getAuditResults(auditId: string): Promise<any | null> {
    const row = this.db.prepare('SELECT * FROM audit_results WHERE audit_id = ?').get(auditId) as any;
    if (!row) return null;
    if (new Date(row.expires_at) <= new Date()) {
      this.db.prepare('DELETE FROM audit_results WHERE audit_id = ?').run(auditId);
      return null;
    }
    return {
      auditId: row.audit_id,
      timestamp: new Date(row.timestamp),
      projectPath: row.project_path,
      summary: tryParseJson(row.summary_json),
      analyzerResults: tryParseJson(row.analyzer_results_json),
      violations: tryParseJson(row.violations_json),
      recommendations: tryParseJson(row.recommendations_json),
      metadata: tryParseJson(row.metadata_json),
      expiresAt: new Date(row.expires_at),
    };
  }

  /**
   * Return the most recent non-expired audit result, optionally scoped.
   * @param projectPath when given, restrict the search to audits for that project.
   * @param resultScope when given, further filter by the audit's stored `metadata.scope` (`full` or `scoped`).
   * @returns the most recent matching audit result, or null when none exist.
   */
  async getMostRecentAuditResults(
    projectPath?: string,
    resultScope?: 'full' | 'scoped'
  ): Promise<any | null> {
    const now = new Date().toISOString();
    let row: any;

    const scopeFilter = resultScope
      ? "AND json_extract(metadata_json, '$.scope') = ?"
      : '';

    if (projectPath) {
      const params: any[] = [projectPath, now];
      if (resultScope) params.push(resultScope);
      row = this.db.prepare(
        `SELECT * FROM audit_results WHERE project_path = ? AND expires_at > ? ${scopeFilter} ORDER BY timestamp DESC, rowid DESC LIMIT 1`
      ).get(...params);
    } else {
      const params: any[] = [now];
      if (resultScope) params.push(resultScope);
      row = this.db.prepare(
        `SELECT * FROM audit_results WHERE expires_at > ? ${scopeFilter} ORDER BY timestamp DESC, rowid DESC LIMIT 1`
      ).get(...params);
    }
    if (!row) return null;
    return {
      auditId: row.audit_id,
      timestamp: new Date(row.timestamp),
      projectPath: row.project_path,
      summary: tryParseJson(row.summary_json),
      analyzerResults: tryParseJson(row.analyzer_results_json),
      violations: tryParseJson(row.violations_json),
      recommendations: tryParseJson(row.recommendations_json),
      metadata: tryParseJson(row.metadata_json),
      expiresAt: new Date(row.expires_at),
    };
  }

  private cleanupExpiredAudits(): void {
    this.db.prepare('DELETE FROM audit_results WHERE expires_at < ?').run(new Date().toISOString());
  }
}
