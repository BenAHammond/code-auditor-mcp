/**
 * queryWithCTE — PARSER REGRESSION GUARD for SQL CTE handling.
 *
 * Exercises the `extractAliasIdentifiers()` CTE regex
 * (`WITH <name> AS (...)`) which ensures CTE names are excluded
 * from extracted table references.
 *
 * Real tables (must appear in violations):
 *   - orders (SELECT in CTE body)
 *   - customers (JOIN in outer query)
 *
 * Aliases/CTE names (must NOT appear in violations):
 *   - RecentOrders (CTE name — WITH RecentOrders AS)
 *   - ro (table alias — FROM RecentOrders ro)
 *   - c (table alias — JOIN customers c)
 *
 * Also exercises the v3.4.8 minimum-length guard: single-char aliases
 * like 'ro' and 'c' are filtered by length < 3. The 2-char 'ro' is
 * caught by alias extraction.
 */

import { db } from './fake-db.js';

export function queryWithCTE(): void {
  db.exec(`
    WITH RecentOrders AS (
      SELECT * FROM orders WHERE created_at > '2024-01-01'
    )
    SELECT ro.*, c.name
    FROM RecentOrders ro
    JOIN customers c ON ro.customer_id = c.id
  `);
}
