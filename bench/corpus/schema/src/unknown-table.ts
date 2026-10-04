/**
 * References a nonexistent table via db.exec — should trigger unknown-table violation.
 */
import { getDB } from './db';

async function getInventory(): Promise<void> {
  // 'inventory' is not in knownTables — this should trigger an unknown-table finding
  await db.exec('SELECT * FROM inventory WHERE quantity > 0');
}

async function getUnknownWidgets(): Promise<void> {
  await db.exec('DELETE FROM widgets WHERE active = 0');
}

// Real D1 handle (getDB(): D1Database) — resolution proves `db` is a DB handle.
const db = getDB();
