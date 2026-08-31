/**
 * File Discovery Utilities
 * Provides functionality for discovering and filtering files for analysis
 * 
 * Supports TypeScript, JavaScript, and JSX/TSX files with configurable
 * include/exclude patterns
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { FileAccounting } from '../services/fileAccounting.js';

/**
 * Spec 44 — the excluded-directory split. The two halves of the default
 * exclusion set behave differently under file accounting:
 *
 * - **Infra** dirs are toolchain artifacts (never source). They are pruned
 *   silently and recorded only as an aggregate `infraPruned` line, because
 *   enumerating `node_modules` per-file is impossible at scale.
 * - **Content** dirs (docs, specs, tmp, …) are small and genuinely "source the
 *   user might have meant to include". They are enumerated per-file and each
 *   file is recorded `dropped: directory pruned` — which is what makes an
 *   `.mdx` under `docs/` appear in the report instead of vanishing.
 */
export const DEFAULT_EXCLUDED_INFRA_DIRS = [
  'node_modules',
  '.next',
  'dist',
  'build',
  '.git',
  'coverage',
  '.turbo',
  'out',
  '.cache',
  '.vscode',
  '.idea',
  // Legacy index dir (CodeIndexDB) from older versions. Kept excluded so
  // pre-existing installs are never re-scanned (Bug #3). The current default
  // lives under `node_modules/.cache/code-auditor` (see dataPaths.ts).
  '.code-index',
];

// Documentation, specs, and backups — rarely contain production source code,
// but enumerated per-file under accounting so they are reported, not silent.
export const DEFAULT_EXCLUDED_CONTENT_DIRS = [
  'tmp',
  'temp',
  'docs',
  'specs',
  'backup',
  'backups',
];

// Backward-compatible union — still the default `excludeDirs` for discovery.
export const DEFAULT_EXCLUDED_DIRS = [
  ...DEFAULT_EXCLUDED_INFRA_DIRS,
  ...DEFAULT_EXCLUDED_CONTENT_DIRS,
];

/**
 * Spec 45 R1 — the per-entry anchoring choice. Each directory basename in
 * `DEFAULT_EXCLUDED_DIRS` is either *any-depth* or *root-anchored* depending on
 * whether the name is an unambiguous toolchain/transient marker (never a source
 * route) or an ambiguous one (could be user source when nested).
 *
 * ANY-DEPTH (13 entries) — toolchain artifacts wherever they appear; nested
 * occurrences are never source, so they are excluded at every depth below the
 * scan root:
 *
 *   - `node_modules` — package deps; monorepo workspaces are still deps.
 *   - `.git` — VCS metadata; submodules are still VCS.
 *   - `.next` — Next.js build output (reserved name).
 *   - `dist`, `out` — build/export output.
 *   - `coverage` — test coverage report.
 *   - `.turbo` — Turborepo cache.
 *   - `.cache` — cache (recall's `scripts/.cache` holds generated build JSON).
 *   - `.vscode`, `.idea` — editor state.
 *   - `.code-index` — legacy index dir (Bug #3); a prior scoped run can leave
 *     `src/agents/.code-index` nested. Current default: `node_modules/.cache/code-auditor`.
 *   - `tmp`, `temp` — transient (recall's `scripts/.wrangler/tmp` is Wrangler
 *     build cache; never source).
 *
 * ROOT-ANCHORED (5 entries) — ambiguous: they can be a real file-router route
 * or user source when nested under `src/`, so they are excluded only as the
 * first component below the scan root. File-based routers (Astro, Next,
 * SvelteKit, Nuxt) make `src/pages/docs/…` and `src/pages/…/build/…` real
 * routes:
 *
 *   - `build` — a nested `src/pages/…/build/…` dir is a route; root `build` is
 *     build output.
 *   - `docs` — `src/pages/docs/…` is a route (recall's two R1 source files);
 *     root `docs` is documentation.
 *   - `specs`, `backup`, `backups` — can be in-repo source.
 */
export const DEFAULT_EXCLUDED_ANY_DEPTH_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  '.vscode',
  '.idea',
  '.code-index',
  'tmp',
  'temp',
]);

