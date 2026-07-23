/**
 * Baseline ratchet — snapshot advisory findings as {fingerprint, file} entries
 * so subsequent audits surface only the delta (new / fixed / known).
 *
 * Spec 18 — R1: The baseline file (.codeauditor.baseline.json) is committed
 * to the user's repo. Invariants are never baselined — declared laws are
 * enforced on all code, always.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fingerprint, buildFingerprintInput } from './fingerprint.js';
import { PACKAGE_VERSION } from './constants.js';
import type { Violation } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BaselineEntry {
  /** SHA-256 fingerprint of [analyzer, rule, file, symbol]. */
  fingerprint: string;
  /** File path at time of snapshot — used for scoped-match correctness. */
  file: string;
}

export interface BaselineMetadata {
  /** Tool version from package.json at snapshot time. */
  toolVersion: string;
  /** Total advisory findings in the baseline (excludes invariants). */
  totalFindings: number;
  /** Per-analyzer finding counts. */
  analyzerCounts: Record<string, number>;
  /** Corpus stats at snapshot time. */
  corpusStats: {
    files: number;
    functions: number;
  };
}

export interface Baseline {
  /** Schema version for forward-compatibility. */
  schemaVersion: 3;
  /** ISO-8601 timestamp of snapshot creation. */
  created: string;
  /** Advisory finding entries (no invariants). */
  entries: BaselineEntry[];
  /** Snapshot metadata. */
  metadata: BaselineMetadata;
}

export interface ClassifiedFindings {
  /** Findings whose fingerprints are absent from the baseline. */
  new: Violation[];
  /** Findings whose fingerprints are present in the baseline. */
  known: Violation[];
  /** Baseline entries with no matching finding in this run. */
  fixed: BaselineEntry[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const BASELINE_FILENAME = '.codeauditor.baseline.json';
const INVARIANTS_ANALYZER = 'invariants';

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load an existing baseline file from the project root.
 * Returns null if no baseline file exists or it fails to parse.
 */
export function loadBaseline(projectRoot: string): Baseline | null {
  const filePath = path.join(projectRoot, BASELINE_FILENAME);
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Basic validation — schemaVersion 3 uses the shared buildFingerprintInput scheme.
    // Reject stale v1/v2 baselines with a clear message so users re-snapshot.
    if (parsed && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2)) {
      console.error(
        `Baseline file has schemaVersion ${parsed.schemaVersion} (older fingerprint scheme). ` +
        'Run `code-audit baseline` to re-snapshot with the current scheme.',
      );
      return null;
    }
    if (!parsed || parsed.schemaVersion !== 3 || !Array.isArray(parsed.entries)) {
      return null;
    }
    return parsed as Baseline;
  } catch {
    return null;
  }
}

/**
 * Write the baseline file to the project root.
 */
