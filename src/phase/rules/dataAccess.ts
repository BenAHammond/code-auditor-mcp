/**
 * Spec 68 §3.2 — the data-access rules, migrated to `analyze(ctx)`.
 *
 * The three rules here read the `data-access-calls` fact (a flat array of
 * `ResolvedQuery`, one per DB call) and do pure classification. Every signal
 * they need was pre-computed by the producer where the AST lived —
 * `hasSqlInjectionRisk` / `sqlEscaped` (sql-injection-risk), `tables`
 * (complex-query), `hasFilter` / `queryText` (unfiltered-query) — so `analyze`
 * never touches a tree, an adapter, or source text.
 *
 * The violation logic is re-homed verbatim from `UniversalDataAccessAnalyzer`
 * (`analyzeQuery` + `checkViolations` + the write/read classifiers). It is
 * copied, not imported, because that analyzer is deleted in §15 and the rule
 * must not couple the new pipeline to a class that is about to disappear. The
 * tenant-tier predicate is imported from `orgFilterTiers.ts` — a pure module
 * free of analyzer/pipeline imports that §15 keeps.
 *
 * Not here, by design:
 *   - `hardcoded-connection` — walks string literals, a different extraction
 *     than resolved queries; not a `data-access-calls` fact.
 *   - `loop-query` — walks loop structure (N+1), not a resolved-call fact.
 *   - The Go arm — `sql-injection-risk` / `unfiltered-query` / `complex-query` /
 *     `missing-org-filter` declare `go` (§9): the Node extraction is
 *     adapter-agnostic, so the same four rules evaluate a Go AST via the
 *     tree-sitter Go grammar rather than reporting a dishonest `notApplicable`.
 */

import type {
  RuleDefinition,
  Finding,
  ResolvedQuery,
  ThresholdValues,
  TableCatalog,
} from '../types.js';
import type { Severity, Resolution } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import {
  buildOrgFilterTierSet,
  tableRequiresOrgFilter,
  hasOrganizationFilter,
  type OrgFilterConfig,
} from '../../analyzers/orgFilterTiers.js';
import { isTestOrSpecPath } from '../../languages/testConventions.js';

/** The shared declaration for the data-access rules in this slice. The
 *  Node extraction is adapter-agnostic (`findNodes` + provenance), so the same
 *  four rules evaluate a Go AST (§9): `go` is declared alongside the
 *  TypeScript family rather than reporting a dishonest `notApplicable`. */
type DataAccessNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript', 'go'];
  readonly facts: readonly ['data-access-calls'];
};

/** `missing-org-filter` additionally reads the `table-catalog` corpus fact for
 *  Tier 3 (DDL-discovered) tenancy. */
type MissingOrgFilterNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript', 'go'];
  readonly facts: readonly ['data-access-calls', 'table-catalog'];
};

const META = RULE_REGISTRY;

// ── Write/read classifiers (re-homed from UniversalDataAccessAnalyzer) ──────

/** True when a SQL statement carries a write verb (INSERT/DELETE/UPDATE/REPLACE). */
function hasWriteVerb(text: string): boolean {
  const upper = text.toUpperCase();
  return /\bINSERT\b/.test(upper) || /\bDELETE\b/.test(upper) || /\bUPDATE\b/.test(upper)
    || /\bREPLACE\s+INTO\b/.test(upper)
    || /\bDELETEFROM\b/.test(upper) || /\bUPDATETABLE\b/.test(upper) || /\bINSERTINTO\b/.test(upper);
}

/** True when a statement is an upsert (keyed by construction — never unfiltered). */
function isUpsertForm(text: string): boolean {
  const upper = text.toUpperCase();
  return /\bINSERT\s+OR\s+(?:IGNORE|REPLACE)\b/.test(upper)
    || /\bREPLACE\s+INTO\b/.test(upper)
    || /\bON\s+CONFLICT\b/.test(upper)
    || /\bON\s+DUPLICATE\s+KEY\b/.test(upper);
}

