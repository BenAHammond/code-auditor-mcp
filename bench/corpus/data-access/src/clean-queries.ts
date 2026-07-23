/**
 * Clean query patterns — should not trigger any data-access violations.
 */

async function fetchAllOrders(userIds: number[]): Promise<any[]> {
  // Batch query — no loop, this is the correct pattern
  const orders = await db.query(
    'SELECT * FROM orders WHERE user_id = ANY($1)',
    [userIds]
  );
  return orders;
}

async function fetchUser(userId: number): Promise<any> {
  const result = await db.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );
  return result[0] || null;
}

// Mock db for compilation
const db = {
  query: async (_sql: string, _params: any[]): Promise<any[]> => []
};
