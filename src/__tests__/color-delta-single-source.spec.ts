/**
 * Colour directive item 2 — the `colorDeltaE` default has one source of truth.
 *
 * The value-drift threshold (`colorDeltaE`) used to be a `2.5` literal in three
 * default objects: `DEFAULT_ANALYZER_CONFIGS.styles` (config), `STYLES_DEFAULTS`
 * (phase rule), and `DEFAULT_STYLES_CONFIG` (legacy analyzer). Three copies of a
 * tunable is a hardcode with three chances to drift. This test locks the wiring:
 * the phase rule and the legacy analyzer both read `DEFAULT_COLOR_DELTA_E` from
 * `src/config/defaults.ts`, so changing that one symbol changes both consumers.
 *
 * This test is the *value* guard — it fails if any consumer's default drifts
 * away from the source. The *literal* guard (that `2.5` is not re-declared
 * outside `defaults.ts`) is the residue grep, not testable here: a primitive
 * equal to the source is indistinguishable from a re-declared literal.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_COLOR_DELTA_E, DEFAULT_ANALYZER_CONFIGS } from '../config/defaults.js';
import { DEFAULT_STYLES_CONFIG } from '../analyzers/universal/UniversalStylesAnalyzer.js';
import { STYLES_DEFAULTS } from '../phase/rules/styles.js';

describe('colorDeltaE single source (item 2)', () => {
  it('exposes the single default from config/defaults.ts', () => {
    // The config namespace reads the named constant — the literal lives here.
    expect(DEFAULT_ANALYZER_CONFIGS.styles.colorDeltaE).toBe(DEFAULT_COLOR_DELTA_E);
  });

  it('the phase rule reads the single default', () => {
    expect(STYLES_DEFAULTS.colorDeltaE).toBe(DEFAULT_COLOR_DELTA_E);
  });

  it('the legacy analyzer reads the single default', () => {
    expect(DEFAULT_STYLES_CONFIG.colorDeltaE).toBe(DEFAULT_COLOR_DELTA_E);
  });

  it('phase rule and legacy analyzer agree on the default', () => {
    expect(STYLES_DEFAULTS.colorDeltaE).toBe(DEFAULT_STYLES_CONFIG.colorDeltaE);
  });
});
