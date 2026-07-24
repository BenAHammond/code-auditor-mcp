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
import type {
  NormalizedDeclaration,
  StyleToken,
  StyleClassUsage,
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
    try {
      const content = readFileSync(filePath, 'utf-8');
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
      const declarations = await extractForFile(filePath, content, registry, tailwindTokens);

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
): Promise<NormalizedDeclaration[]> {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';

  // CSS/SCSS can be extracted without an adapter
  if (ext === '.css' || ext === '.scss') {
    return extractDeclarations(filePath, null as any, sourceCode, undefined, tailwindTokens);
  }

  // TS/JS/TSX/JSX need a language adapter
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
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
        return extractDeclarations(filePath, adapter, sourceCode, ast, tailwindTokens);
      } catch {
        // Parse error — skip
      }
    }

    // Try extraction without AST (regex-only for class attributes)
    return extractDeclarations(filePath, null as any, sourceCode, undefined, tailwindTokens);
  }

  // HTML/Vue/Svelte — extractor handles these with regex
  if (['.html', '.vue', '.svelte'].includes(ext)) {
    return extractDeclarations(filePath, null as any, sourceCode, undefined, tailwindTokens);
  }

  return [];
}

/**
 * Extract class usage from a source file.
 * Looks for className="..." attributes in JSX and class="..." in HTML.
 */
function extractClassUsage(
  filePath: string,
  sourceCode: string,
): StyleClassUsage[] {
  const usage: StyleClassUsage[] = [];
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';

  // Determine mechanism by file type
  let mechanism: StyleClassUsage['mechanism'] = 'class';
  if (['.tsx', '.jsx', '.ts', '.js'].includes(ext)) {
    mechanism = 'className';
  }

  // Match className="..." or class="..."
  const attrRegex = /(?:className|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{(["'`])((?:(?!\3).)*)\3\})/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(sourceCode)) !== null) {
    const value = match[1] ?? match[2] ?? match[4] ?? '';
    const line = sourceCode.slice(0, match.index).split('\n').length;
    const classes = value.split(/\s+/).filter(Boolean);

    // Determine if unresolvable (dynamic expressions like clsx, template literals)
    const isDynamic = !!(match[4] ?? match[3]);
    const hasDynamicParts = isDynamic && /[\${}]/.test(value);

    for (const className of classes) {
      // Skip obvious static utility fragments from dynamic expressions
      if (!className || className.length === 0) continue;

      usage.push({
        className: className.trim(),
        filePath,
        line,
        mechanism,
        unresolvable: hasDynamicParts,
      });
    }
  }

  return usage;
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
}

function removeStaleEntries(rawDb: Database.Database, currentFiles: string[]): number {
  const filesSet = new Set(currentFiles);
  const allIndexed = rawDb.prepare(
    'SELECT DISTINCT file_path FROM style_declarations',
  ).all() as { file_path: string }[];

  let removed = 0;
  for (const { file_path } of allIndexed) {
    if (!filesSet.has(file_path)) {
      rawDb.prepare('DELETE FROM style_declarations WHERE file_path = ?').run(file_path);
      rawDb.prepare('DELETE FROM style_class_usage WHERE file_path = ?').run(file_path);
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
