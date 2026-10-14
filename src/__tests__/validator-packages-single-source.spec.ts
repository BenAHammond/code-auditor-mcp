/**
 * Guard (Spec 21 R4 / config-sweep orphan restore): the validator-package
 * vocabulary has a single source of truth — `DEFAULT_VALIDATOR_PACKAGES` in
 * `src/config/defaults.ts`. It replaced the hand-maintained `VALIDATOR_PACKAGES`
 * `ReadonlySet` that lived in `provenance.ts` and silently did the job of the
 * deleted `validatorPackageList` config key.
 *
 * The config default (`crossDomain.validatorBypass.validatorPackageList`) must
 * be the *same* array object, so a consumer that reads the config key and falls
 * back to `DEFAULT_VALIDATOR_PACKAGES` is not fallback onto a divergent copy.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_ANALYZER_CONFIGS, DEFAULT_VALIDATOR_PACKAGES } from '../config/defaults.js';

describe('validator-package single source', () => {
  it('crossDomain.validatorBypass.validatorPackageList is the single default', () => {
    expect(DEFAULT_ANALYZER_CONFIGS.crossDomain.validatorBypass.validatorPackageList).toBe(
      DEFAULT_VALIDATOR_PACKAGES,
    );
  });

  it('the default list is the 9-package vocabulary, unchanged', () => {
    expect([...DEFAULT_VALIDATOR_PACKAGES].sort()).toEqual([
      '@sinclair/typebox',
      'ajv',
      'arktype',
      'class-validator',
      'joi',
      'superstruct',
      'valibot',
      'yup',
      'zod',
    ]);
  });
});
