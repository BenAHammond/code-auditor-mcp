/**
 * Spec 69 R3 — local binding resolution (#316, criterion 9).
 *
 * A `.where(and(...conditions))` predicate hides its elements from `queryText`:
 * the `data-access-calls` producer extracts the candidate node's own text, which
 * mentions `conditions` but not the `eq(orders.organizationId, …)` elements
 * assembled in prior statements. R3 resolves the local `const`/`let` array
 * binding within the enclosing function and classifies each element all-paths
 * vs some-paths — `missing-org-filter` goes quiet only on an all-paths tenant
 * predicate; a some-paths predicate still fires, naming the branch where the
 * guard is absent.
 *
 * Two fixtures pin criterion 9's acceptance pair:
 *
 *   - `listOrders` — the predicate pushed unconditionally across statements →
 *       all-paths → quiet.
 *   - `listOrdersScoped` — the predicate pushed under `if (organizationId)` →
 *       some-paths → fires, message names `organizationId`.
 *
 * The two remaining motivating fixtures from Fix 6 are out of R3's ceiling and
 * stay asserted as they stand:
 *
 *   - `withOrgScope` wrapper → cross-function, out of the R3 "within a function
 *       body" ceiling — still fires `missing-org-filter` + `unfiltered-query`.
 *   - quote-doubling hoisted into `const safe` → `sql-injection-risk` (a
 *       different rule than the local-binding resolution) — still over-reports.
 *
 * Production-scale versions live in `specs/rule-evidence-corpus`
 * (`tenant-scoping.ts`), whose directives pin the same cases end to end.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { buildDataAccessCalls } from '../phase/runner.js';
import { dataAccessRules } from '../phase/rules/dataAccess.js';
import type {
  ResolvedQuery,
  ThresholdValues,
  ResolutionFact,
  Finding,
} from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** Run the `data-access-calls` producer over a minimal source string. */
function calls(path: string, source: string): Promise<ResolvedQuery[]> {
  return buildDataAccessCalls([{ path, content: source }], 'sqlite');
}

/** Feed produced facts into one data-access rule (the producer → rule glue
 *  `runAudit` performs, in miniature). */
function analyze(
  ruleId: string,
  produced: ResolvedQuery[],
  thresholds: ThresholdValues = {},
  catalog?: ResolutionFact,
): Finding[] {
  const rule = dataAccessRules.find((r) => r.id === ruleId)!;
  const ctx = {
    facts: {
      'data-access-calls': produced,
      'resolution': catalog ?? { tables: [], aliases: {}, classes: [], interfaces: [] },
    },
    formats: ['typescript', 'tsx', 'javascript', 'go'] as const,
    thresholds,
  };
  return [...rule.analyze(ctx)];
}

/** `orders` declared as a tenant table via Tier 1 config, mirroring the corpus's
 *  tenancy tiers (see specs/rule-evidence-corpus/.codeauditor.json). */
const TENANT = { orgFilterTables: ['orders'] };

