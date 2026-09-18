import type { Severity, Violation } from './types.js';

/**
 * Priority ranking for the `next-file` refactor loop (Spec: file-by-file audit
 * consumption). A consuming LLM calls `code-audit next-file` to get the single
 * highest-priority file and all of its findings, fixes it, and repeats. The
 * queue is derived from a fresh audit each time — never stored — so a file that
 * is still in bad shape surfaces again, and there is no cursor to corrupt.
 */

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  severe: 1,
  advisory: 2,
};

/**
 * Rank a severity, throwing on an unknown value. A finding whose severity is not
 * a key here would sort to `undefined` and silently vanish (or mis-rank) — that is
 * a bug in the producer, not a value to drop. The snapshot version gate
 * (`SNAPSHOT_VERSION`) catches known renames; this closes the class for any
 * severity the model does not recognize.
 */
function severityRank(severity: Severity): number {
  const rank = SEVERITY_RANK[severity];
  if (rank === undefined) {
    throw new Error(
      `Unknown severity "${severity}" — a finding that cannot be ranked is a bug, not something to drop.`,
    );
  }
  return rank;
}

export interface RankedFile {
  file: string;
  /** Highest severity present on the file (critical < severe < advisory). */
  maxSeverity: Severity;
  /** Total findings on the file across all analyzers. */
  count: number;
  violations: Violation[];
}

/**
 * Group violations by file and rank worst-first: by highest severity, then by
 * total finding count, then by deterministic path order. The result is a stable
 * queue — repeated audits of an unchanged tree return the same head.
 */
export function rankFilesByPriority(violations: Violation[]): RankedFile[] {
  const byFile = new Map<string, Violation[]>();
  for (const v of violations) {
    const f = v.file || '';
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f)!.push(v);
  }

  return [...byFile.entries()]
    .map(([file, vs]) => ({
      file,
      maxSeverity: vs.reduce<Severity>(
        (max, v) => (severityRank(v.severity) < severityRank(max) ? v.severity : max),
        'advisory'
      ),
      count: vs.length,
      violations: vs,
    }))
    .sort((a, b) => {
      const s = severityRank(a.maxSeverity) - severityRank(b.maxSeverity);
      if (s !== 0) return s;
      const c = b.count - a.count;
      if (c !== 0) return c;
      return a.file.localeCompare(b.file);
    });
}

/**
 * Order one file's findings critical → severe → advisory so the consumer
 * sees the most urgent defect first. Stable for equal severities.
 */
export function orderFindingsWithinFile(violations: Violation[]): Violation[] {
  return [...violations].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );
}
