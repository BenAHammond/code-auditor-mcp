/**
 * Spec 36 R4/R6 — the blocking gate as a pure, testable function.
 *
 * The gate is binary (R4): a rule either gates or it does not. Severity never
 * factors into the decision. A finding blocks only when:
 *   1. it is NOT `new === false` (a baseline-matched "known" finding never
 *      blocks — Spec 36 R2),
 *   2. its file was NOT excluded from the gate by a path profile
 *      (`gateExcluded` — the R4 replace-severity-cap mechanism),
 *   3. its rule declares `gating: true` (Spec 36 R4), and
 *   4. for this occurrence, the rule produced a `resolution` naming the next
 *      action (Spec 36 R6 / Spec 37 R1). A gating rule that cannot name an
 *      action for a given occurrence emits NON-blocking, and the gap is
 *      recorded so it surfaces as a defect in the rule rather than a silent
 *      soft-fail.
 *
 * The consumer of this function routes on the structured result: `blocking`
 * findings gate the write; `resolutionGaps` are the R6 record of occurrences
 * a gating rule failed to make actionable.
 */
import { getViolationRuleEntry } from '../analyzers/ruleRegistry.js';
import { isIntroducedByDiff, type DiffGate } from './diffGate.js';
import type { Violation } from '../types.js';

/** One occurrence where a gating rule failed to name a next action (R6). */
export interface ResolutionGap {
  /** Canonical rule ID that gated but produced no resolution. */
  rule: string;
  file: string;
  line?: number;
  /** Why the occurrence is non-blocking despite the rule gating. */
  reason: 'no-resolution';
}

export interface GatingDecision {
  /** Findings that block the write. Every one is `gating` and has a resolution. */
  blocking: Violation[];
  /**
   * Gating findings that were emitted NON-blocking because the rule could not
   * name an action for this occurrence (Spec 36 R6). Non-empty is a defect in
   * the rule, not a limitation to record silently.
   */
  resolutionGaps: ResolutionGap[];
}

/**
 * Decide which violations block (Spec 36 R4) and which gating findings fell
 * back to non-blocking because they carried no resolution (Spec 36 R6).
 *
 * @param violations The full violation list, including `new` classification.
 */
export function computeGatingDecision(violations: Violation[]): GatingDecision {
  return decideGating(violations, (v) => v.new !== false);
}

/**
 * Diff-scoped gate (Spec 36 R2): block only findings the edit introduced, where
 * "introduced" is determined from the file's prior state (`git HEAD`) rather
 * than a stored baseline. A finding at an untouched line of a tracked file does
 * not block; a finding at a touched line, or anywhere in a new file, does.
 */
export function computeDiffGatingDecision(
  violations: Violation[],
  diffGate: DiffGate,
): GatingDecision {
  return decideGating(violations, (v) => isIntroducedByDiff(v, diffGate));
}

function decideGating(
  violations: Violation[],
  isIntroduced: (v: Violation) => boolean,
): GatingDecision {
  const blocking: Violation[] = [];
  const resolutionGaps: ResolutionGap[] = [];

  for (const v of violations) {
    // R2 — a finding the edit did not introduce never blocks.
    if (!isIntroduced(v)) continue;
    // R4 — a path-profile-excluded file never blocks.
    if (v.gateExcluded) continue;

    // R7 — an inline suppression with a required reason never blocks.
    if (v.suppressed) continue;

    const entry = getViolationRuleEntry(v);
    // R4 — only gating rules participate.
    if (entry?.gating !== true) continue;

    // R6 — a gating rule must name a next action for this occurrence.
    if (entry.resolvable && !v.resolution) {
      resolutionGaps.push({
        rule: v.rule,
        file: v.file,
        line: v.line,
        reason: 'no-resolution',
      });
      continue;
    }

    blocking.push(v);
  }

  return { blocking, resolutionGaps };
}
