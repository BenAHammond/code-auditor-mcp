/**
 * Contains a query inside a loop — should trigger loop-query violation.
 */

interface User {
  id: number;
  name: string;
}

async function fetchUserOrders(userIds: number[]): Promise<Record<number, any[]>> {
  const results: Record<number, any[]> = {};

  for (const userId of userIds) {
    // This query inside a loop is the N+1 pattern
    const orders = await db.query('SELECT * FROM orders WHERE user_id = $1', [userId]);
    results[userId] = orders;
  }

  return results;
}

// Mock db for compilation
const db = {
  query: async (_sql: string, _params: any[]): Promise<any[]> => []
};
