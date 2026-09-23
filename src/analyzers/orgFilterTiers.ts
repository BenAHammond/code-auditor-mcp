/**
 * Tenant-scoping tier resolution (Spec 62 Amendment B).
 *
 * The single source of truth for "does a table require an org/tenant filter?"
 * and "is the missing-org-filter rule applicable to this corpus?". Both the
 * firing predicate (the Stage-4 missing-org-filter reducer) and the
 * applicability predicate (pipeline.ts → applicability.ts) are derived from
 * this one function, so the two can never drift to different tier sets.
 *
 * Three tiers, all read through {@link buildOrgFilterTierSet}:
 *
 *   Tier 1 (config-primary) — `orgFilterTables`: the user's explicit list of
 *     multi-tenant tables. Tenancy is policy; this is the declaration of record.
 *
 *   Tier 2 (schema-inference) — a configured `schemas` table that carries a
 *     column matching `orgFilterColumns` (default org_id/tenant_id/
 *     organization_id/workspace_id). Makes non-English table names detectable
 *     with zero explicit declaration.
 *
 *   Tier 3 (DDL-discovery) — a table whose columns, extracted from SQL DDL
 *     (CREATE TABLE / ALTER TABLE … ADD COLUMN), carry a tenant-scoping column.
 *     This is the tier that was missing from the old firing predicate, which is
 *     what made `missing-org-filter` report a DDL-declared multi-tenant codebase
 *     `clean` (applicability un-suppressed the rule via Tier 3, but firing only
 *     read Tiers 1–2, so nothing fired).
 *
 * The firing predicate and the applicability predicate are NOT separate
 * implementations that "agree by inspection" — they are two consumers of the
 * same {@link OrgFilterTierSet}:
 *
 *   - firing:       `tableRequiresOrgFilter(queryTables, tierSet)`
 *   - applicability: `hasDeclaredTenancy(tierSet)`
 *
 * This module is deliberately free of analyzer and pipeline imports: it is
 * imported statically by applicability.ts (which pipeline.ts imports
 * statically) AND by the Stage-4 reducer in pipelineAdapters.ts (which reaches
 * analyzers only through dynamic import()). Neither import path may pull in
 * pipeline.js or an analyzer class.
 */

/** Default tenant-scoping column names (lowercased by the consumer). */
export const DEFAULT_ORG_FILTER_COLUMNS = [
  'org_id',
  'tenant_id',
  'organization_id',
  'workspace_id',
];

/** The loose config shape the tier resolver reads. Compatible with the
 *  data-access analyzer's `DataAccessAnalyzerConfig` and with the bare
 *  `Record<string, unknown>` the pipeline passes to applicability. */
export interface OrgFilterConfig {
  orgFilterTables?: string[];
  orgFilterColumns?: string[];
  schemas?: Array<{
    name?: string;
    tables?: Array<{
      name?: string;
      columns?: Array<{ name?: unknown; type?: unknown }>;
    }>;
  }>;
}

/** The resolved tenant-scoping picture across all three tiers. */
export interface OrgFilterTierSet {
  /** Tier 1 — explicit tenant table names, lowercased. */
  orgFilterTables: Set<string>;
  /** Tier 2 — configured-schema tables carrying a tenant column, lowercased. */
  schemaOrgTables: Set<string>;
  /** Tier 3 — DDL-discovered tables carrying a tenant column, lowercased. */
  ddlOrgTables: Set<string>;
  /** The tenant-scoping column names this config treats as evidence, lowercased. */
  tenantColumns: string[];
}

/**
 * Build the full tenant-scoping tier set from config + DDL-discovered
 * per-table columns. `ddlTableColumns` is the corpus-wide `Record<table,
 * string[]>` folded by the schema reducer; it is undefined when the schema
 * analyzer was not part of the run (Tier 3 is then empty — the rule can still
 * fire on Tiers 1–2, which come from config alone).
 */
export function buildOrgFilterTierSet(
  config: OrgFilterConfig | undefined,
  ddlTableColumns: Record<string, string[]> | undefined,
): OrgFilterTierSet {
  const tenantColumns = (config?.orgFilterColumns ?? DEFAULT_ORG_FILTER_COLUMNS).map((c) =>
    String(c).toLowerCase(),
  );
  const tenantSet = new Set(tenantColumns);

  const orgFilterTables = new Set(
    (config?.orgFilterTables ?? []).map((t) => String(t).toLowerCase()),
  );

  const schemaOrgTables = new Set<string>();
  for (const schema of config?.schemas ?? []) {
    for (const table of schema.tables ?? []) {
      if (
        (table.columns ?? []).some((c) => tenantSet.has(String(c.name).toLowerCase()))
      ) {
        schemaOrgTables.add(String(table.name).toLowerCase());
      }
    }
  }

  const ddlOrgTables = new Set<string>();
  for (const [table, columns] of Object.entries(ddlTableColumns ?? {})) {
    if ((columns ?? []).some((c) => tenantSet.has(String(c).toLowerCase()))) {
      ddlOrgTables.add(String(table).toLowerCase());
    }
  }

  return { orgFilterTables, schemaOrgTables, ddlOrgTables, tenantColumns };
}

/**
 * Firing predicate — true when any of the query's referenced tables requires an
 * org/tenant filter, across all three tiers.
 */
export function tableRequiresOrgFilter(
  tables: string[],
  tierSet: OrgFilterTierSet,
): boolean {
  return tables.some((t) => {
    const lt = String(t).toLowerCase();
    return (
      tierSet.orgFilterTables.has(lt) ||
      tierSet.schemaOrgTables.has(lt) ||
      tierSet.ddlOrgTables.has(lt)
    );
  });
}

/**
 * Applicability predicate — true when any tier declares tenancy. When false,
 * the rule is `notApplicable` (this corpus has no tenant-scoping input), never
 * `clean` (the strongest claim the tool makes).
 */
export function hasDeclaredTenancy(tierSet: OrgFilterTierSet): boolean {
  return (
    tierSet.orgFilterTables.size > 0 ||
    tierSet.schemaOrgTables.size > 0 ||
    tierSet.ddlOrgTables.size > 0
  );
}
