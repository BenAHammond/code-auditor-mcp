import { describe, it, expect } from 'vitest';
import { rankFilesByPriority, orderFindingsWithinFile } from './nextFile.js';
import type { Violation } from './types.js';

function v(partial: Partial<Violation> & { file: string; severity: Violation['severity'] }): Violation {
  return { rule: 'test', message: 'm', ...partial };
}

describe('rankFilesByPriority', () => {
  it('ranks a file with a critical finding above one with only severe findings', () => {
    const ranked = rankFilesByPriority([
      v({ file: 'b.ts', severity: 'severe', line: 1 }),
      v({ file: 'a.ts', severity: 'critical', line: 1 }),
    ]);
    expect(ranked.map((r) => r.file)).toEqual(['a.ts', 'b.ts']);
  });

  it('breaks severity ties by total finding count (descending)', () => {
    const ranked = rankFilesByPriority([
      v({ file: 'few.ts', severity: 'severe', line: 1 }),
      v({ file: 'many.ts', severity: 'severe', line: 1 }),
      v({ file: 'many.ts', severity: 'severe', line: 2 }),
      v({ file: 'many.ts', severity: 'severe', line: 3 }),
    ]);
    expect(ranked.map((r) => r.file)).toEqual(['many.ts', 'few.ts']);
    expect(ranked[0].count).toBe(3);
  });

  it('breaks count ties by deterministic path order', () => {
    const ranked = rankFilesByPriority([
      v({ file: 'z.ts', severity: 'severe', line: 1 }),
      v({ file: 'a.ts', severity: 'severe', line: 1 }),
    ]);
    expect(ranked.map((r) => r.file)).toEqual(['a.ts', 'z.ts']);
  });

  it('reports the max severity and keeps every violation grouped per file', () => {
    const ranked = rankFilesByPriority([
      v({ file: 'mixed.ts', severity: 'high', line: 1 }),
      v({ file: 'mixed.ts', severity: 'critical', line: 2 }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].maxSeverity).toBe('critical');
    expect(ranked[0].count).toBe(2);
    expect(ranked[0].violations).toHaveLength(2);
  });

  it('returns an empty list for an empty violation set', () => {
    expect(rankFilesByPriority([])).toEqual([]);
  });
});

describe('orderFindingsWithinFile', () => {
  it('orders critical → severe → high and preserves input order for ties', () => {
    const ordered = orderFindingsWithinFile([
      v({ file: 'f.ts', severity: 'high', line: 1 }),
      v({ file: 'f.ts', severity: 'critical', line: 2 }),
      v({ file: 'f.ts', severity: 'severe', line: 3 }),
      v({ file: 'f.ts', severity: 'critical', line: 4 }),
    ]);
    expect(ordered.map((x) => x.severity)).toEqual(['critical', 'critical', 'severe', 'high']);
  });

  it('does not mutate its input', () => {
    const input = [
      v({ file: 'f.ts', severity: 'high', line: 1 }),
      v({ file: 'f.ts', severity: 'critical', line: 2 }),
    ];
    orderFindingsWithinFile(input);
    expect(input[0].severity).toBe('high');
    expect(input[1].severity).toBe('critical');
  });
});
