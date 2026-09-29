/**
 * connection-config.ts — `hardcoded-connection` (rule 28) at production scale.
 *
 * A realistic connection bootstrap: it resolves a database DSN from a
 * deployment stage, and — the defect this rule exists to catch — falls back to
 * hardcoded credentials for several drivers. Every connection-string shape the
 * detector's grammar covers appears as a real string literal.
 *
 * `hardcoded-connection` reads the `string-literals` fact, so its input position
 * is exactly the `string` / `template_string` AST node, and its anchor is that
 * literal's own start line — NOT an enclosing statement — which is why two
 * literals in one expression fire on two distinct lines. A connection URL that
 * appears only in a comment, or only behind `process.env`, never reaches that
 * position and must stay quiet.
 *
 * The five recognized shapes are:
 *   mongodb://  postgres://  mysql://  Server=…;Database=…  Data Source=…;Initial Catalog=…
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires hardcoded-connection 35 — postgres:// URI literal
 *   @quiet hardcoded-connection 37 — postgresql:// is NOT matched (regex is postgres://) — false negative
 *   @fires hardcoded-connection 42 — mysql:// URI literal
 *   @fires hardcoded-connection 47 — mongodb:// URI literal
 *   @quiet hardcoded-connection 52 — redis:// is outside the pattern list
 *   @fires hardcoded-connection 57 — ADO.NET Server=…;Database= pair
 *   @fires hardcoded-connection 62 — Data Source=…;Initial Catalog= pair
 *   @quiet hardcoded-connection 67 — env-var indirection is not a string literal
 */

declare const process: any;

/** Select the PostgreSQL DSN for a deployment stage. */
export function postgresDsn(stage: string): string {
  if (stage === 'production') {
    return 'postgres://app:2f4b91@db.internal:5432/orders';
  }
  return 'postgresql://app:2f4b91@localhost:5432/orders_dev';
}

/** The MySQL DSN for the legacy shard. */
export function legacyMysqlDsn(): string {
  return 'mysql://replica:readonly@shard-3:3306/orders';
}

/** The analytics warehouse connection. */
export function analyticsMongoDsn(): string {
  return 'mongodb://reporter:secret@mongo-0:27017/events';
}

/** The cache cluster — NOT a database, and outside the pattern list. */
export function cacheRedisDsn(): string {
  return 'redis://cache-0:6379/0';
}

/** A Windows service that stores its connection as a raw ADO.NET pair. */
export function windowsServiceConn(): string {
  return 'Server=sql-primary;Database=orders;User Id=sa;Password=hunter2;';
}

/** The legacy reporting service's OLE DB / ODBC pair. */
export function reportingOdbcConn(): string {
  return 'Data Source=reporting-01;Initial Catalog=orders;Integrated Security=true;';
}

/** The correctly-fixed path: read the DSN from the environment. */
export function envDsn(): string {
  return process.env.DATABASE_URL;
}
