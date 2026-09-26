/**
 * Spec 68 §2.1 — the migrated-rules registry is the progress metric.
 *
 * One failing assertion stands in for the whole migration: `MIGRATED_RULES`
 * holds only rules that satisfy all four migration conditions (`analyze(ctx)`,
 * all declared facts live, old analyzer path deleted, parity test pinned), and
 * its size must reach 100. It reads 0 today — no rule is fully migrated — and
 * goes green at 100. A red test drives the migration; a compile error would
 * block every other test, and a false `facts: []` declaration would lie about
 * it. The count is the metric, and it is deliberately red until the last rule
 * lands.
 */

import { describe, it, expect } from 'vitest';
import { MIGRATED_RULES } from '../phase/rules/registry.js';

describe('Spec 68 §2.1 — the migrated-rules registry', () => {
  it('holds all 100 rules once migration is complete', () => {
    expect(MIGRATED_RULES.length).toBe(100);
  });
});