/** True when a statement mass-mutates existing rows without a row-limiting
 *  clause (`UPDATE … SET`) — the TypeScript `unfiltered-query` mass-write set.
 *  `DELETE` is deliberately *not* a mass write here (Spec 68 disposition (a)): a
 *  bare `DELETE FROM t` with no WHERE is whole-table maintenance (the clear-and-
 *  rebuild idiom), not a missing-filter defect. INSERT is not a mass write
 *  (row-adding) either (Spec 55 R5 / Spec 56 R1).
 *
 *  Statement-aware: a mass write is a *leading* `UPDATE <table> SET` clause. The
 *  bare `\bUPDATE\b` word test this once used misread the DDL trigger spelling
 *  `… AFTER UPDATE ON t` inside a `CREATE TRIGGER` block as a mass write — the
 *  word sits in the trigger's event clause, not a statement. `UPDATE <table> SET`
 *  (vs `UPDATE ON`) names the DML verb, so the DDL case no longer matches; the
 *  camelCase `updateTable` builder verb is kept via its own spelling below. */
function hasMassWriteVerb(text: string): boolean {
  const upper = text.toUpperCase();
  return /\bUPDATE\s+\S+\s+SET\b/.test(upper) || /\bUPDATETABLE\b/.test(upper);
}

/** True when the statement is a raw-SQL row-adding statement — `INSERT … INTO`
 *  (optionally `OR IGNORE`/`OR REPLACE`) or `REPLACE … INTO`. Unlike the loose
 *  `\bINSERT\b` word test this replaces, it does *not* match the ORM builder verb
 *  `.insert(table)` (`db.insert(users).values(...)`), whose tenant column rides in
 *  the values object rather than a SQL column list. */
function isRawSqlInsert(text: string): boolean {
  const upper = text.toUpperCase();
  return /\bINSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\b/.test(upper)
    || /\bREPLACE\s+INTO\b/.test(upper);
}

/** The explicit column list of a raw-SQL INSERT/REPLACE, lowercased, or `null`
 *  when the statement has none. A positional `INSERT INTO t VALUES (…)` with no
 *  column list sets every column — tenant included — so the caller treats `null`
 *  as "sets the tenant column" (conservative: no finding). */
function rawInsertColumnList(text: string): string[] | null {
  const m =
    /\bINSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+\S+\s*\(([^)]*)\)/i.exec(text)
    || /\bREPLACE\s+INTO\s+\S+\s*\(([^)]*)\)/i.exec(text);
  if (!m) return null;
  return m[1].split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
}

/** True when a call is an unfiltered write: a mass-write verb (`UPDATE … SET`)
 *  with no row-limiting filter. The write set is UPDATE-only for every format —
 *  a bare `DELETE FROM t` is whole-table maintenance (disposition (a)) and INSERT
 *  is row-adding, so neither is a missing-filter defect, Go or TypeScript (§9
 *  serves both from this one rule). Upsert forms are excluded by `isUpsertForm`. */
function isUnfilteredWrite(call: ResolvedQuery): boolean {
  if (isUpsertForm(call.queryText)) return false;
  return hasMassWriteVerb(call.queryText) && !call.hasFilter;
}

/**
 * True when a call is an unfiltered *read* of a tenant table: a filterless read
 * against a table carrying declared tenancy across all three tiers — config
 * (Tiers 1–2) AND DDL discovery (Tier 3, from the `table-catalog` fact). The
 * read half once read Tiers 1–2 only, so a DDL-only tenant table's filterless
 * read was missed (§69 Fix 4).
 */
function isUnfilteredRead(
  call: ResolvedQuery,
  thresholds: ThresholdValues,
  catalog: TableCatalog,
): boolean {
  return !call.hasFilter
    && !hasWriteVerb(call.queryText)
    && tableRequiresOrgFilter(call.tables, buildTierSet(thresholds, catalog));
}

