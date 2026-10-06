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
import type { SqliteDatabase, SqliteStatement } from '../sqlite/types.js';
import { extractDeclarations } from './styleExtractor.js';
import { loadTailwindConfig, tokensToStyleTokens, type TailwindConfigResult } from './tailwindConfigLoader.js';
import {
  STYLE_MARKUP_EXTENSIONS,
  TYPESCRIPT_EXTENSIONS,
  JAVASCRIPT_EXTENSIONS,
} from '../utils/fileDiscovery.js';
import type {
  NormalizedDeclaration,
  StyleToken,
  StyleClassUsage,
} from './types.js';

// TS/JS source extensions are handled by the styles-source stage-2 visitor
// (Spec 26 Phase 2 follow-up): stage 1 parses every TS/JS file for the other
// visitors regardless, so the indexer no longer re-parses them here — that
// second parse was ~55ms of the scoped short-circuit gate's remaining cost.
const PIPELINE_SOURCE_EXTENSIONS = new Set([...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS]);
// Style-table clear statements, hoisted so the clear-source (full-file) and
// clear-missing (per-removed-file) paths cannot drift on a statement string.
const SQL_STYLE_CLEAR_DECL = 'DELETE FROM style_declarations WHERE file_path = ?';
const SQL_STYLE_CLEAR_USAGE = 'DELETE FROM style_class_usage WHERE file_path = ?';
const SQL_STYLE_CLEAR_TOKEN = 'DELETE FROM style_tokens WHERE file_path = ?';
const SQL_STYLE_CLEAR_CLASS = 'DELETE FROM style_defined_classes WHERE file_path = ?';

// Style-table insert statements, hoisted into the same one-time prepare bundle as
// the clears. `insertDeclarations`/`upsertClassUsage`/`upsertTokens` used to
// `.prepare(...)` these on every call — once per file in the per-file sync loop —
// the same N+1 the clear statements were hoisted to avoid. One parse per
// statement, bound `.run` per row.
const SQL_STYLE_INSERT_DECL = `
  INSERT INTO style_declarations
    (property, raw_value, normalized_value, mechanism, file_path, line,
     context, variant_context, token_ref, content_hash)
  VALUES
    (@property, @rawValue, @normalizedValue, @mechanism, @filePath, @line,
     @context, @variantContext, @tokenRef, @contentHash)
`;
const SQL_STYLE_INSERT_CLASS =
  'INSERT OR IGNORE INTO style_defined_classes (class_name, file_path) VALUES (?, ?)';
const SQL_STYLE_INSERT_USAGE = `
  INSERT INTO style_class_usage
    (class_name, file_path, line, mechanism, unresolvable)
  VALUES
    (@className, @filePath, @line, @mechanism, @unresolvable)
`;
const SQL_STYLE_INSERT_TOKEN = `
  INSERT INTO style_tokens (name, value, file_path, mechanism)
  VALUES (@name, @value, @filePath, @mechanism)
`;

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
  /**
   * Every file path this indexer actually read (readFileSync succeeded).
   * Excludes `.css`/`.scss` (handled by the styles-css stage-2 visitor) and
   * files that failed to read. This is the "any layer read it" evidence used by
   * Spec 44 to reclassify a stage-2 `no adapter`/`no visitor matched` drop as
   * `partially analyzed` — a file the style indexer consumed is not "not analyzed".
   */
  consumedFiles: string[];
  /**
   * In-scope files that actually inserted ≥1 declaration, token, or class-usage
   * row. Empty means the scoped sync found no style data, so the styles reducer
   * can short-circuit. Distinct from `consumedFiles`, which is every file READ
   * (a finding-free file the indexer read is still "consumed", not "contributing").
   */
  contributingFiles: string[];
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
 * @param rawDb The SQLite database to write the style index to.
 * @param files The file paths to sync.
 * @param projectRoot The project root for Tailwind config loading.
 * @param options Sync options (scoped flag).
 * @returns The sync result summary.
 */
