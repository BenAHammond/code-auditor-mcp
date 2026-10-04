/**
 * Dialect detection — the SQL-content facts' honest up-front gate.
 *
 * Spec 70 (SQL as a parsed format) closes on a hard rule: no silent wrong
 * answers. `parseSql` requires a {@link Dialect}, and before this module the
 * dialect came *only* from a project's explicit `databaseType` config. A repo
 * that names no dialect — which is nearly every real repo — never reached the
 * parser at all: the twelve converted SQL-content sites derived from an AST that
 * was never built, and their facts silently read as "no tables / no write / no
 * filter". The parse-failure measurement passed a dialect explicitly per corpus;
 * the real pipeline did not, so its rates did not describe what a user gets.
 *
 * The fix is detection, not configuration. A repo's *declared dependencies*
 * name its database: `pg` / `@neondatabase/serverless` is postgres,
 * `better-sqlite3` / `bun:sqlite` / a D1 binding is sqlite, `mysql2` is mysql.
 * This is the same manifest the package-manifest surface (R4) validates against.
 * Explicit config overrides it. Only when nothing in the manifest indicates a
 * dialect does {@link detectDialect} return a null dialect with a named reason —
 * the caller turns that into a `cannot-fire` diagnostic ("dialect undetermined"),
 * which is honest abstention rather than the silent empty set of facts it was.
 *
 * There is no hardcoded default. A manifest that names *multiple* dialects
 * (`pg` and `mysql2` together) is also honest abstention — an `ambiguous`
 * reason, never a guess at whichever package sorts first.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Dialect } from '../../mcp-tools/discoveryQueries.js';

/** The result of dialect detection: a resolved dialect, or null + a named reason. */
export interface DialectDetection {
  /** The detected dialect, or null when the manifest indicates none / too many. */
  readonly dialect: Dialect | null;
  /** The named reason when `dialect` is null (used in cannot-fire messages). */
  readonly reason: string | null;
}

/**
 * npm/TypeScript database drivers that imply a *single* dialect. This is
 * deliberately drivers only, not query builders or ORMs: `knex`, `kysely`,
 * `drizzle-orm` and `@prisma/client` target any dialect, and `mongodb` /
 * `mongoose` are not SQL — none of them name a dialect, so none is mapped.
 */
const PACKAGE_DIALECTS: Readonly<Record<string, Dialect>> = {
  // PostgreSQL drivers.
  pg: 'postgresql',
  postgres: 'postgresql',
  'pg-pool': 'postgresql',
  'pg-promise': 'postgresql',
  '@neondatabase/serverless': 'postgresql',
  '@vercel/postgres': 'postgresql',
  // MySQL drivers.
  mysql2: 'mysql',
  mysql: 'mysql',
  mariadb: 'mysql',
  '@planetscale/database': 'mysql',
  // SQLite drivers.
  'better-sqlite3': 'sqlite',
  'bun:sqlite': 'sqlite',
  'node:sqlite': 'sqlite',
  sqlite3: 'sqlite',
  '@libsql/client': 'sqlite',
  '@cloudflare/d1': 'sqlite',
};

/**
 * The dialect a single DB-driver package names, or null when the package is not
 * a single-dialect driver — a cross-dialect ORM/query-builder (`knex`,
 * `kysely`, `drizzle-orm`, `@prisma/client`), a non-SQL store (`mongodb`), or
 * any package outside the map. This is the per-call-site companion to
 * {@link detectDialect}: a receiver traced to `pg` is postgres, to `mysql2` is
 * mysql, to `better-sqlite3` is sqlite, and to `knex` names no dialect (the
 * caller falls back to repo-level detection, or abstains).
 *
 * @param packageName The base npm package name (no subpath — `pg`, not
 *   `pg/lib`; `@neondatabase/serverless`, not its subpaths).
 */
export function dialectForPackage(packageName: string): Dialect | null {
  return PACKAGE_DIALECTS[packageName] ?? null;
}

/**
 * True when `wrangler.toml` declares a D1 binding (`[[d1_databases]]`). A D1
 * binding is SQLite; the binding table is the definitive signal (Workers types
 * alone do not imply D1 — a Worker may use only KV/R2).
 */
function wranglerDeclaresD1(projectRoot: string): boolean {
  const tomlPath = path.join(projectRoot, 'wrangler.toml');
  try {
    const content = readFileSync(tomlPath, 'utf8');
    return /^\[\[d1_databases\]\]/im.test(content);
  } catch {
    return false;
  }
}

/**
 * Detect a project's SQL dialect from its dependency manifest. Reads
 * `package.json` `dependencies` + `devDependencies` and `wrangler.toml` (for a
 * Cloudflare D1 binding). Returns a null dialect with a named reason when the
 * manifest names no dialect or names more than one — never a guessed default.
 *
 * @param projectRoot The project directory containing package.json / wrangler.toml.
 * @returns The detected dialect (or null with a reason when none or more than one is named).
 */
export function detectDialect(projectRoot: string): DialectDetection {
  const byDialect = new Map<Dialect, string[]>();

  const packagePath = path.join(projectRoot, 'package.json');
  let manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } | null = null;
  try {
    manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    manifest = null;
  }

  if (manifest) {
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      const dialect = PACKAGE_DIALECTS[name];
      if (dialect) {
        const list = byDialect.get(dialect) ?? [];
        list.push(name);
        byDialect.set(dialect, list);
      }
    }
  }

  if (wranglerDeclaresD1(projectRoot)) {
    const list = byDialect.get('sqlite') ?? [];
    list.push('wrangler d1_databases');
    byDialect.set('sqlite', list);
  }

  const dialects = [...byDialect.keys()];
  if (dialects.length === 1) {
    return { dialect: dialects[0], reason: null };
  }
  if (dialects.length > 1) {
    const detail = dialects
      .map((d) => `${d} via ${(byDialect.get(d) as string[]).join(', ')}`)
      .join('; ');
    return { dialect: null, reason: `dialect undetermined (ambiguous drivers: ${detail})` };
  }
  return {
    dialect: null,
    reason: 'dialect undetermined (no database driver in package.json or wrangler.toml)',
  };
}
