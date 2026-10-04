/**
 * TRUE POSITIVE — real SQL injection risk
 * Unsanitized user input `${req.body.name}` in SQL template.
 * Must produce exactly 1 sql-injection-risk violation.
 */

import Database from 'better-sqlite3';

// Simulating request body — unsanitized user input
const req = {
  body: {
    name: "'; DROP TABLE users; --"
  }
};

export function vulnerableQuery(): void {
  // Provenanced receiver — `new Database()` resolves to the better-sqlite3
  // manifest package (Spec 70 R4), so the dynamic SQL argument is a proven
  // handle and the raw interpolation is flagged.
  const db = new Database(':memory:');
  // Using raw string interpolation with unsanitized user input
  // This is vulnerable to SQL injection — the analyzer MUST flag it
  db.exec(`SELECT * FROM users WHERE name = '${req.body.name}'`);
}
