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
} from '../types.js';
import type { Severity, Resolution } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import {
  buildOrgFilterTierSet,
  tableRequiresOrgFilter,
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

/** True when a statement mutates or deletes existing rows (DELETE/UPDATE) — the
 *  TypeScript `unfiltered-query` mass-write set. INSERT is *not* a mass write:
 *  Spec 55 R5 / Spec 56 R1 made `unfiltered-query` about DELETE/UPDATE with no
 *  row-limiting clause, not about row-adding statements.
 *
 *  Statement-aware: a mass write is a *leading* `DELETE FROM` or `UPDATE … SET`
 *  clause. The bare `\bDELETE\b` / `\bUPDATE\b` word tests this once used misread
 *  the DDL trigger spellings `… AFTER DELETE ON t` / `… AFTER UPDATE ON t` inside
 *  a `CREATE TRIGGER` block as mass writes — the word DELETE/UPDATE sits in the
 *  trigger's event clause, not a statement. `DELETE FROM` (vs `DELETE ON`) and
 *  `UPDATE <table> SET` (vs `UPDATE ON`) name the DML verb, so the DDL case no
 *  longer matches; the camelCase `deleteFrom`/`updateTable` builder verbs are kept
 *  via their own spellings below. */
function hasMassWriteVerb(text: string): boolean {
  const upper = text.toUpperCase();
  return /\bDELETE\s+FROM\b/.test(upper) || /\bUPDATE\s+\S+\s+SET\b/.test(upper)
    || /\bDELETEFROM\b/.test(upper) || /\bUPDATETABLE\b/.test(upper);
}

/** True when the statement adds rows (INSERT / REPLACE INTO). A row-adding
 *  statement carries the tenant column as a *value*, never as a WHERE
 *  predicate, so `missing-org-filter` (which claims "no tenant predicate")
 *  excludes it — the Go subprocess pinned this as `verb != "INSERT"`. */
function isInsertForm(text: string): boolean {
  const upper = text.toUpperCase();
  return /\bINSERT\b/.test(upper)
    || /\bREPLACE\s+INTO\b/.test(upper)
    || /\bINSERTINTO\b/.test(upper);
}

/** True when the call came from a Go file. The Go subprocess classified a write
 *  as INSERT/UPDATE/DELETE, so Go's `unfiltered-query` counts a filterless
 *  INSERT as a write; the TypeScript analyzer (Spec 55 R5 / Spec 56 R1) narrowed
 *  its write set to DELETE/UPDATE. Spec 68 §9 serves both from this one rule and
 *  preserves the Go corpus's pinned count, so the write set is format-aware. */
function isGoCall(call: ResolvedQuery): boolean {
  return call.file.endsWith('.go');
}

/** True when a call is an unfiltered write: a write verb with no filter, where
 *  the write set depends on the source format (Go: INSERT/UPDATE/DELETE;
 *  TypeScript: DELETE/UPDATE). Upsert forms are excluded by `isUpsertForm`. */
function isUnfilteredWrite(call: ResolvedQuery): boolean {
  if (isUpsertForm(call.queryText)) return false;
  const isWrite = isGoCall(call)
    ? hasWriteVerb(call.queryText)
    : hasMassWriteVerb(call.queryText);
  return isWrite && !call.hasFilter;
}

/**
 * True when a call is an unfiltered *read* of a tenant table: a filterless read
 * against a table carrying declared tenancy (config-only — Tiers 1–2; Tier 3
 * DDL discovery belongs to the §5 corpus reduction, not this Stage-2 rule).
 */
function isUnfilteredRead(call: ResolvedQuery, thresholds: ThresholdValues): boolean {
  return !call.hasFilter
    && !hasWriteVerb(call.queryText)
    && requiresOrgFilter(call.tables, thresholds);
}

/** Config-only tenancy: does any referenced table require an org/tenant filter? */
function requiresOrgFilter(tables: string[], thresholds: ThresholdValues): boolean {
  const tierSet = buildOrgFilterTierSet(
    {
      orgFilterTables: asStringArray(thresholds.orgFilterTables),
      orgFilterColumns: asStringArray(thresholds.orgFilterColumns),
      schemas: (thresholds.schemas as OrgFilterConfig['schemas']) ?? [],
    },
    undefined,
  );
  return tableRequiresOrgFilter(tables, tierSet);
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

const unfilteredQuery: RuleDefinition<DataAccessNeeds> = {
  id: 'unfiltered-query',
  analyzer: 'data-access',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['data-access-calls'] },
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
      const isRead = isUnfilteredRead(call, ctx.thresholds);
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
    // firing and applicability cannot drift to different tier sets (Spec 62 B).
    const ddlTableColumns: Record<string, string[]> = {};
    for (const table of ctx.facts['table-catalog'].tables) {
      ddlTableColumns[table.name] = [...table.columns];
    }
    const tierSet = buildOrgFilterTierSet(
      {
        orgFilterTables: asStringArray(ctx.thresholds.orgFilterTables),
        orgFilterColumns: asStringArray(ctx.thresholds.orgFilterColumns),
        schemas: (ctx.thresholds.schemas as OrgFilterConfig['schemas']) ?? [],
      },
      ddlTableColumns,
    );

    for (const call of ctx.facts['data-access-calls']) {
      // The claim is "no organization/tenant *predicate*", not "no filter": a
      // query scoped by primary key still fires (it is scoped by id, not by
      // tenant). `hasOrganizationFilter` is false for the PK-scoped case, so
      // this predicate reproduces the legacy reducer's firing exactly.
      if (call.hasOrganizationFilter) continue;
      // INSERT / REPLACE INTO carry the tenant column as a value, not a WHERE
      // predicate. The Go subprocess pinned `verb != "INSERT"` — a row-adding
      // statement is excluded there, firing as an unfiltered write instead. The
      // legacy TypeScript reducer had no such skip: an INSERT-only tenant table
      // (audit_log in the insert-delete-tables fixture) still fires, because the
      // write omits the tenant predicate on a table that requires it. The
      // format-aware guard reproduces both (Spec 68 §9 / §3.2 parity).
      if (isGoCall(call) && isInsertForm(call.queryText)) continue;
      if (call.tables.length === 0) continue;
      if (!tableRequiresOrgFilter(call.tables, tierSet)) continue;

      const symbol = `${call.enclosingFunction ?? 'top-level'}:${call.method}`;
      out.push({
        ruleId: 'missing-org-filter',
        severity: 'critical',
        message: `Query on ${call.tables.join(', ')} has no organization/tenant predicate`,
        file: call.file,
        line: call.line,
        column: call.column,
        symbol,
        resolution: {
          action: 'add-tenant-predicate',
          summary: `Add the tenant column (organization_id / org_id) to the WHERE predicate on ${call.tables.join(', ')} so this query is scoped to the current organization, not just by primary key.`,
          symbols: call.tables,
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
