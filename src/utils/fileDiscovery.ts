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
  '.idea'
];

// Supported file extensions
export const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx'];
export const JAVASCRIPT_EXTENSIONS = ['.js', '.jsx'];
export const ALL_EXTENSIONS = [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS];

export interface FileDiscoveryOptions {
  extensions?: string[];
  excludeDirs?: string[];
  includePaths?: string[];
  excludePaths?: string[];
  followSymlinks?: boolean;
}

/**
 * Check if a path should be excluded based on directory names
 */
function shouldExcludeDir(filePath: string, excludeDirs: string[]): boolean {
  const parts = filePath.split(path.sep);
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
  }
): Promise<string[]> {
  const results: string[] = [];
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (shouldExcludeDir(fullPath, options.excludeDirs)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        const subResults = await findFilesRecursive(fullPath, options);
        results.push(...subResults);
      } else if (entry.isFile()) {
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
    excludeDirs
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
    pattern: regex
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
  // Convert glob wildcards to regex
  regex = regex.replace(/\*/g, '.*').replace(/\?/g, '.');
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