/**
 * The tenant-scoping tier set from config thresholds + the `table-catalog` fact
 * (Tier 3 DDL discovery). Both `unfiltered-query` (read half) and
 * `missing-org-filter` derive their tier set here, so Tier 3 is never dropped
 * from one and not the other (§69 Fix 4).
 */
function buildTierSet(thresholds: ThresholdValues, catalog: TableCatalog) {
  const ddlTableColumns: Record<string, string[]> = {};
  for (const table of catalog.tables) {
    ddlTableColumns[table.name] = [...table.columns];
  }
  return buildOrgFilterTierSet(
    {
      orgFilterTables: asStringArray(thresholds.orgFilterTables),
      orgFilterColumns: asStringArray(thresholds.orgFilterColumns),
      schemas: (thresholds.schemas as OrgFilterConfig['schemas']) ?? [],
    },
    ddlTableColumns,
  );
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? (v as string[]) : undefined;
}

/** Compute the next stable violation symbol key for a (function, method) pair. */
function nextSymbol(
  fnName: string,
  method: string,
  symbolOrdinals: Map<string, number>,
): string {
  const baseSymbol = `${fnName}:${method}`;
  const ordinal = (symbolOrdinals.get(baseSymbol) ?? 0) + 1;
  symbolOrdinals.set(baseSymbol, ordinal);
  return ordinal > 1 ? `${baseSymbol}:${ordinal}` : baseSymbol;
}

// ── sql-injection-risk ──────────────────────────────────────────────────────

const sqlInjectionRisk: RuleDefinition<DataAccessNeeds> = {
  id: 'sql-injection-risk',
  analyzer: 'data-access',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['data-access-calls'] },
  severity: 'critical',
  message: META['sql-injection-risk'].message,
  docs: META['sql-injection-risk'].docs,
  thresholds: META['sql-injection-risk'].thresholds,
  samples: META['sql-injection-risk'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const ordinals = new Map<string, number>();

    for (const call of ctx.facts['data-access-calls']) {
      if (!call.hasSqlInjectionRisk) continue;
      const symbol = nextSymbol(call.enclosingFunction ?? 'top-level', call.method, ordinals);

      if (call.sqlEscaped) {
        out.push({
          ruleId: 'sql-injection-risk',
          severity: 'high',
          message: `Interpolated SQL in ${call.method} — verify escaping is sufficient. Use parameterized queries.`,
          file: call.file,
          line: call.line,
          column: call.column,
          symbol,
          resolution: {
            action: 'parameterize',
            summary: `The SQL in ${call.method} interpolates a manually quote-escaped value. Quote-doubling defends only the single-quote case (not backslash escapes, unicode quote variants, or numeric/identifier positions) — replace the interpolation with a parameterized query (\`?\`, \`$1\`, or \`:name\`) for a full guarantee.`,
            symbols: [call.method],
            files: [call.file],
            lines: [call.line],
          },
        });
      } else {
        out.push({
          ruleId: 'sql-injection-risk',
          severity: 'critical',
          message: `Potential SQL injection risk in ${call.method}. Use parameterized queries.`,
          file: call.file,
          line: call.line,
          column: call.column,
          symbol,
          resolution: {
            action: 'parameterize',
            summary: `Replace the string-interpolated SQL in ${call.method} with a parameterized query — bind values via the driver's placeholder form (\`?\`, \`$1\`, or \`:name\`) instead of concatenating them into the statement.`,
            symbols: [call.method],
            files: [call.file],
            lines: [call.line],
          },
        });
      }
    }
    return out;
  },
};

// ── complex-query ───────────────────────────────────────────────────────────

