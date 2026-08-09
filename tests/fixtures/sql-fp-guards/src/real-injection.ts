/**
 * TRUE POSITIVE — real SQL injection risk
 * Unsanitized user input `${req.body.name}` in SQL template.
 * Must produce exactly 1 sql-injection-risk violation.
 */

import { getDB } from './fake-db';

// Simulating request body — unsanitized user input
const req = {
  body: {
    name: "'; DROP TABLE users; --"
  }
};

export function vulnerableQuery(): void {
  const db = getDB();
  // Using raw string interpolation with unsanitized user input
  // This is vulnerable to SQL injection — the analyzer MUST flag it
  db.exec(`SELECT * FROM users WHERE name = '${req.body.name}'`);
}
