/**
 * Rule Registry — canonical mapping of every emitted rule/violation-type ID
 * to its emitting analyzer.
 *
 * This is the ONE place that asserts "each rule ID has exactly one emitter."
 * If you add a new emitted ID to an analyzer, add it here. The enforcement
 * test (`registry enforces one emitter per rule ID`) fails the suite on
 * duplicate entries — preventing the `severityOverrides` collision class
 * where two analyzers emit the same string.
 *
 * Rider 2, Spec 19: the `type-mismatch` duplicate between
 * UniversalSchemaAnalyzer (rule) and SchemaValidator (violationType) was
 * discovered during ground-truth enumeration. SchemaValidator's copy was
 * renamed to `schema-field-mismatch`.
 *
 * NOTE: `contractType` is NOT in the buildFingerprintInput rule-ID chain.
 * APIContractAnalyzer violations currently resolve rule='' in fingerprints.
 * They are listed here for collision detection nonetheless, because
 * severityOverrides may use a different resolution path.
 *
 * NOTE: invariants analyzer rule IDs are user-defined and variable —
 * `config-error` and `engine-error` are the only fixed, internal ones.
 */

export interface RuleRegistryEntry {
  /** The analyzer that emits this rule ID. */
  analyzer: string;
  /** The field on the Violation object that holds this ID. */
  field: 'rule' | 'principle' | 'violationType' | 'type' | 'contractType' | 'ruleId' | 'special';
}

/**
 * Every known rule/violation-type ID → analyzer.
 *
 * Invariant IDs (user-defined from .codeauditor.json rules) are NOT
 * listed — they vary per project. The two fixed invariant IDs
 * (`config-error`, `engine-error`) are listed.
 */
