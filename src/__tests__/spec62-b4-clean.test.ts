/**
 * Spec 62 Amendment B — B4: `clean` must mean "could have fired".
 *
 * The Amendment B defect surfaced as a *false `clean`*: `missing-org-filter`'s
 * applicability predicate read three tenant-scoping tiers (config tables,
 * configured-schema columns, DDL columns) while its firing predicate read only
 * the first two. On hhra-org — a real multi-tenant codebase whose tenancy is
 * declared only in DDL (`organization_id` on 17 tables) — the rule was
 * un-suppressed (applicability true) yet could never fire (its firing domain
 * was empty), so it reported `clean` with zero findings. That `clean` claimed
 * "every tenant query is filtered" when the rule had never actually looked.
 *
 * B1 moved the firing predicate to a Stage-4 reducer and B2 made firing and
 * applicability derive from ONE tier function (`buildOrgFilterTierSet`), so the
 * two can no longer drift. B4 is the *coverage-boundary* guarantee over that
 * fix: the reporting pipeline may only label a rule `clean` when its firing
 * predicate was actually reachable with the facts this run produced. A rule
 * whose firing domain is empty — it could not have fired no matter what its
 * input contained — must report a non-clean state (`notApplicable` or
 * `cannot-fire`) with a reason, never `clean`.
 *
 * These tests exercise {@link buildCoverageReport} (the coverage boundary) and
 * assert the invariant directly, including a replay of the exact hhra-org
 * input that fooled the old two-tier predicate.
 */

import { describe, it, expect } from 'vitest';
import { buildCoverageReport, makeReducerStatus } from '../pipeline.js';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';
import {
  evaluateRuleApplicability,
  CANNOT_FIRE_RULES,
  type RuleApplicability,
} from '../analyzers/applicability.js';
import {
  buildOrgFilterTierSet,
  hasDeclaredTenancy,
  tableRequiresOrgFilter,
} from '../analyzers/orgFilterTiers.js';
import type { AnalyzerResult } from '../types.js';

/**
 * The hhra-org shape: tenancy declared *only* in DDL (Tier 3). No config
 * `orgFilterTables`, no configured schema — just a table whose DDL columns
 * carry `organization_id`. This is the input whose firing domain the old
 * two-tier predicate failed to see.
 */
const DDL_ONLY_TENANCY: Record<string, string[]> = {
  accounts: ['id', 'organization_id', 'name'],
};

/** Build the pipeline's rule-applicability map the same way pipeline.ts does —
 *  one `evaluateRuleApplicability` call per registry rule, folded corpus-wide. */
function applicabilityFor(
  dataAccessConfig: Record<string, unknown> | undefined,
  ddlTableColumns: Record<string, string[]> | undefined,
): Map<string, RuleApplicability> {
  const map = new Map<string, RuleApplicability>();
  for (const ruleId of Object.keys(RULE_REGISTRY)) {
    const app = evaluateRuleApplicability(ruleId, dataAccessConfig, ddlTableColumns);
    if (app) map.set(ruleId, app);
  }
  return map;
}

/** Coverage over the `data-access-org-filter` reducer alone, with the
 *  `data-access` fact-key present (the Stage-4 reducer consumed query facts).
 *  Mirrors the post-B1 pipeline shape where `missing-org-filter` is the sole
 *  registry rule under the `data-access-org-filter` analyzer. */
function orgFilterCoverage(
  ddlTableColumns: Record<string, string[]> | undefined,
  factKeys: string[],
): ReturnType<typeof buildCoverageReport> {
  const results: Record<string, AnalyzerResult> = {
    'data-access-org-filter': {
      violations: [],
      executionTime: 0,
      analyzerName: 'data-access-org-filter',
      status: makeReducerStatus(5), // consumed query facts → not "zero facts consumed"
    },
  };
  return buildCoverageReport(
    results,
    { projectRoot: '/test', config: { 'data-access': {}, 'data-access-org-filter': {} } },
    { factKeys, indexTables: [] },
    applicabilityFor(undefined, ddlTableColumns),
  );
}

