/**
 * verify-recall-cases-core.mjs — the pure comparison half of the named-case
 * recall gate.
 *
 * The retired `verify:oracle-shortfalls` gate pinned a *count* — the per-
 * (fact-kind, corpus) aggregate of files / expected / actual — against a stored
 * total. A count baseline goes red every time the detector gets better (any
 * re-pin of the total is a red flag), so it is not a fact worth gating on. This
 * gate replaces it with a *named-case* recall assertion: a hand-authored list of
 * specific (kind, corpus, file, site) cases drawn from HEAD, each of which the
 * producer must still emit. A named case stays green under a legitimate gain
 * (more facts emitted) and goes red only under a regression (that specific site
 * stopped being emitted). It closes per case, from HEAD, with no inquiry into
 * why a historical total shifted.
 *
 * This module is the pure half of the split used by the other drift gates: the
 * measurement (corpus I/O) lives in `verify-recall-cases.ts`, and the failure
 * branch lives here so a gate-liveness test can exercise it without the corpus.
 */

/**
 * Compare measured per-(kind, corpus, file) site sets against the pinned named
 * cases. Only presence matters: a case is satisfied when its `site` string is
 * among the sites emitted for its (kind, corpus, file). Extra emitted sites are
 * irrelevant (a gain never fails the gate); a missing file or a missing site is
 * the recall regression this gate exists to catch.
 *
 * @param {{ [kind: string]: { [corpus: string]: { [file: string]: string[] } } }} measured
 *   fact kind → corpus → file → the sites emitted for that file
 * @param {{ kind: string, corpus: string, file: string, site: string, note: string }[]} baselineCases
 *   the named recall cases (hand-authored, drawn from HEAD)
 * @returns {string[]} drift lines; empty when every case's site is present
 */
export function compareRecallCases(measured, baselineCases) {
  const drift = [];
  for (const c of baselineCases) {
    const sites = measured[c.kind]?.[c.corpus]?.[c.file];
    if (!sites || sites.length === 0) {
      drift.push(
        `${c.kind} on ${c.corpus} ${c.file} not measured — named case '${c.site}' unverified (${c.note})`,
      );
    } else if (!sites.includes(c.site)) {
      drift.push(
        `MISSING RECALL ${c.kind} on ${c.corpus} ${c.file} site '${c.site}' not emitted — a producer stopped emitting this named case (${c.note})`,
      );
    }
  }
  return drift;
}
