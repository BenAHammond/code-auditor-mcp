/**
 * Spec 68 §10 / §16.10 — config tunes, never selects (guard 10, acceptance 14).
 *
 * Config sets threshold values. It does not enable, disable, gate, or scope a
 * rule. The `configGate` / `offByDefault` / `handledLanguages` selection fields
 * are gone from the entry type, and `enabledMigratedRules()` is a pure function
 * of `MIGRATED_RULES` — no config key reaches it. This pins that three ways:
 *
 *   1. structural — `enabledMigratedRules()` returns exactly the migrated id
 *      set, and no `RuleDefinition` carries a selection flag;
 *   2. behavioral — two runs with different threshold maps produce the *same*
 *      set of rule ids in derived coverage (every rule in exactly one state);
 *   3. behavioral — a rule with no config entry still runs against its
 *      documented fallback (threshold absence is not selection).
 *
 * The defect class this removes is §0, rows 4–5: a rule that was off-by-default
 * (`parameter-documentation`, `return-documentation`) or behind a boolean gate
 * could be silently absent from a run. No such knob exists anymore, so a test
 * that would have failed before the migration now passes by construction.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { MIGRATED_RULES } from '../phase/rules/registry.js';
import { enabledMigratedRules } from '../phase/routing.js';
import { runPhaseModelOverFiles } from '../phase/phaseModel.js';
import { deriveCoverage } from '../phase/coverage.js';
import type { ThresholdValues } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

const THREE_PARAM_FN = 'function combine(a, b, c) {\n  return a + b + c;\n}\n';

describe('Spec 68 §16.10 — config cannot select', () => {
  it('enabledMigratedRules is the full migrated set, with no config key in the path', () => {
    const enabled = enabledMigratedRules();
    expect(enabled.size).toBe(MIGRATED_RULES.length);
    for (const rule of MIGRATED_RULES) {
      expect(enabled.has(rule.id)).toBe(true);
    }
  });

  it('no RuleDefinition carries a selection flag', () => {
    for (const rule of MIGRATED_RULES) {
      const keys = Object.keys(rule);
      for (const forbidden of ['configGate', 'offByDefault', 'handledLanguages', 'enabled', 'disabled']) {
        expect(keys, `rule "${rule.id}" must not carry "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it('different threshold maps produce the same set of rules in coverage', async () => {
    const files = [{ path: 'a.ts', content: THREE_PARAM_FN }];
    const empty = await runPhaseModelOverFiles(files, new Map());
    const configured = await runPhaseModelOverFiles(
      files,
      new Map<string, ThresholdValues>([
        ['parameter-count', { maxParametersPerMethod: 2 }],
        ['function-length', { maxLinesPerMethod: 3 }],
      ]),
    );

    const emptyCoverage = deriveCoverage({
      rules: MIGRATED_RULES,
      findings: empty.findings,
      presentFormats: new Set(['typescript']),
      enabledRules: enabledMigratedRules(),
      incompleteFacts: empty.incompleteFacts,
    });
    const configuredCoverage = deriveCoverage({
      rules: MIGRATED_RULES,
      findings: configured.findings,
      presentFormats: new Set(['typescript']),
      enabledRules: enabledMigratedRules(),
      incompleteFacts: configured.incompleteFacts,
    });

    // The set of rule ids that ran is identical — config changed only the
    // thresholds, never which rules exist in coverage.
    const ids = (c: { ruleId: string }[]) => c.map((r) => r.ruleId).sort();
    expect(ids(configuredCoverage)).toEqual(ids(emptyCoverage));
  });

  it('a rule with no config entry still runs against its documented fallback', async () => {
    // `parameter-count` fires only when maxParametersPerMethod < 3. No config
    // entry means the documented fallback (6) applies — the rule still runs,
    // it just produces nothing. Config tunes the threshold; it never de-selects.
    const noConfig = await runPhaseModelOverFiles(
      [{ path: 'a.ts', content: THREE_PARAM_FN }],
      new Map(),
      { enabledRules: new Set(['parameter-count']) },
    );
    expect(noConfig.findings.filter((f) => f.ruleId === 'parameter-count')).toHaveLength(0);

    const tuned = await runPhaseModelOverFiles(
      [{ path: 'a.ts', content: THREE_PARAM_FN }],
      new Map<string, ThresholdValues>([['parameter-count', { maxParametersPerMethod: 2 }]]),
      { enabledRules: new Set(['parameter-count']) },
    );
    expect(tuned.findings.filter((f) => f.ruleId === 'parameter-count')).toHaveLength(1);
  });
});
