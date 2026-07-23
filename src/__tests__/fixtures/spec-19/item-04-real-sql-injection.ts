/**
 * Spec-19 item 4 — sql-injection-risk TRUE positive (oracle: MUST fire at suggestion).
 * Dynamic table name via + concatenation in .query().
 * Legitimate SQL injection signal — user-controlled segment concatenated into query text.
 */
import { query } from './db';

async function getTableData(tableName: string, filter: string): Promise<unknown[]> {
  // Dynamic table name via string concatenation — real injection risk
  const rows = await query(
    'SELECT * FROM ' + tableName + ' WHERE status = \'' + filter + '\''
  );
  return rows;
}

export { getTableData };
