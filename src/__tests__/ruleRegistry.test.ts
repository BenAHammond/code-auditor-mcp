/**
 * Spec 37 R2/R3 — the rule registry is a contract.
 *
 * Every consumer (the gate, print-config, threshold reporting) relies on the
 * registry carrying the full rule metadata; a rule that drops a field silently
 * changes what the gate and reports can rely on. These tests make a missing
 * field a build failure rather than a warning, and enforce the substantive
 * invariants that make the contract meaningful:
 *
 *   - a rule with `thresholds` names real config keys in its analyzer's default
 *     config (Spec 37 R2 / Spec 36 R5) — a threshold that names a ghost key
 *     makes threshold reporting and `--print-config` lie.
 *   - every rule ships inline valid/invalid samples, at least one valid sample
 *     is a near-miss, and resolvable rules assert a `resolution` on each invalid
 *     sample (Spec 37 R3).
 *
 * Spec 45 R1 removes the per-rule `gating` opt-in: every registered rule gates.
 * There is no `gating` field to assert, and no `gating ⇒ resolvable` invariant.
 */
import { describe, it, expect } from 'vitest';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';
import { RUNTIME_DEFAULT_CONFIGS, flatten } from '../config/effectiveConfig.js';

const ENTRIES = Object.entries(RULE_REGISTRY);

describe('rule registry contract — Spec 37 R2/R3', () => {
  it('carries every required field on every entry (missing = build failure)', () => {
    const missing: string[] = [];
    for (const [id, e] of ENTRIES) {
      if (typeof e.resolvable !== 'boolean') missing.push(`${id}.resolvable`);
      if (typeof e.message !== 'string' || e.message.trim() === '') missing.push(`${id}.message`);
      if (typeof e.docs !== 'string' || e.docs.trim() === '') missing.push(`${id}.docs`);
      if (!Array.isArray(e.thresholds)) missing.push(`${id}.thresholds`);
      if (!e.samples || !Array.isArray(e.samples.valid) || !Array.isArray(e.samples.invalid)) {
        missing.push(`${id}.samples`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every rule ships both valid and invalid samples (Spec 37 R3)', () => {
    const missing = ENTRIES
      .filter(([, e]) => e.samples.valid.length === 0 || e.samples.invalid.length === 0)
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  it('every rule has at least one near-miss valid sample (Spec 37 R3)', () => {
    const missing = ENTRIES
      .filter(([, e]) => !e.samples.valid.some((s) => s.nearMiss === true))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  it('every invalid sample of a resolvable rule asserts its resolution (Spec 37 R3)', () => {
    const missing = ENTRIES
      .filter(([, e]) => e.resolvable)
      .filter(([, e]) => e.samples.invalid.some((s) => !s.resolution))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  it('every threshold names a real config key in its analyzer default (Spec 37 R2 / Spec 36 R5)', () => {
    const ghosts: string[] = [];
    for (const [id, e] of ENTRIES) {
      if (e.thresholds.length === 0) continue;
      const defaults = RUNTIME_DEFAULT_CONFIGS[e.analyzer];
      if (!defaults) {
        // A rule that names a threshold must live in an analyzer with a runtime
        // default config surface; otherwise threshold reporting cannot resolve it.
        ghosts.push(`${id} (analyzer ${e.analyzer} has no RUNTIME_DEFAULT_CONFIGS entry)`);
        continue;
      }
      const flat = flatten(defaults, e.analyzer);
      for (const t of e.thresholds) {
        const fullKey = `${e.analyzer}.${t}`;
        if (!(fullKey in flat)) {
          ghosts.push(`${id}.${t} (missing from ${e.analyzer} defaults; have: ${Object.keys(flat).join(', ')})`);
        }
      }
    }
    expect(ghosts).toEqual([]);
  });
});
