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

/**
 * The historical predicate-detection column names — both the JS camelCase and
 * the SQL snake_case spelling for each concept. Kept as the no-config fallback
 * for {@link orgPredicateVocabulary}; the configured `orgFilterColumns` (the
 * discovery vocabulary) takes precedence when declared.
 */
export const DEFAULT_ORG_PREDICATE_PATTERNS = [
  'organizationId',
  'organization_id',
  'orgId',
  'org_id',
  'tenantId',
  'tenant_id',
  'companyId',
  'company_id',
];

/** `workspace_id` → `workspaceId`; a name with no underscore is unchanged. */
function toCamelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((s) => s.length > 0))];
}

/**
 * The tenant-column names the org-filter *predicate* detector treats as
 * evidence, lowercased. This is the SAME vocabulary table discovery uses
 * (`orgFilterColumns`) — one vocabulary, two consumers — so a column the
 * discovery tier names as tenant is also a recognized predicate, and a
 * correctly-scoped query on it never fires `missing-org-filter`.
 *
 * Each snake_case name is expanded to its camelCase spelling too, so the ORM
 * member-access form (`eq(workspaces.workspaceId, …)`) matches as well as the
 * SQL spelling (`WHERE workspace_id = …`).
 *
 * When `orgFilterColumns` is declared, that declaration IS the vocabulary. When
 * it is absent (no config), fall back to the historical predicate default
 * (8 names) ∪ the discovery default (4 names) — so a default-discovered
 * `workspace_id` is also a recognized predicate, not a false positive.
 */
export function orgPredicateVocabulary(
  orgFilterColumns?: readonly unknown[],
  organizationPatterns?: readonly unknown[],
): string[] {
  const declared = orgFilterColumns ?? [];
  if (declared.length) {
    return dedupe(declared.flatMap((c) => {
      const lower = String(c).toLowerCase();
      return [lower, toCamelCase(lower)];
    }));
  }
  const patterns = (organizationPatterns ?? []).length
    ? organizationPatterns!
    : DEFAULT_ORG_PREDICATE_PATTERNS;
  return dedupe([
    ...patterns.map((p) => String(p).toLowerCase()),
    ...DEFAULT_ORG_FILTER_COLUMNS.flatMap((c) => [c, toCamelCase(c)]),
  ]);
}

/** The tenant-column vocabulary the org-filter *predicate* detector reads:
 *  `orgFilterColumns` (the discovery vocabulary) and the legacy
 *  `organizationPatterns` fallback. Structural subset of the analyzer's
 *  `DataAccessAnalyzerConfig`, so that config is assignable to this without
 *  a cast. */
export interface OrgPredicateConfig {
  orgFilterColumns?: readonly string[];
  organizationPatterns?: readonly string[];
}

/**
 * True when the `eq(…)`/helper call starting at `eqIndex` is the *condition* of
 * a join verb — `innerJoin(organizations, eq(a.org_id, b.org_id))` — rather
 * than a predicate under `.where(...)`. A join's second argument is another
 * *column* (`b.org_id`), scoping how rows match, not which rows come back, so it
 * is not tenant isolation. The `eq(…)` under `.where(...)` whose second argument
 * is a dotted *value* (`session.orgId`) is a filter and must NOT be excluded.
 *
 * The check is structural, not semantic: a helper call is a join condition iff
 * the text immediately before it — at the same nesting depth — is a join verb's
 * argument list (`joinVerb(<first-arg>, `). This is the one signal that survives
 * both a bare table first arg (`innerJoin(organizations, …)`) and a dotted one
 * (`innerJoin(schema.organizations, …)`), without resolving object types.
 */