describe('Spec 62 B4 — clean means "could have fired"', () => {
  it('never reports clean when the firing predicate is unreachable (no tenancy)', () => {
    // No tenancy in any tier → hasDeclaredTenancy false → the firing domain is
    // empty → tableRequiresOrgFilter can never be satisfied → the rule could
    // not have fired. It must report notApplicable with a reason, never clean.
    const tierSet = buildOrgFilterTierSet(undefined, undefined);
    expect(hasDeclaredTenancy(tierSet)).toBe(false);

    const row = orgFilterCoverage(undefined, ['data-access'])
      .find((c) => c.ruleId === 'missing-org-filter');

    expect(row).toBeDefined();
    expect(row!.state).toBe('notApplicable');
    expect(row!.reason).toContain('tenant-scoping');
  });

  it('reports clean only when the firing predicate is reachable (DDL tier present)', () => {
    // The hhra-org input: tenancy declared only in DDL. Both applicability AND
    // firing must now see it through the single tier function — so the rule
    // *could* have fired (a query on `accounts` would), and a zero-violation
    // result is an honest `clean`, not a false one.
    const tierSet = buildOrgFilterTierSet(undefined, DDL_ONLY_TENANCY);
    expect(hasDeclaredTenancy(tierSet)).toBe(true);
    expect(tableRequiresOrgFilter(['accounts'], tierSet)).toBe(true);

    const row = orgFilterCoverage(DDL_ONLY_TENANCY, ['data-access'])
      .find((c) => c.ruleId === 'missing-org-filter');

    expect(row).toBeDefined();
    expect(row!.state).toBe('clean');
  });

  it('ties the clean state to firing reachability across a tier matrix', () => {
    // Property: `clean` ⟺ "firing could have fired" ⟺ hasDeclaredTenancy. Walk
    // the same config×DDL matrix the B2 conformance test uses, but assert it at
    // the *coverage boundary* rather than at the predicate level — the thing the
    // defect broke was the boundary mislabeling an unreachable rule as clean.
    const configs: Array<Record<string, unknown> | undefined> = [
      undefined,
      { orgFilterTables: ['accounts'] },
      { schemas: [{ name: 's', tables: [{ name: 'widgets', columns: [{ name: 'tenant_id', type: 'text' }] }] }] },
    ];
    const ddls: Array<Record<string, string[]> | undefined> = [
      undefined,
      {},
      { accounts: ['id', 'organization_id'] },
      { tags: ['id', 'name'] },
    ];

    for (const config of configs) {
      for (const ddl of ddls) {
        const tierSet = buildOrgFilterTierSet(config, ddl);
        const reachable = hasDeclaredTenancy(tierSet);

        const coverage = buildCoverageReport(
          {
            'data-access-org-filter': {
              violations: [],
              executionTime: 0,
              analyzerName: 'data-access-org-filter',
              status: makeReducerStatus(5),
            },
          },
          { projectRoot: '/test', config: { 'data-access': {}, 'data-access-org-filter': {} } },
          { factKeys: ['data-access'], indexTables: [] },
          applicabilityFor(config, ddl),
        );
        const row = coverage.find((c) => c.ruleId === 'missing-org-filter');
        const label = `config=${JSON.stringify(config)} ddl=${JSON.stringify(ddl)}`;

        if (reachable) {
          expect(row!.state, `reachable firing must permit clean: ${label}`).toBe('clean');
        } else {
          expect(row!.state, `unreachable firing must not be clean: ${label}`).toBe('notApplicable');
        }
      }
    }
  });

  it('the coverage boundary never labels a cannot-fire rule clean (enumerated)', () => {
    // Spec 44 bucket 2 rules are structurally unreachable on every corpus. Their
    // verdict is corpus-independent `cannot-fire`; the boundary must report that,
    // never the per-corpus `clean`. Enumerate the registry (not a hand list) and
    // fold every cannot-fire rule into a full applicability map.
    const results: Record<string, AnalyzerResult> = {};
    const config: Record<string, Record<string, unknown>> = {};
    for (const entry of Object.values(RULE_REGISTRY)) {
      config[entry.analyzer] ??= {};
      results[entry.analyzer] ??= {
        violations: [],
        executionTime: 0,
        analyzerName: entry.analyzer,
        status: makeReducerStatus(1),
      };
    }

    const applicability = applicabilityFor(undefined, undefined);
    const coverage = buildCoverageReport(results, { projectRoot: '/test', config }, undefined, applicability);

    const cleanRules = new Set(coverage.filter((c) => c.state === 'clean').map((c) => c.ruleId));
    for (const ruleId of CANNOT_FIRE_RULES.keys()) {
      expect(cleanRules.has(ruleId), `cannot-fire rule "${ruleId}" must not be clean`).toBe(false);
    }
  });
});
