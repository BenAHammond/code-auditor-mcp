/**
 * queryWithSubquery — PARSER REGRESSION GUARD for SQL subquery alias handling.
 *
 * Exercises the `extractAliasIdentifiers()` subquery bare-alias regex
 * (`FROM (SELECT ...) <alias>`) and the explicit-AS-alias regex
 * (`FROM/JOIN <table> AS <alias>`).
 *
 * Real tables (must appear in violations):
 *   - users (FROM users)
 *   - orders (SELECT ... FROM orders inside subquery)
 *
 * Aliases (must NOT appear in violations):
 *   - stats (subquery bare alias — `) AS stats`)
 *   - u (table alias — FROM users u)
 *   - cnt (column alias — COUNT(*) AS cnt)
 *
 * The 3-char `cnt` column alias is a near-miss: it's exactly length 3
 * so it passes the minimum-length guard. However, it's not preceded by
 * FROM/JOIN/INSERT/UPDATE/DELETE keywords, so it should not be extracted
 * by the SQL patterns.
 */

import { db } from './fake-db.js';

export function queryWithSubquery(): void {
  db.exec(`
    SELECT u.name, stats.cnt
    FROM users u
    JOIN (
      SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id
    ) AS stats ON u.id = stats.user_id
  `);
}
