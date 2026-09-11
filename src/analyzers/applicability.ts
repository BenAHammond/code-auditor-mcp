/**
 * Derived rule applicability (Spec 39).
 *
 * A rule's applicability is a predicate over its declared inputs, evaluated
 * before the rule runs. A rule whose predicate is false reports `notApplicable`
 * with a reason naming the absent input — not silence, and not zero findings.
 * A rule that is structurally unreachable (its predicate reads a field no
 * extractor populates) reports `cannot-fire` instead, distinct from a per-corpus
 * `notApplicable`.
 *
 * This module is intentionally free of analyzer imports: pipeline.ts imports it
 * statically, and the analyzer classes pull in pipeline.js (via
 * UniversalSchemaAnalyzer.js → makeVisitorStatus), so a static analyzer import
 * here would create a pipeline↔analyzer cycle. The pipeline-side convention is
 * to reach analyzers only through dynamic import() (see pipelineAdapters.ts).
 */

export interface RuleApplicability {
  applicable: boolean;
  reason?: string;
  /**
   * Discriminates a rule that is *inapplicable to this corpus* (`notApplicable`,
   * the default) from one that is *broken in the tool* (`cannot-fire`). A
   * `cannot-fire` rule has no emission site — the extractor its predicate reads
   * never populates the field — so it reports the same verdict on every project,
   * not just this one. Defaults to `notApplicable` when omitted.
   */
  kind?: 'notApplicable' | 'cannot-fire';
}

/**
 * Spec 52 R3 — the whole-program rule class. These rules draw a global
 * conclusion ("table X is never read", "table Y is unknown", "no validator is
 * reachable") that is only sound when every file in the project contributed to
 * the evidence. On a scoped/diff run the evidence is a partial file set, so a
 * fired finding would be an unqualified global claim backed by partial evidence.
 *
 * On a scoped run each of these is suppressed with a `notApplicable` reason
 * naming the scope, rather than firing a claim the partial corpus cannot
 * support. The dependency-graph rules (unreferenced-module, orphaned-nodes,
 * review-orphans) are omitted here because their Stage-4 reducer already
 * short-circuits on `isScoped` with its own `notRunReason`.
 *
 * Option chosen (over "evaluate against the full project index"): suppress.
 * Rationale — a scoped run is a diff gate whose value is low latency; running
 * whole-program detectors against the full index would re-open the ~600ms
 * corpus-wide sweep the scoped gate exists to avoid, and the index is only as
 * fresh as the last full sync, so a "full" answer could still be stale. The
 * honest answer under a partial corpus is "not applicable to this run", surfaced
 * with a reason, not a global claim and not silence.
 *
 * Revisit note: this decision is scoped to a *scoped run without the daemon*.
 * Both of the reasons above are contingent on that context — the index can be
 * stale only because the scoped gate runs ahead of a fresh sync, and the cost is
 * a full corpus sweep only because there is no resident index to read. The
 * daemon removes both: its index is live by construction, and a read of an
 * already-built whole-program fact is not a sweep. Whoever reopens this should
 * evaluate "answer from the live daemon index" as the option-2 path rather than
 * re-deriving why suppression beat a cold re-sweep.
 */
export const WHOLE_PROGRAM_RULES: ReadonlyArray<string> = [
  'cross-domain/written-never-read',
  'cross-domain/read-never-written',
  'cross-domain/no-validator-reachable',
  'unknown-table',
];

/**
 * Build the `notApplicable` verdicts that suppress the whole-program rule class
 * on a scoped run. Returns an empty map when the run is unscoped — whole-program
 * rules run normally on a full corpus. Extracted as a pure function so the
 * scoped-suppression wiring is unit-testable without spinning up a full pipeline.
 */
export function scopedWholeProgramApplicability(
  isScoped: boolean,
  fileCount: number,
): Map<string, RuleApplicability> {
  const map = new Map<string, RuleApplicability>();
  if (!isScoped) return map;
  for (const ruleId of WHOLE_PROGRAM_RULES) {
    map.set(ruleId, {
      applicable: false,
      kind: 'notApplicable',
      reason: `requires whole-project analysis; this run was scoped to ${fileCount} file(s)`,
    });
  }
  return map;
}

/**
 * Default tenant-scoping column names. The single source of truth is
 * DEFAULT_DATA_ACCESS_CONFIG.orgFilterColumns in UniversalDataAccessAnalyzer.js;
 * this is a local copy because importing that module here would create the cycle
 * described above. Keep in sync with that constant.
 */
const DEFAULT_ORG_FILTER_COLUMNS = ['org_id', 'tenant_id', 'organization_id', 'workspace_id'];

/**
 * A stylesheet source the style indexer could not read (Spec 45 R5). When any
 * exist, `styles/undefined-class` still fires — the class has no matching
 * definition in any *read* stylesheet — but each finding carries this list as
 * `details.incompleteDefinitions` so "undefined" reads as "not defined in any
 * read stylesheet", not as a definitive assertion about the whole project.
 */
export interface UnreadStyleSourceInfo {
  filePath: string;
  reason: string;
}

