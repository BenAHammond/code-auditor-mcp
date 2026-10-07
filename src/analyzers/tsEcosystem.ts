import { builtinModules } from 'node:module';
import databasePackages from '../languages/typescript/database-packages.json' with { type: 'json' };

/**
 * The TypeScript resolution implementation's ecosystem data.
 *
 * Standing correction `specs/correction-seams-not-placement.md` §4: the ecosystem
 * data moves behind the interface, not into a renamed home. `DB_PACKAGES`, the
 * Node builtin set, the JS global set and the ORM method set are the *TypeScript*
 * resolution implementation's own data — the npm/TypeScript/JS-runtime vocabulary
 * — and live here, the TS counterpart of `GO_DB_PACKAGES` / `GO_STDLIB_PACKAGES`
 * in `languages/go/goResolution.ts`. No module above the resolution interface
 * reads these sets: the TS implementation modules (`provenance.ts`,
 * `receiverRoot.ts`, `receiverResolution.ts`) read them directly because they
 * *are* the implementation; every caller above them asks a predicate
 * (`isNodeBuiltin`, `isOrmMethod`) rather than importing a set.
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
 * a declarative data file. Adding an ORM is a data edit that turns
 * `cannot-fire` into a verdict; failing to add it never produces a wrong verdict.
 * This is the ORM residual — the one irreducible fact R3 cannot derive from the
 * audited code (which packages are database clients).
 *
 * Decision A (§ "manifest keys on package AND type") refines the shape: each
 * manifest entry is a package *keyed to the exported names that are DB handles*,
 * not a bare package name. `DB_PACKAGES` remains the coarse key set — the
 * staleness report and the `is-this-a-DB-package` predicates read it — while
 * `DB_HANDLE_TYPES` carries the per-package handle names the import-seed step
 * (`extractProvenancedImports`) consults to decide whether a *named* import
 * seeds handle provenance. The motivating case is `@cloudflare/workers-types`:
 * it exports hundreds of type names, of which only `D1Database` /
 * `D1PreparedStatement` are DB handles — `KVNamespace`, `R2Bucket` and
 * `ExecutionContext` must stay `unproven`, so package-level granularity is not
 * enough.
 */
export const DB_PACKAGES: ReadonlySet<string> = new Set(Object.keys(databasePackages));

/**
 * The per-package handle names (exported types/factories whose import seeds
 * handle provenance), keyed by base package name. A named import
 * (`import { Pool } from 'pg'`) seeds only when `Pool` is in the package's list;
 * a default import (`import Database from 'better-sqlite3'`) or namespace import
 * (`import * as pg from 'pg'`) seeds unconditionally — a DB package's default /
 * namespace is its handle, and tree-sitter records no original export name for a
 * default import to match against. A factory entry (`drizzle`, `neon`,
 * `createClient`, `connect`, …) names the function whose *call* returns the
 * handle, seeded so the call-return propagation rule reaches it.
 */
export const DB_HANDLE_TYPES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(databasePackages).map(([pkg, types]) => [pkg, new Set(types as string[])]),
);

/**
 * Resolve a module specifier to its DB-handle names, or `undefined` when the
 * specifier does not name a DB package. Mirrors the exact-or-subpath match
 * `provenance.ts` uses for `DB_PACKAGES` membership, so `pg/lib` and
 * `mysql2/promise` resolve to their base package's handle names.
 */
export function handleTypesForPackage(specifier: string): ReadonlySet<string> | undefined {
  if (!specifier) return undefined;
  if (DB_HANDLE_TYPES.has(specifier)) return DB_HANDLE_TYPES.get(specifier);
  const slash = specifier.indexOf('/');
  if (slash > 0 && specifier.startsWith('@')) {
    const scoped = specifier.slice(0, specifier.indexOf('/', slash + 1));
    return DB_HANDLE_TYPES.get(scoped);
  }
  if (slash > 0) return DB_HANDLE_TYPES.get(specifier.slice(0, slash));
  return undefined;
}

// ─── The package discriminant: Node builtins + JS globals ─────────────────────
//
// The handle/not-handle decision cannot rest on a method *name* — `join` is
// `Array.prototype.join` and it is also `SQL JOIN`. The discriminant is the
// *package* (or global type) a receiver's declaration resolves to. Both halves
// are probed from the vendor, never maintained as a hand-written replica:

/** Node's builtin module names — the authoritative runtime list from
 *  `require('module').builtinModules`, extended with the `node:` prefix and
 *  subpath forms (`fs`, `node:fs`, `fs/promises`). A root resolving to one of
 *  these is `not-handle`, proven. */
const NODE_BUILTIN_MODULES: ReadonlySet<string> = new Set(builtinModules);

/**
 * True when a module specifier names a Node builtin (`fs`, `node:fs`,
 * `fs/promises`). A bare import reaching here was not a database package, so a
 * builtin is provably `not-handle` (criterion: no Node builtin is a DB client).
 */
export function isNodeBuiltin(specifier: string): boolean {
  if (!specifier) return false;
  const s = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  if (NODE_BUILTIN_MODULES.has(s)) return true;
  // Subpath imports (`fs/promises`, `node:test/reporters`) resolve to the parent.
  const slash = s.indexOf('/');
  return slash > 0 && NODE_BUILTIN_MODULES.has(s.slice(0, slash));
}

/**
 * JS builtin global names — enumerated from the global object at load, never a
 * hand-written list. A receiver whose declaration resolves to one of these types
 * (`Array`, `Map`, `Set`, `String`, `JSON`, `Object`, `Number`, `RegExp`,
 * `Promise`, `Date`, `Buffer`, …) is `not-handle`, proven: no global is a
 * database client. Constructors (function with a `prototype`) and namespace
 * objects (`JSON`, `Math`, `crypto`) are both included.
 */
export const JS_GLOBALS: ReadonlySet<string> = (() => {
  const names = new Set<string>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    let value: unknown;
    try {
      value = (globalThis as Record<string, unknown>)[name];
    } catch {
      continue;
    }
    if (typeof value === 'function' || (value !== null && typeof value === 'object')) {
      names.add(name);
    }
  }
  return names;
})();

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
