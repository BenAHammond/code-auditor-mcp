/**
 * verify-recall-value-drift-core.mjs — the pure comparison behind the
 * recall-protocol value-drift gate (Spec 67 follow-up, "Item 1").
 *
 * The count of 3 value-drift findings on recall-protocol is the first
 * value-drift number since the rule was written that means what the rule's name
 * says: three genuine near-identical color pairs, nothing else. For months that
 * number lived only in `specs/corpus-baselines.md` — prose that documents the
 * number without defending it. A prose baseline can drift silently; this module
 * is the machine form: it parses the analyzer's findings and diffs them against
 * a JSON baseline (`bench/baselines/recall-value-drift.json`), returning the
 * drift lines that make the gate exit non-zero.
 *
 * Split from the I/O gate (`verify-recall-value-drift.ts`) so the failure branch
 * is unit-testable without recall-protocol present (the same extraction that let
 * `verify-self.mjs` keep its I/O while its predicate became testable — Spec 62
 * R9 gate-liveness).
 */

/**
 * Parse value-drift findings into `{ drift, canonical, deltaE76 }` triples.
 *
 * The finding message (UniversalStylesAnalyzer.flagColorDriftMembers) is:
 *   Color drift in "{property}": "{drift}" is near-identical to "{canonical}"
 *   (used N times, ΔE = D.DD). Consider using "{canonical}".
 */
const DRIFT_MESSAGE_RE = /Color drift in "[^"]*": "([^"]+)" is near-identical to "([^"]+)" \(used \d+ times?, ΔE = ([0-9.]+)\)/;

export function extractDriftPairs(violations) {
  const pairs = [];
  for (const v of violations ?? []) {
    if (v.rule !== 'styles/value-drift') continue;
    const m = DRIFT_MESSAGE_RE.exec(v.message ?? '');
    if (!m) continue;
    pairs.push({ drift: m[1], canonical: m[2], deltaE76: m[3] });
  }
  return pairs;
}

/**
 * Diff the extracted pairs against the baseline. A finding and its baseline pair
 * are the same triple `drift|canonical|deltaE76` — the ΔE string is part of the
 * identity because "near-identical" is quantified by the distance; if the color
 * space or the threshold moves, the pair is no longer the same claim. Count
 * mismatch is reported separately from the pair multiset diff.
 *
 * @returns {string[]} drift lines (empty = green).
 */
export function compareToBaseline(actualPairs, baseline) {
  const drift = [];
  if (actualPairs.length !== baseline.expectedCount) {
    drift.push(`value-drift count ${actualPairs.length} != baseline ${baseline.expectedCount}`);
  }
  const key = (p) => `${p.drift}|${p.canonical}|${p.deltaE76}`;
  const expected = new Map();
  for (const p of baseline.pairs) {
    const k = key(p);
    expected.set(k, (expected.get(k) ?? 0) + 1);
  }
  const actual = new Map();
  for (const p of actualPairs) {
    const k = key(p);
    actual.set(k, (actual.get(k) ?? 0) + 1);
  }
  const allKeys = new Set([...expected.keys(), ...actual.keys()]);
  for (const k of allKeys) {
    const e = expected.get(k) ?? 0;
    const a = actual.get(k) ?? 0;
    if (e > a) drift.push(`missing pair ${k}`);
    else if (a > e) drift.push(`extra pair ${k}`);
  }
  return drift;
}
