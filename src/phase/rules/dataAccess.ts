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
 *   - `missing-org-filter` — declares `data-access-calls` + `table-catalog`;
 *     lands with the §5 corpus reduction and the §10 config surface.
 *   - `hardcoded-connection` — walks string literals, a different extraction
 *     than resolved queries; not a `data-access-calls` fact.
 *   - `loop-query` — walks loop structure (N+1), not a resolved-call fact.
 *   - The Go arm — `sql-injection-risk` and `unfiltered-query` declare `go`
 *     in the registry; §9 wires the Node pipeline to the Go grammar, so these
 *     rules declare `formats` without `'go'` here and report the honest
 *     `notApplicable` rather than `clean` on a Go corpus until then.
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

/** The shared declaration for the TS data-access rules in this slice. */
type DataAccessNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['data-access-calls'];
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

/** True when a statement mutates or deletes existing rows (DELETE/UPDATE). */
function hasMassWriteVerb(text: string): boolean {
  const upper = text.toUpperCase();
  return /\bDELETE\b/.test(upper) || /\bUPDATE\b/.test(upper)
    || /\bDELETEFROM\b/.test(upper) || /\bUPDATETABLE\b/.test(upper);
}

/** True when a statement is an upsert (keyed by construction — never unfiltered). */
function isUpsertForm(text: string): boolean {
  const upper = text.toUpperCase();
  return /\bINSERT\s+OR\s+(?:IGNORE|REPLACE)\b/.test(upper)
    || /\bREPLACE\s+INTO\b/.test(upper)
    || /\bON\s+CONFLICT\b/.test(upper)
    || /\bON\s+DUPLICATE\s+KEY\b/.test(upper);
}

/** True when a call is an unfiltered write: a mass-write verb with no filter. */
function isUnfilteredWrite(call: ResolvedQuery): boolean {
  return !isUpsertForm(call.queryText)
    && hasMassWriteVerb(call.queryText)
    && !call.hasFilter;
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
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['data-access-calls'] },
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
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['data-access-calls'] },
  severity: 'high',
  message: META['complex-query'].message,
  docs: META['complex-query'].docs,
  thresholds: META['complex-query'].thresholds,
  thresholdRationale: META['complex-query'].thresholdRationale,
  samples: META['complex-query'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
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
      });
    }
    return out;
  },
};

// ── unfiltered-query ────────────────────────────────────────────────────────

const unfilteredQuery: RuleDefinition<DataAccessNeeds> = {
  id: 'unfiltered-query',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['data-access-calls'] },
  severity: 'high',
  message: META['unfiltered-query'].message,
  docs: META['unfiltered-query'].docs,
  thresholds: META['unfiltered-query'].thresholds,
  samples: META['unfiltered-query'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const ordinals = new Map<string, number>();

    for (const call of ctx.facts['data-access-calls']) {
      // Spec 55 R3 — the query-shape rules skip test/spec files. The rule reads
      // `skipTestFiles` as a threshold (default true); §10 disposition: whether
      // this stays a per-rule scope or moves to the directory scope of §13.1.
      const skipTest = ctx.thresholds.skipTestFiles !== false && isTestOrSpecPath(call.file);
      if (skipTest) continue;

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

/** The three TypeScript data-access rules this slice migrates, in registry order. */
export const dataAccessRules: readonly RuleDefinition<DataAccessNeeds>[] = [
  sqlInjectionRisk,
  complexQuery,
  unfilteredQuery,
];
