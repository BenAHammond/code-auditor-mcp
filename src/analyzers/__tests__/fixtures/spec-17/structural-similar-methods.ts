/**
 * Spec-17 R8 Fixture 12: structural-similar-methods
 * Report section: R3.3 — dry/structural-similarity rule-id split
 *
 * These two functions have the same structure (token-kind pattern) but
 * different identifiers and literal values. They should produce:
 * - ZERO `dry/duplicate` findings (not token-identical)
 * - `dry/structural-similarity` findings (same token-kind sequence)
 *   per the structural similarity rules.
 */

export function processUserOrders(userId: number): string[] {
  const results: string[] = [];
  const connection = createConnection("orders_db");

  try {
    const query = "SELECT order_id, status FROM orders WHERE user_id = ?";
    const rows = connection.execute(query, [userId]);

    for (const row of rows) {
      if (row.status === "active") {
        results.push(`Order ${row.order_id}: pending`);
      } else if (row.status === "shipped") {
        results.push(`Order ${row.order_id}: delivered`);
      } else {
        results.push(`Order ${row.order_id}: unknown`);
      }
    }
  } finally {
    connection.close();
  }

  return results;
}

export function processAdminTasks(adminId: number): string[] {
  const results: string[] = [];
  const connection = createConnection("tasks_db");

  try {
    const query = "SELECT task_id, priority FROM tasks WHERE admin_id = ?";
    const rows = connection.execute(query, [adminId]);

    for (const row of rows) {
      if (row.priority === "high") {
        results.push(`Task ${row.task_id}: urgent`);
      } else if (row.priority === "medium") {
        results.push(`Task ${row.task_id}: scheduled`);
      } else {
        results.push(`Task ${row.task_id}: backlog`);
      }
    }
  } finally {
    connection.close();
  }

  return results;
}

// Helper to satisfy compilation
function createConnection(name: string): { execute(query: string, params: unknown[]): Array<Record<string, unknown>>; close(): void } {
  throw new Error("stub");
}
