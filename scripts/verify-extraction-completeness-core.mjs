/**
 * verify-extraction-completeness-core.mjs — the pure comparison half of the
 * extraction-completeness gate (Spec 68 Thing 2, #312).
 *
 * The gate pins the *residual* receiver-name blind spot in the
 * `data-access-calls` producer: builder-chain call sites (a call whose trailing
 * callee method is `.from`/`.select`/`.insert`/`.update`/`.delete`/`.where`)
 * that the shape-test-augmented extractor still does NOT admit. That residual is
 * a mix of true negatives (Map/Set/cookies/crypto/Stripe receivers sharing the
 * verb) and a small real miss (a query builder whose companion verb lives in a
 * prior statement). Pin it so the next unseen idiom moves a number instead of a
 * quiet report.
 *
 * This module is the pure half of the same split used by
 * verify-recall-value-drift: the measurement lives in the script (corpus is
 * absent in CI → SKIP there), and the failure branch lives here so a
 * gate-liveness test can exercise it without the corpus.
 */

/**
 * Compare measured per-corpus gap counts against the pinned baseline.
 *
 * @param {{ [corpus: string]: number }} measured corpus name → measured gap
 * @param {{ [corpus: string]: number }} baseline corpus name → pinned gap
 * @returns {string[]} drift lines; empty when count and set match exactly
 */
export function compareCompleteness(measured, baseline) {
  const drift = [];
  const names = new Set([...Object.keys(baseline), ...Object.keys(measured)]);
  for (const name of [...names].sort()) {
    const expected = baseline[name];
    const actual = measured[name];
    if (actual === undefined) {
      drift.push(`corpus ${name} not measured (baseline ${expected})`);
    } else if (expected === undefined) {
      drift.push(`unexpected corpus ${name} measured (gap ${actual})`);
    } else if (actual !== expected) {
      drift.push(`corpus ${name} gap ${actual} != baseline ${expected}`);
    }
  }
  return drift;
}
