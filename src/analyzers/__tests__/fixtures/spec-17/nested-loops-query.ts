/**
 * Spec-17 R8 Fixture 16: nested-loops-query
 * Report section: R4.2 — Nested-loop attribution
 *
 * A query inside nested loops should produce a `loop-query` finding where:
 * - The innermost enclosing loop is cited
 * - The nesting depth (>1) is noted in the message
 * - The location is the query-call line, never line 1
 */

export function checkPermissions(db: {
  query(sql: string, params: unknown[]): unknown[];
}): void {
  const users = ["admin", "editor"];
  const resources = ["page:home", "page:settings", "api:users"];

  for (const user of users) {
    for (const resource of resources) {
      // Query inside nested loops — should cite innermost loop (line ~18)
      // and note depth 2 in the message
      const result = db.query(
        "SELECT * FROM permissions WHERE username = ? AND resource = ?",
        [user, resource]
      );
      console.log(result);
    }
  }
}
