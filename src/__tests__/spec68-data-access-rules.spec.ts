/**
 * Spec 68 §3.2 — the data-access rules, migrated to `analyze(ctx)`.
 *
 * The producer (proven by spec68-data-access-calls.spec.ts) extracts
 * `ResolvedQuery[]`; this test proves the *rule* half is a pure classification
 * over that fact. Each rule is exercised against hand-built `ResolvedQuery`
 * fixtures — no parse, no adapter — so the assertions pin the exact
 * signal → finding mapping the old `checkViolations`/`analyzeQuery` produced:
 *
 *   - sql-injection-risk: `hasSqlInjectionRisk` raw → critical, escaped → high
 *   - complex-query:      `tables.length` above the joined-table threshold
 *   - unfiltered-query:   a filterless mass-write, or a filterless read of a
 *                         tenant table (declared tenancy, config-only)
 */

import { describe, it, expect } from 'vitest';
import type { ResolvedQuery, ThresholdValues, Finding } from '../phase/types.js';
import { dataAccessRules } from '../phase/rules/dataAccess.js';

/** A minimal ResolvedQuery with the irrelevant fields defaulted. */
function q(overrides: Partial<ResolvedQuery> = {}): ResolvedQuery {
  return {
    type: 'sql',
    method: 'query',
    file: '/fixture/app.ts',
    line: 1,
    column: 1,
    tables: [],
    queryText: '',
    hasOrganizationFilter: false,
    hasFilter: false,
    hasParameterizedQuery: false,
    hasSqlInjectionRisk: false,
    sqlEscaped: false,
    ...overrides,
  };
}

