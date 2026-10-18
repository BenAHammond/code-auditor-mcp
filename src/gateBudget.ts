/**
 * Single source for the blocking gate's deterministic-work budget (Directive J).
 *
 * The blocking gate (`code-audit changed`) used to be budgeted in CPU time
 * (`auditCpuMs` < 900 ms). CPU time is load-dependent: a co-tenant-heavy machine
 * inflates the figure without touching the rule, so the gate jittered under
 * verify:close's own sustained load. Directive J re-expresses the budget over a
 * deterministic quantity instead — the number of distinct receiver resolutions
 * the phase pipeline performed (`receiverResolutions`, the `handleVerdictCache`
 * size after the pass). A fixed file folds `identifyHandle` a fixed number of
 * times regardless of machine load, so a regression that re-derives provenance
 * or widens the candidate set moves this count deterministically, where CPU time
 * only jittered.
 *
 * The time measurement did not vanish — it moved to `bench/` (measurement, not
 * a gate assertion): see bench/gate-timing.ts. This module is only the budget
 * the *gate* asserts on, and it is the single place both the CLI display and the
 * `verify:gate-budget` verifier read that value from (the verifier parses it out
 * of the CLI's `gate work: … (budget N)` line, so the CLI is the one source).
 *
 * The budget is env-overridable (`CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS`) so the
 * gate-liveness test can force a violation (`=0` → any work fails) without
 * waiting on a genuinely slow rule — the same env-knob pattern as
 * verify-disk-space's `VERIFY_MIN_FREE_BYTES`. Unlike `jobLeaseTtlMs`, `0` is a
 * *valid* override here (it means "always fail", which is what liveness needs),
 * not a "not set" sentinel.
 */

/**
 * The default budget — the number of distinct receiver resolutions the
 * representative gating file must stay under. MEASURED against
 * `src/analyzers/universal/UniversalSOLIDAnalyzer.ts`, never carried over:
 * re-measured each re-baseline with the architectural reason recorded.
 *
 * Directive J re-baseline: the prior budget was 900 ms CPU (~28% headroom over
 * the ~705 ms isolated median). The deterministic count is `handleVerdictCache
 * .size` for that file: 77 on every warm run (5/5 runs, zero jitter — the
 * count moves only when the work does, which is the whole point of the
 * re-expression). 100 = ~30% headroom over the measured 77, matching the
 * headroom discipline of the two prior CPU re-baselines. The headroom is NOT
 * for jitter (there is none) — it is room for legitimate single-site growth in
 * the file before the tripwire fires; a real regression (provenance re-derived,
 * or the candidate set widened) moves the count by 2–5×, far past 100.
 */
export const DEFAULT_GATE_BUDGET_RESOLUTIONS = 100;

/**
 * The env override for the gate budget, or the default. The override accepts any
 * integer ≥ 0 (0 is the liveness knob, not "unset"); a non-numeric or negative
 * value falls back to the default rather than tripping the gate spuriously.
 *
 * @returns the resolved gate budget — the non-negative numeric override when
 *   set, otherwise {@link DEFAULT_GATE_BUDGET_RESOLUTIONS}.
 */
export function gateBudgetResolutions(): number {
  const raw = process.env.CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_GATE_BUDGET_RESOLUTIONS;
}