/**
 * Basenames the tool itself writes into the project, which must never be
 * re-discovered as source on a subsequent run (Bug #3 — "exclude the tool's
 * own output from discovery"). The `audit` command writes `audit-report.<ext>`
 * next to (or under) the project root; its content embeds raw source snippets
 * (e.g. `error_class = 'zombie-capped'`) that would otherwise leak class-usage
 * false positives back into the index.
 */
export const DEFAULT_EXCLUDED_FILES = new Set([
  'audit-report.json',
  'audit-report.html',
  'audit-report.csv',
  'audit-report.sarif',
]);

// Supported file extensions
export const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
export const JAVASCRIPT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
export const JSON_EXTENSIONS = ['.json'];
export const GO_EXTENSIONS = ['.go'];
export const CSS_EXTENSIONS = ['.css', '.scss'];
// Markup extensions that carry `<style>` blocks (Spec 42 R1). Discovered so the
// style indexer can extract their embedded stylesheets; the pipeline itself has
// no language adapter for them, so they are consumed only by syncStyleIndex.
export const MARKUP_EXTENSIONS = ['.astro', '.vue', '.svelte'];
// Markup/component extensions the style extractor reads (embedded <style> blocks
// and class attributes). This is the single source of truth for the extractor's
// markup dispatch — the gates in styleIndexer.ts and the dispatch in
// styleExtractor.ts derive from it so a newly supported dialect is handled
// everywhere at once instead of silently dropped from one list. `.html` is
// included because scoped runs may pass HTML files, even though `.html` is NOT
// discovered by default (recall-protocol's ~11,928 spec-dump `.html` files would
// blow up a full audit).
export const STYLE_MARKUP_EXTENSIONS = ['.html', ...MARKUP_EXTENSIONS];
// Dialects the style indexer cannot yet read (Sass/SCSS indented syntax, Less,
// Stylus). Not discovered as source — the indexer records them as *unread*
// stylesheet sources (Spec 42 R2) so undefined-class never asserts on a class
// that could be defined in one of these.
export const UNREAD_STYLE_EXTENSIONS = ['.less', '.styl', '.sass'];
// Raw-source extensions — no tree-sitter grammar, included for visitors that
// read sourceCode directly (e.g. SQL migrations, TOML config, Prisma schemas)
export const SQL_EXTENSIONS = ['.sql'];
export const TOML_EXTENSIONS = ['.toml'];
export const PRISMA_EXTENSIONS = ['.prisma'];
export const RAW_EXTENSIONS = [...SQL_EXTENSIONS, ...TOML_EXTENSIONS, ...PRISMA_EXTENSIONS];
// NOTE: .html is deliberately NOT here — recall-protocol has ~11,928 .html
// files (spec dumps) and reading them all would blow up the audit. Markup
// extensions are added because they are real component files with styles.
export const ALL_EXTENSIONS = [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS, ...JSON_EXTENSIONS, ...GO_EXTENSIONS, ...CSS_EXTENSIONS, ...RAW_EXTENSIONS, ...MARKUP_EXTENSIONS];
// Every extension the analysis layer understands as source — style-bearing
// (TS/JS/markup/CSS) plus non-style (JSON/Go/SQL/TOML/Prisma), with `.html`
// added since scoped runs may pass it even though it is not discovered by
// default. Single source of truth for the style extractor's "loud" default
// branch: an extension that reaches it unhandled is recorded as an unread
// source (Spec 42 R2) *only* when it is NOT in this set, so a genuinely unknown
// dialect (`.mdx`, `.md`, …) surfaces instead of a silent zero while legitimate
// non-style source and `.css`/`.scss` (handled by the AST pipeline) stay silent.
export const KNOWN_SOURCE_EXTENSIONS = [...ALL_EXTENSIONS, '.html'];

