/**
 * Spec 68 §3.2 — the schema-validator rules, migrated to `analyze(ctx)`.
 *
 * The three rules here (`schema-field-mismatch`, `missing-field`, `extra-field`)
 * read the `cross-language-entities` fact and reduce it through
 * `SchemaValidator` — the same pure class the legacy Stage-4 reducer ran. The
 * reducer (`createSchemaValidatorReducer` in pipelineAdapters.ts) called
 * `extractSchemas(entities)` then `new SchemaValidator().validateSchemas(schemas)`
 * and returned the resulting `SchemaViolation[]`; each violation already carries
 * its own `rule` (`schema-field-mismatch` | `missing-field` | `extra-field`), so
 * the migration is a filter: one rule per violation type, re-homed verbatim.
 *
 * `extractSchemas` and `SchemaValidator` are imported (not re-homed) because —
 * like `DependencyGraphBuilder` — they import no analyzer class and no pipeline,
 * so §15 keeps them. The reducer's two guards are dropped here by construction:
 *   - the `isScoped` early-return is a *stage* concern (scoped runs never reach
 *     a full-corpus reducer), not a rule concern — the phase model hands a rule
 *     whatever facts it declared and the rule evaluates them;
 *   - the `countCrossLanguagePairs === 0` notRunReason is a *coverage* signal
 *     (§8), not a finding — `validateSchemas` on a single-language corpus
 *     returns `[]` because every name-group has `byLanguage.size < 2`, so the
 *     rules already emit nothing (the empty multiset the parity test pins).
 *
 * The `cross-language-entities` producer (`extractCrossLanguageEntities`) emits
 * full `CrossLanguageEntity` values whose `parameters` (TS interfaces) and
 * `metadata.fields` (Go structs) already carry `description`/`tag`, so
 * `extractSchemas` works over the fact as-is — no shape enrichment is required.
 */

import type { RuleDefinition, Finding, Entity } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import {
  SchemaValidator,
  extractSchemas,
  type SchemaViolation,
} from '../../analyzers/cross-language/SchemaValidator.js';
import type { CrossLanguageEntity } from '../../types/crossLanguage.js';

/** The shared declaration for the three schema-validator rules. */
type SchemaValidatorNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript', 'go'];
  readonly facts: readonly ['cross-language-entities'];
};

const META = RULE_REGISTRY;

/**
 * Run the cross-language schema comparison over the entity fact. Returns every
 * violation, across all three rule types; each rule filters to its own `rule`.
 * `validateSchemas` is async, so the three `analyze` bodies await it (the phase
 * model awaits each rule).
 */
async function validate(entities: Entity[]): Promise<SchemaViolation[]> {
  const schemas = extractSchemas(entities as unknown as CrossLanguageEntity[]);
  return new SchemaValidator().validateSchemas(schemas);
}

/** Emit one finding per violation of the given type, re-homed from the reducer. */
function findingsFor(
  violations: SchemaViolation[],
  ruleId: SchemaViolation['rule'],
): Finding[] {
  const out: Finding[] = [];
  for (const v of violations) {
    if (v.rule !== ruleId) continue;
    out.push({
      ruleId,
      severity: v.severity,
      message: v.message,
      file: v.file,
      line: v.line,
      symbol: v.fieldName,
    });
  }
  return out;
}

// ── schema-field-mismatch ────────────────────────────────────────────────────

const schemaFieldMismatch: RuleDefinition<SchemaValidatorNeeds> = {
  id: 'schema-field-mismatch',
  analyzer: 'schema-validator',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'severe',
  message: META['schema-field-mismatch'].message,
  docs: META['schema-field-mismatch'].docs,
  thresholds: META['schema-field-mismatch'].thresholds,
  samples: META['schema-field-mismatch'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return findingsFor(await validate(ctx.facts['cross-language-entities']), 'schema-field-mismatch');
  },
};

// ── missing-field ────────────────────────────────────────────────────────────

const missingField: RuleDefinition<SchemaValidatorNeeds> = {
  id: 'missing-field',
  analyzer: 'schema-validator',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'severe',
  message: META['missing-field'].message,
  docs: META['missing-field'].docs,
  thresholds: META['missing-field'].thresholds,
  samples: META['missing-field'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return findingsFor(await validate(ctx.facts['cross-language-entities']), 'missing-field');
  },
};

// ── extra-field ──────────────────────────────────────────────────────────────

const extraField: RuleDefinition<SchemaValidatorNeeds> = {
  id: 'extra-field',
  analyzer: 'schema-validator',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'severe',
  message: META['extra-field'].message,
  docs: META['extra-field'].docs,
  thresholds: META['extra-field'].thresholds,
  samples: META['extra-field'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return findingsFor(await validate(ctx.facts['cross-language-entities']), 'extra-field');
  },
};

/** The three schema-validator rules this slice migrates, in registry order. */
export const schemaValidatorRules: readonly RuleDefinition<SchemaValidatorNeeds>[] = [
  schemaFieldMismatch,
  missingField,
  extraField,
];
