/**
 * Acknowledged FP — mechanism #6 (static array .map().join() in template)
 * @see docs/sql-injection-fp-defect.md
 *
 * Static array transformed via .map().join() is safe, but the analyzer
 * can't resolve the result as a compile-time constant.
 */
import { getDB } from './fake-db';

const COLUMNS = ['id', 'name', 'email'] as const;

export function queryWithColumns(): void {
  const db = getDB();
  const cols = COLUMNS.map(c => `\`${c}\``).join(', ');
  db.prepare(
    `SELECT ${cols} FROM users`
  ).bind().all();
}
