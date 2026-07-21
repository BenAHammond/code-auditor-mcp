/**
 * Spec-17 R8 Fixture 9: template-prefix-table
 * Report section: R2.3 — Template expressions resolve to wildcards
 *
 * Dynamic table references like `${prefix}_builds` should produce ZERO
 * unknown-table findings. The dynamic segment resolves to a wildcard
 * for known-table matching, and unknown-with-dynamic is never flagged.
 */

const prefix = "user";

export function getBuilds(): string {
  // Template expression table — should NOT be flagged
  const tableName = `${prefix}_builds`;
  return `SELECT * FROM ${tableName}`;
}
