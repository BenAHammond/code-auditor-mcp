/**
 * Compliant code — no banned imports.
 * Should not trigger any invariants violations.
 */

export function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toISOString();
}
