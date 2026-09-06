/**
 * Spec 34 — Schema table discovery (R2.1 AST-based registry extraction +
 * auto-discovery helpers + file gate). Extracted free functions; none of these
 * reference the UniversalSchemaAnalyzer class (no cycle back through the class).
 *
 * Dependency direction is leaf → parent:
 *   discovery.ts ──(types, migrations, config, codeAnalysis)
 */

import fs from 'fs/promises';
import type { Dirent } from 'node:fs';
import path from 'path';
import picomatch from 'picomatch';
import { DEFAULT_EXCLUDED_ANY_DEPTH_DIRS } from '../../../utils/fileDiscovery.js';
import type { AST, LanguageAdapter, ASTNode, ImportInfo } from '../../../languages/types.js';
import type { ProvenanceContext } from '../../provenance.js';
import type {
  SchemaAnalyzerConfig,
  TableSourceEntry,
  TableProvenance,
  RegistryExtractionContext,
} from './types.js';
import {
  DB_RECEIVER_NAMES,
  DB_CALL_METHOD_NAMES,
  DB_BINDING_NAMES,
  SQL_TAG_NAMES,
  escapeRegex,
} from './config.js';
import {
  processMigrationSource,
  stripIdentifier,
  readModuleFromDisk,
  extractReExports,
} from './migrations.js';
import { getCallee } from './codeAnalysis.js';

/**
 * Walk project root recursively, returning files matching any of the given
 * picomatch globs.
 *
 * Uses `readdir` with `withFileTypes` so the entry type comes from the dirent
 * rather than a per-entry `fs.stat`. A migration walk over a large project
 * (or a project with a large local corpus) otherwise performs one `stat`
 * syscall per file — 10k+ syscalls that contend under concurrent test workers
 * and were the load-induced source of the Spec-17 timeout.
 *
 * Skips infra/transient directories (the same `DEFAULT_EXCLUDED_ANY_DEPTH_DIRS`
 * set file discovery uses — `node_modules`, `dist`, `coverage`, …) and
 * dot-directories. Symlinks report as neither file nor directory under
 * `withFileTypes`, so they are not followed — which avoids walking a symlinked
 * corpus out of the project root.
 *
 * @param root The directory to walk.
 * @param globs Picomatch globs to match relative paths against.
 * @returns Absolute paths of matching files, sorted-deterministic per directory.
 */
