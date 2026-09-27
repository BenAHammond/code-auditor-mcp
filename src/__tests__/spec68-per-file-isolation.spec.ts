/**
 * Spec 68 §3.3 / §16.8 — per-file failure isolation.
 *
 * The phase model must treat one file's failure as a *local* fact-completeness
 * defect, not a run-level abort. Two failure modes are pinned here, both
 * exercised through `runPhaseModelOverFiles` with the real producer stack:
 *
 *   - a producer that throws on one file: that (kind, file) pair is recorded
 *     `incomplete`, the file is not silently dropped (which would read `clean`),
 *     and the *other* files' producers still run — their findings appear.
 *   - a file that fails to parse (no adapter resolves it): every file fact kind
 *     that would have been produced from that file's format is recorded
 *     `incomplete`, and again the surviving files still produce findings.
 *
 * `incompleteFacts` is the feed §8's `deriveCoverage` consumes to emit the fifth
 * state (`incomplete`) instead of a false-negative `clean`. This test proves that
 * feed is reachable from a real run — not only from the hand-built map the
 * coverage conformance test constructs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runPhaseModelOverFiles } from '../phase/phaseModel.js';
import type { ThresholdValues } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** A function with three parameters — fires `parameter-count` at max 2. */
const THREE_PARAM_FN = 'function combine(a, b, c) {\n  return a + b + c;\n}\n';

const thresholds: ReadonlyMap<string, ThresholdValues> = new Map([
  ['parameter-count', { maxParametersPerMethod: 2 }],
]);

describe('Spec 68 §16.8 — per-file failure isolation', () => {
  it('a throwing producer records one file incomplete and leaves its neighbors intact', async () => {
    let calls = 0;
    const result = await runPhaseModelOverFiles(
      [
        { path: 'a.ts', content: THREE_PARAM_FN },
        { path: 'b.ts', content: THREE_PARAM_FN },
      ],
      thresholds,
      {
        enabledRules: new Set(['parameter-count']),
        beforeProcess: (kind, file) => {
          if (kind === 'file-symbols' && file === 'a.ts') {
            calls++;
            throw new Error('seeded producer failure');
          }
        },
      },
    );

    // The failure is observable, not swallowed: `a.ts` is incomplete for
    // `file-symbols` (a coverage signal), never a dropped file reading `clean`.
    const incomplete = result.incompleteFacts.get('file-symbols');
    expect(incomplete).toBeDefined();
    expect([...(incomplete ?? [])]).toEqual(['a.ts']);

    // The run continued: `b.ts` produced its finding, and only `b.ts` did.
    const fired = result.findings.filter((f) => f.ruleId === 'parameter-count');
    expect(fired.map((f) => f.file)).toEqual(['b.ts']);
    expect(calls).toBeGreaterThan(0);
  });

  it('a file that fails to parse is recorded incomplete for every fact kind its format supplies', async () => {
    // `x.xyz` resolves to no adapter, so `parseOne` returns null. `formatFor`
    // defaults it to `typescript`, whose `file-symbols` producer would otherwise
    // have served it — the parse-drop branch must mark that (kind, file) pair.
    const result = await runPhaseModelOverFiles(
      [
        { path: 'good.ts', content: THREE_PARAM_FN },
        { path: 'x.xyz', content: 'this is not valid typescript\n' },
      ],
      thresholds,
      { enabledRules: new Set(['parameter-count']) },
    );

    const incomplete = result.incompleteFacts.get('file-symbols');
    expect([...(incomplete ?? [])]).toEqual(['x.xyz']);

    // The surviving file still produced its finding.
    const fired = result.findings.filter((f) => f.ruleId === 'parameter-count');
    expect(fired.map((f) => f.file)).toEqual(['good.ts']);
  });
});
