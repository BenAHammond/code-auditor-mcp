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
    it('flags a filterless DELETE as an unfiltered write', () => {
      const out = analyze('unfiltered-query', [
        q({ queryText: 'DELETE FROM users', tables: ['users'], hasFilter: false, method: 'db.run' }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain('Unfiltered write');
    });

    it('stays quiet on a DELETE carrying a WHERE clause', () => {
      const out = analyze('unfiltered-query', [
        q({ queryText: 'DELETE FROM users WHERE id = ?', tables: ['users'], hasFilter: true }),
      ]);
      expect(out).toEqual([]);
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
        q({ queryText: 'DELETE FROM users', tables: ['users'], hasFilter: false, file: '/fixture/app.test.ts' }),
      ]);
      expect(out).toEqual([]);
    });
  });
});
