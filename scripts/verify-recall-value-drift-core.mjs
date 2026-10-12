/**
 * verify-recall-value-drift-core.mjs — the pure invariant behind the
 * `verify:recall-value-drift` gate.
 *
 * The retired version of this gate diffed a stored baseline (a count plus a pair
 * list) against the current run — a history assertion, not a property of the
 * code. This module is its replacement as an *invariant over the rule's own
 * output*: the styles/value-drift rule clusters colors by CIELAB ΔE76 and flags
 * the non-canonical members of every cluster whose distance falls below its
 * `colorDeltaE` threshold. So an emitted pair must always be *below* the
 * threshold, and a declined pair (one the rule chose not to flag) must always be
 * *at or above* it. That is the one check that fails if the claim is false.
 *
 * The measurement (building a synthetic CSS fixture, running the rule, and
 * recomputing ΔE via the rule's own `labDistance`) lives in
 * `verify-recall-value-drift.ts`; the failure branch lives here so a
 * gate-liveness test can feed deliberately-inconsistent output without a corpus
 * or a build.
 */

/**
 * Check the value-drift invariant over the rule's output.
 *
 * @param {{ emitted: Array<{ drift: string, canonical: string, deltaE76: number }>,
 *           declined: Array<{ drift: string, canonical: string, deltaE76: number }>,
 *           threshold: number }} args
 *   `emitted` are the pairs the rule flagged; `declined` are the pairs it did
 *   not; `deltaE76` is recomputed by the rule's own distance function.
 * @returns {string[]} drift lines; empty when the invariant holds.
 */
export function checkValueDriftInvariant({ emitted, declined, threshold }) {
  const drift = [];
  for (const p of emitted ?? []) {
    if (!(p.deltaE76 < threshold)) {
      drift.push(
        `emitted drift "${p.drift}" → "${p.canonical}" has ΔE ${p.deltaE76} not below threshold ${threshold}`,
      );
    }
  }
  for (const p of declined ?? []) {
    if (p.deltaE76 < threshold) {
      drift.push(
        `declined pair "${p.drift}" → "${p.canonical}" has ΔE ${p.deltaE76} below threshold ${threshold} — should have been emitted`,
      );
    }
  }
  return drift;
}
