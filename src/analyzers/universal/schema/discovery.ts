/**
 * Spec 34 — Schema table discovery (R2.1 AST-based registry extraction +
 * auto-discovery helpers + file gate). Extracted free functions; none of these
 * reference the UniversalSchemaAnalyzer class (no cycle back through the class).
 *
 * Dependency direction is leaf → parent:
 *   discovery.ts ──(types, migrations, config, codeAnalysis)
 */

import fs from 'fs/promises';
import path from 'path';
import picomatch from 'picomatch';
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
 * picomatch globs. Skips node_modules and dot-directories.
 */
export async function walkFiles(root: string, globs: string[]): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return; // Skip unreadable directories
    }

    for (const name of names) {
      const fullPath = path.join(dir, name);
      // Skip node_modules and dot-directories
      if (name === 'node_modules' || name.startsWith('.')) continue;

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue; // Skip unstatable
      }
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (stat.isFile()) {
        const relative = path.relative(root, fullPath);
        const matched = globs.some(g => picomatch.isMatch(relative, g));
        if (matched) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(root);
  return results;
}

export async function discoverTablesFromMigrations(
  projectRoot: string,
  config: SchemaAnalyzerConfig,
): Promise<Set<string>> {
  const tables = new Set<string>();
  const gateGlobs = config.fileGateGlobs ?? ['**/*.sql', '**/migrations/**'];
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

  return tables;
}

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

  for (const migDir of migrationDirs) {
    const absDir = path.resolve(projectRoot, migDir);
    let entries: string[];
    try {
      const dirents = await fs.readdir(absDir, { withFileTypes: true });
      entries = dirents
        .filter(e => e.isFile() && e.name.endsWith('.sql'))
        .map(e => e.name)
        .sort();
    } catch {
      continue;
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

  return tables;
}

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
 */
export function passesFileGate(
  filePath: string,
  sourceCode: string,
  config: SchemaAnalyzerConfig,
  provenanceContext?: ProvenanceContext,
): boolean {
  // Always pass .sql files and migration directories
  const gateGlobs = config.fileGateGlobs ?? ['**/*.sql', '**/migrations/**'];
  for (const glob of gateGlobs) {
    if (picomatch.isMatch(filePath, glob)) {
      return true;
    }
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
  }

  // Check for SQL tagged template literals (syntax feature, not naming convention)
  const sqlTags = config.sqlTagNames ?? [...SQL_TAG_NAMES];
  for (const tag of sqlTags) {
    const pattern = new RegExp(`\\b${escapeRegex(tag)}\`\\s*SELECT|\\b${escapeRegex(tag)}\`\\s*INSERT|\\b${escapeRegex(tag)}\`\\s*UPDATE|\\b${escapeRegex(tag)}\`\\s*DELETE|\\b${escapeRegex(tag)}\`\\s*CREATE`, 'i');
    if (pattern.test(sourceCode)) return true;
  }

  return false;
}

/**
 * Extract table references from registry-shaped table sources (callee + decorator).
 * R2.1: Only tagged template SQL and DB-call patterns produce candidates.
 */
export function extractTablesFromRegistry(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  tableSources: TableSourceEntry[],
  filePath: string,
  /** Resolves a relative module specifier (e.g. './db') to its source text,
   *  so a one-hop barrel re-export can be traced to its origin package.
   *  Defaults to reading from disk relative to `fromFile`. */
  readModule?: (fromFile: string, specifier: string) => string | null
): Array<{ table: string; source: TableProvenance }> {
  if (!ast || !tableSources || tableSources.length === 0) return [];

  const results: Array<{ table: string; source: TableProvenance }> = [];
  const importMap = resolveImportMap(ast, adapter, sourceCode);
  const ctx: RegistryExtractionContext = { filePath, importMap, readModule };

  for (const entry of tableSources) {
    if (entry.kind === 'callee') {
      extractCalleeTables(ast, adapter, sourceCode, entry, ctx, results);
    } else if (entry.kind === 'decorator') {
      extractDecoratorTables(ast, adapter, sourceCode, entry, ctx, results);
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
 * Returns null when the identifier does not originate from `module`.
 */
export function resolveImportedName(
  importMap: Map<string, Map<string, string>>,
  moduleFilter: string,
  rootId: string,
  filePath: string,
  readModule?: (fromFile: string, specifier: string) => string | null
): string | null {
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
 * Walk call_expression nodes for callee-shaped table-source entries.
 */
export function extractCalleeTables(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  entry: TableSourceEntry,
  ctx: RegistryExtractionContext,
  results: Array<{ table: string; source: TableProvenance }>
): void {
  const nodes = adapter.findNodes(ast, {
    custom: (n: ASTNode) => adapter.getNodeType(n) === 'call_expression',
  });

  for (const node of nodes) {
    const callee = getCallee(node, adapter, sourceCode);
    if (!callee) continue;

    const rootId = callee.split('.')[0];

    // Determine the name to match against entry.name.
    // When no module filter is set, match the call-site callee literally.
    // When a module filter IS set, resolve the root identifier through
    // the import map to find the original imported name — this handles
    // aliased imports (e.g. `import { pgTable as table }`), default
    // imports used as method receivers (e.g. `knex.schema.createTable`),
    // and one-hop barrel re-exports (e.g. `import { pgTable } from './db'`).
    let calleeNameToMatch: string;
    if (entry.module) {
      const importedName = resolveImportedName(
        ctx.importMap, entry.module, rootId, ctx.filePath, ctx.readModule
      );
      if (!importedName) continue;

      // Reconstruct the callee with the imported name replacing the local.
      // For simple calls: `table(...)` where rootId='table', importedName='pgTable'
      //   → calleeNameToMatch = 'pgTable'
      // For member calls: `knex.schema.createTable(...)` where rootId='knex'
      //   → calleeNameToMatch = 'knex.schema.createTable' (unchanged, root=imported)
      calleeNameToMatch = importedName + callee.substring(rootId.length);
    } else {
      calleeNameToMatch = callee;
    }

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
 */
export function extractDecoratorTables(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  entry: TableSourceEntry,
  ctx: RegistryExtractionContext,
  results: Array<{ table: string; source: TableProvenance }>
): void {
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

    const rootId = callee.split('.')[0];

    let calleeNameToMatch: string;
    if (entry.module) {
      const importedName = resolveImportedName(
        ctx.importMap, entry.module, rootId, ctx.filePath, ctx.readModule
      );
      if (!importedName) continue;

      calleeNameToMatch = importedName + callee.substring(rootId.length);
    } else {
      calleeNameToMatch = callee;
    }

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
