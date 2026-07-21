/**
 * Spec-17 R8 Fixture 7: word-the-in-comment
 * Report section: R2.1 — SQL-context-only extraction
 *
 * The word "the" appearing in a comment or string literal should produce
 * ZERO schema findings. This was a ~4,500-count false positive in the
 * diagnostic: the old regex matched "the" in comments as a table ref.
 */

// The quick brown fox jumps over the lazy dog
// The answer to life, the universe, and everything

export function tellTheStory(): string {
  const message = "the hero returns from the journey";
  return message;
}