export interface FileDiscoveryOptions {
  extensions?: string[];
  excludeDirs?: string[];
  includePaths?: string[];
  excludePaths?: string[];
  followSymlinks?: boolean;
  /**
   * Opt-in callback fired for every file whose extension is not in the
   * discovery `extensions` set (Spec 43 R5 follow-up). Lets a caller aggregate
   * the "what isn't being analyzed here" list so it can surface in the report
   * instead of vanishing silently at discovery. Extensionless files (`''`) are
   * not reported. Files inside `excludeDirs` are never walked, so they are never
   * reported here — directory exclusion is a separate, documented concern from
   * extension filtering.
   */
  onSkippedExtension?: (ext: string, filePath: string) => void;
  /**
   * Spec 44 — the file-accounting accumulator. When set, discovery records:
   * `directory pruned` drops for every file under a *content* exclude dir,
   * `extension not known` drops for skipped extensions, an aggregate
   * `infraPruned` line per *infra* exclude dir, `directory pruned` drops for
   * `excludePaths` matches (rule = the glob), and `recordTouched` for every
   * candidate that survives filtering. Without it, discovery is a pure
   * enumerator (unchanged behavior).
   */
  fileAccounting?: FileAccounting;
}

/**
 * Classify a path against the excluded-directory split (Spec 44 + Spec 45 R1).
 *
 * Only checks directory components *below* the scan root to avoid false
 * matches against filesystem roots like /tmp or /temp. A component that is a
 * default *infra* dir prunes silently (aggregate); every other excluded
 * component — default *content* dirs and any user-supplied dir — is enumerated
 * per-file so nothing is silently dropped.
 *
 * Spec 45 R1: a basename matches only as the *first* component below the scan
 * root, unless it is one of the `DEFAULT_EXCLUDED_ANY_DEPTH_DIRS` entries
 * (unambiguous toolchain/transient names — see the per-entry list on that
 * constant), which match at any depth. This keeps `src/pages/docs/…` and
 * `src/pages/…/build/…` as source instead of silently pruning them, while still
 * pruning nested `node_modules`, `.cache`, `.code-index`, and `tmp`.
 */
function classifyExcludedDir(
  filePath: string,
  excludeDirs: string[],
  scanRoot: string
): { kind: 'infra' | 'content'; dir: string } | null {
  // Get the relative path below scanRoot
  const relPath = path.relative(scanRoot, filePath);
  // If the path is outside scanRoot (shouldn't happen), don't exclude
  if (relPath.startsWith('..')) return null;
  const parts = relPath.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!excludeDirs.includes(part)) continue;
    // Root-anchored entries match only at the first component; any-depth
    // entries (`node_modules`, `.git`) match anywhere below the scan root.
    if (i !== 0 && !DEFAULT_EXCLUDED_ANY_DEPTH_DIRS.has(part)) continue;
    if (DEFAULT_EXCLUDED_INFRA_DIRS.includes(part)) return { kind: 'infra', dir: part };
    return { kind: 'content', dir: part };
  }
  return null;
}

/**
 * Recursively list every file under a directory, any extension. Used only for
 * *content* exclude dirs (small, enumerated per-file under accounting).
 */
async function enumerateAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await enumerateAllFiles(fullPath)));
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  } catch {
    // Unreadable subtree — skip (mirrors the walk's EACCES tolerance).
  }
  return out;
}

/**
 * Recursively find files matching criteria
 */
async function findFilesRecursive(
  dir: string,
  options: {
    extensions: string[];
    excludeDirs: string[];
    pattern?: RegExp;
    scanRoot: string;
    onSkippedExtension?: (ext: string, filePath: string) => void;
    fileAccounting?: FileAccounting;
  }
): Promise<string[]> {
  const results: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      const excl = classifyExcludedDir(fullPath, options.excludeDirs, options.scanRoot);
      if (excl) {
        const rule = DEFAULT_EXCLUDED_DIRS.includes(excl.dir) ? 'DEFAULT_EXCLUDED_DIRS' : 'excludeDirs';
        if (excl.kind === 'infra') {
          // Aggregate — never per-file (node_modules is not enumerable at scale).
          options.fileAccounting?.recordInfraPruned(excl.dir, rule);
        } else if (entry.isDirectory() && options.fileAccounting) {
          // Content dir — enumerated per-file, each dropped: directory pruned.
          // This is what makes `.mdx` under `docs/` appear (Spec 44 acceptance 5).
          const contentFiles = await enumerateAllFiles(fullPath);
          for (const f of contentFiles) {
            options.fileAccounting.recordDropped('directory pruned', f, { directory: excl.dir, rule });
          }
        }
        continue;
      }

      if (entry.isDirectory()) {
        const subResults = await findFilesRecursive(fullPath, options);
        results.push(...subResults);
      } else if (entry.isFile()) {
        // Skip the tool's own report output by basename (Bug #3).
        if (DEFAULT_EXCLUDED_FILES.has(entry.name)) continue;
        const ext = path.extname(entry.name);
        if (options.extensions.includes(ext)) {
          if (!options.pattern || options.pattern.test(entry.name)) {
            results.push(fullPath);
          }
        } else if (ext !== '') {
          // Record the extension discovery skipped so the report can answer
          // "what isn't being analyzed here" (Spec 43 R5 follow-up) rather than
          // silently dropping the file at discovery.
          options.onSkippedExtension?.(ext, fullPath);
          // Spec 44 reason 2 — a file with a known (or unknown) extension that
          // is simply not in the discovery set.
          options.fileAccounting?.recordDropped('extension not known', fullPath, {
            ext,
            kind: KNOWN_SOURCE_EXTENSIONS.includes(ext) ? 'known-but-not-discovered' : 'unknown',
          });
        }
      }
    }
  } catch (error) {
    // Silently skip directories we can't read
    if ((error as NodeJS.ErrnoException).code !== 'EACCES') {
      console.error(`Error reading directory ${dir}:`, error);
    }
  }

  return results;
}

