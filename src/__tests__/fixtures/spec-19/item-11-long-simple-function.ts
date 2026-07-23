/**
 * Spec-19 item 11 — method-complexity false positive.
 * 52-line function of cyclomatic complexity 1:
 * one SQL call + .map() + large JSDoc comment.
 * No if/for/while/ternary/&&/|| branches.
 * The violation should NOT fire: complexity is 1, threshold is 50.
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
async function generateWeeklyDigest(): Promise<WeeklyStats[]> {
  // Single SQL query — no conditionals, no loops in the query logic
  const rows = await query<Array<Record<string, unknown>>>(
    `SELECT timestamp, event_count, revenue_cents, new_users, churned_users
     FROM analytics.daily_stats
     WHERE timestamp >= now() - interval '7 days'
     ORDER BY timestamp ASC`
  );

  return rows.map((row: Record<string, unknown>) => ({
    day: String(row.timestamp).slice(0, 10),
    count: Number(row.event_count) || 0,
    revenue: Number(row.revenue_cents) / 100 || 0,
    newUsers: Number(row.new_users) || 0,
    churnedUsers: Number(row.churned_users) || 0,
  }));
}

export { generateWeeklyDigest };
