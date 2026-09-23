/**
 * Clean of the N+1 anti-pattern (batch + single-row, no loop) — but the
 * queries still target declared tenant tables (`orders`, `users`) without an
 * org filter, so they fire missing-org-filter (not loop-query, not
 * unfiltered-query — both have a WHERE clause).
 *
 * DB access is provenanced via a real drizzle-orm import (`drizzle(env.DB)`).
 * (Spec 62 A1.3.)
 */

import { drizzle } from 'drizzle-orm';

const env = { DB: { exec: (_sql: string) => [] } };
const db = drizzle(env.DB as any);

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
