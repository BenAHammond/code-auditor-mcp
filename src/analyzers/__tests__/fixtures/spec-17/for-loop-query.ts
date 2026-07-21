/**
 * Spec-17 R8 Fixture 15: for-loop-query
 * Report section: R4.1 — Loop-query findings with correct locations
 *
 * A database query inside a `for` loop should produce a `loop-query`
 * finding where:
 * - The location cites the query-call line (NOT line 1)
 * - The message cites the enclosing loop span line
 */

export function processUsers(db: {
  query(sql: string, params: unknown[]): unknown[];
}): void {
  const users = ["alice", "bob", "charlie"];

  for (const user of users) {
    // This query is inside the for loop — N+1 pattern
    const result = db.query(
      "SELECT * FROM orders WHERE username = ?",
      [user]
    );
    console.log(result);
  }
}
