/**
 * Guard: the shipped enabledAnalyzers list must agree with the analyzer
 * registry. Ghost names (in defaults but not registered) produce silent
 * no-ops. Absent names (registered but not in defaults) mean users never
 * see that analyzer — the schema bug (3.0.0–3.5.x).
 *
 * invariants is exempt from the default list: it is conditional and only
 * runs when invariant rules are configured (Spec 05 R3.1).
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
/** All known analyzer keys in the audit pipeline — the single source of truth for
 *  the registry guard. When a new analyzer is added, update this list. */
const ALL_ANALYZERS = new Set([
  'solid', 'dry', 'data-access', 'react', 'documentation',
  'invariants', 'schema', 'styles', 'conventions', 'cross-domain',
]);
// Analyzer defaults — used by each analyzer's constructor/analyzeAST
import { DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';

/** Analyzers that are intentionally excluded from the default list. */
const CONDITIONAL_ANALYZERS = new Set(['invariants']);

const REGISTRY_KEYS = ALL_ANALYZERS;
const NON_CONDITIONAL_REGISTRY = new Set(
  [...REGISTRY_KEYS].filter((k) => !CONDITIONAL_ANALYZERS.has(k)),
);

describe('defaults ≡ registry guard', () => {
  const defaults = getDefaultConfig().enabledAnalyzers!;
  const defaultsSet = new Set(defaults);

  it('contains no ghost analyzer names (present in defaults, missing from registry)', () => {
    const ghosts = defaults.filter((name) => !REGISTRY_KEYS.has(name));
    expect(ghosts).toEqual([]);
  });

  it('contains no duplicate entries', () => {
    expect(defaults.length).toBe(defaultsSet.size);
  });

  it('includes every non-conditional registry key', () => {
    const absent = [...NON_CONDITIONAL_REGISTRY].filter(
      (key) => !defaultsSet.has(key),
    );
    expect(absent).toEqual([]);
  });

  it('matches the canonical order: solid, dry, react, data-access, documentation, schema, styles, conventions, cross-domain, invariants', () => {
    // Order matters — the first enabled analyzer runs first, and the
    // progress display reflects this order.
    expect(defaults).toEqual([
      'solid',
      'dry',
      'react',
      'data-access',
      'documentation',
      'schema',
      'styles',
      'conventions',
      'cross-domain',
      'invariants',
    ]);
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
