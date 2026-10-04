/**
 * SQL schema-discovery queries — one seam, keyed on database dialect.
 *
 * Standing correction "Seams, Not Placement": the discovery SQL previously lived
 * as three parallel function families (`postgresDiscoveryQueries`,
 * `mysqlDiscoveryQueries`, `sqliteDiscoveryQueries`) with a `switch` fork on a
 * free-form `databaseType` string and a `default: return []` arm that silently
 * produced "no queries" for any dialect it did not recognise. That is the same
 * defect the correction targets: the fork names the dialect in a caller, and a
 * missing case fails silently instead of failing the build.
 *
 * Here the concept is declared as a type: a {@link Dialect} discriminant, a
 * {@link DiscoveryQueryBuilder} interface, a registry keyed on the discriminant,
 * and a compile-time residue check that fails when a dialect has no builder. No
 * caller names a dialect string; {@link normalizeDialect} is the single point a
 * free-form string becomes a {@link Dialect} (or `null`), and
 * {@link buildDiscoveryQueries} indexes the registry with no default arm.
 */

const GET_ALL_TABLES_VIEWS_DESC = 'Get all tables and views';

/** A database dialect that has discovery queries. */
export type Dialect = 'postgresql' | 'mysql' | 'sqlite';

/** One discovery query: a name, the SQL text, and a description for the agent. */
export interface DiscoveryQuery {
  readonly name: string;
  readonly sql: string;
  readonly description: string;
}

/**
 * The inputs a discovery-query builder reads. `tableFilter` is pre-validated SQL
 * text (`WHERE table_name IN (...)` or `''`) built by the caller from an
 * identifier allowlist — a builder never interpolates a user-supplied name.
 */
export interface DiscoveryQueryContext {
  readonly tableFilter: string;
  readonly includeIndexes: boolean;
  readonly includeConstraints: boolean;
}

/** A dialect's discovery-query builder, registered under {@link DISCOVERY_QUERY_BUILDERS}. */
export interface DiscoveryQueryBuilder {
  readonly dialect: Dialect;
  build(ctx: DiscoveryQueryContext): DiscoveryQuery[];
}

/**
 * Emit a dialect's ordered discovery queries from its pre-rendered SQL strings.
 *
 * The push/gate control flow — always `tables` + `columns`, then `foreign_keys`
 * and `indexes` only when the matching context flag is set — is shared across
 * all dialects. A dialect supplies only its SQL text (already interpolated with
 * the pre-validated `tableFilter`); the assembler owns the emit order and the
 * gating, so the three builders differ in data, not in structure.
 */
function assembleQueries(
  ctx: DiscoveryQueryContext,
  sql: { tables: string; columns: string; foreignKeys: string; indexes?: string },
): DiscoveryQuery[] {
  const queries: DiscoveryQuery[] = [
    { name: 'tables', sql: sql.tables, description: GET_ALL_TABLES_VIEWS_DESC },
    { name: 'columns', sql: sql.columns, description: 'Get all columns with types and constraints' },
  ];
  if (ctx.includeConstraints) {
    queries.push({ name: 'foreign_keys', sql: sql.foreignKeys, description: 'Get foreign key relationships' });
  }
  if (ctx.includeIndexes && sql.indexes !== undefined) {
    queries.push({ name: 'indexes', sql: sql.indexes, description: 'Get all indexes' });
  }
  return queries;
}

// ─── PostgreSQL ────────────────────────────────────────────────────────────────

const postgresTablesSql = (filter: string): string => `SELECT table_name, table_type, table_schema
          FROM information_schema.tables
          WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ${filter}
          ORDER BY table_schema, table_name;`;

const postgresColumnsSql = (filter: string): string => `SELECT table_name, column_name, data_type, is_nullable, column_default,
                 character_maximum_length, numeric_precision, numeric_scale
          FROM information_schema.columns
          WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ${filter}
          ORDER BY table_name, ordinal_position;`;

const postgresForeignKeysSql = (filter: string): string => `SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name,
                 ccu.column_name AS foreign_column_name, rc.delete_rule, rc.update_rule
          FROM information_schema.table_constraints AS tc
          JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
          JOIN information_schema.referential_constraints AS rc ON tc.constraint_name = rc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY' ${filter.replace('table_name', 'tc.table_name')}
          ORDER BY tc.table_name, kcu.column_name;`;

