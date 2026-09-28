/**
 * Extract a human-readable message from a thrown value.
 *
 * `throw` accepts anything, so `catch` blocks bind `unknown`. This wraps the
 * common unwrapping — use `Error.message` when the value is an `Error`,
 * otherwise a stable fallback — so the fallback string has a single home
 * instead of repeating in every catch.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
