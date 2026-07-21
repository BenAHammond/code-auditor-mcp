/**
 * Spec-17 R8 Fixture 8: sql-tagged-template
 * Report section: R2.1 — SQL-context-only extraction
 *
 * sql`SELECT * FROM heroes` should produce EXACTLY ONE unknown-table
 * finding ("heroes" is not a known table), and the finding should be
 * on the correct line (where the SQL template is, not line 1).
 */

import { sql } from "drizzle-orm";

export function getHeroes(): Promise<unknown[]> {
  return sql`SELECT * FROM heroes`;
}

export function getVillains(): Promise<unknown[]> {
  // This line should also produce a finding — "villains" is unknown
  const query = sql`SELECT name, power FROM villains WHERE active = true`;
  return query;
}
