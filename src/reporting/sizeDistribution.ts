/**
 * Spec 60 R2 — aggregate raw size readings into per-measure distributions.
 *
 * Pure functions: `median`, `percentile`, and `computeSizeDistributions` take
 * the `SizeSample[]` accumulated by the SOLID analyzer and produce the
 * `SizeDistribution[]` surfaced in `metadata.sizeDistributions`. Kept separate
 * from the pipeline so the percentile definitions are unit-testable in
 * isolation.
 */

import type { SizeDistribution } from '../types.js';
import type { SizeSample } from '../analyzers/universal/UniversalSOLIDAnalyzer.js';

/** Median of a sorted numeric array (average of the two middle values for even n). */
export function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank percentile: the smallest value at or above `p`% of the samples. */
export function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[idx]!;
}

const MEASURES: SizeDistribution['measure'][] = [
  'function-length',
  'parameter-count',
  'complexity',
  'class-size',
  'interface-size',
];

/**
 * The exact population each measure enumerates. This is the denominator contract:
 * a distribution is only meaningful when the reader knows what was counted.
 *
 * Function-like measures (`function-length`, `parameter-count`, `complexity`) are
 * pinned to *named* functions and methods — anonymous functions (arrow callbacks,
 * IIFEs) are excluded because they have no stable identity and are overwhelmingly
 * trivial (cyclomatic complexity 1), so including them dilutes the median with
 * noise. `class-size` and `interface-size` are structural and need no exclusion.
 */
const POPULATIONS: Record<SizeDistribution['measure'], string> = {
  'function-length': 'named functions + methods, anonymous excluded',
  'parameter-count': 'named functions + methods, anonymous excluded',
  complexity: 'named functions + methods, anonymous excluded',
  'class-size': 'all classes',
  'interface-size': 'all interfaces',
};

const MAX_TAIL_ENTRIES = 10;

export function computeSizeDistributions(samples: SizeSample[]): SizeDistribution[] {
  const byMeasure = new Map<string, SizeSample[]>();
  for (const s of samples) {
    const list = byMeasure.get(s.measure) ?? [];
    list.push(s);
    byMeasure.set(s.measure, list);
  }

  const out: SizeDistribution[] = [];
  for (const measure of MEASURES) {
    const list = byMeasure.get(measure);
    if (!list || list.length === 0) continue;

    const values = list.map((s) => s.value).sort((a, b) => a - b);
    const max = values[values.length - 1]!;
    const p95 = percentile(values, 95);

    const maxEntry = list.find((s) => s.value === max);

    const tail = list
      .filter((s) => s.value >= p95)
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_TAIL_ENTRIES)
      .map((s) => ({
        value: s.value,
        entityType: s.entityType,
        fileType: s.fileType,
        file: s.file,
        name: s.name,
      }));

    out.push({
      measure,
      population: POPULATIONS[measure],
      count: list.length,
      median: median(values),
      p95,
      max,
      maxEntry: maxEntry
        ? { entityType: maxEntry.entityType, fileType: maxEntry.fileType, file: maxEntry.file, name: maxEntry.name }
        : undefined,
      ...(tail.length > 0 && { tail }),
    });
  }
  return out;
}
