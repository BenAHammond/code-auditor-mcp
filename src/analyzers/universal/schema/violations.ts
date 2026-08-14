/**
 * Schema violation builders — module-level equivalents of the base
 * UniversalAnalyzer.createViolation with `analyzer: 'schema'` hardcoded, so
 * extracted free functions (Spec 34) can construct violations without a `this`
 * reference back through the analyzer class.
 */

import type { Violation } from '../../../types.js';

/**
 * Module-level equivalent of `UniversalAnalyzer.createViolation`. `rule`
 * identity is preserved exactly; `location` and optional `symbol` are kept,
 * while `analyzer` is hardcoded to `'schema'` instead of `this.name`.
 */
export function createSchemaViolation(
  file: string,
  location: { line: number; column: number },
  message: string,
  severity: 'critical' | 'warning' | 'suggestion',
  rule: string,
  symbol?: string
): Violation {
  const v: Violation = {
    file,
    line: location.line,
    column: location.column,
    severity,
    message,
    rule,
    analyzer: 'schema'
  };
  if (symbol) {
    v.functionName = symbol;
  }
  return v;
}

/**
 * Single-line JSON validation violation — hardcoded `line: 1` / `column: 1`
 * (JSON files have no AST positions). Used by the JSON-schema helpers.
 */
export function emitViolation(
  file: string,
  severity: Violation['severity'],
  message: string,
  rule: string
): Violation {
  return {
    file,
    line: 1,
    column: 1,
    severity,
    message,
    rule,
    analyzer: 'schema',
  };
}
