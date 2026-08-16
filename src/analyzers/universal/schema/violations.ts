/**
 * Schema violation builders — module-level equivalents of the base
 * UniversalAnalyzer.createViolation with `analyzer: 'schema'` hardcoded, so
 * extracted free functions (Spec 34) can construct violations without a `this`
 * reference back through the analyzer class.
 */

import type { Violation } from '../../../types.js';

/**
 * Bundled classification for a schema violation — `severity`, `rule`, and an
 * optional `symbol` travel together so `createSchemaViolation` stays a 4-arg
 * call rather than a 6-arg one.
 */
export interface SchemaViolationClassification {
  severity: 'critical' | 'warning' | 'suggestion';
  rule: string;
  symbol?: string;
}

/**
 * Module-level equivalent of `UniversalAnalyzer.createViolation`. `rule`
 * identity is preserved exactly; `location` and optional `symbol` are kept,
 * while `analyzer` is hardcoded to `'schema'` instead of `this.name`.
 *
 * @param file The file the violation occurred in.
 * @param location The 1-based line/column of the violation.
 * @param message The human-readable violation message.
 * @param classification Bundled severity/rule/symbol classification.
 * @returns A schema analyzer violation.
 */
export function createSchemaViolation(
  file: string,
  location: { line: number; column: number },
  message: string,
  classification: SchemaViolationClassification
): Violation {
  const v: Violation = {
    file,
    line: location.line,
    column: location.column,
    severity: classification.severity,
    message,
    rule: classification.rule,
    analyzer: 'schema'
  };
  if (classification.symbol) {
    v.functionName = classification.symbol;
  }
  return v;
}

/**
 * Single-line JSON validation violation — hardcoded `line: 1` / `column: 1`
 * (JSON files have no AST positions). Used by the JSON-schema helpers.
 *
 * @param file The JSON file the violation occurred in.
 * @param severity The violation severity.
 * @param message The human-readable violation message.
 * @param rule The rule identifier.
 * @returns A schema analyzer violation anchored at 1:1.
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
