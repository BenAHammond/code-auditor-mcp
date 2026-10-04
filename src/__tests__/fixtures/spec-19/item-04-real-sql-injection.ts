/**
 * Spec-19 item 4 — sql-injection-risk TRUE positive (oracle: MUST fire at critical).
 * Dynamic table name via + concatenation in .query().
 * Legitimate SQL injection signal — user-controlled segment concatenated into query text.
 */
import { Pool } from 'pg';

// Spec 70 R4 — handle proven by the manifest-package import: `pool` resolves to
// `new Pool()` whose constructor is a named import from `pg` (in the manifest).
// The SELECT argument is dynamic (string concatenation) so R3 cannot prove the
// handle; the import is the proof.
const pool = new Pool();

async function getTableData(tableName: string, filter: string): Promise<unknown[]> {
  // Dynamic table name via string concatenation — real injection risk
  const result = await pool.query(
    'SELECT * FROM ' + tableName + ' WHERE status = \'' + filter + '\''
  );
  return result.rows;
}

export { getTableData };
