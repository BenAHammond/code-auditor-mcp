/**
 * Spec 45 R1/R2/R4 — the gate blocks on every finding at a blocking severity,
 * regardless of the rule (R1) and regardless of whether the finding is new (R4).
 * A `resolvable` rule that emits without a resolution still blocks and records
 * the gap (R1). These tests exercise the pure decision function directly.
 */
import { describe, it, expect } from 'vitest';
import { computeGatingDecision } from './gate.js';
import type { Severity, Violation } from '../types.js';

function v(partial: Partial<Violation> & { analyzer: string; rule: string }): Violation {
  return {
    file: 'src/a.ts',
    severity: 'critical',
    message: 'm',
    ...partial,
  } as Violation;
}

const DEFAULT = new Set<Severity>(['critical', 'warning']);
const CRITICAL_ONLY = new Set<Severity>(['critical']);
const EVERYTHING = new Set<Severity>(['critical', 'warning', 'suggestion']);

const RESOLVABLE = { analyzer: 'solid', rule: 'solid/class-size' };
const NON_RESOLVABLE = { analyzer: 'solid', rule: 'solid/method-complexity' };

describe('computeGatingDecision — Spec 45 R1/R2/R4', () => {
  it('blocks a critical finding that carries a resolution', () => {
    const decision = computeGatingDecision([
      v({ ...RESOLVABLE, resolution: { action: 'extract-methods', summary: 'split it', symbols: ['Big'] } }),
    ], DEFAULT);
    expect(decision.blocking).toHaveLength(1);
    expect(decision.resolutionGaps).toHaveLength(0);
  });

  it('blocks a warning finding (default blocking set includes warning) — R2', () => {
    const decision = computeGatingDecision([
      v({ ...RESOLVABLE, severity: 'warning', resolution: { action: 'x', summary: 'y' } }),
    ], DEFAULT);
    expect(decision.blocking).toHaveLength(1);
  });

  it('does not block a suggestion finding by default — R2', () => {
    const decision = computeGatingDecision([
      v({ ...RESOLVABLE, severity: 'suggestion', resolution: { action: 'x', summary: 'y' } }),
    ], DEFAULT);
    expect(decision.blocking).toHaveLength(0);
  });

  it('blocks a suggestion finding when the blocking set is widened — R2 configurable', () => {
    const decision = computeGatingDecision([
      v({ ...RESOLVABLE, severity: 'suggestion', resolution: { action: 'x', summary: 'y' } }),
    ], EVERYTHING);
    expect(decision.blocking).toHaveLength(1);
  });

  it('does not block a warning when only critical blocks — R2 configurable narrower set', () => {
    const decision = computeGatingDecision([
      v({ ...RESOLVABLE, severity: 'warning', resolution: { action: 'x', summary: 'y' } }),
    ], CRITICAL_ONLY);
    expect(decision.blocking).toHaveLength(0);
  });

  it('blocks a pre-existing (new === false) finding — R4 not diff-scoped', () => {
    const decision = computeGatingDecision([
      v({ ...RESOLVABLE, new: false, resolution: { action: 'x', summary: 'y' } }),
    ], DEFAULT);
    expect(decision.blocking).toHaveLength(1);
  });

  it('blocks a finding on a rule without a registry gating flag — R1 every rule gates', () => {
    // `solid/method-complexity` previously carried `gating: false`. Every
    // registered rule now gates; severity alone decides.
    const decision = computeGatingDecision([
      v({ ...NON_RESOLVABLE, severity: 'warning', resolution: { action: 'x', summary: 'y' } }),
    ], DEFAULT);
    expect(decision.blocking).toHaveLength(1);
  });

  it('does not block a gate-excluded file — path profile remains', () => {
    const decision = computeGatingDecision([
      v({ ...RESOLVABLE, gateExcluded: true, resolution: { action: 'x', summary: 'y' } }),
    ], DEFAULT);
    expect(decision.blocking).toHaveLength(0);
  });

  it('blocks a resolvable finding with no resolution AND records the gap — R1', () => {
    const decision = computeGatingDecision([v({ ...RESOLVABLE })], DEFAULT);
    expect(decision.blocking).toHaveLength(1);
    expect(decision.resolutionGaps).toEqual([
      { rule: 'solid/class-size', file: 'src/a.ts', reason: 'no-resolution' },
    ]);
  });

  it('does not record a gap for a non-resolvable rule with no resolution', () => {
    const decision = computeGatingDecision([v({ ...NON_RESOLVABLE })], DEFAULT);
    expect(decision.blocking).toHaveLength(1);
    expect(decision.resolutionGaps).toHaveLength(0);
  });
});
