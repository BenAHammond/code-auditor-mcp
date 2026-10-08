/**
 * Baseline ratchet — snapshot advisory findings as {fingerprint, file} entries
 * so subsequent audits surface only the delta (new / fixed / known).
 *
 * Spec 18 — R1: The baseline file (.codeauditor.baseline.json) is committed
 * to the user's repo. Invariants are never baselined — declared laws are
 * enforced on all code, always.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fingerprint, buildFingerprintInput } from './fingerprint.js';
import { PACKAGE_VERSION } from './constants.js';
import { getUserConfigRoot, projectHash } from './dataPaths.js';
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
  /**
   * Schema version for forward-compatibility. Bumped 3 → 4 in 5.0.0 (Spec 68
   * §7/§14): the finding-identity unification changed every fingerprint, so a
   * baseline written by a pre-5.0.0 tool no longer matches current findings.
   */
  schemaVersion: 4;
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

/** Subdirectory of the user config root holding "already warned about a stale
 *  baseline" markers — keyed by project hash, never written into the repo. */
const STALE_NOTIFIED_DIR = 'baseline-migrated';

/** Process-scoped guard mirroring `notifyLegacyIndexLocation`: warn at most once
 *  per project hash per process; the persisted marker handles cross-process. */
const notifiedThisProcess = new Set<string>();

export interface BaselineLoadOptions {
  /** Override the user config dir (tests). */
  configDir?: string;
  /** Override the notification sink (tests). Defaults to `console.error`. */
  notify?: (message: string) => void;
}

function staleMarkerPath(projectRoot: string, configDir: string): string {
  return path.join(configDir, STALE_NOTIFIED_DIR, projectHash(projectRoot));
}

/**
 * Warn once (per project) that the baseline uses a pre-5.0.0 fingerprint scheme
 * and is being ignored. The "once" is recorded in the user config dir — the
 * stale baseline file itself is left untouched, because a read must not mutate
 * the audited tree (the same rule that moved the index out of the repo).
 */
function warnStaleBaselineOnce(
  projectRoot: string,
  schemaVersion: number,
  opts: BaselineLoadOptions,
): void {
  const configDir = path.resolve(opts.configDir ?? getUserConfigRoot());
  const hash = projectHash(projectRoot);
  if (notifiedThisProcess.has(hash) || existsSync(staleMarkerPath(projectRoot, configDir))) {
    return;
  }
  notifiedThisProcess.add(hash);
  const message =
    `Baseline file has schemaVersion ${schemaVersion} (pre-5.0.0 fingerprint scheme); ` +
    'its fingerprints no longer match current findings, so it is ignored. ' +
    'Run `code-audit baseline` to re-snapshot with the current scheme.';
  (opts.notify ?? ((m: string) => console.error(m)))(message);
  try {
    mkdirSync(path.join(configDir, STALE_NOTIFIED_DIR), { recursive: true });
    // `wx` fails if the marker already exists — an idempotent "warned" flag.
    writeFileSync(staleMarkerPath(projectRoot, configDir), '', { flag: 'wx' });
  } catch {
    // A config write failure (read-only home, race) means a possible repeat next
    // run — the lesser evil vs. touching the repo. Never throw from a warning.
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load an existing baseline file from the project root.
 * Returns null if no baseline file exists or it fails to parse.
 *
 * @param projectRoot - Absolute path to the project root containing the baseline file.
 * @param opts - Optional load overrides (config dir + notification sink, for tests).
 * @returns The parsed baseline, or null when absent, incompatible, or unparseable.
 */
export function loadBaseline(projectRoot: string, opts: BaselineLoadOptions = {}): Baseline | null {
  const filePath = path.join(projectRoot, BASELINE_FILENAME);
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Spec 68 §7/§14 — the finding-identity unification changed every
    // fingerprint, so any baseline written by a pre-5.0.0 tool (schemaVersion
    // ≤ 3) is incompatible. Matching it would silently absorb a regression at
    // a lower precision, so reject it loudly with the regeneration command
    // rather than ignore it or match it degraded. The rejection is a one-time
    // event, not a per-run notice: the warning is recorded in the user config
    // dir (keyed by project hash), so the next read returns null silently
    // instead of re-warning on every invocation (including through the hook) —
    // and the stale file is left untouched, because a read must not mutate the
    // audited tree.
    if (parsed && typeof parsed.schemaVersion === 'number' && parsed.schemaVersion < 4) {
      warnStaleBaselineOnce(projectRoot, parsed.schemaVersion, opts);
      return null;
    }
    if (!parsed || parsed.schemaVersion !== 4 || !Array.isArray(parsed.entries)) {
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
 *
 * @param violations - Advisory violations to snapshot (invariants are filtered out).
 * @param metadata - Snapshot metadata (tool version, corpus stats).
 * @returns A Baseline ready to write to `.codeauditor.baseline.json`.
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
    schemaVersion: 4,
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
 *
 * @param violations - Findings from this run to classify.
 * @param baseline - The committed baseline to match against.
 * @param scopedFiles - Optional file scope (e.g. a `changed` run) that limits the `fixed` computation.
 * @returns Findings partitioned into new, known, and fixed.
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
 *
 * @param previous - The prior baseline snapshot.
 * @param current - The freshly computed baseline.
 * @returns Counts of absorbed, fixed, and total findings.
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
