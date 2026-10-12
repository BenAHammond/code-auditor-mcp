/**
 * verify-recall-cases-core.mjs — the pure predicate behind the
 * `verify:recall-cases` gate.
 *
 * The retired gate held a hand-authored list of named `(kind, corpus, file, site)`
 * cases against a JSON baseline. This replacement keeps the *named case* — a
 * pinned source site whose truth was established independently of the detector —
 * but drops the harvested count/pair baseline entirely. The invariant is two
 * assertions per pinned site:
 *
 *   - `emitted`        — the producer still emits a fact at the site (recall).
 *   - `verdictMatches` — the site's verdict matches its recorded disposition
 *                        (the rejection/fold the spec records).
 *
 * A site that stops being emitted, or whose verdict flips, is a regression in the
 * producer or the rule — never a number that merely moved. A legitimate gain (more
 * facts elsewhere) leaves every named site in place and stays green.
 *
 * The measurement (reading the pinned fixtures and running the secret/loop
 * producers over them) lives in `verify-recall-cases.ts`; the failure branch lives
 * here so a gate-liveness test can feed deliberately-inconsistent site results
 * without a corpus or a build.
 */

/**
 * Check the recall-cases invariant over per-site results.
 *
 * @param {{ sites: Array<{ id: string, emitted: boolean,
 *                          verdictMatches: boolean }> }} args
 *   Each site names its `id`, whether a fact was emitted (`emitted`), and whether
 *   the verdict matched the recorded disposition (`verdictMatches`).
 * @returns {string[]} drift lines; empty when the invariant holds.
 */
export function checkRecallCases({ sites }) {
  const drift = [];
  for (const s of sites ?? []) {
    if (!s.emitted) {
      drift.push(`${s.id}: producer emitted no fact at the pinned site (regression)`);
    } else if (!s.verdictMatches) {
      drift.push(`${s.id}: fact emitted but the verdict does not match the recorded disposition`);
    }
  }
  return drift;
}
