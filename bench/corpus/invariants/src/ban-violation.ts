/**
 * Violates the no-legacy-imports rule — imports from legacy-utils.
 * Should trigger a critical invariants violation.
 */

import { oldFormatDate } from './legacy-utils';

export function formatTimestamp(ts: number): string {
  return oldFormatDate(new Date(ts));
}
