/**
 * LCOV (.info) coverage parser — Spec 15 R4.
 *
 * Parses LCOV tracefiles produced by Istanbul/nyc, c8, and similar tools.
 * Extracts per-file, per-line, and per-function coverage data.
 *
 * Format reference: https://ltp.sourceforge.net/coverage/lcov/geninfo.1.php
 */

export interface LcovEntry {
  /** Source file path (SF:) */
  sourceFile: string;
  /** Array of [lineNumber, executionCount] tuples (DA:) */
  lines: Array<[number, number]>;
  /** Map of function name → [line, hitCount] (FN: + FNDA:) */
  functions: Map<string, { line: number; hitCount: number }>;
  /** Lines found (LF:) */
  linesFound: number;
  /** Lines hit (LH:) */
  linesHit: number;
  /** Test name (TN:) */
  testName?: string;
}

/**
 * Parse an LCOV .info file string into structured entries.
 * One entry per `end_of_record` delimited record.
 */
export function parseLcov(content: string): LcovEntry[] {
  const entries: LcovEntry[] = [];
  let current: LcovEntry | null = null;
  /** Pending FN: entries waiting for their FNDA: match in subsequent lines. */
  let pendingFns = new Map<string, number>(); // name → line
  let pendingTestName: string | undefined;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === 'end_of_record') {
      if (trimmed === 'end_of_record' && current) {
        current = null;
        pendingFns = new Map();
        pendingTestName = undefined;
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const tag = trimmed.substring(0, colonIdx);
    const value = trimmed.substring(colonIdx + 1);

    switch (tag) {
      case 'TN':
        // Record test name — applied to the next SF or existing current entry
        pendingTestName = value;
        if (!current) {
          current = createEmptyEntry();
        }
        current.testName = value;
        break;

      case 'SF':
        // New source file — start a fresh record
        current = createEmptyEntry();
        current.sourceFile = value;
        if (pendingTestName) {
          current.testName = pendingTestName;
          pendingTestName = undefined;
        }
        entries.push(current);
        break;

      case 'DA': {
        if (!current) break;
        const [lineNum, count] = value.split(',').map(Number);
        if (!isNaN(lineNum) && !isNaN(count)) {
          current.lines.push([lineNum, count]);
        }
        break;
      }

      case 'LF':
        if (current) current.linesFound = parseInt(value, 10) || 0;
        break;

      case 'LH':
        if (current) current.linesHit = parseInt(value, 10) || 0;
        break;

      case 'FN': {
        if (!current) break;
        const [lineNum, fnName] = splitComma(value);
        if (lineNum !== null && fnName) {
          pendingFns.set(fnName, lineNum);
        }
        break;
      }

      case 'FNDA': {
        if (!current) break;
        const [countStr, fnName] = splitComma(value);
        const count = countStr ?? NaN;
        if (fnName && !isNaN(count)) {
          const line = pendingFns.get(fnName);
          current.functions.set(fnName, {
            line: line ?? 0,
            hitCount: count,
          });
        }
        break;
      }

      case 'BRDA':
      case 'BRF':
      case 'BRH':
        // Branch coverage — not needed for function-level detection
        break;
    }
  }

  return entries;
}

/**
 * Convert LCOV entries to a flat coverage map:
 * sourceFile → Set of covered line numbers.
 */
export function lcovToLineCoverage(entries: LcovEntry[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const entry of entries) {
    const covered = new Set<number>();
    for (const [line, count] of entry.lines) {
      if (count > 0) covered.add(line);
    }
    // Merge with existing (multiple records can cover the same file)
    const existing = map.get(entry.sourceFile);
    if (existing) {
      for (const c of covered) existing.add(c);
    } else {
      map.set(entry.sourceFile, covered);
    }
  }
  return map;
}

/**
 * Convert LCOV entries to a flat set of covered function names per file.
 */
export function lcovToFunctionCoverage(entries: LcovEntry[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of entries) {
    const covered = new Set<string>();
    for (const [fnName, { hitCount }] of entry.functions) {
      if (hitCount > 0) covered.add(fnName);
    }
    const existing = map.get(entry.sourceFile);
    if (existing) {
      for (const c of covered) existing.add(c);
    } else {
      map.set(entry.sourceFile, covered);
    }
  }
  return map;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function createEmptyEntry(): LcovEntry {
  return {
    sourceFile: '',
    lines: [],
    functions: new Map(),
    linesFound: 0,
    linesHit: 0,
  };
}

/** Split "123,foo" → [123, "foo"]; handles commas in function names. */
function splitComma(value: string): [number | null, string | null] {
  const idx = value.indexOf(',');
  if (idx < 0) return [null, null];
  const first = value.substring(0, idx);
  const rest = value.substring(idx + 1);
  const num = parseInt(first, 10);
  return [isNaN(num) ? null : num, rest || null];
}
