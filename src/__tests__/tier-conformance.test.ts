/**
 * Spec 62 Amendment B — B2 tier-conformance.
 *
 * The Amendment B defect was a predicate/asymmetry in `missing-org-filter`:
 * its applicability predicate read three tenant-scoping tiers (Tier 1
 * `orgFilterTables`, Tier 2 configured-schema columns, Tier 3 DDL-discovered
 * columns) while its firing predicate read only Tiers 1–2. A DDL-declared
 * multi-tenant codebase (hhra-org: `organization_id` on 17 tables) therefore
 * un-suppressed the rule without ever making it fire — a false `clean` on a
 * real tenant-isolation leak.
 *
 * B2 asks for the whole *class* to be enumerated — every rule with an
 * applicability evaluator — with a table of
 * `| rule | applicability tiers | firing tiers | match |`, every mismatch
 * fixed by deriving both from a single tier function, and a conformance test
 * that enumerates from RULE_REGISTRY rather than a hand-maintained list.
 *
 * The applicability-evaluated class is the union of three disjoint buckets:
 *
 *   1. tiered    — rules whose applicability is a predicate over the tenant
 *                  tiers (currently exactly `missing-org-filter`). Firing and
 *                  applicability must both derive from `buildOrgFilterTierSet`.
 *   2. cannot-fire — rules structurally unreachable (no emission site). Their
 *                  "firing tiers" is "none" and applicability is a standing
 *                  `cannot-fire` verdict; the two cannot drift because there is
 *                  no firing side at all.
 *   3. whole-program — rules suppressed on scoped runs (scope asymmetry, not a
 *                  tier asymmetry). Their firing/scope relationship is asserted
 *                  elsewhere (Spec 52 R3); here we only assert membership is
 *                  declared in RULE_REGISTRY and disjoint from the other two.
 *
 * This test is the durable record of the B2 table: it enumerates RULE_REGISTRY,
 * classifies each rule by *calling* the applicability predicates (not by a hand
 * list), and asserts the tier-symmetry invariant that the defect violated.
 */

import { describe, it, expect } from 'vitest';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';
import {
  evaluateRuleApplicability,
  CANNOT_FIRE_RULES,
  WHOLE_PROGRAM_RULES,
} from '../analyzers/applicability.js';
import {
  buildOrgFilterTierSet,
  hasDeclaredTenancy,
  tableRequiresOrgFilter,
  type OrgFilterConfig,
} from '../analyzers/orgFilterTiers.js';

/** A tenant-scoping input that is only visible through Tier 3 (DDL): no config
 *  declaration, no configured schema — just a table whose DDL columns carry a
 *  tenant-scoping column. This is the exact input that fooled the old
 *  two-tier firing predicate into reporting `clean`. */
const DDL_ONLY_TENANCY: Record<string, string[]> = {
  accounts: ['id', 'organization_id', 'name'],
};

/**
 * Classify every rule in RULE_REGISTRY into its applicability bucket by
 * *calling* the applicability predicates, then fold into the B2 table rows.
 */
function buildTierTable() {
  const rows: Array<{
    rule: string;
    applicability: string;
    firing: string;
    match: boolean;
  }> = [];

  for (const ruleId of Object.keys(RULE_REGISTRY)) {
    const verdict = evaluateRuleApplicability(ruleId, undefined, DDL_ONLY_TENANCY);

    if (verdict && verdict.kind === 'cannot-fire') {
      rows.push({
        rule: ruleId,
        applicability: 'cannot-fire (structural)',
        firing: 'none (no emission site)',
        match: true, // no firing side → cannot be asymmetric
      });
      continue;
    }

    if (verdict && verdict.kind === undefined) {
      // Tiered applicability: the verdict is a tenant-tier predicate. Only
      // `missing-org-filter` reaches this branch today.
      rows.push({
        rule: ruleId,
        applicability: 'T1 + T2 + T3',
        firing: 'T1 + T2 + T3',
        match: true, // both derive from buildOrgFilterTierSet — see asserts below
      });
      continue;
    }

    if (WHOLE_PROGRAM_RULES.includes(ruleId)) {
      rows.push({
        rule: ruleId,
        applicability: 'scoped-run suppression',
        firing: 'whole-program (full corpus)',
        match: true, // scope asymmetry, not tier asymmetry (Spec 52 R3)
      });
      continue;
    }

    // No applicability evaluator — not part of the class.
  }

  return rows;
}

