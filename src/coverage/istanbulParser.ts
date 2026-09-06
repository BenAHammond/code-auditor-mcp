/**
 * Istanbul (JSON) coverage parser — Spec 15 R4.
 *
 * Parses Istanbul/nyc JSON coverage output. The format is a map of
 * file paths → coverage data objects with statementMap, fnMap, and hit counts.
 *
 * Format reference: https://github.com/istanbuljs/istanbuljs
 */

export interface IstanbulCoverage {
  [filePath: string]: {
    path: string;
    statementMap: Record<string, {
      start: { line: number; column: number };
      end: { line: number; column: number };
    }>;
    fnMap: Record<string, {
      name: string;
      decl: { start: { line: number; column: number }; end: { line: number; column: number } };
      loc: { start: { line: number; column: number }; end: { line: number; column: number } };
      line?: number;
    }>;
    branchMap: Record<string, unknown>;
    /** Statement hit counts: statementId → execution count */
    s: Record<string, number>;
    /** Function hit counts: functionId → execution count */
    f: Record<string, number>;
    /** Branch hit counts */
    b: Record<string, number[]>;
    /** Full path to the source file */
    [key: string]: unknown;
  };
}

interface ParsedFile {
  sourceFile: string;
  /** Set of covered line numbers (statement hit count > 0) */
  coveredLines: Set<number>;
  /** Map of function name → { line, hitCount } */
  functions: Map<string, { line: number; hitCount: number }>;
  /** Total statements */
  totalStatements: number;
  /** Covered statements */
  coveredStatements: number;
}

/**
 * Parse Istanbul JSON coverage data string.
 */
export function parseIstanbul(content: string): ParsedFile[] {
  const raw: unknown = JSON.parse(content);

  // Istanbul output can be a top-level map of file → data, or wrapped in
  // an object with a `coverage` or individual file keys.
  const data = extractCoverageMap(raw);
  if (!data) return [];

  const results: ParsedFile[] = [];

  for (const [filePath, fileData] of Object.entries(data)) {
    if (!fileData || typeof fileData !== 'object') continue;
    const fd = fileData as Record<string, unknown>;

    // Use `path` field if available, otherwise use the key
    const sourceFile = typeof fd.path === 'string' ? fd.path : filePath;
    const coveredLines = new Set<number>();
    const functions = new Map<string, { line: number; hitCount: number }>();

    // Build line coverage from statements
    const stmtMap = fd.statementMap as Record<string, { start: { line: number } }> | undefined;
    const s = fd.s as Record<string, number> | undefined;

    if (stmtMap && s) {
      for (const [stmtId, loc] of Object.entries(stmtMap)) {
        const hitCount = s[stmtId] ?? 0;
        if (hitCount > 0 && loc?.start?.line) {
          coveredLines.add(loc.start.line);
        }
      }
    }

    // Build function coverage
    const fnMap = fd.fnMap as Record<string, {
      name: string;
      decl?: { start?: { line?: number } };
      loc?: { start?: { line?: number } };
      line?: number;
    }> | undefined;
    const f = fd.f as Record<string, number> | undefined;

    if (fnMap && f) {
      for (const [fnId, fnData] of Object.entries(fnMap)) {
        if (!fnData || typeof fnData !== 'object') continue;
        const hitCount = f[fnId] ?? 0;
        const line =
          fnData.line ??
          fnData.decl?.start?.line ??
          fnData.loc?.start?.line ??
          0;
        if (fnData.name) {
          functions.set(fnData.name, { line, hitCount });
        }
      }
    }

    const totalStatements = stmtMap ? Object.keys(stmtMap).length : 0;
    const coveredStatements = s
      ? Object.values(s).filter((c) => c > 0).length
      : 0;

    results.push({
      sourceFile,
      coveredLines,
      functions,
      totalStatements,
      coveredStatements,
    });
  }

  return results;
}

/**
 * Extract the coverage data map from a raw Istanbul JSON value.
 * Handles different wrapper formats.
 */
function extractCoverageMap(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;

  // Direct map of filePath → coverage data (most common)
  // Check if any value has a `statementMap` field
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && 'statementMap' in (val as Record<string, unknown>)) {
      return obj;
    }
  }

  // "istanbul" key (older format)
  if ('istanbul' in obj) {
    return extractCoverageMap(obj.istanbul);
  }

  // "coverage" or "coverageMap" key
  if ('coverage' in obj) {
    return extractCoverageMap(obj.coverage);
  }

  return null;
}

/**
 * Convert Istanbul parsed files to a file → covered lines map.
 */
export function istanbulToLineCoverage(files: ParsedFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const f of files) {
    map.set(f.sourceFile, f.coveredLines);
  }
  return map;
}

/**
 * Convert Istanbul parsed files to a file → covered function names map.
 */
export function istanbulToFunctionCoverage(files: ParsedFile[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const f of files) {
    const covered = new Set<string>();
    for (const [fnName, { hitCount }] of f.functions) {
      if (hitCount > 0) covered.add(fnName);
    }
    map.set(f.sourceFile, covered);
  }
  return map;
}