const complexQuery: RuleDefinition<DataAccessNeeds> = {
  id: 'complex-query',
  analyzer: 'data-access',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['data-access-calls'] },
  severity: 'high',
  message: META['complex-query'].message,
  docs: META['complex-query'].docs,
  thresholds: META['complex-query'].thresholds,
  thresholdRationale: META['complex-query'].thresholdRationale,
  samples: META['complex-query'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const ordinals = new Map<string, number>();
    const joinedTableCount = num(ctx.thresholds, 'joinedTableCount', 4);

    for (const call of ctx.facts['data-access-calls']) {
      if (call.tables.length <= joinedTableCount) continue;
      out.push({
        ruleId: 'complex-query',
        severity: 'high',
        message: `Query references ${call.tables.length} tables`,
        file: call.file,
        line: call.line,
        column: call.column,
        // §7 — one symbol per finding. Without this, two complex queries in the
        // same file collide on `[rule, file, '']` and dedup/baseline folds them.
        symbol: nextSymbol(call.enclosingFunction ?? 'top-level', call.method, ordinals),
      });
    }
    return out;
  },
};

// ── unfiltered-query ────────────────────────────────────────────────────────

const unfilteredQuery: RuleDefinition<MissingOrgFilterNeeds> = {
  id: 'unfiltered-query',
  analyzer: 'data-access',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['data-access-calls', 'table-catalog'] },
  severity: 'high',
  message: META['unfiltered-query'].message,
  docs: META['unfiltered-query'].docs,
  thresholds: META['unfiltered-query'].thresholds,
  samples: META['unfiltered-query'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const ordinals = new Map<string, number>();
    const joinedTableCount = num(ctx.thresholds, 'joinedTableCount', 4);

    for (const call of ctx.facts['data-access-calls']) {
      // Spec 55 R3 — the query-shape rules skip test/spec files. The rule reads
      // `skipTestFiles` as a threshold (default true); §10 disposition: whether
      // this stays a per-rule scope or moves to the directory scope of §13.1.
      const skipTest = ctx.thresholds.skipTestFiles !== false && isTestOrSpecPath(call.file);
      if (skipTest) continue;

      // Spec 55 R5 — reproduce the old `analyzeQuery` priority: `complex-query`
      // ('high', tables > joinedTableCount) wins over `unfiltered-query`
      // ('medium'). A join-heavy unfiltered write is one finding, not two.
      if (call.tables.length > joinedTableCount) continue;

      const isWrite = isUnfilteredWrite(call);
      const isRead = isUnfilteredRead(call, ctx.thresholds, ctx.facts['table-catalog']);
      if ((!isWrite && !isRead) || call.tables.length === 0) continue;

      const kind = isWrite ? 'write' : 'read';
      const subject = kind === 'read' ? `tenant table ${call.tables.join(', ')}` : call.tables.join(', ');
      const symbol = nextSymbol(call.enclosingFunction ?? 'top-level', call.method, ordinals);

      out.push({
        ruleId: 'unfiltered-query',
        severity: 'high',
        message: `Unfiltered ${kind} on ${subject} has no WHERE/HAVING/LIMIT`,
        file: call.file,
        line: call.line,
        column: call.column,
        symbol,
      });
    }
    return out;
  },
};

/** Read a numeric threshold with a documented fallback (default from
 *  `DEFAULT_DATA_ACCESS_CONFIG.performanceThresholds`). */
function num(t: ThresholdValues, key: string, fallback: number): number {
  const v = t[key];
  return typeof v === 'number' ? v : fallback;
}

