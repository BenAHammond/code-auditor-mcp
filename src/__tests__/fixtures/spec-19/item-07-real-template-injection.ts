/**
 * Spec-19 item 7 — sql-injection-risk TRUE positive (oracle: MUST fire at suggestion).
 * Template literal in raw query string with ${filter}.
 * User-controlled filter interpolated into SQL string.
 */
import Database from 'better-sqlite3';

// Spec 70 R4 — handle proven by the manifest-package import; the SELECT argument
// is dynamic (template interpolation) so R3 cannot prove the handle.
const db = new Database(':memory:');

interface Report {
  id: string;
  title: string;
  status: string;
}

async function searchReports(filter: string): Promise<Report[]> {
  // Template literal with user-controlled filter — real injection risk
  const rows = await db.prepare(
    `SELECT id, title, status FROM reports WHERE title LIKE '%${filter}%' ORDER BY created_at DESC`
  ).all();
  return rows;
}

export { searchReports };
