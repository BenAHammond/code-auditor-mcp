/**
 * Contains a query inside a loop — should trigger loop-query violation.
 *
 * DB access is provenanced via a real drizzle-orm import (`drizzle(env.DB)`),
 * not a bare `{ query: … }` mock — so the analyzer can extract the `orders`
 * table and apply missing-org-filter on top of the loop-query. (Spec 62 A1.3.)
 */

import { drizzle } from 'drizzle-orm';

interface User {
  id: number;
  name: string;
}

const env = { DB: { exec: (_sql: string) => [] } };
const db = drizzle(env.DB as any);

async function fetchUserOrders(userIds: number[]): Promise<Record<number, any[]>> {
  const results: Record<number, any[]> = {};

  for (const userId of userIds) {
    // This query inside a loop is the N+1 pattern
    const orders = await db.query('SELECT * FROM orders WHERE user_id = $1', [userId]);
    results[userId] = orders;
  }

  return results;
}
