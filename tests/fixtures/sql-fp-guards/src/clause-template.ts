/**
 * Safe pattern — literal clause-template `.join(' AND ')`.
 *
 * The `where` array holds only literal `col = ?` fragments; the values are
 * bound out-of-band via `.all(...params)`, so the joined text is only
 * placeholders, never raw data.
 */
import { getDB } from './fake-db';

export function queryFindings(runId: string, rule?: string): void {
  const db = getDB();
  const where: string[] = ['run_id = ?'];
  const params: unknown[] = [runId];
  if (rule) {
    where.push('rule = ?');
    params.push(rule);
  }
  db.prepare(
    `SELECT run_id, rule FROM findings WHERE ${where.join(' AND ')}`
  ).all(...params);
}
