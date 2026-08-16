/**
 * Spec 36 R4/R6 — the gate is binary and a gating rule that cannot name a next
 * action does not block (and records the gap). These tests exercise the pure
 * decision function directly, so the forced-failure property (remove a guard,
 * test fails) is attributable to the gate and not to the CLI/hook plumbing.
 */
import { describe, it, expect } from 'vitest';
import { computeGatingDecision } from './gate.js';
import type { Violation } from '../types.js';

function v(partial: Partial<Violation> & { analyzer: string; rule: string }): Violation {
  return {
    file: 'src/a.ts',
    severity: 'critical',
    message: 'm',
    ...partial,
  } as Violation;
}

const GATING = { analyzer: 'solid', rule: 'solid/class-size' };
const GATING_BARE = { analyzer: 'solid', rule: 'single-responsibility' };
const NON_GATING = { analyzer: 'solid', rule: 'solid/method-complexity' };

describe('computeGatingDecision — Spec 36 R4/R6', () => {
  it('blocks a new gating finding that carries a resolution', () => {
    const decision = computeGatingDecision([
      v({
        ...GATING,
        resolution: { action: 'extract-methods', summary: 'split it', symbols: ['Big'] },
      }),
    ]);
    expect(decision.blocking).toHaveLength(1);
    expect(decision.resolutionGaps).toHaveLength(0);
  });

  it('does not block a known (baseline-matched) finding — Spec 36 R2', () => {
    const decision = computeGatingDecision([
      v({ ...GATING, new: false, resolution: { action: 'x', summary: 'y' } }),
    ]);
    expect(decision.blocking).toHaveLength(0);
  });

  it('does not block a gate-excluded file — Spec 36 R4', () => {
    const decision = computeGatingDecision([
      v({ ...GATING, gateExcluded: true, resolution: { action: 'x', summary: 'y' } }),
    ]);
    expect(decision.blocking).toHaveLength(0);
  });

  it('does not block a non-gating rule, even with a resolution', () => {
    const decision = computeGatingDecision([
      v({ ...NON_GATING, resolution: { action: 'x', summary: 'y' } }),
    ]);
    expect(decision.blocking).toHaveLength(0);
    expect(decision.resolutionGaps).toHaveLength(0);
  });

  it('emits a gating finding with no resolution as non-blocking and records the gap — Spec 36 R6', () => {
    const decision = computeGatingDecision([v({ ...GATING })]);
    expect(decision.blocking).toHaveLength(0);
    expect(decision.resolutionGaps).toEqual([
      { rule: 'solid/class-size', file: 'src/a.ts', reason: 'no-resolution' },
    ]);
  });

  it('records a gap for the bare rule-ID gating rule too', () => {
    const decision = computeGatingDecision([v({ ...GATING_BARE })]);
    expect(decision.blocking).toHaveLength(0);
    expect(decision.resolutionGaps).toHaveLength(1);
    expect(decision.resolutionGaps[0].rule).toBe('single-responsibility');
  });

  it('treats an undefined new flag as blocking (no baseline → everything is new)', () => {
    const decision = computeGatingDecision([
      v({ ...GATING, resolution: { action: 'a', summary: 's' } }),
    ]);
    expect(decision.blocking).toHaveLength(1);
  });
});