/**
 * True when a query's predicate is an equality lookup on one of the table's
 * *natural* UNIQUE columns — the bootstrap-lookup signal. A predicate that
 * binds a natural unique key is a lookup by that key (the row is identified by
 * its key, not by tenant), so tenant scoping is structurally unnecessary. Only
 * the *equality* spellings count: `<`/`IN`/`LIKE` on a unique column admit
 * multiple rows and must still carry a tenant predicate.
 *
 * Two exclusions, both from the Thing 1 correction:
 *
 *   - PRIMARY KEY columns are excluded upstream (a surrogate PK is the IDOR
 *     surface, not a bootstrap lookup).
 *   - The raw-SQL comparison form is scoped to WHERE clauses only: a
 *     `JOIN … ON monitor.id = a.monitor_id` equality scopes how rows match,
 *     not which rows return, so it is never a bootstrap lookup.
 *
 *   - Drizzle member access:  `eq(apiKey.prefix, …)` → `prefix`
 *   - positional Knex form:   `.where('prefix', value)` → `prefix`
 *   - raw SQL comparison:     `WHERE prefix = ?` → `prefix`
 *
 * Matching is case-insensitive against the union of DDL SQL names and Drizzle
 * JS/SQL names (both stored in the catalog), so `eq(apiKey.hashedToken, …)`
 * resolves to `hashed_token` via the JS name while `WHERE hashed_token = ?`
 * resolves via the SQL name. `uniqueColumns` is pre-lowercased by the caller.
 */
function hasUniqueColumnFilter(text: string, uniqueColumns: ReadonlySet<string>): boolean {
  // `eq(ident.col, …)` — the Drizzle equality helper, member-access spelling.
  // `eq(…)` is only a filter helper, never a JOIN condition, so it is safe to
  // match anywhere in the query text.
  const eqMemberRe = /\beq\s*\(\s*[A-Za-z_$][\w$]*\s*\.\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
  for (const m of text.matchAll(eqMemberRe)) {
    if (uniqueColumns.has(m[1].toLowerCase())) return true;
  }
  // `.where('col', value)` — the Knex/positional two-argument equality form. The
  // three-argument `.where('col', '>', value)` form is NOT equality, so the
  // negative lookahead rejects a second quoted operand before the `,`/`)`.
  const wherePosRe = /\.where\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?!['"][^'"]*['"]\s*[,)])/g;
  for (const m of text.matchAll(wherePosRe)) {
    if (uniqueColumns.has(m[1].toLowerCase())) return true;
  }
  // `col = ?` / `col == ?` — a raw-SQL equality predicate, but ONLY within a
  // WHERE clause. A JOIN … ON equality (`monitor.id = a.monitor_id`) scopes how
  // rows match, not which rows return, so it must not count as a bootstrap
  // lookup (Thing 1 correction — the openstatus `monitors.go` three-table join).
  const whereRe = /\bWHERE\b/gi;
  for (const wm of text.matchAll(whereRe)) {
    const afterWhere = text.slice(wm.index + wm[0].length);
    const body = afterWhere.split(/\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION)\b/i)[0];
    const rawEqRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b\s*==?\s*[^=]/g;
    for (const em of body.matchAll(rawEqRe)) {
      if (uniqueColumns.has(em[1].toLowerCase())) return true;
    }
  }
  return false;
}

/** The lowercased UNIQUE / PRIMARY-KEY columns of the named tables, unioned —
 *  the set `hasUniqueColumnFilter` matches a filter-column token against. A
 *  table with no catalog entry (or none declared) contributes nothing. */
function uniqueColumnsForTables(tables: string[], catalog: TableCatalog): ReadonlySet<string> {
  const set = new Set<string>();
  for (const name of tables) {
    const entry = catalog.tables.find((t) => t.name === name);
    if (!entry) continue;
    for (const col of entry.uniqueColumns) set.add(col.toLowerCase());
  }
  return set;
}

// ── missing-org-filter ──────────────────────────────────────────────────────