export function saveBaseline(projectRoot: string, baseline: Baseline): void {
  const filePath = path.join(projectRoot, BASELINE_FILENAME);
  writeFileSync(filePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
}

/**
 * Build a Baseline from a set of advisory violations.
 * Invariant findings are excluded — invariants are never baselined.
 */
export function createBaselineFromFindings(
  violations: Violation[],
  metadata: BaselineMetadata,
): Baseline {
  const advisory = violations.filter((v) => v.analyzer !== INVARIANTS_ANALYZER);

  const entries: BaselineEntry[] = advisory.map((v) => ({
    fingerprint: computeViolationFingerprint(v),
    file: v.file ?? '',
  }));

  // Deduplicate by fingerprint (one entry per unique finding)
  const seen = new Set<string>();
  const deduped: BaselineEntry[] = [];
  for (const entry of entries) {
    if (!seen.has(entry.fingerprint)) {
      seen.add(entry.fingerprint);
      deduped.push(entry);
    }
  }

  return {
    schemaVersion: 3,
    created: new Date().toISOString(),
    entries: deduped,
    metadata,
  };
}

/**
 * Classify violations against a baseline.
 *
 * - **new**: fingerprint absent from baseline
 * - **known**: fingerprint present in baseline
 * - **fixed**: baseline entries with no matching violation in this run
 *
 * When `scopedFiles` is provided (e.g. a `changed` run), `fixed` is computed
 * only among baseline entries whose file is in scope — preventing a scoped
 * run from classifying all untouched entries as "fixed."
 *
 * Scoped entries not in the file list are excluded entirely from the result;
 * they are neither new, known, nor fixed for this run.
 */
export function matchFindings(
  violations: Violation[],
  baseline: Baseline,
  scopedFiles?: string[],
): ClassifiedFindings {
  // Build fingerprint set from baseline for O(1) lookup
  const baselineMap = new Map<string, BaselineEntry>();
  for (const entry of baseline.entries) {
    baselineMap.set(entry.fingerprint, entry);
  }

  // Build set of current fingerprints
  const currentFingerprints = new Set<string>();
  const newFindings: Violation[] = [];
  const knownFindings: Violation[] = [];

  // Determine which baseline entries to include as candidates for "fixed"
  // When scoped, only entries whose file is in the scope are eligible
  const scopeFileSet = scopedFiles ? new Set(scopedFiles) : null;

  for (const v of violations) {
    // Invariants are classified as "new" regardless of baseline content
    if (v.analyzer === INVARIANTS_ANALYZER) {
      newFindings.push(v);
      continue;
    }

    const fp = computeViolationFingerprint(v);
    currentFingerprints.add(fp);

    if (baselineMap.has(fp)) {
      knownFindings.push(v);
    } else {
      newFindings.push(v);
    }
  }

  // Compute fixed: baseline entries not present in current run,
  // scoped to the file list when provided
  const fixed: BaselineEntry[] = [];
  for (const entry of baseline.entries) {
    // If scoped, only consider entries whose file is in scope
    if (scopeFileSet && !scopeFileSet.has(entry.file)) {
      continue;
    }
    if (!currentFingerprints.has(entry.fingerprint)) {
      fixed.push(entry);
    }
  }

  return { new: newFindings, known: knownFindings, fixed };
}

/**
 * Compare current and previous baselines to compute what changed.
 * Returns counts for reporting during re-snapshot.
 */
export function diffBaselines(
  previous: Baseline,
  current: Baseline,
): { absorbed: number; fixed: number; total: number } {
  const prevSet = new Set(previous.entries.map((e) => e.fingerprint));
  const currSet = new Set(current.entries.map((e) => e.fingerprint));

  // Absorbed: in current but not in previous (new findings entering baseline)
  const absorbed: string[] = [];
  for (const fp of currSet) {
    if (!prevSet.has(fp)) absorbed.push(fp);
  }

  // Fixed: in previous but not in current (findings that were fixed)
  const fixed: string[] = [];
  for (const fp of prevSet) {
    if (!currSet.has(fp)) fixed.push(fp);
  }

  return {
    absorbed: absorbed.length,
    fixed: fixed.length,
    total: currSet.size,
  };
}

/**
 * Hash the baseline fingerprint set for a stable identifier.
 * Used in AuditResult.metadata.baseline.hash for ledger integration (Spec 11).
 */
export function hashBaseline(baseline: Baseline): string {
  const sorted = [...baseline.entries.map((e) => e.fingerprint)].sort();
  return createHash('sha256').update(sorted.join(',')).digest('hex');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute the stable fingerprint for a violation.
 * Delegates to the shared buildFingerprintInput — the single canonical
 * tuple source for all surfaces.
 */
function computeViolationFingerprint(violation: Violation): string {
  return fingerprint(buildFingerprintInput(violation));
}

// Re-export for convenience
export const BaselineManager = {
  load: loadBaseline,
  save: saveBaseline,
  createFromFindings: createBaselineFromFindings,
  matchFindings,
  diffBaselines,
  hashBaseline,
};
