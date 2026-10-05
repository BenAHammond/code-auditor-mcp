/**
 * verify-oracle-shortfalls-core.mjs — the pure comparison half of the
 * oracle-shortfall aggregate gate (Spec 69 R1, criterion 4).
 *
 * The gate pins the per-(fact-kind, corpus) completeness shortfall aggregate:
 * for each fact kind, the number of files whose counted oracle out-counted its
 * producer, and the summed expected vs actual units. Those numbers are stable
 * because the corpora are frozen (READ-ONLY reference), so a move means one of
 * two things: a producer/oracle changed (the regression this gate exists to
 * catch), or a corpus changed (a violation of the read-only contract). Either
 * way the gate must fail loudly, never pass quietly.
 *
 * This module is the pure half of the split used by
 * verify-recall-value-drift / verify-extraction-completeness: the measurement
 * lives in `verify-oracle-shortfalls.ts` (the corpus is absent in CI → SKIP
 * there), and the failure branch lives here so a gate-liveness test can exercise
 * it without the corpus.
 */

/**
 * Compare measured per-(kind, corpus) shortfall aggregates against the pinned
 * baseline. The `residual` (expected − actual) is derived, not stored: it is
 * the by-design gap the baseline's per-kind `composition` note explains, so only
 * the three raw counters are pinned.
 *
 * @param {{ [kind: string]: { [corpus: string]: { files: number, expected: number, actual: number } } }} measured
 *   fact kind → corpus → measured aggregate
 * @param {{ [kind: string]: { composition: string, corpora: { [corpus: string]: { files: number, expected: number, actual: number } } } }} baselineKinds
 *   fact kind → { composition prose, corpus → pinned aggregate }
 * @returns {string[]} drift lines; empty when every (kind, corpus) matches exactly
 */
export function compareOracleShortfalls(measured, baselineKinds) {
  const drift = [];
  const kinds = new Set([...Object.keys(baselineKinds), ...Object.keys(measured)]);
  for (const kind of [...kinds].sort()) {
    const baselineCorpora = baselineKinds[kind]?.corpora ?? {};
    const measuredCorpora = measured[kind] ?? {};
    const corpora = new Set([...Object.keys(baselineCorpora), ...Object.keys(measuredCorpora)]);
    for (const corpus of [...corpora].sort()) {
      const expected = baselineCorpora[corpus];
      const actual = measuredCorpora[corpus];
      if (expected === undefined) {
        drift.push(
          `unexpected ${kind} on ${corpus} measured (files ${actual.files}, expected ${actual.expected}, actual ${actual.actual})`,
        );
      } else if (actual === undefined) {
        drift.push(
          `${kind} on ${corpus} not measured (baseline files ${expected.files}, expected ${expected.expected}, actual ${expected.actual})`,
        );
      } else {
        for (const field of ['files', 'expected', 'actual']) {
          if (actual[field] !== expected[field]) {
            // A producer emitting *fewer* facts than its last recording is a
            // defect, not drift: it means an extractor silently stopped emitting,
            // which a routine re-record would paper over. It is marked distinctly
            // so a human cannot mistake it for the benign inverse (a producer
            // recovering facts, or a corpus drift under the read-only contract).
            if (field === 'actual' && actual.actual < expected.actual) {
              drift.push(
                `REGRESSION ${kind} on ${corpus} actual ${actual.actual} < baseline ${expected.actual} (producer emitted fewer facts than its last recording — a defect until attributed)`,
              );
            } else {
              drift.push(`${kind} on ${corpus} ${field} ${actual[field]} != baseline ${expected[field]}`);
            }
          }
        }
      }
    }
  }
  return drift;
}