export async function walkFiles(root: string, globs: string[]): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string) {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of dirents) {
      const name = entry.name;
      if (entry.isDirectory()) {
        // Skip infra/transient directories and dot-directories.
        if (name.startsWith('.') || DEFAULT_EXCLUDED_ANY_DEPTH_DIRS.has(name)) continue;
        await walk(path.join(dir, name));
      } else if (entry.isFile()) {
        const fullPath = path.join(dir, name);
        const relative = path.relative(root, fullPath);
        if (globs.some(g => picomatch.isMatch(relative, g))) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(root);
  return results;
}

// Migration DDL discovery is a full-repo walk and is the hot path behind
// schema auto-discovery. A run analyzing many files (or a test suite, or a
// long-lived MCP server) calls it once per no-schema analyze(). Memoize the
// result per (projectRoot, gateGlobs) so the walk happens once per project.
// Bounded to avoid unbounded growth in a long-running server; the oldest entry
// is evicted when the cap is reached. Callers treat the returned set as
// read-only.
const migrationsCache = new Map<string, Set<string>>();
const MIGRATIONS_CACHE_MAX = 16;

/**
 * Discover tables by replaying DDL from migration files under the project root.
 *
 * @param projectRoot The project directory to search.
 * @param config Schema analyzer configuration (fileGateGlobs for migration files).
 * @returns The set of table names discovered from migration DDL.
 */
export async function discoverTablesFromMigrations(
  projectRoot: string,
  config: SchemaAnalyzerConfig,
): Promise<Set<string>> {
  const gateGlobs = config.fileGateGlobs ?? ['**/*.sql', '**/migrations/**'];
  const cacheKey = `${projectRoot}\u0000${gateGlobs.join('\u0000')}`;
  const cached = migrationsCache.get(cacheKey);
  if (cached) return cached;

  const tables = new Set<string>();
  const walkedFiles = await walkFiles(projectRoot, gateGlobs);
  walkedFiles.sort();

  for (const file of walkedFiles) {
    try {
      const source = await fs.readFile(file, 'utf8');
      processMigrationSource(source, tables);
    } catch {
      // Skip unreadable files
    }
  }

  if (migrationsCache.size >= MIGRATIONS_CACHE_MAX) {
    const oldest = migrationsCache.keys().next().value;
    if (oldest !== undefined) migrationsCache.delete(oldest);
  }
  migrationsCache.set(cacheKey, tables);
  return tables;
}

/**
 * Discover tables from a Cloudflare D1 `wrangler.toml` migration directory.
 *
 * @param projectRoot The project directory containing wrangler.toml.
 * @returns The set of table names discovered from D1 migration files.
 */
/**
 * Parse `migrations_dir` entries from a wrangler.toml `[[d1_databases]]` block.
 */
function extractWranglerMigrationDirs(wranglerContent: string): string[] {
  const migrationDirs: string[] = [];
  let inD1Block = false;
  for (const line of wranglerContent.split('\n')) {
    const trimmed = line.trim();
    if (/^\[\[d1_databases\]\]/i.test(trimmed)) {
      inD1Block = true;
      continue;
    }
    if (inD1Block && trimmed.startsWith('[')) {
      inD1Block = false;
      continue;
    }
    if (inD1Block) {
      const m = trimmed.match(/^migrations_dir\s*=\s*['"](.+?)['"]/);
      if (m) {
        migrationDirs.push(m[1]);
      }
    }
  }
  return migrationDirs;
}

/** Replay DDL from every `.sql` file in a migration directory into `tables`. */
async function processMigrationDirectory(absDir: string, tables: Set<string>): Promise<void> {
  let entries: string[];
  try {
    const dirents = await fs.readdir(absDir, { withFileTypes: true });
    entries = dirents
      .filter(e => e.isFile() && e.name.endsWith('.sql'))
      .map(e => e.name)
      .sort();
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = path.join(absDir, entry);
    try {
      const source = await fs.readFile(filePath, 'utf8');
      processMigrationSource(source, tables);
    } catch {
      // Skip unreadable files
    }
  }
}

/**
 * Discover tables referenced by Cloudflare D1 migrations under `wrangler.toml`.
 *
 * Reads the `wrangler.toml` config, resolves its migration directories, and
 * scans each migration file for `CREATE TABLE` DDL.
 *
 * @param projectRoot Root directory containing `wrangler.toml`.
 * @returns Set of table names discovered from D1 migration files.
 */
export async function discoverTablesFromWrangler(
  projectRoot: string,
): Promise<Set<string>> {
  const tables = new Set<string>();

  const wranglerPath = path.join(projectRoot, 'wrangler.toml');
  let wranglerContent: string;
  try {
    wranglerContent = await fs.readFile(wranglerPath, 'utf8');
  } catch {
    return tables; // No wrangler.toml
  }

  for (const migDir of extractWranglerMigrationDirs(wranglerContent)) {
    await processMigrationDirectory(path.resolve(projectRoot, migDir), tables);
  }

  return tables;
}

/**
 * Discover tables by scanning explicit schema files for CREATE TABLE DDL.
 *
 * @param schemaFiles Relative paths of schema files to scan.
 * @param projectRoot The project directory the paths resolve against.
 * @returns The set of table names discovered from schema-file DDL.
 */
export async function discoverTablesFromSchemaFiles(
  schemaFiles: string[],
  projectRoot: string,
): Promise<Set<string>> {
  const tables = new Set<string>();

  for (const file of schemaFiles) {
    const absPath = path.resolve(projectRoot, file);
    try {
      const source = await fs.readFile(absPath, 'utf8');
      const createRe = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|\w+)/gi;
      let match: RegExpExecArray | null;
      while ((match = createRe.exec(source)) !== null) {
        tables.add(stripIdentifier(match[1]));
      }
    } catch {
      // Skip unreadable files
    }
  }

  return tables;
}

/**
 * Discover tables from ORM schema artifacts (Drizzle builders, Prisma models).
 *
 * @param files Candidate file paths to scan for ORM schema definitions.
 * @returns The set of table names discovered from ORM schemas.
 */
export async function discoverTablesFromOrmSchemas(
  files: string[],
): Promise<Set<string>> {
  const tables = new Set<string>();

  for (const file of files) {
    const lowerFile = file.toLowerCase();

    if (/\.(ts|tsx|js|jsx)$/i.test(file)) {
      try {
        const source = await fs.readFile(file, 'utf8');
        if (/from\s+['"]drizzle-orm/.test(source)) {
          const builderRegex = /(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g;
          let match: RegExpExecArray | null;
          while ((match = builderRegex.exec(source)) !== null) {
            tables.add(match[1]);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (file.endsWith('schema.prisma') || file.endsWith('\\schema.prisma')) {
      try {
        const source = await fs.readFile(file, 'utf8');
        const modelRegex = /model\s+(\w+)\s*\{/g;
        let match: RegExpExecArray | null;
        while ((match = modelRegex.exec(source)) !== null) {
          tables.add(match[1]);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return tables;
}

/**
 * Pre-filter: only analyze files that show DB usage.
 * Checks: .sql/migration glob, D1/SQL imports, env-binding patterns, DB calls.
 *
 * @param filePath The file under consideration.
 * @param sourceCode The raw source text.
 * @param config Schema analyzer configuration (globs, DB names, tag names).
 * @param provenanceContext Provenance-based DB detection context (Spec 21).
 * @returns True when the file shows DB usage and should be analyzed.
 */
/**
 * Legacy name-based DB detection: D1/SQL imports, env bindings, and
 * receiver.method call patterns. Used in 'names' mode or when no provenance
 * context is supplied.
 */
function detectDbUsageByName(sourceCode: string, config: SchemaAnalyzerConfig): boolean {
  // Check for D1 or SQL API imports
  const importPatterns = [
    /import\s+.*\b(D1Database|D1PreparedStatement|D1Result)\b/,
    /import\s+.*from\s+['"].*d1['"]/,
    /import\s+.*from\s+['"].*pg['"]/,
    /import\s+.*from\s+['"].*mysql['"]/,
    /import\s+.*from\s+['"].*sqlite['"]/,
    /import\s+.*from\s+['"].*knex['"]/,
    /import\s+.*from\s+['"].*drizzle['"]/,
    /import\s+.*from\s+['"].*prisma['"]/,
  ];
  for (const pat of importPatterns) {
    if (pat.test(sourceCode)) return true;
  }

  // Check for env-binding patterns (e.g., env.DB in Cloudflare Workers)
  const bindingNames = config.dbBindingNames ?? [...DB_BINDING_NAMES];
  for (const binding of bindingNames) {
    if (sourceCode.includes(binding)) return true;
  }

  // Check for DB call patterns (receiver.method)
  const receivers = config.dbReceiverNames ?? [...DB_RECEIVER_NAMES];
  const methods = config.dbCallMethods ?? [...DB_CALL_METHOD_NAMES];
  for (const receiver of receivers) {
    for (const method of methods) {
      const pattern = new RegExp(`\\b${escapeRegex(receiver)}\\.${escapeRegex(method)}\\s*\\(`);
      if (pattern.test(sourceCode)) return true;
    }
  }

  return false;
}

/**
 * Detect SQL tagged template literals — a syntax feature, not a naming
 * convention (e.g. sql\`SELECT ...\`).
 */
function hasSqlTag(sourceCode: string, config: SchemaAnalyzerConfig): boolean {
  const sqlTags = config.sqlTagNames ?? [...SQL_TAG_NAMES];
  for (const tag of sqlTags) {
    const pattern = new RegExp(`\\b${escapeRegex(tag)}\`\\s*SELECT|\\b${escapeRegex(tag)}\`\\s*INSERT|\\b${escapeRegex(tag)}\`\\s*UPDATE|\\b${escapeRegex(tag)}\`\\s*DELETE|\\b${escapeRegex(tag)}\`\\s*CREATE`, 'i');
    if (pattern.test(sourceCode)) return true;
  }
  return false;
}

/**
 * Decide whether a file should be scanned for DB usage (the file gate).
 *
 * SQL files and migration directories always pass. In provenance modes the
 * gate defers to DB-provenanced identifiers; in name mode it falls back to
 * name-based DB detection.
 *
 * @param filePath Path of the file being gated.
 * @param sourceCode Contents of the file being gated.
 * @param config Schema analyzer configuration (globs, tag names).
 * @param provenanceContext Optional provenance metadata for DB detection.
 * @returns True when the file should be scanned for schema references.
 */
export function passesFileGate(
  filePath: string,
  sourceCode: string,
  config: SchemaAnalyzerConfig,
  provenanceContext?: ProvenanceContext,
): boolean {
  // Always pass .sql files and migration directories
  const gateGlobs = config.fileGateGlobs ?? ['**/*.sql', '**/migrations/**'];
  if (gateGlobs.some(glob => picomatch.isMatch(filePath, glob))) {
    return true;
  }

  // Spec 21: Provenance-first DB detection — if any identifier is DB-provenanced,
  // this file passes the gate. This replaces the regex patterns for import/environment/
  // receiver.method checks in hybrid and provenance modes.
  if (provenanceContext && provenanceContext.mode !== 'names') {
    if (provenanceContext.dbProvenanced.size > 0) {
      return true;
    }
  }

  // Legacy name-based detection — used in 'names' mode or when no provenance context
  if (!provenanceContext || provenanceContext.mode === 'names') {
    if (detectDbUsageByName(sourceCode, config)) return true;
  }

  // Check for SQL tagged template literals (syntax feature, not naming convention)
  return hasSqlTag(sourceCode, config);
}

/**
 * Cheap pre-gate for schema auto-discovery: does any analyzed file show DB
 * context (a migration/SQL glob match, a DB import/binding/call, or an SQL
 * tagged template)?
 *
 * `discoverTablesFromMigrations` is a full-repo walk. Running it for files
 * with no DB context (e.g. `import { spawn } from "node:child_process"`) is
 * pure wasted I/O: the per-file gate in `analyzeAST` rejects every one of
 * those files, so no discovered table could ever be referenced. Skip the
 * walk when there is nothing to discover.
 *
 * @param files Candidate file paths.
 * @param config Schema analyzer configuration.
 * @returns True when at least one file passes the DB-context file gate.
 */
export async function anyFileHasDbContext(
  files: string[],
  config: SchemaAnalyzerConfig,
): Promise<boolean> {
  for (const file of files) {
    if (file.endsWith('.json')) continue;
    try {
      const source = await fs.readFile(file, 'utf8');
      if (passesFileGate(file, source, config)) return true;
    } catch {
      // Unreadable files can't show DB context.
    }
  }
  return false;
}

/**
 * Extract table references from registry-shaped table sources (callee + decorator).
 * R2.1: Only tagged template SQL and DB-call patterns produce candidates.
 *
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param tableSources Registry entries (callee/decorator) to match.
 * @param ctx Extraction context carrying the AST, adapter, source text, file
 *   path, and an optional module reader.
 * @returns Extracted table names with ORM-registry provenance.
 */
export function extractTablesFromRegistry(
  tableSources: TableSourceEntry[],
  ctx: RegistryExtractionContext
): Array<{ table: string; source: TableProvenance }> {
  if (!ctx.ast || !tableSources || tableSources.length === 0) return [];

  const results: Array<{ table: string; source: TableProvenance }> = [];
  const importMap = resolveImportMap(ctx.ast, ctx.adapter, ctx.sourceCode);
  const resolved: RegistryExtractionContext = { ...ctx, importMap };

  for (const entry of tableSources) {
    if (entry.kind === 'callee') {
      extractCalleeTables(entry, resolved, results);
    } else if (entry.kind === 'decorator') {
      extractDecoratorTables(entry, resolved, results);
    }
  }

  return results;
}

/**
 * Resolve import statements to a module → (importedName → localName) map.
 *
 * For non-aliased imports (`import { pgTable } from 'x'`) the imported and
 * local names are identical.  For aliased imports (`import { pgTable as table }`)
 * the map records `pgTable → table`, so the callee-extraction logic can trace
 * the call-site identifier back to the original export name.
 *
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param _sourceCode The raw source text (unused; kept for signature parity).
 * @returns A module → (imported name → local name) map.
 */
export function resolveImportMap(
  ast: AST,
  adapter: LanguageAdapter,
  _sourceCode: string
): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  try {
    const imports: ImportInfo[] = adapter.extractImports(ast);
    for (const imp of imports) {
      if (!map.has(imp.source)) {
        map.set(imp.source, new Map());
      }
      const nameMap = map.get(imp.source)!;
      for (const spec of imp.specifiers) {
        const localName = spec.alias || spec.name;
        if (spec.isDefault || spec.isNamespace) {
          // `import knex from 'knex'` or `import * as knex from 'knex'`
          // Key is the module specifier; value is the local binding.
          nameMap.set(spec.name, localName);
        } else {
          // `import { pgTable as table } from 'x'`
          // Key is the original export name; value is the local alias.
          nameMap.set(spec.name, localName);
        }
      }
    }
  } catch {
    // Gracefully handle adapters that don't support extractImports
  }
  return map;
}

/**
 * Resolve the call-site root identifier to the original package export name
 * when a `module` filter is set.  Handles two shapes:
 *
 *   1. Direct import — `import { pgTable } from 'drizzle-orm/pg-core'`
 *      (the root identifier is bound directly to `entry.module`).
 *   2. One-hop barrel re-export — `import { pgTable } from './db'` where
 *      `./db` does `export * from 'drizzle-orm/pg-core'` (or a named
 *      re-export).  Only ONE hop is traced; a barrel that re-exports from
 *      another local module is treated as unresolved.
 *
 * @param moduleFilter The required originating module.
 * @param rootId The call-site root identifier.
 * @param ctx Extraction context (import map, file path, module reader).
 * @returns The original export name, or null when unresolved.
 */
export function resolveImportedName(
  moduleFilter: string,
  rootId: string,
  ctx: RegistryExtractionContext
): string | null {
  const { importMap, filePath, readModule } = ctx;
  if (!importMap) return null;

  // 1. Direct import from the required module.
  const direct = importMap.get(moduleFilter);
  if (direct) {
    for (const [name, local] of direct) {
      if (local === rootId) return name;
    }
    // The module is imported, but rootId is not one of its bindings.
    return null;
  }

  // 2. One-hop barrel re-export through a local module.
  for (const [specifier, nameMap] of importMap) {
    // Only relative/absolute module specifiers can be local barrels.
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;

    // Which name does this local module bind to rootId?
    let localImportedName: string | null = null;
    for (const [name, local] of nameMap) {
      if (local === rootId) {
        localImportedName = name;
        break;
      }
    }
    if (!localImportedName) continue;

    const barrelSource = readModule
      ? readModule(filePath, specifier)
      : readModuleFromDisk(filePath, specifier);
    if (!barrelSource) continue;

    for (const reExport of extractReExports(barrelSource)) {
      if (reExport.source !== moduleFilter) continue;
      // `export * from 'x'` — every name maps to itself (no rename).
      if (reExport.star) return localImportedName;
      // `export { a as b } from 'x'` — local export name → original name.
      const original = reExport.renamed.get(localImportedName);
      if (original) return original;
    }
  }

  return null;
}

/**
 * Extract the string literal at a specific argument position from a
 * call_expression node. Counts string/template arguments in order;
 * skips non-string children (like `(` / `,` / `)` delimiters and
 * non-string argument expressions).
 *
 * @param node The call_expression node.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @param argIndex The 0-based string-argument position to extract.
 * @returns The unquoted string at that position, or null when absent.
 */
export function getArgStringLiteral(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  argIndex: number
): string | null {
  if (!node.children) return null;
  for (const child of node.children) {
    const type = adapter.getNodeType(child);
    if (type === 'arguments' && child.children) {
      let stringCount = 0;
      for (const arg of child.children) {
        const argType = adapter.getNodeType(arg);
        if (
          argType === 'string' ||
          argType === 'template_string' ||
          argType === 'template_literal'
        ) {
          if (stringCount === argIndex) {
            const text = adapter.getNodeText(arg, sourceCode).trim();
            if (
              (text.startsWith("'") && text.endsWith("'")) ||
              (text.startsWith('"') && text.endsWith('"')) ||
              (text.startsWith('`') && text.endsWith('`'))
            ) {
              return text.slice(1, -1);
            }
            return text;
          }
          stringCount++;
        }
      }
    }
  }
  return null;
}

/**
 * Resolve the call-site callee to the name to match against `entry.name`.
 *
 * When no module filter is set, match the call-site callee literally. When a
 * module filter IS set, resolve the root identifier through the import map to
 * find the original imported name — this handles aliased imports
 * (e.g. `import { pgTable as table }`), default imports used as method
 * receivers (e.g. `knex.schema.createTable`), and one-hop barrel re-exports
 * (e.g. `import { pgTable } from './db'`).
 *
 * @param entry The table-source entry being resolved.
 * @param callee The raw callee text at the call site.
 * @param ctx The registry extraction context (import map, etc.).
 * @returns The name to match, or null when the callee cannot be resolved.
 */
export function resolveCalleeMatchName(
  entry: TableSourceEntry,
  callee: string,
  ctx: RegistryExtractionContext
): string | null {
  const rootId = callee.split('.')[0];

  if (!entry.module) {
    return callee;
  }

  const importedName = resolveImportedName(entry.module, rootId, ctx);
  if (!importedName) return null;

  // Reconstruct the callee with the imported name replacing the local.
  // For simple calls: `table(...)` where rootId='table', importedName='pgTable'
  //   → 'pgTable'
  // For member calls: `knex.schema.createTable(...)` where rootId='knex'
  //   → 'knex.schema.createTable' (unchanged, root=imported)
  return importedName + callee.substring(rootId.length);
}

/**
 * Walk call_expression nodes for callee-shaped table-source entries.
 *
 * @param entry The callee-shaped registry entry to match.
 * @param ctx Shared extraction context (AST, adapter, source, import map, reader).
 * @param results Accumulator for extracted table references.
 */
export function extractCalleeTables(
  entry: TableSourceEntry,
  ctx: RegistryExtractionContext,
  results: Array<{ table: string; source: TableProvenance }>
): void {
  const { ast, adapter, sourceCode } = ctx;
  const nodes = adapter.findNodes(ast, {
    custom: (n: ASTNode) => adapter.getNodeType(n) === 'call_expression',
  });

  for (const node of nodes) {
    const callee = getCallee(node, adapter, sourceCode);
    if (!callee) continue;

    const calleeNameToMatch = resolveCalleeMatchName(entry, callee, ctx);
    if (!calleeNameToMatch) continue;

    const matches = calleeNameToMatch === entry.name ||
                    calleeNameToMatch.endsWith('.' + entry.name);
    if (!matches) continue;

    const table = getArgStringLiteral(node, adapter, sourceCode, entry.arg);
    if (!table) continue;

    results.push({
      table,
      source: {
        table,
        tier: 'orm-registry',
        sourceFile: ctx.filePath,
        description: entry.description || `ORM: ${entry.name}`,
      },
    });
  }
}

/**
 * Walk decorator nodes for decorator-shaped table-source entries.
 * Handles both argument-bearing decorators (@Entity('table')) and
 * bare decorators (skipped — no table name to extract).
 *
 * @param entry The decorator-shaped registry entry to match.
 * @param ctx Shared extraction context (AST, adapter, source, import map, reader).
 * @param results Accumulator for extracted table references.
 */
export function extractDecoratorTables(
  entry: TableSourceEntry,
  ctx: RegistryExtractionContext,
  results: Array<{ table: string; source: TableProvenance }>
): void {
  const { ast, adapter, sourceCode } = ctx;
  const nodes = adapter.findNodes(ast, {
    custom: (n: ASTNode) => adapter.getNodeType(n) === 'decorator',
  });

  for (const node of nodes) {
    if (!node.children) continue;

    // Find the call_expression child (decorator with args, e.g. @Entity('tbl'))
    let callExpr: ASTNode | null = null;
    for (const child of node.children) {
      if (adapter.getNodeType(child) === 'call_expression') {
        callExpr = child;
        break;
      }
    }
    if (!callExpr) continue; // bare decorator — no args to extract

    const callee = getCallee(callExpr, adapter, sourceCode);
    if (!callee) continue;

    const calleeNameToMatch = resolveCalleeMatchName(entry, callee, ctx);
    if (!calleeNameToMatch) continue;

    const matches = calleeNameToMatch === entry.name ||
                    calleeNameToMatch.endsWith('.' + entry.name);
    if (!matches) continue;
    const table = getArgStringLiteral(callExpr, adapter, sourceCode, entry.arg);
    if (!table) continue;

    results.push({
      table,
      source: {
        table,
        tier: 'orm-registry',
        sourceFile: ctx.filePath,
        description: entry.description || `Decorator: ${entry.name}`,
      },
    });
  }
}
