/**
 * Spec 69 R5 — pin the five variable-split (conditional) tenant-predicate
 * shapes as must-fire fixtures.
 *
 * R3's local-binding resolution distinguishes an all-paths tenant predicate
 * (the isolation is unconditional → quiet) from a some-paths one (the predicate
 * is applied only on some branches → the query still executes unscoped → fire).
 * The five real hhra-org sites whose predicate is pushed inside an `if` or a
 * ternary are the acceptance set for that distinction (criterion 12). Each is
 * pinned here so a future resolution change that quietly silences a conditional
 * case — e.g. resolving a ternary or a reassignment to all-paths — fails a test
 * rather than a corpus.
 *
 * The five shapes, one per real site:
 *
 *   1. `isOrganizationAdmin` — `if (organizationId) conditions.push(eq(org…))`
 *        → some-paths, message names `organizationId`.
 *   2. `getUploadStatus` — `if (organizationIds && organizationIds.length > 0)
 *        conditions.push(inArray(org…))` → some-paths, names the compound guard.
 *   3. admin data page — `if (organizationId && organizationId !== 'all')
 *        conditions.push(eq(org…))` → some-paths, names the compound guard.
 *   4. sample-ownership stats — a ternary `organizationId
 *        ? statsQuery.where(eq(org…)) : statsQuery.limit(…)` → fires plain;
 *        the predicate is not a `and(...conditions)` spread, so R3's spread
 *        resolution does not see it — it must still fire.
 *   5. admin data base — `query = conditions.length > 0
 *        ? baseQuery.where(and(...conditions)) : baseQuery` → the base builder
 *        fires plain; the `.where` is applied by reassignment, outside R3's
 *        spread resolution — it must still fire.
 *
 * Shapes 1–3 exercise R3's some-paths path (the "is absent" message); shapes
 * 4–5 are the two conditional forms R3 deliberately does not resolve (its
 * ceiling is the `.where(and(...conditions))` spread), pinned so they stay
 * firing rather than being mistaken for all-paths and quietly silenced.
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

/** The hhra-org tenant tables (Tier 1 config), mirroring the corpus tenancy. */
const TENANT = {
  orgFilterTables: ['user_organizations', 'raw_certifier_data', 'sample_ownership'],
};

