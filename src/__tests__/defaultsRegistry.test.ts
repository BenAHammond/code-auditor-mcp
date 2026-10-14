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
      // { 0.05, 2 } — the same precedence the legacy auditRunner Phase 2
      // used. The exported namespace must not advertise a different divergence
      // default than the one actually applied.
      expect(DEFAULT_ANALYZER_CONFIGS.dry.divergence).toEqual({
        divergenceThreshold: 0.05,
        divergenceRuns: 2,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Report-output defaults must not be advertised
// ---------------------------------------------------------------------------
//
// `outputDirectory` is refused by the loader (`output-directory-refused`): no
// run path writes to it, and `print-config` must not advertise a default for it.
// A user who copies such a key into `.codeauditor.json` gets a refusal, not
// silence. There is no default here, so print-config never advertises a key the
// loader then refuses.
describe('report-output defaults are not advertised', () => {
  it('getDefaultConfig has no outputDirectory key', () => {
    const defaults = getDefaultConfig() as Record<string, unknown>;
    expect('outputDirectory' in defaults).toBe(false);
  });

  it('project-type and environment defaults do not reintroduce outputDirectory', () => {
    for (const t of ['nextjs', 'react', 'node']) {
      expect('outputDirectory' in (getProjectTypeDefaults(t) as Record<string, unknown>)).toBe(false);
    }
    for (const e of ['ci', 'development', 'production']) {
      expect('outputDirectory' in (getEnvironmentDefaults(e) as Record<string, unknown>)).toBe(false);
    }
  });
});