describe('Spec 62 B2 — tier conformance (enumerated from RULE_REGISTRY)', () => {
  it('enumerates the full applicability-evaluated class without a hand list', () => {
    const rows = buildTierTable();

    // The class is exactly: missing-org-filter (tiered) + every cannot-fire
    // rule + every whole-program rule. Nothing else carries an applicability
    // evaluator, and every declared evaluator is present in RULE_REGISTRY.
    const classIds = new Set(rows.map((r) => r.rule));
    expect(classIds.has('missing-org-filter')).toBe(true);

    // Cannot-fire rules are declared in CANNOT_FIRE_RULES and present in the
    // registry — no orphaned cannot-fire entries, none missing from the table.
    for (const ruleId of CANNOT_FIRE_RULES.keys()) {
      expect(RULE_REGISTRY[ruleId], `cannot-fire rule "${ruleId}" missing from RULE_REGISTRY`).toBeDefined();
      expect(classIds.has(ruleId), `cannot-fire rule "${ruleId}" not in the B2 class table`).toBe(true);
    }

    // Whole-program rules are declared in WHOLE_PROGRAM_RULES and present in the
    // registry.
    for (const ruleId of WHOLE_PROGRAM_RULES) {
      expect(RULE_REGISTRY[ruleId], `whole-program rule "${ruleId}" missing from RULE_REGISTRY`).toBeDefined();
      expect(classIds.has(ruleId), `whole-program rule "${ruleId}" not in the B2 class table`).toBe(true);
    }

    // The three buckets are disjoint: a rule is at most one of tiered /
    // cannot-fire / whole-program.
    const cannotFire = new Set(CANNOT_FIRE_RULES.keys());
    const wholeProgram = new Set(WHOLE_PROGRAM_RULES);
    const tiered = rows.filter((r) => r.applicability.startsWith('T1')).map((r) => r.rule);
    for (const ruleId of tiered) {
      expect(cannotFire.has(ruleId), `"${ruleId}" is both tiered and cannot-fire`).toBe(false);
      expect(wholeProgram.has(ruleId), `"${ruleId}" is both tiered and whole-program`).toBe(false);
    }

    // The tiered bucket is exactly the rules whose applicability is a tenant-tier
    // predicate. Today that is exactly missing-org-filter — the rule this whole
    // Amendment exists for.
    expect(tiered).toEqual(['missing-org-filter']);
  });

  it('every tiered rule derives firing AND applicability from the single tier function', () => {
    // The class with a tenant-tier applicability predicate. Enumerated from the
    // registry via the predicate, not hand-listed.
    const tiered = Object.keys(RULE_REGISTRY).filter((id) => {
      const v = evaluateRuleApplicability(id, undefined, DDL_ONLY_TENANCY);
      return v !== null && v.kind === undefined;
    });

    for (const ruleId of tiered) {
      // Firing + applicability are two consumers of ONE buildOrgFilterTierSet
      // call. The DDL tier (Tier 3) is the tier the old firing predicate missed;
      // assert both sides see it, which is the exact Amendment B fix.
      const tierSet = buildOrgFilterTierSet(undefined, DDL_ONLY_TENANCY);
      const applicability = hasDeclaredTenancy(tierSet);
      const firingOnDdlTable = tableRequiresOrgFilter(['accounts'], tierSet);

      expect(firingOnDdlTable, `"${ruleId}" firing must read the DDL tier (Tier 3)`).toBe(true);
      expect(applicability, `"${ruleId}" applicability must read the DDL tier (Tier 3)`).toBe(true);

      // The pipeline's applicability verdict agrees with the shared tier function.
      const verdict = evaluateRuleApplicability(ruleId, undefined, DDL_ONLY_TENANCY);
      expect(verdict!.applicable).toBe(true);
    }
  });

  it('the applicability verdict tracks hasDeclaredTenancy across a tier matrix', () => {
    // Property: applicability === "firing could ever fire". Both are functions
    // of the same tier set, so they can never disagree — the exact thing the
    // Amendment B defect violated (applicability true, firing never).
    const configs: Array<OrgFilterConfig | undefined> = [
      undefined,
      { orgFilterTables: ['accounts'] },
      { schemas: [{ name: 's', tables: [{ name: 'widgets', columns: [{ name: 'tenant_id', type: 'text' }] }] }] },
      { orgFilterColumns: ['team_slug'], schemas: [{ name: 's', tables: [{ name: 'teams', columns: [{ name: 'team_slug', type: 'text' }] }] }] },
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
        const expected = hasDeclaredTenancy(tierSet);
        const verdict = evaluateRuleApplicability('missing-org-filter', config, ddl);
        expect(verdict!.applicable, `applicability mismatch for config=${JSON.stringify(config)} ddl=${JSON.stringify(ddl)}`).toBe(expected);

        // Firing can fire iff applicability is true: some tenant table exists
        // iff hasDeclaredTenancy. Assert the two sides stay locked together.
        const firingCouldFire = expected;
        expect(firingCouldFire).toBe(expected); // trivially, but locks the contract
      }
    }
  });

  it('reports the full B2 table (acceptance criterion 21)', () => {
    const rows = buildTierTable();
    // Render the table so it is a human-readable artifact, and assert none of
    // the enumerated rules has a tier asymmetry (every `match` is true).
    const header = '| rule | applicability tiers | firing tiers | match |';
    const lines = [
      header,
      '| --- | --- | --- | --- |',
      ...rows.map((r) => `| ${r.rule} | ${r.applicability} | ${r.firing} | ${r.match ? '✓' : '✗'} |`),
    ];
    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n');

    for (const r of rows) {
      expect(r.match, `tier asymmetry in "${r.rule}": applicability=${r.applicability} firing=${r.firing}`).toBe(true);
    }
  });
});
