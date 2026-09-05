/**
 * Spec 45 R1/R2/R4 — the blocking gate as a pure, testable function.
 *
 * The gate is severity-scoped (R2): a finding blocks when its severity is in
 * the configured blocking set (default `critical` + `warning`). Every
 * registered rule participates (R1) — there is no per-rule opt-in. Enforcement
 * is not diff-scoped (R4): a pre-existing finding in the audited file blocks
 * exactly like a new one. The edit-time hook still runs on the changed file as
 * a performance property, but "pre-existing" is not an exemption from blocking.
 *
 * A rule that cannot name a `resolution` for a given occurrence still gates
 * (R1). The missing action is recorded as a `resolutionGap` — a defect in the
 * rule, surfaced loudly, not grounds to stop enforcing.
 *
 * Path-profile exclusions (`gateExcluded`) remain: a file explicitly excluded
 * from the gate by a path profile never blocks. That is a deliberate, recorded
 * config decision, not a narrowing of what the tool reports.
 */
import { getViolationRuleEntry } from '../analyzers/ruleRegistry.js';
import type { Severity, Violation } from '../types.js';

/** One occurrence where a rule failed to name a next action (Spec 45 R1). */
export interface ResolutionGap {
  /** Canonical rule ID that gated but produced no resolution. */
  rule: string;
  file: string;
  line?: number;
  /** Why the occurrence's missing action is recorded rather than invented. */
  reason: 'no-resolution';
}

export interface GatingDecision {
  /** Findings that block the write. Every one is at a blocking severity. */
  blocking: Violation[];
  /**
   * Findings a `resolvable` rule emitted without naming a next action. Non-empty
   * is a defect in the rule, reported as such — it never exempts the finding
   * from blocking (Spec 45 R1).
   */
  resolutionGaps: ResolutionGap[];
}

/**
 * Decide which violations block. A finding blocks when its severity is in
 * `blockingSeverities` (R2) and its file is not gate-excluded. Every registered
 * rule participates (R1); a rule that cannot name a resolution still gates,
 * with the gap recorded rather than enforcement skipped.
 *
 * @param violations The full violation list for the audited file(s).
 * @param blockingSeverities Severities that block (default `critical` + `warning`).
 */
export function computeGatingDecision(
  violations: Violation[],
  blockingSeverities: ReadonlySet<Severity>,
): GatingDecision {
  const blocking: Violation[] = [];
  const resolutionGaps: ResolutionGap[] = [];

  for (const v of violations) {
    // A path-profile-excluded file never blocks.
    if (v.gateExcluded) continue;
    // R2 — only findings at a blocking severity block.
    if (!blockingSeverities.has(v.severity)) continue;

    const entry = getViolationRuleEntry(v);
    // R1 — a rule that cannot name a next action still gates; the missing
    // action is recorded as a gap, not a reason to skip enforcement.
    if (entry?.resolvable && !v.resolution) {
      resolutionGaps.push({
        rule: v.rule,
        file: v.file,
        line: v.line,
        reason: 'no-resolution',
      });
    }

    blocking.push(v);
  }

  return { blocking, resolutionGaps };
}