export const RULE_REGISTRY: Record<string, Readonly<RuleRegistryEntry>> = {
  // ── solid (UniversalSOLIDAnalyzer) ──────────────────────────────────────
  'solid/class-size':          { analyzer: 'solid',             field: 'rule' },
  'solid/method-complexity':   { analyzer: 'solid',             field: 'rule' },
  'open-closed':               { analyzer: 'solid',             field: 'rule' },
  'single-responsibility':     { analyzer: 'solid',             field: 'rule' },
  'interface-segregation':     { analyzer: 'solid',             field: 'rule' },
  'liskov-substitution':       { analyzer: 'solid',             field: 'rule' },
  'dependency-inversion':      { analyzer: 'solid',             field: 'rule' },

  // ── dry (UniversalDRYAnalyzer) ──────────────────────────────────────────
  'dry/duplicate':             { analyzer: 'dry',               field: 'rule' },
  'dry/structural-similarity': { analyzer: 'dry',               field: 'rule' },
  'duplicate-string-literal':  { analyzer: 'dry',               field: 'rule' },
  'duplicate-import':          { analyzer: 'dry',               field: 'rule' },

  // ── data-access (UniversalDataAccessAnalyzer) ───────────────────────────
  'sql-injection-risk':        { analyzer: 'data-access',       field: 'rule' },
  'missing-org-filter':        { analyzer: 'data-access',       field: 'rule' },
  'complex-query':             { analyzer: 'data-access',       field: 'rule' },
  'unfiltered-query':          { analyzer: 'data-access',       field: 'rule' },
  'hardcoded-connection':      { analyzer: 'data-access',       field: 'rule' },
  'direct-sql':                { analyzer: 'data-access',       field: 'rule' },
  'loop-query':                { analyzer: 'data-access',       field: 'rule' },

  // ── documentation (UniversalDocumentationAnalyzer) ─────────────────────
  'file-documentation':        { analyzer: 'documentation',     field: 'rule' },
  'function-documentation':    { analyzer: 'documentation',     field: 'rule' },
  'parameter-documentation':   { analyzer: 'documentation',     field: 'rule' },
  'return-documentation':      { analyzer: 'documentation',     field: 'rule' },
  'class-documentation':       { analyzer: 'documentation',     field: 'rule' },
  'method-documentation':      { analyzer: 'documentation',     field: 'rule' },

  // ── schema (UniversalSchemaAnalyzer) ────────────────────────────────────
  'invalid-json':              { analyzer: 'schema',            field: 'rule' },
  'missing-schema-declaration':{ analyzer: 'schema',            field: 'rule' },
  'undefined-required-field':  { analyzer: 'schema',            field: 'rule' },
  'invalid-type':              { analyzer: 'schema',            field: 'rule' },
  'invalid-range':             { analyzer: 'schema',            field: 'rule' },
  'file-error':                { analyzer: 'schema',            field: 'rule' },
  'type-mismatch':             { analyzer: 'schema',            field: 'rule' },
  'string-too-short':          { analyzer: 'schema',            field: 'rule' },
  'string-too-long':           { analyzer: 'schema',            field: 'rule' },
  'pattern-mismatch':          { analyzer: 'schema',            field: 'rule' },
  'invalid-format':            { analyzer: 'schema',            field: 'rule' },
  'below-minimum':             { analyzer: 'schema',            field: 'rule' },
  'above-maximum':             { analyzer: 'schema',            field: 'rule' },
  'too-few-items':             { analyzer: 'schema',            field: 'rule' },
  'too-many-items':            { analyzer: 'schema',            field: 'rule' },
  'missing-required-field':    { analyzer: 'schema',            field: 'rule' },
  'unexpected-property':       { analyzer: 'schema',            field: 'rule' },
  'enum-mismatch':             { analyzer: 'schema',            field: 'rule' },
  'sql-injection':             { analyzer: 'schema',            field: 'rule' },

  // ── react (reactAnalyzer) ───────────────────────────────────────────────
  'hooks-naming':              { analyzer: 'react',             field: 'rule' },
  'complexity':                { analyzer: 'react',             field: 'violationType' },
  'missing-props':             { analyzer: 'react',             field: 'violationType' },
  'no-error-boundary':         { analyzer: 'react',             field: 'violationType' },
  'hooks-violation':           { analyzer: 'react',             field: 'violationType' },
  'performance':               { analyzer: 'react',             field: 'violationType' },
  'accessibility':             { analyzer: 'react',             field: 'violationType' },

  // ── invariants (invariantsAnalyzer) — fixed internal IDs only ──────────
  'config-error':              { analyzer: 'invariants',        field: 'rule' },
  'engine-error':              { analyzer: 'invariants',        field: 'rule' },

  // ── cross-language-solid (CrossLanguageSOLIDAnalyzer) ───────────────────
  'SRP':                       { analyzer: 'cross-language-solid', field: 'principle' },
  'OCP':                       { analyzer: 'cross-language-solid', field: 'principle' },
  'ISP':                       { analyzer: 'cross-language-solid', field: 'principle' },
  'DIP':                       { analyzer: 'cross-language-solid', field: 'principle' },
  'LSP':                       { analyzer: 'cross-language-solid', field: 'principle' },

  // ── schema-validator (SchemaValidator) ──────────────────────────────────
  'field-mismatch':            { analyzer: 'schema-validator',  field: 'violationType' },
  'schema-field-mismatch':     { analyzer: 'schema-validator',  field: 'violationType' },
  'missing-field':             { analyzer: 'schema-validator',  field: 'violationType' },
  'extra-field':               { analyzer: 'schema-validator',  field: 'violationType' },
  'constraint-mismatch':       { analyzer: 'schema-validator',  field: 'violationType' },
  'version-mismatch':          { analyzer: 'schema-validator',  field: 'violationType' },

  // ── api-contract (APIContractAnalyzer) ──────────────────────────────────
  // NOTE: contractType is NOT in the buildFingerprintInput chain.
  // These IDs are fingerprint-invisible but listed for collision detection.
  'api-type-mismatch':         { analyzer: 'api-contract',      field: 'contractType' },
  'missing-endpoint':          { analyzer: 'api-contract',      field: 'contractType' },
  'api-extra-field':           { analyzer: 'api-contract',      field: 'contractType' },
  'api-missing-field':         { analyzer: 'api-contract',      field: 'contractType' },
  'method-mismatch':           { analyzer: 'api-contract',      field: 'contractType' },
  'auth-mismatch':             { analyzer: 'api-contract',      field: 'contractType' },

  // ── dependency-graph (DependencyGraphBuilder) ───────────────────────────
  'circular-dependency':       { analyzer: 'dependency-graph',  field: 'type' },
  'break-cycles':              { analyzer: 'dependency-graph',  field: 'type' },
  'tight-coupling':            { analyzer: 'dependency-graph',  field: 'type' },
  'reduce-coupling':           { analyzer: 'dependency-graph',  field: 'type' },
  'hub-nodes':                 { analyzer: 'dependency-graph',  field: 'type' },
  'split-responsibilities':    { analyzer: 'dependency-graph',  field: 'type' },
  'orphaned-nodes':            { analyzer: 'dependency-graph',  field: 'type' },
  'review-orphans':            { analyzer: 'dependency-graph',  field: 'type' },
};
