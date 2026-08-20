import { describe, it, expect } from 'vitest';
import { FileAccounting, AccountingBalanceError } from './fileAccounting.js';

describe('FileAccounting', () => {
  it('balances when every touched file reaches a terminal state', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/a.ts');
    fa.recordTouched('/proj/b.ts');
    fa.recordTouched('/proj/c.ts');
    fa.recordAnalyzed('/proj/a.ts');
    fa.recordAnalyzed('/proj/b.ts');
    fa.recordDropped('no adapter', '/proj/c.ts');

    expect(() => fa.assertBalanced()).not.toThrow();
    const s = fa.summary();
    expect(s.touched).toBe(3);
    expect(s.analyzed).toBe(2);
    expect(s.dropped).toBe(1);
    expect(s.analyzed + s.dropped).toBe(s.touched);
    expect(s.reasons['no adapter']).toEqual({
      count: 1,
      files: [{ filePath: '/proj/c.ts' }],
    });
  });

  it('throws AccountingBalanceError with a transcript when a file is touched but never classified', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/leaked.ts');
    fa.recordTouched('/proj/ok.ts');
    fa.recordAnalyzed('/proj/ok.ts');

    let caught: AccountingBalanceError | undefined;
    try {
      fa.assertBalanced();
    } catch (e) {
      caught = e as AccountingBalanceError;
    }

    expect(caught).toBeInstanceOf(AccountingBalanceError);
    expect(caught!.name).toBe('AccountingBalanceError');
    expect(caught!.message).toContain('touched but never classified');
    expect(caught!.message).toContain('/proj/leaked.ts');
  });

  it('throws on a double-classification conflict', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/a.ts');
    fa.recordDropped('parse failed', '/proj/a.ts');
    fa.recordAnalyzed('/proj/a.ts'); // conflict: analyzed after dropped

    expect(() => fa.assertBalanced()).toThrow(AccountingBalanceError);
  });

  it('is idempotent for a file reaching multiple visitors (analyzed → analyzed)', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/a.ts');
    fa.recordAnalyzed('/proj/a.ts');
    fa.recordAnalyzed('/proj/a.ts');
    fa.assertBalanced();
    expect(fa.summary().analyzed).toBe(1);
  });

  it('reclassifies analyzed → dropped only via the sanctioned path', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/big.sql');
    fa.recordAnalyzed('/proj/big.sql');
    fa.reclassifyAnalyzedToDropped('size threshold', '/proj/big.sql', { bytes: 9_000_000 });

    fa.assertBalanced();
    const s = fa.summary();
    expect(s.analyzed).toBe(0);
    expect(s.dropped).toBe(1);
    expect(s.reasons['size threshold']).toEqual({
      count: 1,
      files: [{ filePath: '/proj/big.sql', bytes: 9_000_000 }],
    });
  });

  it('records infra prunes as an aggregate, not per-file', () => {
    const fa = new FileAccounting();
    fa.recordInfraPruned('/proj/node_modules', 'DEFAULT_EXCLUDED_DIRS');
    fa.recordInfraPruned('/proj/node_modules', 'DEFAULT_EXCLUDED_DIRS');
    fa.recordInfraPruned('/proj/dist', 'DEFAULT_EXCLUDED_DIRS');

    fa.assertBalanced();
    const s = fa.summary();
    expect(s.touched).toBe(0);
    expect(s.infraPruned).toEqual([
      { directory: '/proj/node_modules', rule: 'DEFAULT_EXCLUDED_DIRS', directories: 2 },
      { directory: '/proj/dist', rule: 'DEFAULT_EXCLUDED_DIRS', directories: 1 },
    ]);
  });

  it('keeps reason 8 (unsupported dialect) out of the file-level balance', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/a.ts');
    fa.recordAnalyzed('/proj/a.ts');
    fa.recordUnsupportedDialect('/proj/a.ts', 'embedded .scss');

    fa.assertBalanced();
    const s = fa.summary();
    expect(s.touched).toBe(1);
    expect(s.analyzed).toBe(1);
    expect(s.dropped).toBe(0);
    expect(s.reasons['unsupported dialect']).toEqual({
      count: 1,
      files: [{ filePath: '/proj/a.ts', reason: 'embedded .scss' }],
    });
  });

  it('reclassifies a dropped no-adapter file that produced findings as partially analyzed', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/page.astro');
    fa.recordDropped('no adapter', '/proj/page.astro');

    // A stage-3 reducer read it and emitted a finding → partially analyzed.
    fa.reclassifyDroppedToPartiallyAnalyzed('/proj/page.astro');

    fa.assertBalanced();
    const s = fa.summary();
    expect(s.touched).toBe(1);
    expect(s.analyzed).toBe(0);
    expect(s.partiallyAnalyzed).toBe(1);
    expect(s.dropped).toBe(0);
    expect(s.analyzed + s.partiallyAnalyzed + s.dropped).toBe(s.touched);
    // Still under its original reason, flagged `partial: true`.
    expect(s.reasons['no adapter']).toEqual({
      count: 1,
      files: [{ filePath: '/proj/page.astro', partial: true }],
    });
  });

  it('only reclassifies no-adapter / no-visitor-matched drops', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/a.astro');
    fa.recordTouched('/proj/b.ts');
    fa.recordTouched('/proj/c.ts');
    fa.recordDropped('no adapter', '/proj/a.astro');
    fa.recordDropped('no visitor matched', '/proj/b.ts');
    fa.recordDropped('path profile excluded', '/proj/c.ts');

    fa.reclassifyDroppedToPartiallyAnalyzed('/proj/a.astro');
    fa.reclassifyDroppedToPartiallyAnalyzed('/proj/b.ts');
    // Not reclassifiable — deliberately removed from every layer.
    fa.reclassifyDroppedToPartiallyAnalyzed('/proj/c.ts');

    fa.assertBalanced();
    const s = fa.summary();
    expect(s.partiallyAnalyzed).toBe(2);
    expect(s.dropped).toBe(1);
    expect(s.reasons['path profile excluded']).toEqual({
      count: 1,
      files: [{ filePath: '/proj/c.ts' }],
    });
  });

  it('no-ops when reclassifying an analyzed or absent file', () => {
    const fa = new FileAccounting();
    fa.recordTouched('/proj/a.ts');
    fa.recordAnalyzed('/proj/a.ts');

    // An analyzed file with findings stays analyzed; absent/touched stay put.
    fa.reclassifyDroppedToPartiallyAnalyzed('/proj/a.ts');
    fa.reclassifyDroppedToPartiallyAnalyzed('/proj/missing.ts');

    fa.assertBalanced();
    const s = fa.summary();
    expect(s.analyzed).toBe(1);
    expect(s.partiallyAnalyzed).toBe(0);
    expect(s.dropped).toBe(0);
  });
});
