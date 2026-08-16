/**
 * Per-rule wall-time accounting (Spec 38 R2).
 *
 * ESLint ships `TIMING=1` for per-rule cost. The pipeline already times each
 * *visitor* (`visitorDurationMs` in pipeline.ts); this module is the finer
 * granularity — one accumulated timer per rule ID — so a rule making the
 * blocking gate too slow to keep can be identified and either optimized or
 * removed from the gating set (Spec 38 R3).
 *
 * Timing is opt-in via `CODE_AUDIT_RULE_TIMING=1`. When the variable is unset
 * (the default, and every baseline/CI run), `withRuleTiming` calls the wrapped
 * function directly with zero overhead and zero behaviour change — the
 * recall/knex/primer/blitz baselines are therefore unaffected.
 *
 * The accumulator is module-level and reset once per pipeline run. Because a
 * single rule may run in more than one place (e.g. `solid/class-size` fires for
 * both method-count and aggregate-complexity), entries are summed per rule ID.
 */

import { performance } from 'perf_hooks';

export interface RuleTimingEntry {
  /** Total wall time attributed to this rule across the run, in ms. */
  totalMs: number;
  /** Number of timed invocations (for an average when total is noisy). */
  calls: number;
}

const timings = new Map<string, RuleTimingEntry>();

/** True when per-rule timing is enabled for this process. */
export function isRuleTimingEnabled(): boolean {
  return process.env.CODE_AUDIT_RULE_TIMING === '1';
}

/** Clear the accumulator. Called once at the start of a pipeline run. */
export function resetRuleTiming(): void {
  timings.clear();
}

/**
 * Accumulate a measured duration for a rule ID.
 * @param ruleId - The rule ID to attribute the duration to.
 * @param ms - The measured duration in milliseconds.
 */
export function recordRuleTime(ruleId: string, ms: number): void {
  const cur = timings.get(ruleId) ?? { totalMs: 0, calls: 0 };
  cur.totalMs += ms;
  cur.calls += 1;
  timings.set(ruleId, cur);
}

/**
 * Run `fn`, timing it under `ruleId` when per-rule timing is enabled.
 * When disabled this is a transparent pass-through (no allocation, no clock).
 * @param ruleId - The rule ID to attribute the duration to.
 * @param fn - The work to time.
 * @returns The result of `fn`, unchanged.
 */
export function withRuleTiming<T>(ruleId: string, fn: () => T): T {
  if (!isRuleTimingEnabled()) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    recordRuleTime(ruleId, performance.now() - t0);
  }
}

/** Read the accumulated per-rule timings. */
export function getRuleTiming(): Map<string, RuleTimingEntry> {
  return timings;
}

/**
 * Per-rule timings sorted slowest-first (Spec 38 R2).
 * @returns The accumulated rule timings, ordered by total milliseconds descending.
 */
export function getRuleTimingSortedDesc(): Array<{ ruleId: string; totalMs: number; calls: number }> {
  return [...timings.entries()]
    .map(([ruleId, entry]) => ({ ruleId, totalMs: entry.totalMs, calls: entry.calls }))
    .sort((a, b) => b.totalMs - a.totalMs);
}
