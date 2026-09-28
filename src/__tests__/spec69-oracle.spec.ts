/**
 * Spec 69 R1 — the completeness oracle (criteria 1–3).
 *
 * Three demonstrations, one per acceptance criterion:
 *   • criterion 1 (forcing function) — every file processor declares an `oracle`.
 *     The compile-time half is the sixth `@ts-expect-error` seed in
 *     seeded-defects.ts (a `FileProcessor` literal missing `oracle`); this is the
 *     runtime half — a producer whose `oracle` is `undefined` fails here even if
 *     the type were ever weakened to optional.
 *   • criterion 2 (per-file shortfall) — `oracleShortfall` records the file,
 *     processor, and both counts when a counted oracle's emitted count falls
 *     below its expected count. The unit test seeds a drop directly; the
 *     end-to-end test proves `processFile` → `buildFacts` → `oracleShortfalls`
 *     threads it, using the real `file-symbols` residual (a class's methods ride
 *     on the class symbol, so the oracle's node count exceeds the emitted
 *     symbols by design).
 *   • criterion 3 (enumeration) — `noOracleProcessors` lists every processor
 *     with no statable oracle, named with its reason; the counted ones are
 *     absent from the list.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { PRODUCERS, noOracleProcessors } from '../phase/producers.js';
import { oracleShortfall, countOracle, noOracle } from '../phase/oracles.js';
import { runPhaseModelOverFiles } from '../phase/phaseModel.js';
import type { ParsedFile } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** The known counted oracles — a processor whose completeness is measured. */
const COUNTED_IDS = new Set([
  'file-symbols.typescript',
  'file-symbols.tsx',
  'file-symbols.javascript',
  'imports.typescript',
  'imports.tsx',
  'imports.javascript',
  'export-form.typescript',
  'export-form.tsx',
  'export-form.javascript',
]);

describe('Spec 69 R1 criterion 1 — the oracle forcing function', () => {
  it('every file processor declares an oracle', () => {
    for (const [kind, formats] of Object.entries(PRODUCERS)) {
      for (const [format, p] of Object.entries(formats)) {
        const id = `${kind}.${format}`;
        expect(p.oracle, `${id} is missing its oracle`).toBeDefined();
        expect(['counted', 'none'], `${id} has an invalid oracle status`).toContain(p.oracle.status);
      }
    }
  });
});

describe('Spec 69 R1 criterion 2 — per-file shortfall recording', () => {
  const fake = { file: '/x.ts', format: 'typescript', source: '' } as ParsedFile;

  it('records a shortfall when a counted oracle emits fewer than expected', () => {
    const drop = countOracle(() => 3);
    expect(oracleShortfall(drop, fake, 2, 'file-symbols.typescript')).toEqual({
      file: '/x.ts',
      processor: 'file-symbols.typescript',
      expected: 3,
      actual: 2,
    });
  });

  it('does not record a shortfall at equality or over-emission (an upper bound)', () => {
    const oracle = countOracle(() => 3);
    expect(oracleShortfall(oracle, fake, 3, 'p')).toBeNull();
    expect(oracleShortfall(oracle, fake, 4, 'p')).toBeNull();
  });

  it('never records a shortfall for a none oracle', () => {
    expect(oracleShortfall(noOracle('no statable count'), fake, 0, 'p')).toBeNull();
  });

  it('threads the real file-symbols residual end to end', async () => {
    const result = await runPhaseModelOverFiles(
      [
        {
          path: 'with-methods.ts',
          content: 'export class Service {\n  fetch() { return 1; }\n  save() { return 2; }\n}\n',
        },
      ],
      new Map(),
      { enabledRules: new Set(['parameter-count']) },
    );
    const sf = result.oracleShortfalls.find((s) => s.processor === 'file-symbols.typescript');
    expect(sf, 'a class with methods should produce a positive file-symbols residual').toBeDefined();
    expect(sf!.file).toBe('with-methods.ts');
    // 1 class_declaration + 2 method_definition nodes vs 1 emitted class symbol
    // (methods ride on their class symbol, so the emitted count is lower).
    expect(sf!.expected).toBe(3);
    expect(sf!.actual).toBe(1);
  });
});

describe('Spec 69 R1 criterion 3 — no-oracle enumeration', () => {
  it('enumerates exactly the processors with no statable oracle, each with a reason', () => {
    const none = noOracleProcessors();
    // Completeness: the enumeration is exactly the non-counted processors.
    let total = 0;
    let counted = 0;
    for (const formats of Object.values(PRODUCERS)) {
      for (const p of Object.values(formats)) {
        total += 1;
        if (p.oracle.status === 'counted') counted += 1;
      }
    }
    expect(none.length).toBe(total - counted);

    const ids = new Set(none.map((e) => e.processor));
    // Counted processors are absent; a known none is present, named with a reason.
    for (const countedId of COUNTED_IDS) {
      expect(ids.has(countedId), `${countedId} is counted and must not be enumerated`).toBe(false);
    }
    expect(ids.has('function-index.typescript'), 'function-index has no oracle and must be enumerated').toBe(true);
    for (const e of none) {
      expect(e.reason.length, `${e.processor} must state a reason`).toBeGreaterThan(0);
    }
  });
});
