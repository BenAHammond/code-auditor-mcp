/**
 * Spec 68 §3.2 — the schema-json rules, migrated to `analyze(ctx)`.
 *
 * The legacy JSON-schema validation was one monolithic free function
 * (`analyzeJsonSchemas` in `jsonSchema.ts`) that emitted 17 distinct rule ids
 * with hardcoded `line:1, column:1` anchors (JSON files have no AST position
 * the old path read). The phase model splits that into:
 *
 *   - a `json-document` producer (the parsed value of each `.json` file);
 *   - the `schema-validations` corpus processor (the one `analyzeJsonSchemas`
 *     call, projected onto `SchemaValidationFact` — the classification of which
 *     rule fired, at what severity, with what message is the processor's);
 *   - these 17 rules, each a thin filter over the fact by its own rule id.
 *
 * Because the processor re-homes the validation verbatim, each rule's `analyze`
 * is a pure projection: it does not re-validate, it just names the rule whose
 * findings it owns. The severity is the fact's (the legacy emit carried it per
 * violation, e.g. `invalid-json` is `critical`, `missing-schema-declaration` is
 * `high`, the rest `severe`), so the static `severity` below is the rule's
 * default and the finding's severity is the fact's — identical on every path.
 */

import type { RuleDefinition, Finding, SchemaValidationFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import type { Severity } from '../../types.js';

const META = RULE_REGISTRY;

/** The shared declaration for all 17 schema-json rules: they evaluate JSON
 *  files and read the one corpus fact the processor reduces from them. */
type SchemaJsonNeeds = {
  readonly formats: readonly ['json'];
  readonly facts: readonly ['schema-validations'];
};

/** The 17 registry rule ids, in registry order, each mapped to its fixed
 *  severity (the value the legacy `emit`/`emitViolation` carried for that id). */
const SCHEMA_JSON_RULES: ReadonlyArray<{ id: string; severity: Severity }> = [
  { id: 'invalid-json', severity: 'critical' },
  { id: 'missing-schema-declaration', severity: 'high' },
  { id: 'undefined-required-field', severity: 'severe' },
  { id: 'invalid-type', severity: 'severe' },
  { id: 'invalid-range', severity: 'severe' },
  { id: 'type-mismatch', severity: 'severe' },
  { id: 'string-too-short', severity: 'severe' },
  { id: 'string-too-long', severity: 'severe' },
  { id: 'pattern-mismatch', severity: 'severe' },
  { id: 'invalid-format', severity: 'severe' },
  { id: 'below-minimum', severity: 'severe' },
  { id: 'above-maximum', severity: 'severe' },
  { id: 'too-few-items', severity: 'severe' },
  { id: 'too-many-items', severity: 'severe' },
  { id: 'missing-required-field', severity: 'severe' },
  { id: 'unexpected-property', severity: 'severe' },
  { id: 'enum-mismatch', severity: 'severe' },
];

/** Project one rule's slice of the fact onto its findings, re-homed verbatim
 *  from the legacy violation fields (anchor always 1:1). */
function findingsFor(validations: readonly SchemaValidationFact[], ruleId: string): Finding[] {
  const out: Finding[] = [];
  for (const v of validations) {
    if (v.rule !== ruleId) continue;
    out.push({
      ruleId,
      severity: v.severity,
      message: v.message,
      file: v.file,
      line: v.line,
      column: v.column,
    });
  }
  return out;
}

/** Build one thin rule definition for a schema-json rule id. */
function schemaJsonRule(id: string, severity: Severity): RuleDefinition<SchemaJsonNeeds> {
  return {
    id,
    analyzer: 'schema',
    needs: { formats: ['json'], facts: ['schema-validations'] },
    severity,
    message: META[id].message,
    docs: META[id].docs,
    thresholds: META[id].thresholds,
    samples: META[id].samples,
    analyze(ctx): Finding[] {
      return findingsFor(ctx.facts['schema-validations'], id);
    },
  };
}

/** The 17 schema-json rules this slice migrates, in registry order. */
export const schemaJsonRules: readonly RuleDefinition<SchemaJsonNeeds>[] =
  SCHEMA_JSON_RULES.map(({ id, severity }) => schemaJsonRule(id, severity));
