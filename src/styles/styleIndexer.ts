/**
 * Style indexer — Spec 10.
 *
 * Syncs style declarations, design tokens, and class usage to the SQLite
 * style index. Uses content-hash-based change detection to avoid re-extracting
 * unchanged files.
 *
 * Called from auditRunner.ts before the analyzer run, mirroring the function
 * index sync pattern.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import type { LanguageAdapter } from '../languages/types.js';
import { extractDeclarations, extractTokens, getOrLoadTailwindTokens } from './styleExtractor.js';
import { loadTailwindConfig, tokensToStyleTokens } from './tailwindConfigLoader.js';
import {
  findFiles,
  UNREAD_STYLE_EXTENSIONS,
  STYLE_MARKUP_EXTENSIONS,
  KNOWN_SOURCE_EXTENSIONS,
  TYPESCRIPT_EXTENSIONS,
  JAVASCRIPT_EXTENSIONS,
} from '../utils/fileDiscovery.js';
import type {
  NormalizedDeclaration,
  StyleToken,
  StyleClassUsage,
  UnreadStyleSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StyleSyncResult {
  /** Files whose declarations were added or updated. */
  changed: number;
  /** Files that were skipped (content hash unchanged). */
  skipped: number;
  /** Files whose declarations were removed (no longer on disk). */
  removed: number;
  /** Files that failed extraction. */
  errors: number;
}

