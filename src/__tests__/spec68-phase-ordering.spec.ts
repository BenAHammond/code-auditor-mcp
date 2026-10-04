/**
 * Spec 68 §1 / §16.5 — phase ordering (guard 5, acceptance 6).
 *
 * The three phases are strictly ordered: no rule's `analyze` is invoked before
 * every file has been parsed and every processor level has completed. This is a
 * *structural* property of `runPhaseModelOverFiles` — `analyzeAll` is only
 * called after `buildFacts` returns — but the guard pins it against a seeded
 * slow processor: a producer that takes real wall-clock must finish before the
 * first rule runs, or the property is a claim rather than an invariant.
 *
 * The observation points are the two §16 seams on `PhaseInfra`: `beforeProcess`
 * (awaited before each producer) and `beforeAnalyze` (awaited before the first
 * rule). The event log they append must show every processor completing before
 * `analyze` — and `analyze` strictly last.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runPhaseModelOverFiles } from '../phase/phaseModel.js';
import type { ThresholdValues } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

const THREE_PARAM_FN = 'function combine(a, b, c) {\n  return a + b + c;\n}\n';

const thresholds: ReadonlyMap<string, ThresholdValues> = new Map([
  ['parameter-count', { maxParametersPerMethod: 2 }],
]);

describe('Spec 68 §16.5 — phase ordering (seeded slow processor)', () => {
  it('does not begin analysis until the slow processor has completed', async () => {
    const events: string[] = [];
    const result = await runPhaseModelOverFiles(
      [
        { path: 'slow.ts', content: THREE_PARAM_FN },
        { path: 'fast.ts', content: THREE_PARAM_FN },
      ],
      thresholds,
      {
        enabledRules: new Set(['parameter-count']),
        beforeProcess: async (kind, file) => {
          if (kind !== 'file-symbols') return;
          if (file === 'slow.ts') {
            events.push('process:slow:start');
            await new Promise((r) => setTimeout(r, 40));
            events.push('process:slow:end');
          } else {
            events.push(`process:${file}`);
          }
        },
        beforeAnalyze: () => {
          events.push('analyze');
        },
      },
    );

    // The slow producer finished before the first rule ran, and analysis is last.
    expect(events).toEqual([
      'process:slow:start',
      'process:slow:end',
      'process:fast.ts',
      'analyze',
    ]);

    // The run still completed: both files produced their finding.
    const fired = result.findings.filter((f) => f.ruleId === 'parameter-count');
    expect(fired.map((f) => f.file).sort()).toEqual(['fast.ts', 'slow.ts']);
  });

  it('analysis follows corpus-processor completion, not just per-file completion', async () => {
    // `resolution` is a corpus producer reduced from `ddl-declarations` after
    // every file's producers have run. The ordering seam must show the corpus
    // level (and the per-file level) complete before `analyze`.
    const events: string[] = [];
    await runPhaseModelOverFiles(
      [
        { path: 'a.ts', content: THREE_PARAM_FN },
        { path: 'b.ts', content: THREE_PARAM_FN },
      ],
      thresholds,
      {
        enabledRules: new Set(['parameter-count']),
        beforeProcess: async (kind, file) => {
          events.push(`process:${kind}:${file}`);
          if (file === 'a.ts') {
            await new Promise((r) => setTimeout(r, 20));
          }
        },
        beforeAnalyze: () => {
          events.push('analyze');
        },
      },
    );

    const analyzeAt = events.indexOf('analyze');
    expect(analyzeAt).toBeGreaterThan(0);
    // Every processing event precedes analysis.
    expect(events.slice(0, analyzeAt).every((e) => e.startsWith('process:'))).toBe(true);
    // Analysis is the final event — nothing runs after it.
    expect(analyzeAt).toBe(events.length - 1);
  });
});