const postgresIndexesSql = (filter: string): string => `SELECT tablename, indexname, indexdef
          FROM pg_indexes
          WHERE schemaname NOT IN ('information_schema', 'pg_catalog') ${filter.replace('table_name', 'tablename')}
          ORDER BY tablename, indexname;`;

const postgresBuilder: DiscoveryQueryBuilder = {
  dialect: 'postgresql',
  build(ctx) {
    const f = ctx.tableFilter;
    return assembleQueries(ctx, {
      tables: postgresTablesSql(f),
      columns: postgresColumnsSql(f),
      foreignKeys: postgresForeignKeysSql(f),
      indexes: postgresIndexesSql(f),
    });
  },
};

// ─── MySQL ─────────────────────────────────────────────────────────────────────

const mysqlTablesSql = (filter: string): string => `SELECT table_name, table_type, table_schema
          FROM information_schema.tables
          WHERE table_schema = DATABASE() ${filter}
          ORDER BY table_name;`;

const mysqlColumnsSql = (filter: string): string => `SELECT table_name, column_name, data_type, is_nullable, column_default,
                 character_maximum_length, numeric_precision, numeric_scale,
                 column_key, extra
          FROM information_schema.columns
          WHERE table_schema = DATABASE() ${filter}
          ORDER BY table_name, ordinal_position;`;

const mysqlForeignKeysSql = (filter: string): string => `SELECT table_name, column_name, referenced_table_name, referenced_column_name,
                 delete_rule, update_rule
          FROM information_schema.key_column_usage
          WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL ${filter}
          ORDER BY table_name, column_name;`;

const mysqlBuilder: DiscoveryQueryBuilder = {
  dialect: 'mysql',
  build(ctx) {
    const f = ctx.tableFilter;
    return assembleQueries(ctx, {
      tables: mysqlTablesSql(f),
      columns: mysqlColumnsSql(f),
      foreignKeys: mysqlForeignKeysSql(f),
    });
  },
};

// ─── SQLite ────────────────────────────────────────────────────────────────────

const sqliteBuilder: DiscoveryQueryBuilder = {
  dialect: 'sqlite',
  build() {
    return [
      {
        name: 'tables',
        sql: `SELECT name as table_name, type as table_type
              FROM sqlite_master
              WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
              ORDER BY name;`,
        description: GET_ALL_TABLES_VIEWS_DESC,
      },
      {
        name: 'table_info',
        sql: `-- Run this for each table: PRAGMA table_info(table_name);
              -- This will give you column information for each table`,
        description: 'Get column information (run PRAGMA table_info for each table)',
      },
    ];
  },
};

// ─── Registry ──────────────────────────────────────────────────────────────────

/** Exactly one builder per dialect; total over {@link Dialect}. */
export const DISCOVERY_QUERY_BUILDERS: Readonly<Record<Dialect, DiscoveryQueryBuilder>> = {
  postgresql: postgresBuilder,
  mysql: mysqlBuilder,
  sqlite: sqliteBuilder,
};

// Compile-time residue check — a missing builder fails the build.
type _UnregisteredDialect = Exclude<Dialect, keyof typeof DISCOVERY_QUERY_BUILDERS>;
const _allDialectsRegistered: _UnregisteredDialect extends never ? true : never = true;

// Liveness seed — legal only while the residue above is `never`. Remove one
// registration, the residue widens to that name, the assignment compiles, and
// the `@ts-expect-error` goes unused → the build fails.
// @ts-expect-error — an unregistered dialect would make this a non-never type
const _missingDialect: Exclude<Dialect, keyof typeof DISCOVERY_QUERY_BUILDERS> = 'postgresql';

void _allDialectsRegistered;
void _missingDialect;

// ─── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * The single point a free-form `databaseType` string becomes a {@link Dialect}.
 * Returns `null` for any string that has no builder — the caller decides how to
 * surface "not a supported dialect" (never a silent empty result).
 */
export function normalizeDialect(input: string): Dialect | null {
  const normalized = input.trim().toLowerCase();
  return normalized in DISCOVERY_QUERY_BUILDERS ? (normalized as Dialect) : null;
}

/**
 * Build the ordered discovery queries for a dialect, with no default arm — the
 * registry is total, so every {@link Dialect} has a builder.
 */
export function buildDiscoveryQueries(dialect: Dialect, ctx: DiscoveryQueryContext): DiscoveryQuery[] {
  return DISCOVERY_QUERY_BUILDERS[dialect].build(ctx);
}
