/**
 * Only references known tables — should not trigger any schema violations.
 */
import { getDB } from './db';

async function getUsers(): Promise<void> {
  await db.exec('SELECT * FROM users WHERE active = true');
}

async function getHighValueOrders(): Promise<void> {
  await db.exec('SELECT * FROM orders WHERE total > 100');
}

async function getProductsInStock(): Promise<void> {
  await db.exec('SELECT * FROM products WHERE stock > 0');
}

// Real D1 handle (getDB(): D1Database) — resolution proves `db` is a DB handle.
const db = getDB();
