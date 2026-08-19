/**
 * Unit tests for derived rule applicability (Spec 42 R2/R3, Spec 39).
 *
 * R2 — styles/undefined-class must not assert a class is undefined when any
 *      stylesheet source went unread; it reports notApplicable naming them.
 * R3 — missing-org-filter derives its own applicability from the table catalog;
 *      no tenant-scoping column anywhere → notApplicable, no config flag.
 */
import { describe, it, expect } from 'vitest';
import { evaluateRuleApplicability } from './applicability.js';

describe('evaluateRuleApplicability — styles/undefined-class (R2)', () => {
  it('returns null (runs unconditionally) when no stylesheets were unread', () => {
    expect(evaluateRuleApplicability('styles/undefined-class', undefined, undefined, [])).toBeNull();
    expect(evaluateRuleApplicability('styles/undefined-class', undefined, undefined, undefined)).toBeNull();
  });

  it('reports notApplicable naming every unread source when any exist', () => {
    const app = evaluateRuleApplicability(
      'styles/undefined-class',
      undefined,
      undefined,
      [
        { filePath: 'styles/theme.sass', reason: 'unsupported style dialect: .sass' },
        { filePath: 'styles/legacy.less', reason: 'unsupported style dialect: .less' },
      ],
    );
    expect(app).not.toBeNull();
    expect(app!.applicable).toBe(false);
    expect(app!.reason).toBe(
      'stylesheets were not read: styles/theme.sass (unsupported style dialect: .sass), styles/legacy.less (unsupported style dialect: .less)',
    );
  });

  it('is a whole-run predicate: one unread source anywhere disables the rule', () => {
    const app = evaluateRuleApplicability('styles/undefined-class', undefined, undefined, [
      { filePath: 'a.styl', reason: 'unsupported style dialect: .styl' },
    ]);
    expect(app!.applicable).toBe(false);
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
    const app = evaluateRuleApplicability('missing-org-filter', undefined, [
      'id',
      'workspace_id',
      'name',
    ]);
    expect(app!.applicable).toBe(true);
  });

  it('reports notApplicable naming the absent tenant column when nothing matches', () => {
    const app = evaluateRuleApplicability('missing-org-filter', undefined, ['id', 'name', 'slug']);
    expect(app).toEqual({
      applicable: false,
      reason: 'no tenant-scoping column found in table catalog',
    });
  });

  it('is notApplicable on an empty catalog', () => {
    const app = evaluateRuleApplicability('missing-org-filter', undefined, []);
    expect(app!.applicable).toBe(false);
  });
});

describe('evaluateRuleApplicability — passthrough', () => {
  it('returns null for rules without an applicability predicate', () => {
    expect(evaluateRuleApplicability('solid/srp', undefined, undefined)).toBeNull();
    expect(evaluateRuleApplicability('react/keys', {}, ['id'])).toBeNull();
  });
});
