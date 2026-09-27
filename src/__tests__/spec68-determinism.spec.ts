/**
 * Spec 68 §6.4 / §16.7 — determinism across worker counts (guard 7, acceptance 12).
 *
 * The phase model's per-file fan-out must not reorder output. Same repository,
 * one worker and eight workers, byte-identical report. This pins the guarantee
 * at the `runPhaseModelOverFiles` seam: the fact merge is file-sorted, and rules
 * run in registry order, so the findings array — not just a canonicalized sort
 * of it — is identical regardless of `workerCount`.
 *
 * The files are inserted in a deliberately non-lexicographic order and one of
 * them fails to parse, so a completion-order-dependent merge would surface as a
 * reordering or a dropped `incomplete` entry here.
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
const threeParam = (name: string) =>
  `function ${name}(a, b, c) {\n  return a + b + c;\n}\n`;

const thresholds: ReadonlyMap<string, ThresholdValues> = new Map([
  ['parameter-count', { maxParametersPerMethod: 2 }],
]);

// Insertion order is shuffled on purpose; the file-sorted merge must dominate.
const corpus = [
  { path: 'zeta.ts', content: threeParam('zetaFn') },
  { path: 'alpha.ts', content: threeParam('alphaFn') },
  { path: 'mid.ts', content: threeParam('midFn') },
  { path: 'bad.xyz', content: 'this is not valid typescript\n' }, // parse drop
  { path: 'beta.ts', content: threeParam('betaFn') },
  { path: 'omega.ts', content: threeParam('omegaFn') },
  { path: 'gamma.ts', content: threeParam('gammaFn') },
  { path: 'delta.ts', content: threeParam('deltaFn') },
  { path: 'epsilon.ts', content: threeParam('epsilonFn') },
  { path: 'eta.ts', content: threeParam('etaFn') },
];

describe('Spec 68 §6.4 — determinism across worker counts', () => {
  it('one worker and eight produce the identical findings array, in order', async () => {
    const serial = await runPhaseModelOverFiles(corpus, thresholds, {
      enabledRules: new Set(['parameter-count']),
      workerCount: 1,
    });
    const parallel = await runPhaseModelOverFiles(corpus, thresholds, {
      enabledRules: new Set(['parameter-count']),
      workerCount: 8,
    });

    // Byte-identical, not just deep-equal-after-sort: the array order itself
    // must be stable, since consumers' SARIF fingerprints and baselines key on it.
    expect(JSON.stringify(parallel.findings)).toBe(JSON.stringify(serial.findings));
    expect(JSON.stringify(parallel.incompleteFacts, replacerForMap)).toBe(
      JSON.stringify(serial.incompleteFacts, replacerForMap),
    );
  });

  it('the findings are file-sorted, not completion-ordered', async () => {
    const result = await runPhaseModelOverFiles(corpus, thresholds, {
      enabledRules: new Set(['parameter-count']),
      workerCount: 8,
    });
    const files = result.findings.map((f) => f.file);
    expect(files).toEqual([...files].sort());
    // The unparseable `bad.xyz` produced no finding, so every finding is a .ts.
    expect(files).not.toContain('bad.xyz');
  });

  it('the parse drop is recorded incomplete identically at both widths', async () => {
    const serial = await runPhaseModelOverFiles(corpus, thresholds, {
      enabledRules: new Set(['parameter-count']),
      workerCount: 1,
    });
    const parallel = await runPhaseModelOverFiles(corpus, thresholds, {
      enabledRules: new Set(['parameter-count']),
      workerCount: 8,
    });
    expect([...(parallel.incompleteFacts.get('file-symbols') ?? [])]).toEqual(
      [...(serial.incompleteFacts.get('file-symbols') ?? [])],
    );
  });
});

/** `Map`/`Set` are not JSON-serializable with plain stringify; normalize to
 *  plain objects/arrays so the byte-identical assertion covers `incompleteFacts`
 *  too. */
function replacerForMap(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
