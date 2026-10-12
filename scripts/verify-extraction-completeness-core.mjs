/**
 * verify-extraction-completeness-core.mjs — the pure predicate behind the
 * `verify:extraction-completeness` gate.
 *
 * The data-access pipeline projects a broadened *candidate* set
 * (`extractDataAccessCallCandidates`) and then admits a subset into real
 * `DatabaseCall`s (`extractDataAccessCalls`). The gate's invariant is that every
 * candidate the extractor did not admit carries a *reason* — a three-way
 * disposition:
 *
 *   - `extracted`            — the candidate appears in the admitted set.
 *   - declined (non-builder) — `queryBuilderShape` is false, so its rejection has
 *                              a reason: it is not a query-builder-shaped call.
 *   - unaccounted            — `queryBuilderShape` is true yet the candidate was
 *                              not admitted: no reason, the failure.
 *
 * A query-builder-shaped candidate is admitted by construction (`isQueryBuilderShape`
 * feeds `isSqlPosition` → `isSqlQuery`), so the only way one is declined is a real
 * regression in the admission seam — exactly what this predicate must catch.
 *
 * The measurement (parsing a fixture, running both extractors, and matching a
 * candidate to its admitted call by `line:column`) lives in
 * `verify-extraction-completeness.ts`; the failure branch lives here so a
 * gate-liveness test can feed deliberately-inconsistent dispositions without a
 * fixture or a build.
 */

/**
 * Check the extraction-completeness invariant over a candidate disposition list.
 *
 * @param {{ candidates: Array<{ site: string, extracted: boolean,
 *                              queryBuilderShape: boolean }> }} args
 *   Each candidate names its `site`, whether it was admitted (`extracted`), and
 *   whether it is query-builder-shaped (`queryBuilderShape`).
 * @returns {string[]} drift lines; empty when the invariant holds.
 */
export function checkExtractionCompleteness({ candidates }) {
  const drift = [];
  for (const c of candidates ?? []) {
    if (c.extracted) continue;
    if (!c.queryBuilderShape) continue;
    drift.push(
      `candidate ${c.site} is query-builder-shaped but was not extracted (no disposition reason)`,
    );
  }
  return drift;
}
