/**
 * Guard (Spec 22 Item 3): the config objects in DEFAULT_ANALYZER_CONFIGS
 * must be structurally consistent with each analyzer's own DEFAULT_*_CONFIG.
 * A key-name mismatch between the two surfaces survives shallow-spread merge
 * because the nested object is replaced wholesale. The merge-path test below
 * directly replicates the production merge that each analyzer performs:
 *   const finalConfig = { ...DEFAULT_*_CONFIG, ...(user config) };
 */
import { describe, it, expect } from 'vitest';
import { getDefaultConfig, getProjectTypeDefaults, getEnvironmentDefaults, DEFAULT_ANALYZER_CONFIGS } from '../config/defaults.js';
// Analyzer defaults — used by each analyzer's constructor/analyzeAST
import { DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { DEFAULT_DRY_CONFIG } from '../analyzers/universal/UniversalDRYAnalyzer.js';

// ---------------------------------------------------------------------------
// Spec 22 Item 3 — config-key guards
//
// The analyzer config merge in each UniversalAnalyzer subclass is:
//   const finalConfig = { ...DEFAULT_*_CONFIG, ...(user config) };
//
// This is a SHALLOW spread: when the user config names a nested object, the
// ENTIRE nested object from the analyzer's DEFAULT is replaced. The fix is
// key-name alignment, and these guards prevent regression.
// ---------------------------------------------------------------------------

describe('config-key guards (Spec 22 Item 3)', () => {
  describe('dry defaults drift (Spec 49 after-33)', () => {
    it('DEFAULT_ANALYZER_CONFIGS.dry mirrors the authoritative DEFAULT_DRY_CONFIG', () => {
      // DEFAULT_ANALYZER_CONFIGS.dry is exported from the library but never
      // merged into the pipeline; the analyzer enforces DEFAULT_DRY_CONFIG.
      // The two surfaces drifted (minLineThreshold 3 vs 15, similarityThreshold
      // 0.5 vs 0.85, checkImports/checkStrings true vs false). This pins the
      // exported namespace to the enforced values so the public export cannot
      // lie again — `divergence` is the one key the pipeline reads separately.
      const { divergence, ...dryDefaults } = DEFAULT_ANALYZER_CONFIGS.dry;
      expect(dryDefaults).toEqual(DEFAULT_DRY_CONFIG);
    });

    it('DEFAULT_ANALYZER_CONFIGS.dry.divergence mirrors the diverging-clone fallback', () => {
      // The migrated `dry/diverging-clone` rule (phase/rules/dry.ts) reads
      // divergence from `dry.divergence` with a hardcoded fallback of
      // { 0.05, 2, 0.5 } — the same precedence the legacy auditRunner Phase 2
      // used. The exported namespace must not advertise a different divergence
      // default than the one actually applied.
      expect(DEFAULT_ANALYZER_CONFIGS.dry.divergence).toEqual({
        divergenceThreshold: 0.05,
        divergenceRuns: 2,
        minPairSimilarity: 0.5,
      });
    });
  });

  describe('data-access analyzer merge path', () => {
    it('removes parameterizedQueries from both config surfaces (short-circuit deleted)', () => {
      // checkQuerySecurity's whole-text substring short-circuit over
      // `securityPatterns.parameterizedQueries` was deleted: a presence test on the
      // query text (`prepared`, `parameterized`, `$1`, `:param`) cleared any query
      // whose text contained one of those before isSafeDynamicPart ran. With the
      // short-circuit gone and no other consumer, the key must not exist on either
      // config surface — a user cannot put it back and re-enable the false negative.
      const analyzerSp = DEFAULT_DATA_ACCESS_CONFIG.securityPatterns as Record<string, unknown> | undefined;
      expect(analyzerSp?.parameterizedQueries).toBeUndefined();
      const defaultsSp = DEFAULT_ANALYZER_CONFIGS.dataAccess.securityPatterns as Record<string, unknown> | undefined;
      expect(defaultsSp?.parameterizedQueries).toBeUndefined();
    });

    it('rejects the old parameterized key name (regression guard)', () => {
      // The old key was `parameterized` (singular) in DEFAULT_ANALYZER_CONFIGS.
      // It must not return under any name.
      const defaultsDataAccess = DEFAULT_ANALYZER_CONFIGS.dataAccess;
      const sp = defaultsDataAccess.securityPatterns as Record<string, unknown> | undefined;
      expect(sp?.parameterized).toBeUndefined();
    });

    it('rejects ghost sanitized key (never consumed by any analyzer)', () => {
      // Ghost keys — config entries that no analyzer reads — are the same
      // class as the ghost security/component config sections deleted in
      // v3.4.3. sanitized was co-located with the old parameterized key
      // and was never consumed by any code.
      const defaultsDataAccess = DEFAULT_ANALYZER_CONFIGS.dataAccess;
      const sp = defaultsDataAccess.securityPatterns as Record<string, unknown> | undefined;
      expect(sp?.sanitized).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Report-output defaults must not be advertised
// ---------------------------------------------------------------------------
//
// `outputFormats`/`outputDirectory` were dead defaults: nothing in the run path
// read them, but `print-config` surfaced them as defaults, so a user copied the
// key into `.codeauditor.json` and either got refused (`output-directory-refused`)
// or silently ignored. They are removed from the defaults so print-config stops
// advertising a key the loader then refuses/ignores.
describe('report-output defaults are not advertised', () => {
  it('getDefaultConfig has no outputFormats/outputDirectory key', () => {
    const defaults = getDefaultConfig() as Record<string, unknown>;
    expect('outputFormats' in defaults).toBe(false);
    expect('outputDirectory' in defaults).toBe(false);
  });

  it('project-type and environment defaults do not reintroduce outputFormats', () => {
    for (const t of ['nextjs', 'react', 'node']) {
      expect('outputFormats' in (getProjectTypeDefaults(t) as Record<string, unknown>)).toBe(false);
    }
    for (const e of ['ci', 'development', 'production']) {
      expect('outputFormats' in (getEnvironmentDefaults(e) as Record<string, unknown>)).toBe(false);
    }
  });
});
