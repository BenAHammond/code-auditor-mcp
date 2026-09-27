/**
 * Shared symbol extractor for fingerprint construction.
 *
 * One canonical source — used by baseline matching, tasks.from_audit dedupe,
 * and SARIF partial fingerprints. If these surfaces drift, the same violation
 * fingerprints differently across surfaces, silently breaking baseline
 * matching and task deduplication.
 *
 * Spec 68 §7 — one finding identity: the symbol is a single field, `symbol`,
 * populated by the processor (phase rule `analyze`) or legacy analyzer that
 * located the finding. The nine pre-§7 symbol-bearing fields
 * (`functionName`/`className`/`componentName`/`methodName`/`hookName`/
 * `interfaceName`/`name`/`enclosingSymbol`) are gone; there is no fallback
 * chain to resurrect.
 */

import type { Violation } from './types.js';

/**
 * Extract the canonical symbol from a violation record — the single `symbol`
 * field, or `''` when the finding is not symbol-anchored (a file-level or
 * corpus-level finding whose identity is the file/rule itself).
 */
export function extractSymbol(violation: Violation): string {
  return violation.symbol ?? '';
}
