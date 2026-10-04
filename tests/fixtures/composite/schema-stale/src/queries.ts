/** Mock DB read interface. */
export interface D1Database {
  query(sql: string): unknown;
}

/** Read a create-only table — known, no schema finding. */
export function listUsers(db: D1Database): unknown {
  return db.query('SELECT * FROM users');
}

/** Read a table dropped in 002 — stale-table-reference. */
export function listLegacyOrders(db: D1Database): unknown {
  return db.query('SELECT * FROM legacy_orders');
}

/** Read a table never created — unknown-table. */
export function listGhost(db: D1Database): unknown {
  return db.query('SELECT * FROM ghost_table');
}
