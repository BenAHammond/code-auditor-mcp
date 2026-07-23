/**
 * References a nonexistent table via db.exec — should trigger unknown-table violation.
 */

async function getInventory(): Promise<void> {
  // 'inventory' is not in knownTables — this should trigger an unknown-table finding
  await db.exec('SELECT * FROM inventory WHERE quantity > 0');
}

async function getUnknownWidgets(): Promise<void> {
  await db.exec('DELETE FROM widgets WHERE active = 0');
}

// Mock db for compilation
const db = {
  exec: async (_sql: string): Promise<void> => {},
};