function isJoinCondition(text: string, eqIndex: number): boolean {
  const before = text.slice(0, eqIndex);
  return /\b(?:innerJoin|leftJoin|rightJoin|fullJoin|crossJoin|join)\s*\(\s*[^(),]*\s*,\s*$/.test(
    before,
  );
}

/**
 * The tenant-scoping *predicate* detector — does this query text apply an
 * org/tenant filter? The predicate vocabulary is the SAME vocabulary discovery
 * uses (`orgFilterColumns`, via {@link orgPredicateVocabulary}), so a project
 * whose tenant column is `workspace_id`/`team_id`/… is recognized here as well
 * as by table discovery, and a correctly-scoped query on it never fires
 * `missing-org-filter`.
 *
 * The analyzer computes this during extraction; the migrated `missing-org-filter`
 * rule recomputes it at analysis time from the query text + its resolved
 * thresholds, so the predicate and the tier set can never read two different
 * vocabularies (§69 Fix 1 — one vocabulary, two consumers).
 *
 * @param text The query statement text (comments stripped, query-scoped).
 * @param config The org-filter predicate config (may be undefined).
 * @returns True when the query carries an org/tenant-scoping predicate.
 */
export function hasOrganizationFilter(
  text: string,
  config?: OrgPredicateConfig,
): boolean {
  const candidates = orgPredicateVocabulary(config?.orgFilterColumns, config?.organizationPatterns);

  // An org-scoping column is a *filter* only when it is used as a predicate
  // operand — the left-hand side of a comparison/IN/IS/LIKE (`org_id = ?`,
  // `tenant_id IN (...)`), the key side of a filter object (`where({ org_id })`),
  // or the column argument of a positional where (`where('org_id', x)`).
  // A column that merely appears in the SELECT list (`SELECT org_id FROM …`) or
  // an INSERT column list is NOT a filter. This replaces the old substring
  // proxy that treated any occurrence of the column name — a SELECT column, a
  // comment, a property name — as evidence of tenant isolation.
  // The candidates are joined with `|`; wrap them in `(?:…)` so the word
  // boundaries and the operator/key suffix below bind to EVERY alternative, not
  // just the first (`\borganizationid`) and last (`company_id\b…`) of them. The
  // un-grouped form let `\borganizationid` match a bare column name with no
  // operator — which is exactly how a `.select({ organizationId: col })`
  // projection was misread as a filter (Spec 68 Thing 2 `sample_ownership`).
  const alt = `(?:${candidates.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;

  // SQL comparison operand (`org_id = ?`, `tenant_id IN (...)`).
  const comparisonRe = new RegExp(
    `\\b${alt}\\b\\s*(?:=|!=|<>|<=|>=|<|>|\\bIS\\b|\\bIN\\b|\\bLIKE\\b)`,
    'i',
  );
  if (comparisonRe.test(text)) return true;

  // ORM comparison-helper form: the org column as the FIRST argument of a
  // predicate helper — `eq(org_id, v)`, `inArray(org_id, vs)`, `lt(org_id, v)`.
  // The old bare-column match caught these by accident; the operator/object/
  // positional regexes do not (they expect `org_id =` / `{ org_id: }` /
  // `where('org_id')`). A helper's first arg is the column and its second arg
  // is the value. Distinguish that from a JOIN-on-org — `innerJoin(x, eq(a.org_id,
  // b.org_id))` — whose second arg is *another column* (`b.org_id`), not a value:
  // a join scopes how rows match, not which rows come back, so it is not tenant
  // isolation. The old blanket negative lookahead rejected ANY dotted second arg,
  // which also rejected a dotted *value* — `eq(workspaces.workspaceId,
  // session.workspaceId)` is a correctly-scoped predicate, not a join, but its
  // `session.workspaceId` looked like a column to that lookahead. So the join
  // exclusion is now scoped to the shape itself: an `eq(col, dotted)` is only a
  // join when it is the argument of a join verb (`innerJoin(x, eq(a.org_id,
  // b.org_id))`); the same shape under `.where(...)` is a predicate.
  const helperRe = new RegExp(
    `\\b(?:eq|ne|notEq|gt|gte|lt|lte|inArray|notInArray|like|ilike|notIlike|between|notBetween)\\s*\\(\\s*(?:[\\w$]+\\.)*\\s*\\b${alt}\\b\\s*,`,
    'gi',
  );
  for (const m of text.matchAll(helperRe)) {
    if (!isJoinCondition(text, m.index ?? 0)) return true;
  }

  // Object-literal filter: the column as a value key inside a predicate/set
  // object (`.where({ org_id: v })`, `.values({ org_id: v })`, Prisma
  // `where: { org_id: v }`). The colon is a filter signal ONLY inside a
  // scoping verb; a `.select({ org_id: col })` projection is a SELECT alias,
  // not a predicate, so a bare `org_id:` must not match (Spec 68 Thing 2
  // `sample_ownership`). This is strictly narrower than the old bare-`:`
  // match: it can only stop firing on projections, never start on new text.
  const objectFilterRe = new RegExp(
    `\\b(?:where|andWhere|orWhere|whereEq|whereNot|having|on|set|values|data)\\s*(?:\\(|:)\\s*\\{[^{}]*\\b${alt}\\b\\s*:`,
    'i',
  );
  if (objectFilterRe.test(text)) return true;

  // Positional ORM where: `.where('org_id', x)` / `.andWhere("org_id", x)`.
  const positionalRe = new RegExp(
    `\\b(?:where|andWhere|orWhere|whereEq|whereNot|having|on)\\s*\\(\\s*['"\`]\\s*${alt}\\s*['"\`]`,
    'i',
  );
  return positionalRe.test(text);
}

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
  /** The tenant-scoping column names this config treats as evidence — each
   *  snake_case spelling plus its lowercased camelCase form (so a quoted
   *  camelCase DDL column like `"organizationId"` is still recognized). */
  tenantColumns: string[];
}

/**
 * Build the full tenant-scoping tier set from config + DDL-discovered
 * per-table columns. `ddlTableColumns` is the corpus-wide `Record<table,
 * string[]>` folded by the schema reducer; it is undefined when the schema
 * analyzer was not part of the run (Tier 3 is then empty — the rule can still
 * fire on Tiers 1–2, which come from config alone).
 * @param config The org-filter config (may be undefined).
 * @param ddlTableColumns Corpus-wide DDL-declared per-table columns.
 * @returns The resolved tenant-scoping tier set.
 */
export function buildOrgFilterTierSet(
  config: OrgFilterConfig | undefined,
  ddlTableColumns: Record<string, string[]> | undefined,
): OrgFilterTierSet {
  // The tier-discovery vocabulary carries BOTH the snake_case spelling and its
  // lowercased camelCase form. A quoted camelCase DDL identifier
  // (`"organizationId"`) lowercases to `organizationid` — one token, not
  // `organization_id` — and would otherwise be invisible to Tier 3, while the
  // predicate vocabulary (`orgPredicateVocabulary`) already recognizes the
  // camelCase spelling. This is the same "two vocabularies for one concept"
  // asymmetry §69 Fix 1 closed; expanding the tier set here closes the
  // discovery half (§69 Fix 3).
  const tenantColumns = dedupe(
    (config?.orgFilterColumns ?? DEFAULT_ORG_FILTER_COLUMNS).flatMap((c) => {
      const lower = String(c).toLowerCase();
      return [lower, toCamelCase(lower).toLowerCase()];
    }),
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
 * @param tables The query's referenced table names.
 * @param tierSet The resolved tenant-scoping tier set.
 * @returns True when any referenced table requires an org/tenant filter.
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
 * @param tierSet The resolved tenant-scoping tier set.
 * @returns True when any tier declares tenancy.
 */
export function hasDeclaredTenancy(tierSet: OrgFilterTierSet): boolean {
  return (
    tierSet.orgFilterTables.size > 0 ||
    tierSet.schemaOrgTables.size > 0 ||
    tierSet.ddlOrgTables.size > 0
  );
}