const missingOrgFilter: RuleDefinition<MissingOrgFilterNeeds> = {
  id: 'missing-org-filter',
  analyzer: 'data-access-org-filter',
  needs: {
    formats: ['typescript', 'tsx', 'javascript', 'go'],
    facts: ['data-access-calls', 'table-catalog'],
  },
  severity: 'critical',
  message: META['missing-org-filter'].message,
  docs: META['missing-org-filter'].docs,
  thresholds: META['missing-org-filter'].thresholds,
  samples: META['missing-org-filter'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];

    // Tier 3 (DDL discovery) comes from the corpus reduction of the schema facts
    // into `table-catalog`; Tiers 1–2 come from the config thresholds. The one
    // `buildOrgFilterTierSet` is shared with the applicability predicate, so
    // firing and applicability cannot drift to different tier sets (Spec 62 B),
    // and with the `unfiltered-query` read half (§69 Fix 4).
    const catalog = ctx.facts['table-catalog'];
    const tierSet = buildTierSet(ctx.thresholds, catalog);

    // The tenant-scoping column names this config treats as evidence (lowercased
    // by `buildOrgFilterTierSet`), matched against a raw-SQL INSERT column list.
    const tenantColumnSet = new Set(tierSet.tenantColumns);

    // The predicate detector runs on the SAME vocabulary as the tier set above
    // (`orgFilterColumns` from the thresholds) — one vocabulary, two consumers.
    // The producer bakes `call.hasOrganizationFilter` with the DEFAULT config
    // (no project config reaches a `process(file)` call), so trusting that field
    // would read a different vocabulary than the tier set and re-introduce the
    // §69 Fix-1 defect. Re-derive it here from `queryText` + the resolved
    // thresholds so predicate detection and table discovery can never drift.
    const predicateConfig = {
      orgFilterColumns: asStringArray(ctx.thresholds.orgFilterColumns),
      organizationPatterns: asStringArray(ctx.thresholds.organizationPatterns),
    };

    for (const call of ctx.facts['data-access-calls']) {
      // Resolve ORM schema-object identifiers to their declared SQL names
      // (`.from(sampleOwnership)` → `sample_ownership`) before the tier lookup,
      // so a query referencing a Drizzle schema object reaches the DDL-declared
      // catalog entry (and its Tier-3 tenancy) the identifier names.
      const tables = call.tables.map((t) => catalog.aliases[t] ?? t);
      if (tables.length === 0) continue;
      if (!tableRequiresOrgFilter(tables, tierSet)) continue;

      const isInsert = isRawSqlInsert(call.queryText);

      // Spec 69 R3 — a `.where(and(...conditions))` predicate hides its elements
      // from `queryText`; read the resolved binding instead. An all-paths tenant
      // predicate quiets the rule (the isolation is unconditional); a some-paths
      // predicate fires, naming the branch where the guard is absent. The
      // predicate detector runs on the same `predicateConfig` vocabulary, so
      // resolution and discovery can never read two vocabularies (§69 Fix 1).
      const resolvedElements = call.resolvedWhere?.elements ?? [];
      const allPathsOrg = resolvedElements.some(
        (e) => e.allPaths && hasOrganizationFilter(e.text, predicateConfig),
      );
      const somePathsOrg = resolvedElements.filter(
        (e) => !e.allPaths && hasOrganizationFilter(e.text, predicateConfig),
      );

      // For a read/mutation the claim is "no organization/tenant *predicate*": a
      // query scoped by primary key still fires (scoped by id, not tenant). For a
      // raw-SQL row-adding statement (INSERT/REPLACE) there is no WHERE predicate
      // at all — the tenant column is a *value* in the column list — so the check
      // is "does the column list set the tenant column?", format-agnostic for Go
      // and TypeScript alike (Spec 68 §9). The ORM builder verb `.insert(t).values(...)`
      // is not raw SQL, so it stays on the predicate path, where
      // `hasOrganizationFilter` already detects `org_id:` value keys.
      if (isInsert) {
        const columns = rawInsertColumnList(call.queryText);
        // `null` = positional INSERT (`INSERT INTO t VALUES (…)`, no column list)
        // — every column is set, tenant included.
        const setsTenant = columns === null
          || columns.some((c) => tenantColumnSet.has(c));
        if (setsTenant) continue;
      } else if (hasOrganizationFilter(call.queryText, predicateConfig)) {
        continue;
      } else if (allPathsOrg) {
        // The tenant predicate is present on every path (array initializer or an
        // unconditional push) — the isolation is unconditional, so no finding.
        continue;
      } else if (hasUniqueColumnFilter(call.queryText, uniqueColumnsForTables(tables, catalog))) {
        // A predicate bound to a UNIQUE / PRIMARY-KEY column returns at most one
        // row — the bootstrap-lookup shape (`eq(apiKey.prefix, …)`). Scoping by
        // tenant is structurally unnecessary here, so the rule stays quiet.
        continue;
      }

      const conditionalBranch = somePathsOrg.length > 0
        ? somePathsOrg.map((e) => e.branch ?? 'a conditional branch').join(' / ')
        : null;

      const symbol = `${call.enclosingFunction ?? 'top-level'}:${call.method}`;
      out.push({
        ruleId: 'missing-org-filter',
        severity: 'critical',
        message: isInsert
          ? `INSERT into ${tables.join(', ')} does not set the organization/tenant column`
          : conditionalBranch
            ? `Query on ${tables.join(', ')} has no organization/tenant predicate when ${conditionalBranch} is absent`
            : `Query on ${tables.join(', ')} has no organization/tenant predicate`,
        file: call.file,
        line: call.line,
        column: call.column,
        symbol,
        resolution: {
          action: isInsert ? 'add-tenant-column' : 'add-tenant-predicate',
          summary: isInsert
            ? `Add the tenant column (organization_id / org_id) to the INSERT column list on ${tables.join(', ')} so the row is scoped to the current organization.`
            : conditionalBranch
              ? `Add the tenant column (organization_id / org_id) to the WHERE predicate unconditionally on ${tables.join(', ')} — it is currently applied only when ${conditionalBranch} is present, so the query runs unscoped otherwise.`
              : `Add the tenant column (organization_id / org_id) to the WHERE predicate on ${tables.join(', ')} so this query is scoped to the current organization, not just by primary key.`,
          symbols: tables,
        },
      });
    }
    return out;
  },
};

