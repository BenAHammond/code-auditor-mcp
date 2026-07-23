/**
 * Spec-19 R1 diagnostic fixture — items 11, 12, 17 as class methods.
 * The original false positives were class methods; reproducing within a class
 * to match the analyzeClass → findNodeByLocation → getComplexity code path.
 *
 * All branch operators (||, &&) replaced with ?? so calculateCyclomaticComplexity
 * returns exactly 1 for each method. ?? is not counted as a branch by the
 * complexity calculator (it only counts && and || binary operators).
 */

import { query } from './db';

interface WeeklyStats {
  day: string;
  count: number;
  revenue: number;
  newUsers: number;
  churnedUsers: number;
}

/**
 * ReportGenerator — contains the long-but-simple method from item 11
 * and the data-assembly method from item 17.
 */
export class ReportGenerator {

  /**
   * Generates the weekly digest report for the dashboard.
   *
   * This function queries the analytics database for the past 7 days,
   * maps over the results to normalize field names and fill gaps
   * where certain metrics were not recorded (edge case: weekends
   * with zero activity), and returns an ordered array of daily
   * statistics suitable for rendering in the weekly digest card.
   *
   * The normalization step handles the following cases:
   * - Missing revenue fields (null → 0)
   * - Missing new-user counts (null → 0)
   * - Missing churn counts (null → 0)
   * - Timestamp-to-day conversion (UTC → local)
   *
   * Performance note: the query itself is a single SELECT; the
   * .map() is pure data transformation on an expected 7-row result
   * set. The function is long only because the JSDoc is thorough.
   */
  async generateWeeklyDigest(): Promise<WeeklyStats[]> {
    // Single SQL query — no conditionals, no loops in the query logic
    const rows = await query<Array<Record<string, unknown>>>(
      `SELECT timestamp, event_count, revenue_cents, new_users, churned_users
       FROM analytics.daily_stats
       WHERE timestamp >= now() - interval '7 days'
       ORDER BY timestamp ASC`
    );

    // Use ?? (not ||) — ?? is not counted as a branch by cyclomatic complexity
    return rows.map((row: Record<string, unknown>) => ({
      day: String(row.timestamp).slice(0, 10),
      count: Number(row.event_count ?? 0),
      revenue: Number(row.revenue_cents ?? 0) / 100,
      newUsers: Number(row.new_users ?? 0),
      churnedUsers: Number(row.churned_users ?? 0),
    }));
  }

  /**
   * Assembles a payload from a raw record.
   * Pure data shaping — object spread, property assignment, zero branches.
   * Uses ?? (not ||) so complexity stays at 1.
   */
  assemblePayload(record: Record<string, any>): Record<string, any> {
    const { id, fields, meta, tags } = record;

    const attributes = {
      ...fields,
      source: 'sync-engine',
      recordId: id,
    };

    const labels = (tags ?? []).map((t: string) => t.toLowerCase().trim());

    const payload: Record<string, any> = {
      id,
      displayName: (fields?.display_name ?? fields?.name ?? id),
      attributes,
      createdAt: (meta?.created ?? ''),
      updatedAt: (meta?.updated ?? ''),
      version: (meta?.version ?? 0),
      labels,
      normalized: true,
    };

    return payload;
  }
}
