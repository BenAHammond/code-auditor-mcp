/**
 * Shared symbol extractor for fingerprint construction.
 *
 * One canonical priority chain — used by baseline matching, tasks.from_audit
 * dedupe, and SARIF partial fingerprints. If these surfaces drift, the same
 * violation fingerprints differently across surfaces, silently breaking
 * baseline matching and task deduplication.
 *
 * Priority: `symbol` first (explicit canonical marker), then entity-name
 * fields in descending specificity, then context fallbacks.
 */

import type { Violation } from './types.js';

/**
 * Extract the canonical symbol from a violation record.
 *
 * The priority chain covers all known symbol-carrying fields across the
 * analyzer surface area. New fields should be added here — never copied
 * inline to a caller.
 */
export function extractSymbol(violation: Violation): string {
  return (violation.symbol
    ?? violation.functionName
    ?? violation.className
    ?? violation.componentName
    ?? violation.methodName
    ?? violation.hookName
    ?? violation.interfaceName
    ?? violation.name
    ?? violation.enclosingSymbol
    ?? '') as string;
}
