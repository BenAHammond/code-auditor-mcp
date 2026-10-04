/**
 * Acknowledged FP — mechanism #3 (ternary of static string constants)
 * @see docs/sql-injection-fp-defect.md
 *
 * Ternary choosing between two compile-time constants is safe, but
 * the analyzer can't evaluate the branch.
 */
import Database from 'better-sqlite3';

const USE_PROD = true;

export function queryConditional(): void {
  const db = new Database(':memory:');
  const table = USE_PROD ? 'users' : 'users_staging';
  db.prepare(
    `SELECT * FROM ${table} LIMIT 10`
  ).bind().all();
}
