/**
 * Legacy utility — this module is banned by the no-legacy-imports rule.
 * Needed as a target for the import-ban rule fixture.
 */

export function oldFormatDate(date: Date): string {
  return date.toLocaleDateString('en-US');
}