describe('Spec 69 R5 — five conditional tenant-predicate shapes stay firing (#318)', () => {
  describe('1. isOrganizationAdmin — `if (organizationId) conditions.push(eq(org…))`', () => {
    const source = [
      'export async function isOrganizationAdmin(userId, organizationId) {',
      "  const conditions = [eq(user_organizations.userId, userId), eq(user_organizations.role, 'admin')];",
      '  if (organizationId) {',
      '    conditions.push(eq(user_organizations.organizationId, organizationId));',
      '  }',
      '  return db.select().from(user_organizations).where(and(...conditions)).limit(1);',
      '}',
    ].join('\n');

    it('resolves the org predicate as some-paths, branch named', () => {
      const out = calls('/fixture/r5-is-org-admin.ts', source);
      const org = out[0].resolvedWhere?.elements.find((e) =>
        e.text.includes('organizationId'),
      );
      expect(org).toEqual({
        text: 'eq(user_organizations.organizationId, organizationId)',
        allPaths: false,
        branch: 'organizationId',
      });
    });

    it('still fires critical, message names the absent branch', () => {
      const out = analyze('missing-org-filter', calls('/fixture/r5-is-org-admin.ts', source), TENANT);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].message).toContain('organizationId');
      expect(out[0].message).toContain('is absent');
    });
  });

  describe('2. getUploadStatus — `if (organizationIds && organizationIds.length > 0) conditions.push(inArray(org…))`', () => {
    const source = [
      'export function getUploadStatus(uploadId, userId, organizationIds) {',
      '  const conditions = [eq(raw_certifier_data.id, uploadId), eq(raw_certifier_data.userId, userId)];',
      '  if (organizationIds && organizationIds.length > 0) {',
      '    conditions.push(inArray(raw_certifier_data.organizationId, organizationIds));',
      '  }',
      '  return db.select().from(raw_certifier_data).where(and(...conditions));',
      '}',
    ].join('\n');

    it('resolves the inArray predicate as some-paths, compound branch named', () => {
      const out = calls('/fixture/r5-upload-status.ts', source);
      const org = out[0].resolvedWhere?.elements.find((e) =>
        e.text.includes('organizationId'),
      );
      expect(org).toEqual({
        text: 'inArray(raw_certifier_data.organizationId, organizationIds)',
        allPaths: false,
        branch: 'organizationIds && organizationIds.length > 0',
      });
    });

    it('still fires critical, message names the compound branch', () => {
      const out = analyze('missing-org-filter', calls('/fixture/r5-upload-status.ts', source), TENANT);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].message).toContain('organizationIds && organizationIds.length > 0');
      expect(out[0].message).toContain('is absent');
    });
  });

  describe("3. admin data page — `if (organizationId && organizationId !== 'all') conditions.push(eq(org…))`", () => {
    const source = [
      'export function adminData(organizationId) {',
      '  const conditions = [];',
      "  if (organizationId && organizationId !== 'all') {",
      '    conditions.push(eq(raw_certifier_data.organizationId, organizationId));',
      '  }',
      '  return db.select().from(raw_certifier_data).where(and(...conditions));',
      '}',
    ].join('\n');

    it('resolves the pushed predicate as some-paths, compound branch named', () => {
      const out = calls('/fixture/r5-admin-data.ts', source);
      expect(out[0].resolvedWhere?.elements).toEqual([
        {
          text: 'eq(raw_certifier_data.organizationId, organizationId)',
          allPaths: false,
          branch: "organizationId && organizationId !== 'all'",
        },
      ]);
    });

    it('still fires critical, message names the absent branch', () => {
      const out = analyze('missing-org-filter', calls('/fixture/r5-admin-data.ts', source), TENANT);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].message).toContain("organizationId && organizationId !== 'all'");
      expect(out[0].message).toContain('is absent');
    });
  });

  describe('4. sample-ownership stats — ternary `organizationId ? statsQuery.where(eq(org…)) : …`', () => {
    const source = [
      'export function sampleStats(organizationId) {',
      '  const statsQuery = db.select().from(sample_ownership);',
      '  return organizationId',
      '    ? statsQuery.where(eq(sample_ownership.organizationId, organizationId))',
      '    : statsQuery.limit(50);',
      '}',
    ].join('\n');

    it('the producer sees the bare builder, not the ternary predicate', () => {
      const out = calls('/fixture/r5-sample-ownership.ts', source);
      expect(out).toHaveLength(1);
      expect(out[0].hasFilter).toBe(false);
      // The ternary predicate is not a `and(...conditions)` spread, so R3 leaves
      // `resolvedWhere` unset — the rule must still fire on the bare builder.
      expect(out[0].resolvedWhere).toBeUndefined();
    });

    it('still fires critical — a future change must not resolve the ternary to quiet', () => {
      const out = analyze('missing-org-filter', calls('/fixture/r5-sample-ownership.ts', source), TENANT);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].ruleId).toBe('missing-org-filter');
    });
  });

  describe('5. admin data base — `query = cond ? baseQuery.where(and(...conditions)) : baseQuery`', () => {
    const source = [
      'export function adminDataBase(organizationId) {',
      '  const conditions = [];',
      '  if (organizationId) {',
      '    conditions.push(eq(raw_certifier_data.organizationId, organizationId));',
      '  }',
      '  const baseQuery = db.select().from(raw_certifier_data);',
      '  const query = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;',
      '  return query;',
      '}',
    ].join('\n');

    it('the producer sees the bare builder, not the reassigned predicate', () => {
      const out = calls('/fixture/r5-admin-data-base.ts', source);
      // The `.where` is applied to `baseQuery` by reassignment in a later
      // statement; `baseQuery`'s own chain carries no predicate, and R3's spread
      // resolution does not cross statements to the reassignment.
      expect(out).toHaveLength(1);
      expect(out[0].hasFilter).toBe(false);
      expect(out[0].resolvedWhere).toBeUndefined();
    });

    it('still fires critical — a future change must not resolve the reassignment to quiet', () => {
      const out = analyze('missing-org-filter', calls('/fixture/r5-admin-data-base.ts', source), TENANT);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].ruleId).toBe('missing-org-filter');
    });
  });
});
