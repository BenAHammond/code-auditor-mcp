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
  /**
   * Optional dot-separated path to a config boolean within the analyzer's namespace.
   * When the config value is `false`, the rule is `notApplicable` (explicitly disabled).
   *
   * Example: `checkStructuralSimilarity` → looked up as config.config.dry.checkStructuralSimilarity.
   * The path is relative to the analyzer namespace (config.config[analyzer]).
   */
  configGate?: string;
  /**
   * Spec 33 Item 14 — the input sources this rule consumes, used to promote a
   * zero-violation rule from `unassessed` to `clean` (≥1 input present) or
   * `notApplicable` (all inputs absent). Each entry is one of:
   *   - `'files'` — the analyzer ran on ≥1 parsed source file (always present at
   *     the zero-violation branch, since earlier checks already excluded the
   *     empty-input cases);
   *   - a fact-key — a visitor/reducer name (e.g. `'schema-json'`, `'function-index'`)
   *     whose per-file facts were non-empty this run;
   *   - an index table — a table name (e.g. `'schema_usage'`, `'functions'`) that
   *     held ≥1 row at coverage-build time.
   *
   * Omitted for non-pipeline analyzers (schema-validator, api-contract,
   * dependency-graph), whose rules stay `unassessed`.
   */
  input?: string[];
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
  'solid/class-size':          { analyzer: 'solid',             field: 'rule', input: ['files'] },
  'solid/method-complexity':   { analyzer: 'solid',             field: 'rule', input: ['files'] },
  'open-closed':               { analyzer: 'solid',             field: 'rule', input: ['files'] },
  'single-responsibility':     { analyzer: 'solid',             field: 'rule', input: ['files'] },
  'interface-segregation':     { analyzer: 'solid',             field: 'rule', input: ['files'] },
  'liskov-substitution':       { analyzer: 'solid',             field: 'rule', input: ['files'] },
  'dependency-inversion':      { analyzer: 'solid',             field: 'rule', input: ['files'] },

  // ── dry (UniversalDRYAnalyzer) ──────────────────────────────────────────
  'dry/duplicate':             { analyzer: 'dry',               field: 'rule', input: ['files'] },
  'dry/structural-similarity': { analyzer: 'dry',               field: 'rule', configGate: 'checkStructuralSimilarity', input: ['files'] },
  'duplicate-string-literal':  { analyzer: 'dry',               field: 'rule', configGate: 'checkStrings', input: ['files'] },
  'duplicate-import':          { analyzer: 'dry',               field: 'rule', configGate: 'checkImports', input: ['files'] },

  // ── data-access (UniversalDataAccessAnalyzer) ───────────────────────────
  'sql-injection-risk':        { analyzer: 'data-access',       field: 'rule', input: ['files'] },
  'missing-org-filter':        { analyzer: 'data-access',       field: 'rule', input: ['files'] },
  'complex-query':             { analyzer: 'data-access',       field: 'rule', input: ['files'] },
  'unfiltered-query':          { analyzer: 'data-access',       field: 'rule', input: ['files'] },
  'hardcoded-connection':      { analyzer: 'data-access',       field: 'rule', input: ['files'] },

  'loop-query':                { analyzer: 'data-access',       field: 'rule', input: ['files'] },

  // ── documentation (UniversalDocumentationAnalyzer) ─────────────────────
  'file-documentation':        { analyzer: 'documentation',     field: 'rule', input: ['files'] },
  'function-documentation':    { analyzer: 'documentation',     field: 'rule', input: ['files'] },
  'parameter-documentation':   { analyzer: 'documentation',     field: 'rule', input: ['files'] },
  'return-documentation':      { analyzer: 'documentation',     field: 'rule', input: ['files'] },
  'class-documentation':       { analyzer: 'documentation',     field: 'rule', input: ['files'] },
  'method-documentation':      { analyzer: 'documentation',     field: 'rule', input: ['files'] },

  // ── schema (UniversalSchemaAnalyzer) ────────────────────────────────────
  // JSON validation rules → emitted by the schema-json visitor path.
  'invalid-json':              { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'missing-schema-declaration':{ analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'undefined-required-field':  { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'invalid-type':              { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'invalid-range':             { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'file-error':                { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'type-mismatch':             { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'string-too-short':          { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'string-too-long':           { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'pattern-mismatch':          { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'invalid-format':            { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'below-minimum':             { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'above-maximum':             { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'too-few-items':             { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'too-many-items':            { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'missing-required-field':    { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'unexpected-property':       { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  'enum-mismatch':             { analyzer: 'schema',            field: 'rule', input: ['schema-json'] },
  // SQL-injection → emitted by the schema-code visitor over TS/JS source.
  'sql-injection':             { analyzer: 'schema',            field: 'rule', input: ['schema-code'] },

  // ── react (reactAnalyzer) ───────────────────────────────────────────────
  'hooks-naming':              { analyzer: 'react',             field: 'rule', input: ['files'] },
  'complexity':                { analyzer: 'react',             field: 'rule', input: ['files'] },
  'missing-props':             { analyzer: 'react',             field: 'rule', configGate: 'requirePropTypes', input: ['files'] },
  'no-error-boundary':         { analyzer: 'react',             field: 'rule', input: ['files'] },
  'performance':               { analyzer: 'react',             field: 'rule', configGate: 'requireMemoization', input: ['files'] },
  'accessibility':             { analyzer: 'react',             field: 'rule', input: ['files'] },
  'raw-element':               { analyzer: 'react',             field: 'rule', input: ['files'] },

  // ── invariants (invariantsAnalyzer) — fixed internal IDs only ──────────
  'config-error':              { analyzer: 'invariants',        field: 'rule', input: ['files'] },
  'engine-error':              { analyzer: 'invariants',        field: 'rule', input: ['files'] },

  // ── schema-validator (SchemaValidator) ──────────────────────────────────
  'field-mismatch':            { analyzer: 'schema-validator',  field: 'rule' },
  'schema-field-mismatch':     { analyzer: 'schema-validator',  field: 'rule' },
  'missing-field':             { analyzer: 'schema-validator',  field: 'rule' },
  'extra-field':               { analyzer: 'schema-validator',  field: 'rule' },
  'constraint-mismatch':       { analyzer: 'schema-validator',  field: 'rule' },
  'version-mismatch':          { analyzer: 'schema-validator',  field: 'rule' },

  // ── api-contract (APIContractAnalyzer) ──────────────────────────────────
  'api-type-mismatch':         { analyzer: 'api-contract',      field: 'rule' },
  'missing-endpoint':          { analyzer: 'api-contract',      field: 'rule' },
  'api-extra-field':           { analyzer: 'api-contract',      field: 'rule' },
  'api-missing-field':         { analyzer: 'api-contract',      field: 'rule' },
  'method-mismatch':           { analyzer: 'api-contract',      field: 'rule' },
  'auth-mismatch':             { analyzer: 'api-contract',      field: 'rule' },

  // ── dependency-graph (DependencyGraphBuilder) ───────────────────────────
  'circular-dependency':       { analyzer: 'dependency-graph',  field: 'type' },
  'break-cycles':              { analyzer: 'dependency-graph',  field: 'type' },
  'tight-coupling':            { analyzer: 'dependency-graph',  field: 'type' },
  'reduce-coupling':           { analyzer: 'dependency-graph',  field: 'type' },
  'hub-nodes':                 { analyzer: 'dependency-graph',  field: 'type' },
  'split-responsibilities':    { analyzer: 'dependency-graph',  field: 'type' },
  'orphaned-nodes':            { analyzer: 'dependency-graph',  field: 'type' },
  'review-orphans':            { analyzer: 'dependency-graph',  field: 'type' },

  // ── styles (UniversalStylesAnalyzer) ─────────────────────────────────────
  'styles/value-drift':              { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },
  'styles/off-scale':                { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },
  'styles/undefined-class':          { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },
  'styles/undefined-class-disabled': { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },
  'styles/token-bypass':             { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },
  'styles/mechanism-fragmentation':  { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },
  'styles/mechanism-mixing':         { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },
  'styles/declaration-set-similarity': { analyzer: 'styles',     field: 'rule', input: ['styles-css'] },
  'styles/z-index-sprawl':           { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },
  'styles/z-index-singleton':        { analyzer: 'styles',       field: 'rule', input: ['styles-css'] },

  // ── conventions (UniversalConventionsAnalyzer) ───────────────────────────
  'conventions/usage-pair':     { analyzer: 'conventions',       field: 'rule', input: ['function-index'] },
  'conventions/import-form':    { analyzer: 'conventions',       field: 'rule', input: ['function-index'] },
  'conventions/error-handling': { analyzer: 'conventions',       field: 'rule', input: ['function-index'] },
  'conventions/export-shape':   { analyzer: 'conventions',       field: 'rule', input: ['function-index'] },
  'conventions/naming':         { analyzer: 'conventions',       field: 'rule', input: ['function-index'] },

  // ── cross-domain (CrossDomainAnalyzer) ────────────────────────────────────
  'cross-domain/written-never-read':   { analyzer: 'cross-domain', field: 'rule', input: ['schema_usage', 'functions'] },
  'cross-domain/read-never-written':   { analyzer: 'cross-domain', field: 'rule', input: ['schema_usage', 'functions'] },
  'cross-domain/transaction-boundary': { analyzer: 'cross-domain', field: 'rule', input: ['schema_usage', 'functions'] },
  'cross-domain/validation-bypass':    { analyzer: 'cross-domain', field: 'rule', input: ['schema_usage', 'functions'] },
  'cross-domain/uncovered-risk':       { analyzer: 'cross-domain', field: 'rule', input: ['schema_usage', 'functions'] },
};