function analyze(ruleId: string, calls: ResolvedQuery[], thresholds: ThresholdValues = {}): Finding[] {
  const rule = dataAccessRules.find((r) => r.id === ruleId)!;
  const ctx = {
    facts: { 'data-access-calls': calls },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  return [...rule.analyze(ctx)];
}

describe('Spec 68 data-access rules (analyze over ResolvedQuery)', () => {
  describe('sql-injection-risk', () => {
    it('flags raw unescaped interpolation as critical', () => {
      const out = analyze('sql-injection-risk', [q({ hasSqlInjectionRisk: true, sqlEscaped: false, method: 'db.run' })]);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].message).toContain('db.run');
    });

    it('downgrades quote-escaped interpolation to high', () => {
      const out = analyze('sql-injection-risk', [q({ hasSqlInjectionRisk: true, sqlEscaped: true, method: 'db.run' })]);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('high');
      expect(out[0].message).toContain('verify escaping');
    });

    it('stays quiet on a parameterized (safe) call', () => {
      const out = analyze('sql-injection-risk', [q({ hasSqlInjectionRisk: false })]);
      expect(out).toEqual([]);
    });
  });

  describe('complex-query', () => {
    it('flags a query referencing more tables than the joined-table threshold', () => {
      const out = analyze('complex-query', [q({ tables: ['a', 'b', 'c', 'd', 'e'] })]);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('high');
      expect(out[0].message).toContain('5 tables');
    });

    it('stays quiet at or below the default threshold (4)', () => {
      const out = analyze('complex-query', [q({ tables: ['a', 'b', 'c', 'd'] })]);
      expect(out).toEqual([]);
    });

    it('honours a lowered joined-table threshold', () => {
      const out = analyze('complex-query', [q({ tables: ['a', 'b', 'c'] })], { joinedTableCount: 2 });
      expect(out).toHaveLength(1);
    });
  });

  describe('unfiltered-query', () => {
    it('flags a filterless UPDATE as an unfiltered write', () => {
      const out = analyze('unfiltered-query', [
        q({ queryText: 'UPDATE users SET active = 0', tables: ['users'], hasFilter: false, method: 'db.run' }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain('Unfiltered write');
    });

    it('stays quiet on an UPDATE carrying a WHERE clause', () => {
      const out = analyze('unfiltered-query', [
        q({ queryText: 'UPDATE users SET active = 0 WHERE id = ?', tables: ['users'], hasFilter: true }),
      ]);
      expect(out).toEqual([]);
    });

    it('stays quiet on a bare DELETE — whole-table maintenance is exempt (Spec 68 disposition (a))', () => {
      const out = analyze('unfiltered-query', [
        q({ queryText: 'DELETE FROM users', tables: ['users'], hasFilter: false, method: 'db.run' }),
      ]);
      expect(out).toEqual([]);
    });

    it('treats Go writes format-agnostically — UPDATE fires, DELETE/INSERT do not (Spec 68 §9)', () => {
      const goFile = { file: '/fixture/app.go' };

      const update = analyze('unfiltered-query', [
        q({ queryText: 'UPDATE users SET active = 0', tables: ['users'], hasFilter: false, method: 'db.run', ...goFile }),
      ]);
      expect(update).toHaveLength(1);
      expect(update[0].message).toContain('Unfiltered write');

      const deleteAll = analyze('unfiltered-query', [
        q({ queryText: 'DELETE FROM users', tables: ['users'], hasFilter: false, method: 'db.run', ...goFile }),
      ]);
      expect(deleteAll).toEqual([]);

      const insert = analyze('unfiltered-query', [
        q({ queryText: 'INSERT INTO users (name) VALUES (?)', tables: ['users'], hasFilter: false, method: 'db.run', ...goFile }),
      ]);
      expect(insert).toEqual([]);
    });

    it('flags a filterless read of a declared tenant table as a read', () => {
      const out = analyze(
        'unfiltered-query',
        [q({ queryText: 'SELECT * FROM projects', tables: ['projects'], hasFilter: false })],
        { orgFilterTables: ['projects'] },
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain('Unfiltered read');
      expect(out[0].message).toContain('tenant table projects');
    });

    it('stays quiet on a filterless read of a non-tenant table', () => {
      const out = analyze('unfiltered-query', [
        q({ queryText: 'SELECT * FROM config', tables: ['config'], hasFilter: false }),
      ]);
      expect(out).toEqual([]);
    });

    it('skips test/spec files (Spec 55 R3)', () => {
      const out = analyze('unfiltered-query', [
        q({ queryText: 'UPDATE users SET active = 0', tables: ['users'], hasFilter: false, file: '/fixture/app.test.ts' }),
      ]);
      expect(out).toEqual([]);
    });
  });

  describe('missing-org-filter (INSERT column-list — Spec 68 §9)', () => {
    /** `missing-org-filter` additionally reads the `table-catalog` fact; Tier 1
     *  tenancy comes from the `orgFilterTables` threshold, so the catalog is empty. */
    function analyzeOrg(ruleId: string, calls: ResolvedQuery[], thresholds: ThresholdValues = {}): Finding[] {
      const rule = dataAccessRules.find((r) => r.id === ruleId)!;
      const ctx = {
        facts: {
          'data-access-calls': calls,
          'table-catalog': { tables: [] as Array<{ name: string; source: string; columns: string[] }>, aliases: {} },
        },
        formats: ['typescript', 'tsx', 'javascript', 'go'] as const,
        thresholds,
      };
      return [...rule.analyze(ctx)];
    }

    const tenant = { orgFilterTables: ['users'] };

    it('raw-SQL INSERT that sets the tenant column in its column list is quiet', () => {
      const out = analyzeOrg('missing-org-filter', [
        q({ queryText: 'INSERT INTO users (organization_id, name) VALUES ($1, $2)', tables: ['users'], method: 'db.run' }),
      ], tenant);
      expect(out).toEqual([]);
    });

    it('raw-SQL INSERT that omits the tenant column fires (row would be unscoped)', () => {
      const out = analyzeOrg('missing-org-filter', [
        q({ queryText: 'INSERT INTO users (name, email) VALUES ($1, $2)', tables: ['users'], method: 'db.run' }),
      ], tenant);
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain('does not set the organization/tenant column');
      expect(out[0].resolution?.action).toBe('add-tenant-column');
    });

    it('a positional INSERT with no column list is quiet (every column is set)', () => {
      const out = analyzeOrg('missing-org-filter', [
        q({ queryText: 'INSERT INTO users VALUES ($1, $2, $3)', tables: ['users'], method: 'db.run' }),
      ], tenant);
      expect(out).toEqual([]);
    });

    it('a Go raw-SQL INSERT omitting the tenant column fires — format-agnostic (§9)', () => {
      const out = analyzeOrg('missing-org-filter', [
        q({ queryText: 'INSERT INTO users (name, email) VALUES ($1, $2)', tables: ['users'], method: 'db.Exec', file: '/fixture/app.go' }),
      ], tenant);
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain('does not set the organization/tenant column');
    });

    it('an ORM builder insert without the tenant key still fires via the predicate path', () => {
      const out = analyzeOrg('missing-org-filter', [
        q({ queryText: 'db.insert(users).values({ name, email })', tables: ['users'], method: 'db.insert' }),
      ], tenant);
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain('has no organization/tenant predicate');
      expect(out[0].resolution?.action).toBe('add-tenant-predicate');
    });

    it('an ORM builder insert that sets the tenant key is quiet', () => {
      const out = analyzeOrg('missing-org-filter', [
        q({ queryText: 'db.insert(users).values({ organization_id: orgId, name })', tables: ['users'], method: 'db.insert', hasOrganizationFilter: true }),
      ], tenant);
      expect(out).toEqual([]);
    });
  });
});
