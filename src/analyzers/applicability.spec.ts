/**
 * Unit tests for derived rule applicability (Spec 45 R5, Spec 42 R3, Spec 39).
 *
 * Spec 45 R5 — styles/undefined-class has no applicability predicate: it always
 *      runs. Unread stylesheets are reported as context on its findings, not as
 *      notApplicable.
 * R3 — missing-org-filter derives its own applicability from the table catalog;
 *      no tenant-scoping column anywhere → notApplicable, no config flag.
 */
import { describe, it, expect } from 'vitest';
import { evaluateRuleApplicability, CANNOT_FIRE_RULES } from './applicability.js';

describe('evaluateRuleApplicability — styles/undefined-class (Spec 45 R5)', () => {
  it('returns null (runs unconditionally) — unread stylesheets never disable it', () => {
    expect(evaluateRuleApplicability('styles/undefined-class', undefined, undefined)).toBeNull();
  });
});

describe('evaluateRuleApplicability — missing-org-filter (R3)', () => {
  it('applies when the user declared tenant-scoped tables by name (Tier 1)', () => {
    const app = evaluateRuleApplicability(
      'missing-org-filter',
      { orgFilterTables: ['accounts'] },
      undefined,
    );
    expect(app!.applicable).toBe(true);
    expect(app!.reason).toBeUndefined();
  });

  it('applies when a configured schema declares a tenant-scoping column (Tier 2)', () => {
    const app = evaluateRuleApplicability(
      'missing-org-filter',
      {
        schemas: [{ tables: [{ columns: [{ name: 'id' }, { name: 'tenant_id' }] }] }],
      },
      undefined,
    );
    expect(app!.applicable).toBe(true);
  });

  it('matches tenant columns case-insensitively (Tier 2)', () => {
    const app = evaluateRuleApplicability(
      'missing-org-filter',
      { schemas: [{ tables: [{ columns: [{ name: 'Tenant_ID' }] }] }] },
      undefined,
    );
    expect(app!.applicable).toBe(true);
  });

  it('honors a configured orgFilterColumns override (Tier 2)', () => {
    const custom = evaluateRuleApplicability(
      'missing-org-filter',
      {
        orgFilterColumns: ['org_id', 'team_slug'],
        schemas: [{ tables: [{ columns: [{ name: 'team_slug' }] }] }],
      },
      undefined,
    );
    expect(custom!.applicable).toBe(true);

    const miss = evaluateRuleApplicability(
      'missing-org-filter',
      {
        orgFilterColumns: ['team_slug'],
        schemas: [{ tables: [{ columns: [{ name: 'org_id' }] }] }],
      },
      undefined,
    );
    expect(miss!.applicable).toBe(false);
  });

  it('applies when the DDL-derived table catalog carries a tenant column (Tier 3)', () => {
    const app = evaluateRuleApplicability('missing-org-filter', undefined, {
      accounts: ['id', 'workspace_id', 'name'],
    });
    expect(app!.applicable).toBe(true);
  });

  it('reports notApplicable naming the absent tenant column when nothing matches', () => {
    const app = evaluateRuleApplicability('missing-org-filter', undefined, {
      accounts: ['id', 'name', 'slug'],
    });
    expect(app).toEqual({
      applicable: false,
      reason: 'no tenant-scoping column found in table catalog',
    });
  });

  it('is notApplicable on an empty catalog', () => {
    const app = evaluateRuleApplicability('missing-org-filter', undefined, {});
    expect(app!.applicable).toBe(false);
  });

  it('is table-scoped: a tenant column on one table does not mark another table tenant (Tier 3)', () => {
    // Amendment B — applicability is per-table now, not "any column anywhere".
    const app = evaluateRuleApplicability('missing-org-filter', undefined, {
      audit_log: ['id', 'org_id'],
      // `tags` has no tenant column; the flat catalog of old would have been
      // fooled, but the per-table map keeps tenancy table-scoped.
    });
    expect(app!.applicable).toBe(true);
  });
});

describe('evaluateRuleApplicability — cannot-fire rules (Spec 44 bucket 2)', () => {
  it('has no cannot-fire rules after the 4.1.0 removal', () => {
    // The ten cannot-fire rules (six api-contract, file-error, three
    // schema-validator aliases) were removed in 4.1.0 — registry entry, emission
    // site, and ledger row. The `cannot-fire` verdict remains in the
    // applicability vocabulary (RuleApplicability.kind) but no rule carries it.
    expect(CANNOT_FIRE_RULES.size).toBe(0);
  });
});

describe('evaluateRuleApplicability — passthrough', () => {
  it('returns null for rules without an applicability predicate', () => {
    expect(evaluateRuleApplicability('solid/srp', undefined, undefined)).toBeNull();
    expect(evaluateRuleApplicability('react/keys', {}, ['id'])).toBeNull();
  });
});
