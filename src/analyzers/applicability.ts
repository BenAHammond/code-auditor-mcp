/**
 * Derived rule applicability (Spec 39).
 *
 * A rule's applicability is a predicate over its declared inputs, evaluated
 * before the rule runs. A rule whose predicate is false reports `notApplicable`
 * with a reason naming the absent input — not silence, and not zero findings.
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
}

/**
 * Default tenant-scoping column names. The single source of truth is
 * DEFAULT_DATA_ACCESS_CONFIG.orgFilterColumns in UniversalDataAccessAnalyzer.js;
 * this is a local copy because importing that module here would create the cycle
 * described above. Keep in sync with that constant.
 */
const DEFAULT_ORG_FILTER_COLUMNS = ['org_id', 'tenant_id', 'organization_id', 'workspace_id'];

/**
 * A stylesheet source the style indexer could not read (Spec 42 R2). When any
 * exist, styles/undefined-class must not assert a class is undefined because it
 * may be defined in one of these files.
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
 * @param unreadStyleSources Stylesheets the indexer could not read (Spec 42 R2).
 */
export function evaluateRuleApplicability(
  ruleId: string,
  dataAccessConfig: Record<string, unknown> | undefined,
  ddlColumns: string[] | undefined,
  unreadStyleSources?: UnreadStyleSourceInfo[],
): RuleApplicability | null {
  if (ruleId === 'styles/undefined-class') {
    return evaluateUndefinedClassApplicability(unreadStyleSources);
  }
  if (ruleId === 'missing-org-filter') {
    return evaluateMissingOrgFilterApplicability(dataAccessConfig, ddlColumns);
  }
  return null;
}

/**
 * Spec 42 R2 — whole-run scope: if any stylesheet went unread, a class this
 * detector would otherwise flag undefined may in fact be defined there. Report
 * notApplicable naming what was unread rather than assert undefined.
 */
function evaluateUndefinedClassApplicability(
  unreadStyleSources?: UnreadStyleSourceInfo[],
): RuleApplicability | null {
  if (unreadStyleSources && unreadStyleSources.length > 0) {
    // Surface the per-source reason (which encodes the offending extension for
    // the Spec 43 R5 fallthrough, or the unsupported dialect for Spec 42 R2)
    // rather than only the file path, so a "loud" fallthrough stays loud end to
    // end instead of being collapsed back to a bare path list.
    const names = unreadStyleSources
      .map((s) => (s.reason ? `${s.filePath} (${s.reason})` : s.filePath))
      .join(', ');
    return {
      applicable: false,
      reason: `stylesheets were not read: ${names}`,
    };
  }
  return null;
}

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
