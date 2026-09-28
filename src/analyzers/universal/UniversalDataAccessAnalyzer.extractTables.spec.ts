/**
 * Unit tests for the data-access `extractTables` guards added in the four-bug
 * fix (#127):
 *   - JS built-in `.from(...)` construction (Array.from / Buffer.from /
 *     Uint8Array.from) must not be read as a SQL/ORM `.from(table)`.
 *   - SQL aggregates/keywords captured by the `FROM x` / `UPDATE x` patterns
 *     (`MIN`, `MAX` from `EXTRACT(YEAR FROM MIN(...))`, `SKIP` from
 *     `FOR UPDATE SKIP LOCKED`) must be dropped, not surfaced as tables.
 */

import { describe, it, expect } from 'vitest';
import { extractTables, DEFAULT_DATA_ACCESS_CONFIG } from './UniversalDataAccessAnalyzer.js';

describe('extractTables — JS .from / SQL-keyword guards', () => {
  it('reads the real .from(table) but not Array.from(...) argument', () => {
    const text = 'db.select().from(organizations).where(inArray(organizations.id, Array.from(accessibleOrgIds)))';
    expect(extractTables(text, DEFAULT_DATA_ACCESS_CONFIG)).toEqual(['organizations']);
  });

  it('does not read Buffer.from(...) argument as a table', () => {
    const text = "db.execute(Buffer.from('SELECT 1'))";
    expect(extractTables(text, DEFAULT_DATA_ACCESS_CONFIG)).toEqual([]);
  });

  it('does not read EXTRACT(YEAR FROM MIN(...)) aggregates as tables', () => {
    const text = 'db.select({ min: sql`EXTRACT(YEAR FROM MIN(sampleDate))`, max: sql`EXTRACT(YEAR FROM MAX(sampleDate))` })';
    expect(extractTables(text, DEFAULT_DATA_ACCESS_CONFIG)).toEqual([]);
  });

  it('does not read FOR UPDATE SKIP LOCKED as a table', () => {
    const text = 'db.execute(`SELECT * FROM users WHERE id = 1 FOR UPDATE SKIP LOCKED`)';
    expect(extractTables(text, DEFAULT_DATA_ACCESS_CONFIG)).toEqual(['users']);
  });

  it('does not read Drizzle sql.join(fragments, sep) first argument as a table', () => {
    const text = "baseQuery.where(sql`${sql.join(conditions, sql` AND `)}`)";
    expect(extractTables(text, DEFAULT_DATA_ACCESS_CONFIG)).toEqual([]);
  });

  it('does not count a CTE alias as a table (WITH recent_orders AS … FROM recent_orders)', () => {
    const text = `WITH recent_orders AS (
      SELECT * FROM orders WHERE created_at > '2024-01-01'
    )
    SELECT * FROM recent_orders JOIN customers c ON c.id = recent_orders.customer_id`;
    expect(extractTables(text, DEFAULT_DATA_ACCESS_CONFIG)).toEqual(['orders', 'customers']);
  });

  it('does not count a RECURSIVE CTE name with a column list as a table', () => {
    const text = `WITH RECURSIVE deps(id, name) AS (
      SELECT 1, 'a'
      UNION ALL
      SELECT deps.id + 1, 'b' FROM deps
    )
    SELECT * FROM deps`;
    expect(extractTables(text, DEFAULT_DATA_ACCESS_CONFIG)).toEqual([]);
  });

  it('does not count a comma-separated CTE sibling as a table', () => {
    const text = `WITH ranked AS (SELECT * FROM functions f),
      coverage AS (SELECT * FROM coverage_data WHERE covered = 1)
    SELECT * FROM ranked r LEFT JOIN coverage c ON c.id = r.id`;
    expect(extractTables(text, DEFAULT_DATA_ACCESS_CONFIG)).toEqual(['functions', 'coverage_data']);
  });
});
