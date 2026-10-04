/**
 * Spec 68 §3.2 — the schema rules, migrated to `analyze(ctx)`.
 *
 * The `schema-usage` + `resolution` producers (proven by the producer
 * liveness suite) extract table references and the known-table set; this test
 * proves the *rule* half is a pure classification over those facts. Each rule
 * is exercised against hand-built `SchemaUsageFact` / `ResolutionFact` fixtures —
 * no parse, no adapter — pinning the exact signal → finding mapping the old
 * `checkMissingReferences` / `checkNamingConventions` produced:
 *
 *   - unknown-table:            a reference to a name absent from the catalog,
 *                               with a Levenshtein suggestion when one is near;
 *                               fail-open when the unknown:known ratio exceeds 10.
 *   - table-naming-convention:  a non-snake_case, non-`Table`-suffix name.
 */

import { describe, it, expect } from 'vitest';
import type { SchemaUsageFact, ResolutionFact, MigrationHistory, ThresholdValues, Finding } from '../phase/types.js';
import { schemaRules } from '../phase/rules/schema.js';

function u(overrides: Partial<SchemaUsageFact> = {}): SchemaUsageFact {
  return {
    tableName: 'users',
    filePath: '/fixture/app.ts',
    functionName: 'top-level',
    usageType: 'select',
    line: 1,
    ...overrides,
  };
}

function catalog(names: string[]): ResolutionFact {
  return {
    tables: names.map((name) => ({ name, source: '/fixture/schema.ts', columns: [] })),
    aliases: {},
    classes: [],
    interfaces: [],
  };
}

/** `unknown-table` reads `migration-history` to partition dropped tables; these
 *  fixtures exercise the never-existed path, so the history is empty. */
function analyze(
  ruleId: string,
  facts: { 'schema-usage': SchemaUsageFact[]; 'resolution': ResolutionFact },
  thresholds: ThresholdValues = {},
): Finding[] {
  const rule = schemaRules.find((r) => r.id === ruleId)!;
  const migrationHistory: MigrationHistory = { dropped: {} };
  const ctx = {
    facts: { ...facts, 'migration-history': migrationHistory },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  return [...rule.analyze(ctx)];
}

describe('Spec 68 schema rules (analyze over schema-usage + resolution)', () => {
  describe('unknown-table', () => {
    it('flags a reference to a name absent from the catalog', () => {
      const out = analyze('unknown-table', {
        'schema-usage': [u({ tableName: 'user', usageType: 'select' })],
        'resolution': catalog(['users', 'orders']),
      });
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
      expect(out[0].message).toContain("unknown table 'user'");
    });

    it('suggests a near table within edit distance 2', () => {
      const out = analyze('unknown-table', {
        'schema-usage': [u({ tableName: 'user', usageType: 'select' })],
        'resolution': catalog(['users', 'orders']),
      });
      expect(out[0].message).toContain("Did you mean: 'users'?");
    });

    it('stays quiet on a known table', () => {
      const out = analyze('unknown-table', {
        'schema-usage': [u({ tableName: 'users' })],
        'resolution': catalog(['users']),
      });
      expect(out).toEqual([]);
    });

    it('skips query-builder selectors and system tables', () => {
      const out = analyze('unknown-table', {
        'schema-usage': [
          u({ tableName: 'users', origin: 'query-builder' }),
          u({ tableName: 'sqlite_master' }),
        ],
        'resolution': catalog(['orders']),
      });
      expect(out).toEqual([]);
    });

    it('skips host-language template substitutions (${…})', () => {
      const out = analyze('unknown-table', {
        'schema-usage': [u({ tableName: '${this.tableName}', usageType: 'select' })],
        'resolution': catalog(['users']),
      });
      expect(out).toEqual([]);
    });

    it('fails open when the unknown:known ratio exceeds 10', () => {
      const usages = Array.from({ length: 11 }, () =>
        u({ tableName: `ghost_${Math.random()}` }),
      );
      const out = analyze('unknown-table', {
        'schema-usage': usages,
        'resolution': catalog(['only_one_known']),
      });
      expect(out).toEqual([]);
    });
  });

  describe('table-naming-convention', () => {
    it('flags a camelCase table name', () => {
      const out = analyze('table-naming-convention', {
        'schema-usage': [u({ tableName: 'UserProfiles', usageType: 'select' })],
        'resolution': catalog([]),
      });
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('high');
      expect(out[0].message).toContain("'UserProfiles'");
    });

    it('accepts snake_case', () => {
      const out = analyze('table-naming-convention', {
        'schema-usage': [u({ tableName: 'user_profiles' })],
        'resolution': catalog([]),
      });
      expect(out).toEqual([]);
    });

    it('accepts an ORM `Table`-suffix class name', () => {
      const out = analyze('table-naming-convention', {
        'schema-usage': [u({ tableName: 'UsersTable' })],
        'resolution': catalog([]),
      });
      expect(out).toEqual([]);
    });

    it('skips query-builder selectors', () => {
      const out = analyze('table-naming-convention', {
        'schema-usage': [u({ tableName: 'CamelCase', origin: 'query-builder' })],
        'resolution': catalog([]),
      });
      expect(out).toEqual([]);
    });
  });
});