/** The TypeScript data-access rules this slice migrates, in registry order. */
export const dataAccessRules: readonly RuleDefinition<DataAccessNeeds | MissingOrgFilterNeeds>[] = [
  sqlInjectionRisk,
  complexQuery,
  unfilteredQuery,
  missingOrgFilter,
];

// ── loop-query ──────────────────────────────────────────────────────────────

/**
 * `loop-query` reads the `loop-queries` fact (a flat array of `LoopQueryFact`,
 * one per loop whose body issues a DB call) — not `data-access-calls`. It is
 * exported in a *separate* array from `dataAccessRules` because the two fact
 * kinds are distinct: the data-access slice context carries `data-access-calls`
 * + `table-catalog`, while this rule's context carries `loop-queries` alone.
 *
 * Detection is the producer's — `collectLoopQueryCandidates` in the analyzer,
 * shared with the legacy `checkLoopQueries` — so `analyze` is a pure projection
 * of the pre-computed anchor/symbol/depth, and parity holds by construction.
 */
type LoopQueryNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['loop-queries'];
};

const loopQuery: RuleDefinition<LoopQueryNeeds> = {
  id: 'loop-query',
  analyzer: 'data-access',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['loop-queries'] },
  severity: 'severe',
  message: META['loop-query'].message,
  docs: META['loop-query'].docs,
  thresholds: META['loop-query'].thresholds,
  samples: META['loop-query'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const q of ctx.facts['loop-queries']) {
      const depthMsg = q.depth > 1 ? ` (nested ${q.depth} levels deep)` : '';
      out.push({
        ruleId: 'loop-query',
        severity: 'severe',
        message: `Database query inside loop${depthMsg} ` +
          `(loop at line ${q.loopLine}). ` +
          `This may cause N+1 performance issues. Consider batching queries or using a join.`,
        file: q.file,
        line: q.line,
        column: q.column,
        symbol: q.symbol,
      });
    }
    return out;
  },
};

/** The loop-query rule this slice migrates (reads `loop-queries`). */
export const loopQueryRules: readonly RuleDefinition<LoopQueryNeeds>[] = [loopQuery];