export interface StyleSyncOptions {
  /** When true, only process the given files (scoped/diff audit). Default false. */
  scoped?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sync the style index for the given files.
 *
 * - Extracts declarations, tokens, and class usage from each file.
 * - Uses content hashes to skip unchanged files.
 * - For scoped runs: deletes and re-inserts declarations for the given files.
 * - For full runs: also removes stale entries for files no longer on disk.
 */
export async function syncStyleIndex(
  rawDb: Database.Database,
  files: string[],
  projectRoot: string,
  options: StyleSyncOptions = {},
): Promise<StyleSyncResult> {
  const result: StyleSyncResult = { changed: 0, skipped: 0, removed: 0, errors: 0 };
  const scoped = options.scoped ?? false;

  // Unread stylesheet sources (Spec 42 R2). When any exist, the
  // styles/undefined-class detector reports notApplicable rather than
  // asserting a class is undefined (it may live in the unread source).
  const unreadSources: UnreadStyleSource[] = [];

  // Load Tailwind config once for the project
  const tailwindResult = loadTailwindConfig(projectRoot);
  const tailwindTokens = tailwindResult.tokens;

  // Get the language registry for adapters (needed by TS/JSX extraction)
  let registry: LanguageRegistry | null = null;
  try {
    registry = LanguageRegistry.getInstance();
  } catch {
    // Registry not initialized — TS/JSX extraction will use source-only fallback
  }

  // Process each file
  for (const filePath of files) {
    // Skip .css and .scss files — handled by styles-css pipeline visitor (Spec 26 Phase 2).
    // .scss is parsed by tree-sitter-scss which extends the CSS grammar.
    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      result.errors++;
      unreadSources.push({
        filePath,
        reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    try {
      const contentHash = computeFileHash(content);

      // Check if file is already indexed and unchanged
      if (!scoped) {
        const existingHash = getStoredHash(rawDb, filePath);
        if (existingHash === contentHash) {
          result.skipped++;
          continue;
        }
      }

      // Delete old entries for this file (both scoped and full)
      deleteFileEntries(rawDb, filePath);

      // Extract declarations
      const declarations = await extractForFile(filePath, content, registry, tailwindTokens, unreadSources);

      // Insert declarations
      if (declarations.length > 0) {
        insertDeclarations(rawDb, filePath, declarations, contentHash);
      }

      // Extract and insert tokens (CSS custom properties)
      const cssTokens = extractTokens(filePath, content);
      if (cssTokens.length > 0) {
        upsertTokens(rawDb, filePath, cssTokens);
      }

      // Extract and insert class usage
      const classUsage = extractClassUsage(filePath, content);
      if (classUsage.length > 0) {
        upsertClassUsage(rawDb, filePath, classUsage);
      }

      result.changed++;
    } catch {
      result.errors++;
    }
  }

  // Full runs: also record stylesheet dialects the indexer cannot read
  // (Sass indented syntax, Less, Stylus) — a class may be defined there.
  if (!scoped) {
    unreadSources.push(...(await findUnreadStyleFiles(projectRoot)));
  }

  // Persist unread sources. Full runs rebuild the table wholesale; scoped runs
  // only upsert the read-failures they encountered (leaving prior full-run rows
  // for the rest of the project intact).
  persistUnreadSources(rawDb, unreadSources, scoped);

  // For full runs: remove stale entries for files not in the current set
  if (!scoped) {
    result.removed = removeStaleEntries(rawDb, files);
  }

  // Insert Tailwind theme tokens as style tokens
  if (tailwindResult.source !== 'none' && result.changed > 0) {
    const twTokens = tokensToStyleTokens(tailwindResult, projectRoot);
    if (twTokens.length > 0) {
      // Upsert each token individually (name is the unique key)
      upsertTokens(rawDb, tailwindResult.configPath ?? 'tailwind-theme', twTokens);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract declarations for a single file, dispatching to the appropriate
 * extractor based on file extension.
 */
async function extractForFile(
  filePath: string,
  sourceCode: string,
  registry: LanguageRegistry | null,
  tailwindTokens: any,
  unreadSources?: UnreadStyleSource[],
): Promise<NormalizedDeclaration[]> {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';

  // CSS/SCSS can be extracted without an adapter
  if (ext === '.css' || ext === '.scss') {
    return extractDeclarations(filePath, null as any, sourceCode, undefined, tailwindTokens, unreadSources);
  }

  // TS/JS/TSX/JSX need a language adapter (derived from the discovery constants)
  if ([...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS].includes(ext)) {
    let adapter: LanguageAdapter | null = null;
    try {
      if (registry) {
        adapter = registry.getAdapterForFile(filePath);
      }
    } catch {
      // Adapter not available — skip extraction for this file
    }

    if (adapter) {
      try {
        const ast = await adapter.parse(filePath, sourceCode);
        try {
          return extractDeclarations(filePath, adapter, sourceCode, ast, tailwindTokens, unreadSources);
        } finally {
          // Free the WASM tree. The style index parses every TS/JS file to pull
          // out class/style declarations; without this the tree (and, for TSX/JSX,
          // the one-off parser) leaks in the shared Emscripten arena and exhausts
          // the 2 GB wasm ceiling — the trigger for Aborted() on large corpora.
          ast.dispose?.();
        }
      } catch {
        // Parse error — skip
      }
    }

    // Try extraction without AST (regex-only for class attributes)
    return extractDeclarations(filePath, null as any, sourceCode, undefined, tailwindTokens, unreadSources);
  }

  // Markup/component files — extractor handles these with regex. Derived from
  // the shared STYLE_MARKUP_EXTENSIONS so it can't drift from extractDeclarations
  // (the `.astro` silent-drop bug).
  if (STYLE_MARKUP_EXTENSIONS.includes(ext)) {
    return extractDeclarations(filePath, null as any, sourceCode, undefined, tailwindTokens, unreadSources);
  }

  // Not a style-bearing extension. Known source (`.css`/`.scss` — handled by the
  // AST pipeline — plus JSON/Go/SQL/TOML/Prisma owned by other analyzers) is
  // skipped silently; any *other* extension is unhandled — record it so
  // undefined-class surfaces the gap instead of silently dropping the file type
  // (Spec 42 R2 backstop).
  if (ext && !KNOWN_SOURCE_EXTENSIONS.includes(ext)) {
    unreadSources?.push({ filePath, reason: `unsupported source extension: ${ext}` });
  }
  return [];
}

/**
 * Extract class usage from a source file.
 * Looks for className="..." attributes in JSX and class="..." in HTML.
 */
export function extractClassUsage(
  filePath: string,
  sourceCode: string,
): StyleClassUsage[] {
  const usage: StyleClassUsage[] = [];
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';

  // Class usage only exists in markup/component source. Data/config files
  // (`.json`, `.sql`, `.toml`, `.prisma`), `.go`, and stylesheets can contain
  // `class`/`className` substrings inside string literals (Bug #3 — e.g. an
  // audit-report.json embedding a raw source snippet with `error_class =
  // 'zombie-capped'`). Those must never reach the class-usage table, so gate
  // extraction to the extensions that actually carry class attributes. Derived
  // from the shared discovery constants so this list can't drift from the
  // declaration extractor (the `.astro` silent-drop bug).
  const CLASS_USAGE_EXTENSIONS = [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS, ...STYLE_MARKUP_EXTENSIONS];
  if (!CLASS_USAGE_EXTENSIONS.includes(ext)) return [];

  // Determine mechanism by file type
  let mechanism: StyleClassUsage['mechanism'] = 'class';
  if ([...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS].includes(ext)) {
    mechanism = 'className';
  }

  // Match className="..." or class="..." as an attribute. The leading \b word
  // boundary is load-bearing: without it, `class` matches as a substring of
  // identifiers like `error_class` (and `className` inside `myclassName`), so a
  // SQL string literal such as `error_class = 'zombie-capped'` leaks its
  // *value* into the class-usage table and is later flagged undefined-class.
  const attrRegex = /\b(?:className|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{(["'`])((?:(?!\3).)*)\3\})/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(sourceCode)) !== null) {
    const value = match[1] ?? match[2] ?? match[4] ?? '';
    const line = sourceCode.slice(0, match.index).split('\n').length;
    const classes = value.split(/\s+/).filter(Boolean);

    // Any className wrapped in {…} is dynamic — the expression can produce
    // arbitrary class names at runtime (variables, ternaries, clsx calls,
    // template literals, etc.). Mark all extracted fragments as unresolvable
    // so the undefined-class detector skips them individually rather than
    // false-flagging runtime values as missing CSS definitions.
    // Spec 22 Task #254 — root cause: the old code only set unresolvable
    // when the expression contained ${} template interpolation, missing
    // simple variable/ternary/function-call expressions.
    const isDynamic = !!(match[4] ?? match[3]);

    for (const className of classes) {
      // Skip obvious static utility fragments from dynamic expressions
      if (!className || className.length === 0) continue;

      usage.push({
        className: className.trim(),
        filePath,
        line,
        mechanism,
        unresolvable: isDynamic,
      });
    }
  }

  return usage;
}

// ---------------------------------------------------------------------------
// Unread stylesheet sources (Spec 42 R2)
// ---------------------------------------------------------------------------

/**
 * Discover stylesheet files whose dialect the indexer cannot read (Sass indented
 * syntax, Less, Stylus). Each is recorded as an unread source so that
 * `styles/undefined-class` reports `notApplicable` instead of asserting a class
 * is undefined when it could be defined in one of these files.
 */
async function findUnreadStyleFiles(projectRoot: string): Promise<UnreadStyleSource[]> {
  const files = await findFiles(projectRoot, { extensions: UNREAD_STYLE_EXTENSIONS });
  return files.map((filePath) => {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1);
    return { filePath, reason: `unsupported style dialect: ${ext}` };
  });
}

/**
 * Persist unread stylesheet sources.
 *
 * Full runs rebuild the table wholesale so dialects/read-failures that no longer
 * exist are dropped. Scoped runs only upsert the read-failures they encountered,
 * leaving prior full-run rows for the rest of the project intact.
 */
function persistUnreadSources(
  rawDb: Database.Database,
  unreadSources: UnreadStyleSource[],
  scoped: boolean,
): void {
  if (scoped) {
    if (unreadSources.length === 0) return;
    const upsert = rawDb.prepare(
      `INSERT INTO style_unread_sources (file_path, reason) VALUES (@filePath, @reason)
       ON CONFLICT(file_path) DO UPDATE SET reason = excluded.reason`,
    );
    const txn = rawDb.transaction(() => {
      for (const s of unreadSources) upsert.run({ filePath: s.filePath, reason: s.reason });
    });
    txn();
    return;
  }

  rawDb.prepare('DELETE FROM style_unread_sources').run();
  if (unreadSources.length === 0) return;

  const insert = rawDb.prepare(
    'INSERT INTO style_unread_sources (file_path, reason) VALUES (@filePath, @reason)',
  );
  const txn = rawDb.transaction(() => {
    for (const s of unreadSources) insert.run({ filePath: s.filePath, reason: s.reason });
  });
  txn();
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function getStoredHash(rawDb: Database.Database, filePath: string): string | null {
  const row = rawDb.prepare(
    'SELECT content_hash FROM style_declarations WHERE file_path = ? LIMIT 1',
  ).get(filePath) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

function deleteFileEntries(rawDb: Database.Database, filePath: string): void {
  rawDb.prepare('DELETE FROM style_declarations WHERE file_path = ?').run(filePath);
  rawDb.prepare('DELETE FROM style_class_usage WHERE file_path = ?').run(filePath);
  rawDb.prepare('DELETE FROM style_tokens WHERE file_path = ?').run(filePath);
  rawDb.prepare('DELETE FROM style_unread_sources WHERE file_path = ?').run(filePath);
}

function removeStaleEntries(rawDb: Database.Database, currentFiles: string[]): number {
  const filesSet = new Set(currentFiles);
  // Union all three tables — style_class_usage and style_tokens can have
  // entries for files that don't appear in style_declarations (e.g. TSX
  // files that use Tailwind classes without defining CSS declarations).
  const allIndexed = rawDb.prepare(
    `SELECT DISTINCT file_path FROM style_declarations
     UNION
     SELECT DISTINCT file_path FROM style_class_usage
     UNION
     SELECT DISTINCT file_path FROM style_tokens`,
  ).all() as { file_path: string }[];

  let removed = 0;
  for (const { file_path } of allIndexed) {
    if (!filesSet.has(file_path)) {
      rawDb.prepare('DELETE FROM style_declarations WHERE file_path = ?').run(file_path);
      rawDb.prepare('DELETE FROM style_class_usage WHERE file_path = ?').run(file_path);
      rawDb.prepare('DELETE FROM style_tokens WHERE file_path = ?').run(file_path);
      removed++;
    }
  }
  return removed;
}

function insertDeclarations(
  rawDb: Database.Database,
  filePath: string,
  declarations: NormalizedDeclaration[],
  contentHash: string,
): void {
  const insert = rawDb.prepare(`
    INSERT INTO style_declarations
      (property, raw_value, normalized_value, mechanism, file_path, line,
       context, variant_context, token_ref, content_hash)
    VALUES
      (@property, @rawValue, @normalizedValue, @mechanism, @filePath, @line,
       @context, @variantContext, @tokenRef, @contentHash)
  `);

  const txn = rawDb.transaction(() => {
    for (const d of declarations) {
      insert.run({
        property: d.property,
        rawValue: d.rawValue,
        normalizedValue: d.normalizedValue ? JSON.stringify(d.normalizedValue) : null,
        mechanism: d.mechanism,
        filePath: d.filePath,
        line: d.line,
        context: d.context ?? null,
        variantContext: d.variantContext ?? null,
        tokenRef: d.tokenRef ?? null,
        contentHash,
      });
    }
  });

  txn();
}

function upsertTokens(
  rawDb: Database.Database,
  filePath: string,
  tokens: StyleToken[],
): void {
  // Delete existing tokens from this file first, then insert fresh
  rawDb.prepare('DELETE FROM style_tokens WHERE file_path = ?').run(filePath);

  const insert = rawDb.prepare(`
    INSERT INTO style_tokens (name, value, file_path, mechanism)
    VALUES (@name, @value, @filePath, @mechanism)
  `);

  const txn = rawDb.transaction(() => {
    for (const token of tokens) {
      insert.run({
        name: token.name,
        value: token.value,
        filePath: token.filePath,
        mechanism: token.mechanism,
      });
    }
  });

  txn();
}

function upsertClassUsage(
  rawDb: Database.Database,
  filePath: string,
  usage: StyleClassUsage[],
): void {
  // Delete existing class usage for this file first
  rawDb.prepare('DELETE FROM style_class_usage WHERE file_path = ?').run(filePath);

  const insert = rawDb.prepare(`
    INSERT INTO style_class_usage
      (class_name, file_path, line, mechanism, unresolvable)
    VALUES
      (@className, @filePath, @line, @mechanism, @unresolvable)
  `);

  const txn = rawDb.transaction(() => {
    for (const u of usage) {
      insert.run({
        className: u.className,
        filePath: u.filePath,
        line: u.line,
        mechanism: u.mechanism,
        unresolvable: u.unresolvable ? 1 : 0,
      });
    }
  });

  txn();
}
