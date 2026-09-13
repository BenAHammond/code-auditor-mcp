/**
 * Corpus-derived fixture — crowd-answer-game report, Spec 55 R1.
 *
 * Source: the "crowd-answer-game" external audit (CHANGELOG 3.9.3), which found
 * `orphaned-nodes` using a flat global bare-name table built from
 * `metadata.callees` — so a function referenced only by an anonymous arrow,
 * JSX tag, or bare function value was invisible and wrongly orphaned.
 *
 * `normalize` is referenced *only* through a bare function value in an array
 * (`[normalize]`), a shape the old callee extractor missed but the scope-aware
 * `fileReferences` index now captures.
 *
 * Expected: **no** `orphaned-nodes` — a function defined and referenced in one
 * file can no longer be orphaned.
 */

/** A non-exported helper referenced only through a bare value in an array. */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Apply the helper through a bare-value reference in the same file. */
export function normalizeNames(names: string[]): string[] {
  const transformers: Array<(s: string) => string> = [normalize];
  return names.map((n) => transformers[0](n));
}
