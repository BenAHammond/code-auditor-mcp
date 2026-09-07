/**
 * Guard: the shipped enabledAnalyzers list must agree with the canonical
 * analyzer set — which is now DERIVED from RULE_REGISTRY (the unique `analyzer`
 * values) rather than hand-typed. Ghost names (in defaults but not registered)
 * produce silent no-ops; absent names (registered but not in defaults) mean
 * users never see that analyzer — the schema bug (3.0.0–3.5.x), which recurred
 * as the four-list drift (RULE_REGISTRY 13 vs defaults 10 vs registry 10 vs
 * validateConfig 7).
 *
 * This test asserts the DEFAULT list is *exactly* the canonical ALL_ANALYZERS,
 * so a divergent hand-maintained list can never sneak back in.
 *
 * Guard 2 (Spec 22 Item 3): the config objects in DEFAULT_ANALYZER_CONFIGS
 * must be structurally consistent with each analyzer's own DEFAULT_*_CONFIG.
 * A key-name mismatch between the two surfaces (e.g. `parameterized` in
 * defaults vs `parameterizedQueries` in the analyzer) survives shallow-spread
 * merge because the nested object is replaced wholesale. The merge-path test
 * below directly replicates the production merge that each analyzer performs:
 *   const finalConfig = { ...DEFAULT_*_CONFIG, ...(user config) };
 */
import { describe, it, expect } from 'vitest';
import { getDefaultConfig, DEFAULT_ANALYZER_CONFIGS } from '../config/defaults.js';
import { ALL_ANALYZERS } from '../analyzers/ruleRegistry.js';
// Analyzer defaults — used by each analyzer's constructor/analyzeAST
import { DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { DEFAULT_DRY_CONFIG } from '../analyzers/universal/UniversalDRYAnalyzer.js';

describe('defaults ≡ registry guard', () => {
  const defaults = getDefaultConfig().enabledAnalyzers!;

  it('equals the canonical ALL_ANALYZERS (derived from RULE_REGISTRY, not hand-typed)', () => {
    expect(defaults).toEqual([...ALL_ANALYZERS]);
  });

  it('contains no duplicate entries', () => {
    expect(defaults.length).toBe(new Set(defaults).size);
  });

  it('ALL_ANALYZERS itself is de-duplicated and sorted (canonical form)', () => {
    expect([...ALL_ANALYZERS]).toEqual([...new Set(ALL_ANALYZERS)].sort());
  });
});

// ---------------------------------------------------------------------------
// Spec 22 Item 3 — config-key guards
//
// The analyzer config merge in each UniversalAnalyzer subclass is:
//   const finalConfig = { ...DEFAULT_*_CONFIG, ...(user config) };
//
// This is a SHALLOW spread. When the user config has e.g.
// `securityPatterns: { parameterized: [...] }`, the ENTIRE
// `securityPatterns` object from the analyzer's DEFAULT is replaced
// — including the `parameterizedQueries` key that checkQuerySecurity()
// reads. The fix is key-name alignment, and these guards prevent
// regression.
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

    it('DEFAULT_ANALYZER_CONFIGS.dry.divergence mirrors the auditRunner fallback', () => {
      // auditRunner.ts:949-951 reads divergence from analyzerConfigs.dry.divergence
      // with a hardcoded fallback of { 0.05, 2, 0.5 }. The exported namespace must
      // not advertise a different divergence default than the one actually applied.
      expect(DEFAULT_ANALYZER_CONFIGS.dry.divergence).toEqual({
        divergenceThreshold: 0.05,
        divergenceRuns: 2,
        minPairSimilarity: 0.5,
      });
    });
  });

  describe('data-access analyzer merge path', () => {
    it('preserves parameterizedQueries through the production shallow-spread merge', () => {
      // Replicate the production merge in UniversalDataAccessAnalyzer.analyzeAST:
      //   const finalConfig = { ...DEFAULT_DATA_ACCESS_CONFIG, ...config };
      //
      // When the user's analyzerConfigs.dataAccess is DEFAULT_ANALYZER_CONFIGS.dataAccess
      // (i.e., no explicit user override), the merge must not lose
      // `securityPatterns.parameterizedQueries`.
      const defaultsDataAccess = DEFAULT_ANALYZER_CONFIGS.dataAccess;
      const merged = { ...DEFAULT_DATA_ACCESS_CONFIG, ...defaultsDataAccess };

      // The parameterizedQueries key, read by checkQuerySecurity(), must survive
      expect(merged.securityPatterns?.parameterizedQueries).toBeDefined();
      expect(Array.isArray(merged.securityPatterns!.parameterizedQueries)).toBe(true);
      expect(merged.securityPatterns!.parameterizedQueries!.length).toBeGreaterThan(0);
    });

    it('documents that sqlInjectionRisks is replaced by the shallow-spread merge (low-impact)', () => {
      // The production merge: { ...DEFAULT_DATA_ACCESS_CONFIG, ...config }
      // replaces the ENTIRE securityPatterns object. When the config has
      // securityPatterns, the analyzer's own sqlInjectionRisks is lost.
      // Impact is near-zero: the hardcoded patterns in checkQuerySecurity()
      // already cover '${' and 'concat'; 'string interpolation' matches
      // nothing in real SQL. This test is documentation, not a bug claim.
      const defaultsDataAccess = DEFAULT_ANALYZER_CONFIGS.dataAccess;
      const merged = { ...DEFAULT_DATA_ACCESS_CONFIG, ...defaultsDataAccess };

      // parameterizedQueries survives — this is the critical path
      expect(merged.securityPatterns?.parameterizedQueries).toBeDefined();
      // sqlInjectionRisks does NOT survive — known, low-impact
      expect(merged.securityPatterns?.sqlInjectionRisks).toBeUndefined();
    });

    it('rejects the old parameterized key name (regression guard)', () => {
      // The bug was that DEFAULT_ANALYZER_CONFIGS.dataAccess.securityPatterns
      // had the key `parameterized` while the analyzer's checkQuerySecurity()
      // reads `parameterizedQueries`. The old key must not return.
      const defaultsDataAccess = DEFAULT_ANALYZER_CONFIGS.dataAccess;
      const sp = defaultsDataAccess.securityPatterns as Record<string, unknown> | undefined;
      expect(sp?.parameterized).toBeUndefined();
    });

    it('rejects ghost sanitized key (never consumed by any analyzer)', () => {
      // Ghost keys — config entries that no analyzer reads — are the same
      // class as the ghost security/component config sections deleted in
      // v3.4.3. sanitized was co-located with the old parameterized key
      // and was never consumed by checkQuerySecurity() or any other code.
      const defaultsDataAccess = DEFAULT_ANALYZER_CONFIGS.dataAccess;
      const sp = defaultsDataAccess.securityPatterns as Record<string, unknown> | undefined;
      expect(sp?.sanitized).toBeUndefined();
    });
  });
});