/**
 * Evaluate whether a rule is applicable to the current codebase, given inputs
 * the pipeline has already computed.
 *
 * Returns null when the rule has no applicability predicate — the rule runs
 * unconditionally and its reporting state remains governed by the Spec 33 item
 * 14 input mapping.
 *
 * @param ruleId The registry rule id.
 * @param dataAccessConfig The namespaced data-access config (may be undefined).
 * @param ddlColumns Aggregated DDL-declared columns from the schema reducer.
 * @returns The rule's applicability verdict, or null when the rule declares no
 * applicability predicate and runs unconditionally.
 */
export function evaluateRuleApplicability(
  ruleId: string,
  dataAccessConfig: Record<string, unknown> | undefined,
  ddlColumns: string[] | undefined,
): RuleApplicability | null {
  if (ruleId === 'missing-org-filter') {
    return evaluateMissingOrgFilterApplicability(dataAccessConfig, ddlColumns);
  }
  const cannotFireReason = CANNOT_FIRE_RULES.get(ruleId);
  if (cannotFireReason !== undefined) {
    return { applicable: false, reason: cannotFireReason, kind: 'cannot-fire' };
  }
  return null;
}

/**
 * Spec 44 bucket 2 — rules that are structurally unreachable: their predicate
 * reads a field no extractor populates (or they are a legacy alias with no
 * emission site). Unlike `notApplicable` ("this corpus has no input for me"),
 * a `cannot-fire` rule reports the same verdict on every project — it is a
 * standing finding about the analyzer, so it stays visible rather than folding
 * into a per-project "nothing to see here".
 *
 * Each reason names the specific extractor and the specific field (or absence
 * of an emission site) so a reader can tell *why* it cannot fire. Remove an id
 * here when its extraction begins emitting it.
 */
const CANNOT_FIRE_RULES: ReadonlyMap<string, string> = new Map([
  // api-contract — reads response/auth metadata that extractEndpoints /
  // extractAPICalls never populate, or has no emission site at all.
  ['api-type-mismatch', 'cannot fire — extractEndpoints/extractAPICalls never populate responseSchema/expectedResponseType/deprecated, the fields this rule reads'],
  ['missing-endpoint', 'cannot fire — gated: extractMethodFrom*/extractPathFromGo derive method and URL from function names (name proxy), so any finding is fabricated'],
  ['api-extra-field', 'cannot fire — no emission site: the analyzer has no code that produces this rule'],
  ['api-missing-field', 'cannot fire — no emission site: the analyzer has no code that produces this rule'],
  ['method-mismatch', 'cannot fire — gated: extractMethodFrom* derives the verb from function names (name proxy), so any finding is fabricated'],
  ['auth-mismatch', 'cannot fire — extractEndpoints never sets `authentication`, the field this rule reads'],

  // schema — file errors are routed to state.errors, never a file-error violation.
  ['file-error', 'cannot fire — schema file errors are routed to state.errors, never emitted as a `file-error` violation'],

  // schema-validator — legacy alias or reads constraints/version the extractor never assigns.
  ['field-mismatch', 'cannot fire — legacy alias: the validator emits `schema-field-mismatch`, never `field-mismatch`'],
  ['constraint-mismatch', 'cannot fire — extractSchemas never assigns `constraints` on fields, the input this rule reads'],
  ['version-mismatch', 'cannot fire — extractSchemas never assigns `version` on schemas, the input this rule reads'],
]);

/**
 * Spec 39/42 R3 — `missing-org-filter` is applicable when the project declares a
 * tenant-scoping column in one of three places: configured tenant tables by name,
 * a configured schema table, or the DDL-derived table catalog.
 */
function evaluateMissingOrgFilterApplicability(
  dataAccessConfig: Record<string, unknown> | undefined,
  ddlColumns: string[] | undefined,
): RuleApplicability {
  // Tier 1 — user declared tenant-scoped tables by name (policy of record).
  const orgFilterTables: string[] = (dataAccessConfig?.orgFilterTables as string[] | undefined) ?? [];
  if (orgFilterTables.length > 0) return { applicable: true };

  const orgFilterColumns: string[] =
    (dataAccessConfig?.orgFilterColumns as string[] | undefined) ?? DEFAULT_ORG_FILTER_COLUMNS;
  const schemas: Array<{ tables?: Array<{ columns?: Array<{ name: unknown }> }> }> =
    (dataAccessConfig?.schemas as any) ?? [];

  const tenantColumns = new Set(orgFilterColumns.map((c) => String(c).toLowerCase()));

  // Tier 2 — a configured schema declares a table carrying a tenant-scoping column.
  for (const schema of schemas) {
    for (const table of schema.tables ?? []) {
      for (const column of table.columns ?? []) {
        if (tenantColumns.has(String(column.name).toLowerCase())) {
          return { applicable: true };
        }
      }
    }
  }

  // Tier 3 — the table catalog (DDL-derived columns) carries a tenant-scoping column.
  if (ddlColumns?.some((c) => tenantColumns.has(String(c).toLowerCase()))) {
    return { applicable: true };
  }

  return {
    applicable: false,
    reason: 'no tenant-scoping column found in table catalog',
  };
}