/**
 * Find all files matching the given options
 */
export async function findFiles(
  rootDir: string = process.cwd(),
  options: FileDiscoveryOptions = {}
): Promise<string[]> {
  const extensions = options.extensions || ALL_EXTENSIONS;
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDED_DIRS;
  
  const files = await findFilesRecursive(rootDir, {
    extensions,
    excludeDirs,
    scanRoot: rootDir,
    ...(options.onSkippedExtension ? { onSkippedExtension: options.onSkippedExtension } : {}),
    ...(options.fileAccounting ? { fileAccounting: options.fileAccounting } : {})
  });

  // Apply additional filtering
  const filtered = filterFiles(files, {
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
    fileAccounting: options.fileAccounting
  });

  // Spec 44 — every candidate that survives discovery filtering is "touched"
  // (it will be classified analyzed/dropped in stage 2). Recording it here —
  // after include/exclude filtering — means a positive-selection `includePaths`
  // narrows the universe instead of producing touched-but-dropped entries.
  if (options.fileAccounting) {
    for (const f of filtered) options.fileAccounting.recordTouched(f);
  }

  // Sort for consistent output
  return filtered.sort();
}

/**
 * Find TypeScript/TSX files
 */
export async function findTypeScriptFiles(
  rootDir: string = process.cwd(),
  options: Omit<FileDiscoveryOptions, 'extensions'> = {}
): Promise<string[]> {
  return findFiles(rootDir, {
    ...options,
    extensions: TYPESCRIPT_EXTENSIONS
  });
}

/**
 * Find JavaScript/JSX files
 */
export async function findJavaScriptFiles(
  rootDir: string = process.cwd(),
  options: Omit<FileDiscoveryOptions, 'extensions'> = {}
): Promise<string[]> {
  return findFiles(rootDir, {
    ...options,
    extensions: JAVASCRIPT_EXTENSIONS
  });
}

/**
 * Find JSON files
 */
export async function findJsonFiles(
  rootDir: string = process.cwd(),
  options: Omit<FileDiscoveryOptions, 'extensions'> = {}
): Promise<string[]> {
  return findFiles(rootDir, {
    ...options,
    extensions: JSON_EXTENSIONS
  });
}

/**
 * Find files by pattern (e.g., "*.test.ts", "*.spec.tsx")
 */
export async function findFilesByPattern(
  rootDir: string = process.cwd(),
  pattern: string | RegExp,
  options: FileDiscoveryOptions = {}
): Promise<string[]> {
  const extensions = options.extensions || ALL_EXTENSIONS;
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDED_DIRS;
  
  // Convert string pattern to RegExp if needed
  const regex = typeof pattern === 'string' 
    ? new RegExp(pattern.replace(/\*/g, '.*'))
    : pattern;
  
  const files = await findFilesRecursive(rootDir, {
    extensions,
    excludeDirs,
    pattern: regex,
    scanRoot: rootDir,
    ...(options.onSkippedExtension ? { onSkippedExtension: options.onSkippedExtension } : {}),
    ...(options.fileAccounting ? { fileAccounting: options.fileAccounting } : {})
  });

  // Apply additional filtering
  const filtered = filterFiles(files, {
    includePaths: options.includePaths,
    excludePaths: options.excludePaths,
    fileAccounting: options.fileAccounting
  });

  if (options.fileAccounting) {
    for (const f of filtered) options.fileAccounting.recordTouched(f);
  }

  return filtered.sort();
}

