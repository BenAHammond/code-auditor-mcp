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
 *
 * The one exception is {@link orgFilterTiers}: a pure, dependency-free module
 * that is the single source of truth for tenant-scoping tiers. Both this
 * applicability predicate and the Stage-4 missing-org-filter reducer derive
 * from it, so firing and applicability can never read different tier sets.
 */

import {
  buildOrgFilterTierSet,
  hasDeclaredTenancy,
  type OrgFilterConfig,
} from './orgFilterTiers.js';

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
  'stale-table-reference',
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
 * @param ddlTableColumns Aggregated DDL-declared per-table columns from the
 *   schema reducer (`Record<table, columns>`), folded corpus-wide.
 * @returns The rule's applicability verdict, or null when the rule declares no
 * applicability predicate and runs unconditionally.
 */
export function evaluateRuleApplicability(
  ruleId: string,
  dataAccessConfig: Record<string, unknown> | undefined,
  ddlTableColumns: Record<string, string[]> | undefined,
): RuleApplicability | null {
  if (ruleId === 'missing-org-filter') {
    return evaluateMissingOrgFilterApplicability(dataAccessConfig, ddlTableColumns);
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
 *
 * As of 4.1.0 this map is empty: the ten `cannot-fire` rules (the six
 * api-contract rules, `file-error`, and the three schema-validator aliases)
 * were removed outright — registry entry, emission site, and ledger row — rather
 * than kept as standing findings. The `cannot-fire` verdict remains part of the
 * applicability vocabulary for when a future rule is genuinely unreachable, but
 * no such rule currently exists.
 *
 * This map is NOT the only producer of the `cannot-fire` state: the static-config
 * extractors (`lintConfigReader.ts`, `tailwindConfigLoader.ts`, and the
 * styles-source visitor in `pipelineAdapters.ts`) emit a `CoverageDiagnostic`
 * with `kind: 'cannot-fire'` when a project config cannot be read statically
 * (Spec 61 R3.4). That diagnostic route is independent of this map, so emptying
 * this map does not dead the `cannot-fire` state — the diagnostic route remains
 * live (and is exercised by `spec61-exploits.spec.ts` fixture 8). The
 * unresolvable dynamic-import path emits the sibling `unresolved-dynamic-import`
 * kind, not `cannot-fire`.
 */
export const CANNOT_FIRE_RULES: ReadonlyMap<string, string> = new Map([]);

/**
 * Spec 64 R1 — a rule whose detector is language-shaped reports `cannot-fire`
 * when the corpus holds function rows in a language it cannot classify.
 *
 * The verdict is `cannot-fire` ONLY when *no* in-scope function is in a handled
 * language — i.e. the detector could not fire anywhere. A mixed corpus (handled
 * + unhandled rows) leaves the rule applicable: it evaluates the handled rows
 * normally, and the unhandled rows are reported per-file by the analyzer's
 * `cannot-fire` coverage diagnostics, not by suppressing the rule's findings on
 * the handled majority. Gating the whole rule on a single stray `.go` file would
 * trade a false clean for a false cannot-fire — dropping real TypeScript findings
 * — which is the same over-reach "clean must mean could have fired" exists to
 * prevent, from the other side.
 *
 * @param handledLanguages The rule's declared `handledLanguages` (registry). A
 *   rule with no declaration runs language-agnostically and returns null.
 * @param corpusLanguages The distinct `functions.language` values present this
 *   run (null/undefined means "no function rows, nothing to gate on").
 */
export function evaluateHandledLanguagesApplicability(
  handledLanguages: readonly string[] | undefined,
  corpusLanguages: ReadonlySet<string> | undefined,
): RuleApplicability | null {
  if (!handledLanguages || handledLanguages.length === 0) return null;
  if (!corpusLanguages || corpusLanguages.size === 0) return null;

  // Applicable whenever at least one in-scope function is classifiable — the
  // unhandled rows are the per-file diagnostics' job, not a reason to silence the
  // handled majority.
  const hasHandled = [...corpusLanguages].some((lang) => handledLanguages.includes(lang));
  if (hasHandled) return null;

  const unhandled = [...corpusLanguages].sort();
  return {
    applicable: false,
    kind: 'cannot-fire',
    reason: `handles ${handledLanguages.join('/')} functions only; found function rows only in unhandled language(s): ${unhandled.join(', ')}`,
  };
}

/**
 * Spec 39/42 R3 + Spec 62 Amendment B — `missing-org-filter` is applicable when
 * the project declares tenancy in any tier. Applicability and firing read the
 * SAME tier set, built once by {@link buildOrgFilterTierSet}:
 *
 *   Tier 1 (config-primary) — `orgFilterTables`, the explicit tenant-table list.
 *   Tier 2 (schema-inference) — a configured schema table carrying a
 *     tenant-scoping column (org_id/tenant_id/organization_id/workspace_id).
 *   Tier 3 (DDL-discovery) — a table whose DDL columns carry a tenant-scoping
 *     column. This tier was the Amendment B defect: applicability read it (3
 *     tiers) while the firing predicate read only Tiers 1–2, so a DDL-declared
 *     multi-tenant codebase un-suppressed the rule without ever making it fire —
 *     reporting `clean` on a real leak. Both consumers now derive from one
 *     function, so they cannot drift.
 */
function evaluateMissingOrgFilterApplicability(
  dataAccessConfig: Record<string, unknown> | undefined,
  ddlTableColumns: Record<string, string[]> | undefined,
): RuleApplicability {
  const tierSet = buildOrgFilterTierSet(dataAccessConfig as OrgFilterConfig | undefined, ddlTableColumns);
  if (hasDeclaredTenancy(tierSet)) return { applicable: true };

  return {
    applicable: false,
    reason: 'no tenant-scoping column found in table catalog',
  };
}
