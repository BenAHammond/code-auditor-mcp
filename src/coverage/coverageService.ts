/**
 * Coverage import service — Spec 15 R4.
 *
 * Orchestrates importing coverage data from lcov .info or Istanbul JSON files,
 * auto-detecting the format and storing results in the CodeIndexDB.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { CoverageEntry } from '../types.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { parseLcov, lcovToLineCoverage } from './lcovParser.js';
import { parseIstanbul, istanbulToLineCoverage } from './istanbulParser.js';

export type CoverageFormat = 'lcov' | 'istanbul';

export interface ImportResult {
  format: CoverageFormat;
  filesImported: number;
  entriesImported: number;
  basis: 'measured';
  source: string;
}

/**
 * Detect the coverage format from file content.
 * LCOV files start with "TN:" — Istanbul files are JSON.
 */
export function detectFormat(content: string): CoverageFormat {
  const trimmed = content.trim();
  if (trimmed.startsWith('TN:') || trimmed.startsWith('SF:')) {
    return 'lcov';
  }
  return 'istanbul';
}

/**
 * Import a coverage file into the CodeIndexDB.
 *
 * @param filePath - Path to the coverage file (.info or .json)
 * @param projectRoot - Project root for resolving relative paths
 * @returns Import statistics
 */
export async function importCoverageFile(
  filePath: string,
  projectRoot: string,
): Promise<ImportResult> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const format = detectFormat(raw);

  let lineCoverage: Map<string, Set<number>>;
  let filesImported: number;

  if (format === 'lcov') {
    const entries = parseLcov(raw);
    lineCoverage = lcovToLineCoverage(entries);
    filesImported = new Set(entries.map((e) => e.sourceFile).filter(Boolean)).size;
  } else {
    const parsed = parseIstanbul(raw);
    lineCoverage = istanbulToLineCoverage(parsed);
    filesImported = parsed.length;
  }

  // Query all indexed functions from the DB and match against coverage
  const db = CodeIndexDB.getInstance();
  await db.initialize();

  const allFunctions = (db as any).rawDb
    .prepare(
      `SELECT id, name, file_path, line_number, is_exported FROM functions
       WHERE language IN ('typescript', 'javascript', 'go')`,
    )
    .all() as Array<{
    id: number;
    name: string;
    file_path: string;
    line_number: number;
    is_exported: number;
  }>;

  const entries: Array<{
    functionName: string;
    filePath: string;
    lineNumber: number;
    basis: 'measured';
    covered: boolean;
    source: string;
  }> = [];

  const absoluteProjectRoot = path.resolve(projectRoot);

  for (const fn of allFunctions) {
    let covered = false;

    // Try matching by absolute path and relative-path variants
    for (const [covFilePath, coveredLines] of lineCoverage) {
      const absPath = normalizePath(path.resolve(absoluteProjectRoot, covFilePath));
      const fnAbsPath = normalizePath(path.resolve(absoluteProjectRoot, fn.file_path));

      if (absPath === fnAbsPath || covFilePath === fn.file_path) {
        covered = coveredLines.has(fn.line_number);
        break;
      }
    }

    entries.push({
      functionName: fn.name,
      filePath: fn.file_path,
      lineNumber: fn.line_number,
      basis: 'measured',
      covered,
      source: filePath,
    });
  }

  const entriesImported = entries.filter((e) => e.covered).length;

  db.importCoverageData(entries);

  return {
    format,
    filesImported,
    entriesImported,
    basis: 'measured',
    source: filePath,
  };
}

/**
 * Generate a coverage report from the DB.
 */
export async function generateCoverageReport(): Promise<{
  totalFunctions: number;
  coveredFunctions: number;
  coverageRate: number;
  byRiskDecile: Array<{ decile: number; covered: number; total: number; rate: number }>;
  untestedTopDecile: Array<{
    functionName: string;
    filePath: string;
    riskScore: number;
    basis: string;
  }>;
  staleImport: boolean;
}> {
  const db = CodeIndexDB.getInstance();
  await db.initialize();

  const byRiskDecile = db.getCoverageByRiskDecile(10);
  const untestedTopDecile = db.getUntestedTopDecile(0.1);
  const staleImport = db.isCoverageStale();

  // Overall stats
  const totalResult = (db as any).rawDb
    .prepare('SELECT COUNT(*) as cnt FROM functions')
    .get() as { cnt: number };
  const coveredResult = (db as any).rawDb
    .prepare(
      `SELECT COUNT(DISTINCT function_name || ':' || file_path) as cnt
       FROM coverage_data WHERE covered = 1`,
    )
    .get() as { cnt: number };

  const totalFunctions = totalResult.cnt;
  const coveredFunctions = coveredResult.cnt;
  const coverageRate = totalFunctions > 0 ? coveredFunctions / totalFunctions : 0;

  return {
    totalFunctions,
    coveredFunctions,
    coverageRate,
    byRiskDecile,
    untestedTopDecile,
    staleImport,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}
