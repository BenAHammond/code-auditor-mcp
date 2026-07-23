/**
 * Only references known tables — should not trigger any schema violations.
 */

async function getUsers(): Promise<void> {
  await db.exec('SELECT * FROM users WHERE active = true');
}

async function getHighValueOrders(): Promise<void> {
  await db.exec('SELECT * FROM orders WHERE total > 100');
}

async function getProductsInStock(): Promise<void> {
  await db.exec('SELECT * FROM products WHERE stock > 0');
}

// Mock db for compilation
const db = {
  exec: async (_sql: string): Promise<void> => {},
};
