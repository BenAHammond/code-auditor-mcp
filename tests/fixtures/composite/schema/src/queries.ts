/** Mock DB read interface. */
export interface DB {
  query(sql: string): unknown;
}

/** Read a known snake_case table — no schema finding. */
export function listUsers(db: DB): unknown {
  return db.query('SELECT * FROM users');
}

/** Read a table declared in no migration — unknown-table. */
export function listAuditLogs(db: DB): unknown {
  return db.query('SELECT * FROM audit_logs');
}

/** Read a camelCase table — table-naming-convention. */
export function listUserProfiles(db: DB): unknown {
  return db.query('SELECT * FROM userProfiles');
}
