import { describe, it, expect } from 'vitest';
import { parseLcov, lcovToLineCoverage, lcovToFunctionCoverage } from '../lcovParser.js';
import {
  parseIstanbul,
  istanbulToLineCoverage,
  istanbulToFunctionCoverage,
} from '../istanbulParser.js';

// ── LCOV Parser ──────────────────────────────────────────────────────────

describe('lcovParser', () => {
  const sampleLcov = `TN:test suite
SF:src/handlers/createOrder.ts
FN:10,createOrder
FNDA:1,createOrder
FNDA:0,unusedHelper
DA:10,1
DA:12,1
DA:15,0
LF:3
LH:2
end_of_record
SF:src/utils/format.ts
DA:1,1
DA:2,0
LF:2
LH:1
end_of_record
`;

  it('parses multiple records from an LCOV file', () => {
    const entries = parseLcov(sampleLcov);
    expect(entries).toHaveLength(2);
    expect(entries[0].sourceFile).toBe('src/handlers/createOrder.ts');
    expect(entries[1].sourceFile).toBe('src/utils/format.ts');
  });

  it('extracts test name from TN record', () => {
    const entries = parseLcov(sampleLcov);
    expect(entries[0].testName).toBe('test suite');
  });

  it('parses line execution data (DA records)', () => {
    const entries = parseLcov(sampleLcov);
    expect(entries[0].lines).toEqual([
      [10, 1],
      [12, 1],
      [15, 0],
    ]);
    expect(entries[1].lines).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it('parses LF/LH summary fields', () => {
    const entries = parseLcov(sampleLcov);
    expect(entries[0].linesFound).toBe(3);
    expect(entries[0].linesHit).toBe(2);
    expect(entries[1].linesFound).toBe(2);
    expect(entries[1].linesHit).toBe(1);
  });

  it('parses function definitions (FN) and execution counts (FNDA)', () => {
    const entries = parseLcov(sampleLcov);
    const fns = entries[0].functions;
    expect(fns.has('createOrder')).toBe(true);
    expect(fns.get('createOrder')).toEqual({ line: 10, hitCount: 1 });
    expect(fns.has('unusedHelper')).toBe(true);
    expect(fns.get('unusedHelper')).toEqual({ line: 0, hitCount: 0 });
  });

  it('converts to line coverage map', () => {
    const entries = parseLcov(sampleLcov);
    const map = lcovToLineCoverage(entries);
    expect(map.size).toBe(2);
    expect(map.get('src/handlers/createOrder.ts')).toEqual(new Set([10, 12]));
    expect(map.get('src/utils/format.ts')).toEqual(new Set([1]));
  });

  it('converts to function coverage map', () => {
    const entries = parseLcov(sampleLcov);
    const map = lcovToFunctionCoverage(entries);
    expect(map.size).toBe(2);
    expect(map.get('src/handlers/createOrder.ts')).toEqual(new Set(['createOrder']));
    // unusedHelper had hitCount 0, so not covered
  });

  it('handles empty input', () => {
    const entries = parseLcov('');
    expect(entries).toEqual([]);
  });

  it('handles input with only whitespace', () => {
    const entries = parseLcov('\n  \n  \n');
    expect(entries).toEqual([]);
  });

  it('merges coverage across multiple records for the same file', () => {
    const multiRecord = `SF:src/app.ts
DA:1,1
DA:2,0
end_of_record
SF:src/app.ts
DA:3,1
DA:2,1
end_of_record
`;
    const entries = parseLcov(multiRecord);
    const map = lcovToLineCoverage(entries);
    expect(map.get('src/app.ts')).toEqual(new Set([1, 2, 3]));
  });

  it('handles FNDA entries without prior FN', () => {
    // FNDA for a function name that wasn't declared via FN
    const orphanFnda = `SF:src/app.ts
FNDA:5,orphanFunc
DA:10,1
end_of_record
`;
    const entries = parseLcov(orphanFnda);
    const fns = entries[0].functions;
    expect(fns.has('orphanFunc')).toBe(true);
    expect(fns.get('orphanFunc')!.hitCount).toBe(5);
    expect(fns.get('orphanFunc')!.line).toBe(0); // no FN line
  });

  it('skips BRDA/BRF/BRH branch tags', () => {
    const withBranches = `SF:src/app.ts
BRDA:10,0,0,1
BRF:2
BRH:1
DA:10,1
end_of_record
`;
    const entries = parseLcov(withBranches);
    expect(entries).toHaveLength(1);
    expect(entries[0].lines).toEqual([[10, 1]]);
  });
});

// ── Istanbul Parser ──────────────────────────────────────────────────────

describe('istanbulParser', () => {
  const sampleIstanbul = {
    '/project/src/handlers/createOrder.ts': {
      path: '/project/src/handlers/createOrder.ts',
      statementMap: {
        '0': { start: { line: 10, column: 0 }, end: { line: 10, column: 20 } },
        '1': { start: { line: 12, column: 0 }, end: { line: 12, column: 15 } },
        '2': { start: { line: 15, column: 0 }, end: { line: 15, column: 30 } },
      },
      fnMap: {
        '0': {
          name: 'createOrder',
          decl: { start: { line: 10, column: 0 }, end: { line: 10, column: 10 } },
          loc: { start: { line: 10, column: 0 }, end: { line: 20, column: 1 } },
        },
        '1': {
          name: 'validateInput',
          decl: { start: { line: 5, column: 0 }, end: { line: 5, column: 14 } },
          loc: { start: { line: 5, column: 0 }, end: { line: 8, column: 1 } },
        },
      },
      branchMap: {},
      s: { '0': 1, '1': 1, '2': 0 },
      f: { '0': 2, '1': 0 },
      b: {},
    },
    '/project/src/utils/format.ts': {
      path: '/project/src/utils/format.ts',
      statementMap: {
        '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      },
      fnMap: {},
      branchMap: {},
      s: { '0': 1 },
      f: {},
      b: {},
    },
  };

  it('parses Istanbul JSON coverage', () => {
    const result = parseIstanbul(JSON.stringify(sampleIstanbul));
    expect(result).toHaveLength(2);
  });

  it('extracts covered lines from statement hit counts', () => {
    const result = parseIstanbul(JSON.stringify(sampleIstanbul));
    const file1 = result.find((f) => f.sourceFile.includes('createOrder'));
    expect(file1).toBeDefined();
    expect(file1!.coveredLines).toEqual(new Set([10, 12]));
    // Line 15 had hit count 0, not covered
  });

  it('extracts function coverage with hit counts', () => {
    const result = parseIstanbul(JSON.stringify(sampleIstanbul));
    const file1 = result.find((f) => f.sourceFile.includes('createOrder'));
    expect(file1).toBeDefined();
    expect(file1!.functions.size).toBe(2);
    expect(file1!.functions.get('createOrder')).toEqual({ line: 10, hitCount: 2 });
    expect(file1!.functions.get('validateInput')).toEqual({ line: 5, hitCount: 0 });
  });

  it('converts to line coverage map', () => {
    const result = parseIstanbul(JSON.stringify(sampleIstanbul));
    const map = istanbulToLineCoverage(result);
    expect(map.size).toBe(2);
    expect(map.get('/project/src/handlers/createOrder.ts')).toEqual(new Set([10, 12]));
    expect(map.get('/project/src/utils/format.ts')).toEqual(new Set([1]));
  });

  it('converts to function coverage map', () => {
    const result = parseIstanbul(JSON.stringify(sampleIstanbul));
    const map = istanbulToFunctionCoverage(result);
    expect(map.size).toBe(2);
    expect(map.get('/project/src/handlers/createOrder.ts')).toEqual(new Set(['createOrder']));
    expect(map.get('/project/src/utils/format.ts')).toEqual(new Set());
  });

  it('handles empty JSON object', () => {
    const result = parseIstanbul('{}');
    expect(result).toEqual([]);
  });

  it('handles nested coverage key', () => {
    const nested = {
      coverage: {
        '/project/src/app.ts': {
          path: '/project/src/app.ts',
          statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } } },
          fnMap: {},
          branchMap: {},
          s: { '0': 1 },
          f: {},
          b: {},
        },
      },
    };
    const result = parseIstanbul(JSON.stringify(nested));
    expect(result).toHaveLength(1);
    expect(result[0].sourceFile).toBe('/project/src/app.ts');
  });

  it('uses fnData.line when decl and loc are missing', () => {
    const withLineField = {
      '/project/src/app.ts': {
        path: '/project/src/app.ts',
        statementMap: {},
        fnMap: {
          '0': { name: 'myFunc', line: 42 },
        },
        branchMap: {},
        s: {},
        f: { '0': 3 },
        b: {},
      },
    };
    const result = parseIstanbul(JSON.stringify(withLineField));
    expect(result[0].functions.get('myFunc')).toEqual({ line: 42, hitCount: 3 });
  });

  it('handles invalid JSON gracefully', () => {
    expect(() => parseIstanbul('not json')).toThrow();
  });

  it('records total and covered statement counts', () => {
    const result = parseIstanbul(JSON.stringify(sampleIstanbul));
    const file1 = result.find((f) => f.sourceFile.includes('createOrder'));
    expect(file1!.totalStatements).toBe(3);
    expect(file1!.coveredStatements).toBe(2);
  });
});
