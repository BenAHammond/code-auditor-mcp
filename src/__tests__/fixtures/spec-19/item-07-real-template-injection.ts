/**
 * Spec-19 item 7 — sql-injection-risk TRUE positive (oracle: MUST fire at suggestion).
 * Template literal in raw query string with ${filter}.
 * User-controlled filter interpolated into SQL string.
 */
import { query } from './db';

interface Report {
  id: string;
  title: string;
  status: string;
}

async function searchReports(filter: string): Promise<Report[]> {
  // Template literal with user-controlled filter — real injection risk
  const rows = await query<Report[]>(
    `SELECT id, title, status FROM reports WHERE title LIKE '%${filter}%' ORDER BY created_at DESC`
  );
  return rows;
}

export { searchReports };