describe('Spec 69 R3 motivating fixtures — local binding resolution (#316)', async () => {
  describe('conditions array built across statements → missing-org-filter FP', async () => {
    const source = [
      'export function listOrders(session) {',
      '  const conditions = [];',
      "  conditions.push(eq(orders.organizationId, session.orgId));",
      '  return db.select().from(orders).where(and(...conditions));',
      '}',
    ].join('\n');

    it('resolves the pushed predicate into the fact, all-paths', async () => {
      const out = await calls('/fixture/r3-conditions.ts', source);
      expect(out).toHaveLength(1);
      expect(out[0].queryText).toBe('db.select().from(orders).where(and(...conditions))');
      expect(out[0].hasOrganizationFilter).toBe(false);
      expect(out[0].hasFilter).toBe(true);
      // R3: the spread binding resolves to its unconditional push, all-paths.
      expect(out[0].resolvedWhere?.elements).toEqual([
        { text: 'eq(orders.organizationId, session.orgId)', allPaths: true },
      ]);
    });

    it('the rule stays quiet — the predicate is present and unconditional', async () => {
      const out = analyze('missing-org-filter', await calls('/fixture/r3-conditions.ts', source), TENANT);
      expect(out).toEqual([]);
    });
  });

  describe('predicate pushed under an `if` → some-paths stays firing (criterion 9)', async () => {
    const source = [
      'export function listOrdersScoped(userId, organizationId) {',
      "  const conditions = [eq(orders.id, userId), eq(orders.role, 'admin')];",
      '  if (organizationId) {',
      '    conditions.push(eq(orders.organizationId, organizationId));',
      '  }',
      '  return db.select().from(orders).where(and(...conditions));',
      '}',
    ].join('\n');

    it('resolves the pushed predicate as some-paths, branch named', async () => {
      const out = await calls('/fixture/r3-some-paths.ts', source);
      expect(out).toHaveLength(1);
      expect(out[0].resolvedWhere?.elements).toEqual([
        { text: 'eq(orders.id, userId)', allPaths: true },
        { text: "eq(orders.role, 'admin')", allPaths: true },
        {
          text: 'eq(orders.organizationId, organizationId)',
          allPaths: false,
          branch: 'organizationId',
        },
      ]);
    });

    it('still fires critical, message names the absent branch', async () => {
      const out = analyze('missing-org-filter', await calls('/fixture/r3-some-paths.ts', source), TENANT);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].ruleId).toBe('missing-org-filter');
      expect(out[0].message).toContain('organizationId');
      expect(out[0].message).toContain('is absent');
    });
  });

  describe('generic scoping wrapper (withOrgScope) → missing-org-filter + unfiltered-query FP', async () => {
    const source = [
      'function withOrgScope(qb, session) { return qb.where(eq(orders.organizationId, session.orgId)); }',
      'export function listOrders(session) {',
      '  const base = db.select().from(orders);',
      '  return withOrgScope(base, session);',
      '}',
    ].join('\n');

    it('pins the defect: the producer sees the bare builder; the wrapper body is admitted unproven', async () => {
      const out = await calls('/fixture/r3-wrapper.ts', source);
      // Spec 70 R1.2 — unproven receivers are admitted, not dropped. The wrapper's
      // `qb.where(…)` (receiver `qb` = un-annotated parameter → unproven) is now its
      // own query alongside the bare builder the producer sees for `listOrders`.
      expect(out).toHaveLength(2);
      const builder = out.find((q) => q.queryText === 'db.select().from(orders)');
      expect(builder).toBeDefined();
      expect(builder!.hasFilter).toBe(false);
      expect(builder!.hasOrganizationFilter).toBe(false);
      // The wrapper's own where-clause still carries the org filter, so it does not
      // itself feed a missing-org-filter — the over-fire below comes from the bare
      // builder (which R3 cannot see the wrapper's predicate across functions).
      const wrapper = out.find((q) => q.queryText.includes('qb.where'));
      expect(wrapper).toBeDefined();
      expect(wrapper!.hasOrganizationFilter).toBe(true);
      expect(wrapper!.handleVerdict?.kind).toBe('unproven');
    });

    it('missing-org-filter over-fires critical — FLIP to quiet when R3 resolves the wrapper', async () => {
      const out = analyze('missing-org-filter', await calls('/fixture/r3-wrapper.ts', source), TENANT);
      // FLIP (R3): expect(out).toEqual([]);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].ruleId).toBe('missing-org-filter');
    });

    it('unfiltered-query over-fires high — FLIP to quiet when R3 resolves the wrapper', async () => {
      const out = analyze('unfiltered-query', await calls('/fixture/r3-wrapper.ts', source), TENANT);
      // FLIP (R3): expect(out).toEqual([]);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('high');
      expect(out[0].ruleId).toBe('unfiltered-query');
    });
  });

  describe('quote-doubling hoisted into `const safe` → sql-injection-risk over-report', async () => {
    const source = [
      "import { Pool } from 'pg';",
      'const db = new Pool();',
      'export function search(keyword) {',
      "  const safe = keyword.replace(/'/g, \"''\");",
      "  return db.query(`SELECT * FROM products WHERE name LIKE '%${safe}%'`);",
      '}',
    ].join('\n');

    it('pins the defect: the producer reads `${safe}` as unescaped', async () => {
      const out = await calls('/fixture/r3-hoisted.ts', source);
      expect(out).toHaveLength(1);
      expect(out[0].hasSqlInjectionRisk).toBe(true);
      expect(out[0].sqlEscaped).toBe(false);
    });

    it('and the rule over-reports critical — FLIP to high when R3 resolves `safe`', async () => {
      const out = analyze('sql-injection-risk', await calls('/fixture/r3-hoisted.ts', source));
      // FLIP (R3): expect(out[0].severity).toBe('high'); — the escape is present, just hoisted.
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].ruleId).toBe('sql-injection-risk');
    });
  });
});