/**
 * Filter files by include/exclude patterns
 */
export function filterFiles(
  files: string[],
  options: {
    includePaths?: string[];
    excludePaths?: string[];
    fileAccounting?: FileAccounting;
  } = {}
): string[] {
  let filtered = [...files];

  // Apply include patterns (positive selection — narrows the universe; a file
  // removed here is simply not "touched", not dropped).
  if (options.includePaths && options.includePaths.length > 0) {
    filtered = filtered.filter(file => {
      return options.includePaths!.some(pattern => {
        // Convert glob patterns to regex
        const regex = globToRegex(pattern);
        return regex.test(file);
      });
    });
  }

  // Apply exclude patterns
  if (options.excludePaths && options.excludePaths.length > 0) {
    const kept: string[] = [];
    for (const file of filtered) {
      const matched = options.excludePaths.find(pattern => {
        // Convert glob patterns to regex
        const regex = globToRegex(pattern);
        return regex.test(file);
      });
      if (matched) {
        // Spec 44 reason 1 — a user `excludePaths` prune, rule = the glob.
        options.fileAccounting?.recordDropped('directory pruned', file, { rule: matched });
      } else {
        kept.push(file);
      }
    }
    filtered = kept;
  }

  return filtered;
}

/**
 * Convert simple glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  // Escape special regex characters except * and ?
  let regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Convert **/ (zero or more path segments). Use a sentinel to prevent
  // the subsequent single-* replacement from corrupting the quantifier.
  regex = regex.replace(/\*\*\//g, '\x00');
  // Convert remaining glob wildcards to regex
  regex = regex.replace(/\*/g, '.*').replace(/\?/g, '.');
  // Restore **/ pattern as (.*/)* (zero or more segments)
  regex = regex.replace(/\x00/g, '(.*/)*');
  return new RegExp(`^${regex}$`);
}

/**
 * Get file statistics
 */
export async function getFileStats(filePath: string): Promise<{
  size: number;
  modified: Date;
  lines?: number;
}> {
  const stats = await fs.stat(filePath);
  
  // Count lines for text files
  let lines: number | undefined;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    lines = content.split('\n').length;
  } catch {
    // Ignore errors reading file content
  }
  
  return {
    size: stats.size,
    modified: stats.mtime,
    lines
  };
}

/**
 * Check if a file exists and is readable
 */
export async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.R_OK);
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Alias for findFiles to match expected import
 */
export const discoverFiles = findFiles;

/**
 * Discovery result plus the extensions discovery skipped, aggregated with
 * counts. Surfacing this list makes "what isn't being analyzed here" answerable
 * from the report instead of from a grep (Spec 43 R5 follow-up — the same
 * silent-fallthrough fix applied to `.astro`/`.vue`/`.svelte` at extraction,
 * moved one layer earlier to discovery).
 */
export interface DiscoverFilesDetailedResult {
  files: string[];
  skippedExtensions: Array<{ ext: string; count: number }>;
}

/**
 * Discover files and simultaneously record the extensions discovery skipped.
 * Mirrors `findFiles` (same defaults and filtering), but the returned
 * `skippedExtensions` is aggregated during the recursive walk — before
 * `includePaths`/`excludePaths` filtering — so it reflects the full scan, not
 * just the filtered subset. Sorted by count descending, then extension.
 */
export async function discoverFilesDetailed(
  rootDir: string = process.cwd(),
  options: FileDiscoveryOptions = {}
): Promise<DiscoverFilesDetailedResult> {
  const counts = new Map<string, number>();
  const onSkippedExtension = (ext: string) => {
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  };
  const files = await findFiles(rootDir, { ...options, onSkippedExtension });
  const skippedExtensions = [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
  return { files, skippedExtensions };
}