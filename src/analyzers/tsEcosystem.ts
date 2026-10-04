import databasePackages from '../languages/typescript/database-packages.json' with { type: 'json' };

/**
 * The TypeScript resolution implementation's ecosystem data.
 *
 * Standing correction `specs/correction-seams-not-placement.md` §4: the ecosystem
 * data moves behind the interface, not into a renamed home. `DB_PACKAGES`,
 * the DB-call method set and the ORM method set are the *TypeScript* resolution
 * implementation's own data — the npm/TypeScript package vocabulary — and live
 * here, the TS counterpart of `GO_DB_PACKAGES` in `languages/go/goResolution.ts`.
 * No module above the resolution interface reads these sets: the TS
 * implementation modules (`provenance.ts`, `receiverRoot.ts`,
 * `receiverResolution.ts`) read them directly because they *are* the
 * implementation; every caller above them asks a predicate (`isOrmMethod`)
 * rather than importing a set.
 *
 * This replaces the old claim in `provenance.ts` that these were a "universal,
 * language-invariant vocabulary": `database/sql` and `*sql.DB` are not npm
 * package names, and `better-sqlite3` is not a Go import path. There is one
 * ecosystem per dialect, owned by that dialect's resolution implementation.
 */

/**
 * Database packages — the npm/TypeScript package vocabulary (Spec R1.1).
 *
 * Spec 70 R4 / criterion 10: this set is loaded from the per-ecosystem manifest
 * (`src/languages/typescript/database-packages.json`, beside the format adapter),
 * a declarative data file holding package names only. Adding an ORM is a data
 * edit that turns `cannot-fire` into a verdict; failing to add it never produces
 * a wrong verdict. This is the ORM residual — the one irreducible fact R3 cannot
 * derive from the audited code (which packages are database clients).
 */
export const DB_PACKAGES: ReadonlySet<string> = new Set(databasePackages);

/**
 * DB call methods — the fixed API surface.
 *
 * Spec 33 Item 11 FP category 5: the bare-identifier hybrid fallback in
 * `isDBProvenanced` treated any `get(...)` / `each(...)` / `values(...)` call
 * as a DB query, flagging lodash-style object accessors (e.g.
 * `@directus/utils`'s `get(item, ...)`) as sql-injection. Those three names
 * are also common non-DB methods (lodash `get`, jQuery/iterator
 * `each`, Map/WebSocket `.values()`), so they are removed from the fallback —
 * mirroring the `get`/`each` trim in CHANGELOG 3.4.9 (DB_CALL_METHOD_NAMES).
 *
 * `query` is deliberately RETAINED: it is a genuine query-execution method on
 * mysql2, pg, node-postgres, D1 and Planetscale (`.query(...)`), and the
 * spec-19 data-access fixtures exercise it as a canonical DB entry point.
 * Removing it would turn real SQL-injection positives into false negatives.
 *
 * `raw` is deliberately retained: it is a genuine raw-execution method on
 * D1 prepared statements, Knex, and Kysely, and the Item-6 taint-tracking
 * fixtures exercise it as the canonical raw-SQL entry point.
 */
export const DB_CALL_METHODS: ReadonlySet<string> = new Set([
  'exec',
  'prepare',
  'batch',
  'run',
  'all',
  'first',
  'query',
  'raw',
]);

/** ORM method patterns — fixed API surface for ORM recognition (Spec 21 R1) */
export const ORM_METHODS: ReadonlySet<string> = new Set([
  'find',
  'findOne',
  'findMany',
  'findFirst',
  'findUnique',
  'select',
  'insert',
  'insertMany',
  'update',
  'updateOne',
  'updateMany',
  'delete',
  'deleteOne',
  'deleteMany',
  'from',
  'where',
  'join',
  'leftJoin',
  'rightJoin',
  'innerJoin',
  'create',
  'createMany',
  'aggregate',
  'count',
  'distinct',
  'execute',
  'query',
  // Kysely builder verbs (camelCase SQL, absent from the SQL-keyword path).
  'selectFrom',
  'selectAll',
  'insertInto',
  'updateTable',
  'deleteFrom',
  'executeTakeFirst',
  'executeTakeFirstOrThrow',
  'values',
  'set',
  'onConflict',
  'returning',
  'whereRef',
]);

/**
 * True when a method name is an ORM method. The one ecosystem predicate a caller
 * above the resolution interface needs: `dbMethodInMemberChain` (inside the
 * implementation) reads `ORM_METHODS` directly, but the data-access analyzer's
 * query-compiler discriminator (`isSqlStringConstruction`) must not read the set
 * itself. `ORM_METHODS` is mixed-case (`findUnique`, `selectFrom`), so the match
 * tests both the lowercased form (for lowercase entries like `find`/`select`/`set`)
 * and the raw name (for camelCase entries).
 */
export function isOrmMethod(method: string): boolean {
  const lower = method.toLowerCase();
  return ORM_METHODS.has(lower) || ORM_METHODS.has(method);
}
