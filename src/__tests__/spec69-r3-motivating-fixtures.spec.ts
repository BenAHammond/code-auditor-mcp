/**
 * Spec 69 R3 — motivating fixtures (Fix 6, §69 item 6).
 *
 * Three minimal reproductions of the local-binding-resolution defect Spec 69 R3
 * (#316) fixes. Each pins the *current* false positive: the `data-access-calls`
 * producer emits a fact whose `queryText` / `hasFilter` / `sqlEscaped` does NOT
 * reflect a predicate or escape assembled in a *prior statement*, so the rule
 * fires (or over-reports) even though the source is scoped / escaped.
 *
 * These are the motivating fixtures for R3. They assert the defect *as it
 * stands today*, not the desired outcome, so they stay green until R3 lands and
 * the flip is the acceptance signal. When local binding resolution lands, flip
 * each `// FLIP` assertion to the desired end state:
 *
 *   - conditions array built across statements → `missing-org-filter` FP
 *       today: fires critical   FLIP: quiet
 *   - generic scoping wrapper (`withOrgScope`) → `missing-org-filter` +
 *       `unfiltered-query` FP
 *       today: fires critical / high   FLIP: quiet / quiet
 *   - quote-doubling hoisted into `const safe` → `sql-injection-risk` over-report
 *       today: critical   FLIP: high (escaped, not raw)
 *
 * The R3 root cause (§ spec-69 lines 64–76) is local binding: a fact assembled
 * in a prior statement that the rule reads only at the candidate node. This file
 * is deliberately small and single-purpose — the production-scale versions live
 * in `specs/rule-evidence-corpus` (`tenant-scoping.ts`, `sql-injection-surface.ts`),
 * whose directives pin the same three cases end to end.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import { dataAccessRules } from '../phase/rules/dataAccess.js';
import type {
  ParsedFile,
  ResolvedQuery,
  ThresholdValues,
  TableCatalog,
  Finding,
} from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** Run the `data-access-calls` producer over a minimal source string. */
function calls(path: string, source: string): ResolvedQuery[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = {
    file: path,
    format: 'typescript',
    source,
    ast,
    adapter: adapter!,
  };
  try {
    return PRODUCERS['data-access-calls']['typescript'].process(file);
  } finally {
    ast.dispose?.();
  }
}

/** Feed produced facts into one data-access rule (the producer → rule glue
 *  `runAudit` performs, in miniature). */
function analyze(
  ruleId: string,
  produced: ResolvedQuery[],
  thresholds: ThresholdValues = {},
  catalog?: TableCatalog,
): Finding[] {
  const rule = dataAccessRules.find((r) => r.id === ruleId)!;
  const ctx = {
    facts: {
      'data-access-calls': produced,
      'table-catalog': catalog ?? { tables: [], aliases: {} },
    },
    formats: ['typescript', 'tsx', 'javascript', 'go'] as const,
    thresholds,
  };
  return [...rule.analyze(ctx)];
}

/** `orders` declared as a tenant table via Tier 1 config, mirroring the corpus's
 *  tenancy tiers (see specs/rule-evidence-corpus/.codeauditor.json). */
const TENANT = { orgFilterTables: ['orders'] };

describe('Spec 69 R3 motivating fixtures — local binding resolution (#316)', () => {
  describe('conditions array built across statements → missing-org-filter FP', () => {
    const source = [
      'export function listOrders(session) {',
      '  const conditions = [];',
      "  conditions.push(eq(orders.organizationId, session.orgId));",
      '  return db.select().from(orders).where(and(...conditions));',
      '}',
    ].join('\n');

    it('pins the defect: the producer leaves the pushed predicate out of queryText', () => {
      const out = calls('/fixture/r3-conditions.ts', source);
      expect(out).toHaveLength(1);
      expect(out[0].queryText).toBe('db.select().from(orders).where(and(...conditions))');
      expect(out[0].hasOrganizationFilter).toBe(false);
      expect(out[0].hasFilter).toBe(true);
    });

    it('and the rule over-fires critical — FLIP to quiet when R3 resolves `conditions`', () => {
      const out = analyze('missing-org-filter', calls('/fixture/r3-conditions.ts', source), TENANT);
      // FLIP (R3): expect(out).toEqual([]); — the predicate is present and unconditional.
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].ruleId).toBe('missing-org-filter');
    });
  });

  describe('generic scoping wrapper (withOrgScope) → missing-org-filter + unfiltered-query FP', () => {
    const source = [
      'function withOrgScope(qb, session) { return qb.where(eq(orders.organizationId, session.orgId)); }',
      'export function listOrders(session) {',
      '  const base = db.select().from(orders);',
      '  return withOrgScope(base, session);',
      '}',
    ].join('\n');

    it('pins the defect: the producer sees the bare builder, not the wrapped predicate', () => {
      const out = calls('/fixture/r3-wrapper.ts', source);
      expect(out).toHaveLength(1);
      expect(out[0].queryText).toBe('db.select().from(orders)');
      expect(out[0].hasFilter).toBe(false);
      expect(out[0].hasOrganizationFilter).toBe(false);
    });

    it('missing-org-filter over-fires critical — FLIP to quiet when R3 resolves the wrapper', () => {
      const out = analyze('missing-org-filter', calls('/fixture/r3-wrapper.ts', source), TENANT);
      // FLIP (R3): expect(out).toEqual([]);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].ruleId).toBe('missing-org-filter');
    });

    it('unfiltered-query over-fires high — FLIP to quiet when R3 resolves the wrapper', () => {
      const out = analyze('unfiltered-query', calls('/fixture/r3-wrapper.ts', source), TENANT);
      // FLIP (R3): expect(out).toEqual([]);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('high');
      expect(out[0].ruleId).toBe('unfiltered-query');
    });
  });

  describe('quote-doubling hoisted into `const safe` → sql-injection-risk over-report', () => {
    const source = [
      'export function search(keyword) {',
      "  const safe = keyword.replace(/'/g, \"''\");",
      "  return db.query(`SELECT * FROM products WHERE name LIKE '%${safe}%'`);",
      '}',
    ].join('\n');

    it('pins the defect: the producer reads `${safe}` as unescaped', () => {
      const out = calls('/fixture/r3-hoisted.ts', source);
      expect(out).toHaveLength(1);
      expect(out[0].hasSqlInjectionRisk).toBe(true);
      expect(out[0].sqlEscaped).toBe(false);
    });

    it('and the rule over-reports critical — FLIP to high when R3 resolves `safe`', () => {
      const out = analyze('sql-injection-risk', calls('/fixture/r3-hoisted.ts', source));
      // FLIP (R3): expect(out[0].severity).toBe('high'); — the escape is present, just hoisted.
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].ruleId).toBe('sql-injection-risk');
    });
  });
});
