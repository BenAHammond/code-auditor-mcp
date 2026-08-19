/**
 * File Discovery Utilities
 * Provides functionality for discovering and filtering files for analysis
 * 
 * Supports TypeScript, JavaScript, and JSX/TSX files with configurable
 * include/exclude patterns
 */

import { promises as fs } from 'fs';
import path from 'path';

// Default directories to exclude from analysis
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules',
  '.next',
  'dist',
  'build',
  '.git',
  'coverage',
  '.turbo',
  'out',
  '.cache',
  'tmp',
  'temp',
  '.vscode',
  '.idea',
  // Documentation, specs, and backups — rarely contain production source code
  'docs',
  'specs',
  'backup',
  'backups',
  // The tool's own on-disk index (CodeIndexDB). A prior audit run writes
  // `.code-index/index.db` into the project root; it must never be re-scanned
  // as source on a subsequent run (Bug #3).
  '.code-index',
];

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
export const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx'];
export const JAVASCRIPT_EXTENSIONS = ['.js', '.jsx'];
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
}

/**
 * Check if a path should be excluded based on directory names.
 * Only checks directory components *below* the scan root to avoid
 * false matches against filesystem roots like /tmp or /temp.
 */
function shouldExcludeDir(filePath: string, excludeDirs: string[], scanRoot: string): boolean {
  // Get the relative path below scanRoot
  const relPath = path.relative(scanRoot, filePath);
  // If the path is outside scanRoot (shouldn't happen), don't exclude
  if (relPath.startsWith('..')) return false;
  const parts = relPath.split(path.sep);
  return parts.some(part => excludeDirs.includes(part));
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
  }
): Promise<string[]> {
  const results: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (shouldExcludeDir(fullPath, options.excludeDirs, options.scanRoot)) {
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
    scanRoot: rootDir
  });

  // Apply additional filtering
  let filtered = filterFiles(files, {
    includePaths: options.includePaths,
    excludePaths: options.excludePaths
  });

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
    scanRoot: rootDir
  });
  
  // Apply additional filtering
  let filtered = filterFiles(files, {
    includePaths: options.includePaths,
    excludePaths: options.excludePaths
  });
  
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
  } = {}
): string[] {
  let filtered = [...files];
  
  // Apply include patterns
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
    filtered = filtered.filter(file => {
      return !options.excludePaths!.some(pattern => {
        // Convert glob patterns to regex
        const regex = globToRegex(pattern);
        return regex.test(file);
      });
    });
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