export async function syncStyleIndex(
  rawDb: SqliteDatabase,
  files: string[],
  projectRoot: string,
  options: StyleSyncOptions = {},
): Promise<StyleSyncResult> {
  const result: StyleSyncResult = { changed: 0, skipped: 0, removed: 0, errors: 0, consumedFiles: [], contributingFiles: [] };
  const scoped = options.scoped ?? false;

  // Prepare the nine style-table statements (five clears + four inserts) once up
  // front, and preload the per-file content hash map for the skip check. Both
  // were per-file round-trips before (a `.prepare(...)` on every
  // `deleteFileEntries`/`insertDeclarations`/`upsertClassUsage`/`upsertTokens`
  // call, and a `SELECT content_hash` on every `getStoredHash`) — the classic
  // N+1 on a full-corpus sync. One parse per statement + one grouped read removes
  // the per-file queries entirely.
  const stmts = prepareStyleStatements(rawDb);
  const storedHashes = scoped ? null : loadStoredHashes(rawDb);

  // Load Tailwind config only when a file will actually consume tokens. The load
  // shells out to `git ls-files` (~50 ms), so on a run where every file is skipped
  // by the two guards below (e.g. a diff-scoped `.ts` change — `changed:0`) it would
  // be pure overhead on the `changed` gate. The load is memoized per process, so
  // calling it lazily here costs nothing on full runs that do reach extraction.
  const hasExtractableFile = files.some((filePath) => {
    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) return false;
    const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
    return !PIPELINE_SOURCE_EXTENSIONS.has(ext);
  });
  let tailwindResult: TailwindConfigResult | null = null;
  if (hasExtractableFile) {
    tailwindResult = loadTailwindConfig(projectRoot);
  }

  // Process each file
  for (const filePath of files) {
    // Skip .css and .scss files — handled by styles-css pipeline visitor (Spec 26 Phase 2).
    // .scss is parsed by tree-sitter-scss which extends the CSS grammar.
    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) continue;

    // Skip TS/JS source — handled by the styles-source stage-2 visitor, which
    // reuses the AST stage 1 already parsed (no re-parse here).
    const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
    if (PIPELINE_SOURCE_EXTENSIONS.has(ext)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
      // Reading the file is itself consumption (Spec 44) — record it regardless
      // of whether extraction later finds declarations. A finding-free file the
      // indexer read is still "partially analyzed", not "not analyzed".
      result.consumedFiles.push(filePath);
    } catch {
      // Read failure is now recorded by the traverse phase's own read attempt
      // (`runPhaseModel`); here it is only a sync error count.
      result.errors++;
      continue;
    }

    try {
      const contentHash = computeFileHash(content);

      // Check if file is already indexed and unchanged
      if (!scoped) {
        const existingHash = storedHashes?.get(filePath) ?? null;
        if (existingHash === contentHash) {
          result.skipped++;
          continue;
        }
      }

      // Delete old entries for this file (both scoped and full)
      deleteFileEntries(stmts, filePath);

      // Extract declarations. Only reachable for an extractable file, so
      // `tailwindResult` is non-null here (loaded above when hasExtractableFile).
      const declarations = extractForFile(filePath, content, tailwindResult!.tokens);

      // Whether this file contributed any style data (declaration, token, or
      // class usage). Feeds `contributingFiles`, the scoped short-circuit signal
      // for the styles reducer.
      let contributed = false;

      // Insert declarations
      if (declarations.length > 0) {
        insertDeclarations(rawDb, stmts, filePath, declarations, contentHash);
        contributed = true;
      }

      // Extract and insert class usage
      const classUsage = extractClassUsage(filePath, content);
      if (classUsage.length > 0) {
        upsertClassUsage(rawDb, stmts, filePath, classUsage);
        contributed = true;
      }

      if (contributed) {
        result.contributingFiles.push(filePath);
      }

      result.changed++;
    } catch {
      result.errors++;
    }
  }

  // The `.less`/`.styl`/`.sass` dialect walk now lives in the traverse phase
  // (`runPhaseModel`) — it produces those walk-level unread reasons directly
  // into the `unread-style-sources` fact, so this indexer no longer walks for
  // them here. The content-level `<style lang="…">` reason is likewise collected
  // by the markup `style-declarations` producer (`extractStylesMarkup`) from the
  // file content the phase model already read — this indexer no longer persists
  // the `style_unread_sources` table at all.

  // For full runs: remove stale entries for files not in the current set
  if (!scoped) {
    result.removed = removeStaleEntries(rawDb, files, stmts);
  }

  // Insert Tailwind theme tokens as style tokens
  if (tailwindResult && tailwindResult.source !== 'none' && result.changed > 0) {
    const twTokens = tokensToStyleTokens(tailwindResult, projectRoot);
    if (twTokens.length > 0) {
      // Upsert each token individually (name is the unique key)
      upsertTokens(rawDb, stmts, tailwindResult.configPath ?? 'tailwind-theme', twTokens);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract declarations for a single markup/component file. TS/JS source is
 * handled by the styles-source stage-2 visitor; .css/.scss by the styles-css
 * visitor — so only markup reaches this dispatcher.
 */
function extractForFile(
  filePath: string,
  sourceCode: string,
  tailwindTokens: any,
): NormalizedDeclaration[] {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';

  // Markup/component files — extractor handles these with regex. Derived from
  // the shared STYLE_MARKUP_EXTENSIONS so it can't drift from extractDeclarations
  // (the `.astro` silent-drop bug).
  if (STYLE_MARKUP_EXTENSIONS.includes(ext)) {
    return extractDeclarations(filePath, null as any, sourceCode, undefined, tailwindTokens);
  }

  // Not a style-bearing extension — skipped silently here. The unknown-extension
  // backstop (Spec 42 R2) now lives in the traverse phase's own read loop
  // (`runPhaseModel`), which records `unsupported source extension: <ext>` and
  // skips the parse; this indexer contributes no unread source for it.
  return [];
}

/**
 * Extract class usage from a source file.
 * Looks for className="..." attributes in JSX and class="..." in HTML.
 * @param filePath The source file path.
 * @param sourceCode The raw source text.
 * @returns The class usages extracted from the source.
 */
export function extractClassUsage(
  filePath: string,
  sourceCode: string,
): StyleClassUsage[] {
  const usage: StyleClassUsage[] = [];
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';

  // Class usage only exists in files that can carry a real class/className
  // attribute: JSX (`.tsx`/`.jsx`) and markup (`.html`/`.astro`/`.vue`/`.svelte`).
  // Data/config files (`.json`, `.sql`, `.toml`, `.prisma`), `.go`, and
  // stylesheets can contain `class`/`className` substrings inside string literals
  // (Bug #3 — e.g. an audit-report.json embedding a raw source snippet with
  // `error_class = 'zombie-capped'`); those must never reach the class-usage table.
  //
  // Plain `.ts`/`.js` (and their `.mts`/`.cts`/`.mjs`/`.cjs` variants) are excluded
  // for the same reason: with no JSX, a `class="…"` substring there is always inside
  // a string or template literal — HTML being generated (e.g. htmlReportGenerator.ts),
  // whose stylesheet is typically embedded in the same file and not indexed. Flagging
  // it undefined-class is a false positive, so gate extraction to the extensions that
  // actually carry real class attributes.
  const JSX_EXTENSIONS = ['.tsx', '.jsx'];
  const CLASS_USAGE_EXTENSIONS = [...JSX_EXTENSIONS, ...STYLE_MARKUP_EXTENSIONS];
  if (!CLASS_USAGE_EXTENSIONS.includes(ext)) return [];

  // Determine mechanism by file type
  let mechanism: StyleClassUsage['mechanism'] = 'class';
  if (JSX_EXTENSIONS.includes(ext)) {
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
// Database helpers
// ---------------------------------------------------------------------------

function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The per-file statements — four clears and four inserts — prepared once per
 *  sync and reused across every `deleteFileEntries`/`removeStaleEntries`/
 *  `insertDeclarations`/`upsertClassUsage`/`upsertTokens` call. Keeping them as a
 *  single bundle means the prepare cost is paid once at the top of
 *  `syncStyleIndex` instead of on every file (the per-file `.prepare(...)` N+1
 *  this replaces, both on the clear and the insert halves of the write path). */
interface StyleStatements {
  decl: SqliteStatement;
  usage: SqliteStatement;
  token: SqliteStatement;
  class: SqliteStatement;
  insertDecl: SqliteStatement;
  insertClass: SqliteStatement;
  insertUsage: SqliteStatement;
  insertToken: SqliteStatement;
}

function prepareStyleStatements(rawDb: SqliteDatabase): StyleStatements {
  return {
    decl: rawDb.prepare(SQL_STYLE_CLEAR_DECL),
    usage: rawDb.prepare(SQL_STYLE_CLEAR_USAGE),
    token: rawDb.prepare(SQL_STYLE_CLEAR_TOKEN),
    class: rawDb.prepare(SQL_STYLE_CLEAR_CLASS),
    insertDecl: rawDb.prepare(SQL_STYLE_INSERT_DECL),
    insertClass: rawDb.prepare(SQL_STYLE_INSERT_CLASS),
    insertUsage: rawDb.prepare(SQL_STYLE_INSERT_USAGE),
    insertToken: rawDb.prepare(SQL_STYLE_INSERT_TOKEN),
  };
}

/** One grouped read of every indexed file's content hash. All rows for a file
 *  share a single hash (written uniformly by `insertDeclarations`), so
 *  `GROUP BY file_path` collapses the table to one entry per file and replaces
 *  the per-file `SELECT content_hash … LIMIT 1` that `getStoredHash` used to run
 *  for every candidate file in a full sync. */
function loadStoredHashes(rawDb: SqliteDatabase): Map<string, string> {
  const rows = rawDb.prepare(
    'SELECT file_path, MAX(content_hash) AS content_hash FROM style_declarations GROUP BY file_path',
  ).all() as { file_path: string; content_hash: string | null }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.content_hash != null) map.set(row.file_path, row.content_hash);
  }
  return map;
}

function deleteFileEntries(stmts: StyleStatements, filePath: string): void {
  stmts.decl.run(filePath);
  stmts.usage.run(filePath);
  stmts.token.run(filePath);
  stmts.class.run(filePath);
}

function removeStaleEntries(
  rawDb: SqliteDatabase,
  currentFiles: string[],
  stmts: StyleStatements,
): number {
  const filesSet = new Set(currentFiles);
  // Union all four tables — style_class_usage, style_tokens, and
  // style_defined_classes can have entries for files that don't appear in
  // style_declarations (e.g. TSX files that use Tailwind classes without
  // defining CSS declarations).
  const allIndexed = rawDb.prepare(
    `SELECT DISTINCT file_path FROM style_declarations
     UNION
     SELECT DISTINCT file_path FROM style_class_usage
     UNION
     SELECT DISTINCT file_path FROM style_tokens
     UNION
     SELECT DISTINCT file_path FROM style_defined_classes`,
  ).all() as { file_path: string }[];

  let removed = 0;
  for (const { file_path } of allIndexed) {
    if (!filesSet.has(file_path)) {
      stmts.decl.run(file_path);
      stmts.usage.run(file_path);
      stmts.token.run(file_path);
      stmts.class.run(file_path);
      removed++;
    }
  }
  return removed;
}

function insertDeclarations(
  rawDb: SqliteDatabase,
  stmts: StyleStatements,
  filePath: string,
  declarations: NormalizedDeclaration[],
  contentHash: string,
): void {
  const txn = rawDb.transaction(() => {
    for (const d of declarations) {
      stmts.insertDecl.run({
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

      // Populate the defined-class catalog (Spec 45) from each declaration's
      // selector context so styles/undefined-class can resolve names via an
      // indexed `class_name IN (...)` lookup instead of a full-corpus scan.
      if (d.context) {
        for (const m of d.context.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
          stmts.insertClass.run(m[1], filePath);
        }
      }
    }
  });

  txn();
}

function upsertTokens(
  rawDb: SqliteDatabase,
  stmts: StyleStatements,
  filePath: string,
  tokens: StyleToken[],
): void {
  // Delete existing tokens from this file first, then insert fresh
  stmts.token.run(filePath);

  const txn = rawDb.transaction(() => {
    for (const token of tokens) {
      stmts.insertToken.run({
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
  rawDb: SqliteDatabase,
  stmts: StyleStatements,
  filePath: string,
  usage: StyleClassUsage[],
): void {
  // Delete existing class usage for this file first
  stmts.usage.run(filePath);

  const txn = rawDb.transaction(() => {
    for (const u of usage) {
      stmts.insertUsage.run({
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
