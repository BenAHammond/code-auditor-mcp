/**
 * Default configurations for the code auditor
 */

import { AuditConfig, ChurnConfig, PathProfile } from '../types.js';

/**
 * Get default configuration
 *
 * @returns The built-in default audit configuration.
 */
export function getDefaultConfig(): AuditConfig {
  return {
    // Spec 42 — markup/component extensions carry embedded `<style>` blocks and
    // class attributes. They were in fileDiscovery's MARKUP_EXTENSIONS (so they
    // were discovered) but absent from this positive-selection includePaths glob
    // list, which silently dropped them before the style indexer could read
    // them. A `.svelte`/`.astro`/`.vue` file in a project was therefore never
    // style-indexed — Svelte support that never saw real input.
    includePaths: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.cts', '**/*.mjs', '**/*.cjs', '**/*.go', '**/*.css', '**/*.scss', '**/*.svelte', '**/*.astro', '**/*.vue', '**/*.sql', '**/*.prisma'],
    excludePaths: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.test.{ts,tsx,js,jsx}',
      '**/*.spec.{ts,tsx,js,jsx}'
    ],
    // Note: no `outputDirectory` default. Reports are written only to an explicit
    // CLI `--output` path (or stdout); a config default here would advertise a key
    // that `print-config` then shows and the loader then refuses. See
    // configLoader.ts `output-directory-refused`.
    minSeverity: 'high',
    // Spec 11 sweep follow-up — the health-score floor, single-sourced to
    // DEFAULT_HEALTH_SCORE_THRESHOLD (referenced, not re-declared). The removed
    // `maxSevere`/`maxCritical`/`maxHigh` siblings are gone for good.
    thresholds: { minHealthScore: DEFAULT_HEALTH_SCORE_THRESHOLD },
    // Spec 54 R3 — severity is urgency, not permission. There is no
    // `severityOverrides` and no `gateSeverities`: every rule is assigned on the
    // urgency axis (critical/severe/high) and every finding blocks. Per-rule
    // severity tuning disappeared with the old vocabulary.
    // Spec 13 R1 — churn lookback window. The single default lives in
    // DEFAULT_CHURN_CONFIG above; referencing it here (not re-declaring) is what
    // keeps `loadConfig` and `print-config` honest about the effective value.
    churn: DEFAULT_CHURN_CONFIG,
    // Spec 50 R5 — daemon lifecycle. Never auto-start (a background process the
    // user did not ask for); idle-exit after 5 minutes so it does not linger.
    daemon: {
      autoStart: false,
      idleTimeoutMs: 5 * 60 * 1000,
    },
  };
}

/**
 * Get project type specific defaults
 *
 * @param projectType The project kind (`nextjs`, `react`, `node`, …).
 * @returns Project-type-specific defaults, or an empty object when unknown.
 */
export function getProjectTypeDefaults(projectType: string): Partial<AuditConfig> {
  switch (projectType) {
    case 'nextjs':
      return {
        includePaths: ['app/**/*.{ts,tsx}', 'pages/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
        excludePaths: [
          ...getDefaultConfig().excludePaths!,
          '**/.next/**',
          '**/public/**'
        ]
      };
    
    case 'react':
      return {
        includePaths: ['src/**/*.{ts,tsx,js,jsx}'],
        excludePaths: [
          ...getDefaultConfig().excludePaths!,
          '**/public/**',
          '**/build/**'
        ]
      };
    
    case 'node':
      return {
        includePaths: ['src/**/*.{ts,js}', 'lib/**/*.{ts,js}']
      };
    
    default:
      return {};
  }
}

/**
 * Get environment-specific defaults
 *
 * @param env The environment (`ci`, `development`, `production`, …).
 * @returns Environment-specific defaults, or an empty object when unknown.
 */
export function getEnvironmentDefaults(env: string): Partial<AuditConfig> {
  switch (env) {
    case 'ci':
      return {};

    case 'development':
      return {
        minSeverity: 'high'
      };

    case 'production':
      return {
        minSeverity: 'severe'
      };
    
    default:
      return {};
  }
}

/**
 * The value-drift colour threshold — the single source of truth for the
 * `styles.colorDeltaE` config key (Spec 70 colour directive, item 2). The phase
 * rule (`src/phase/rules/styles.ts`) and the legacy analyzer
 * (`src/analyzers/universal/UniversalStylesAnalyzer.ts`) both read this symbol;
 * the literal must not be re-declared elsewhere.
 *
 * `1.0` is the CIEDE2000 (ΔE00) just-noticeable difference. The CIEDE2000
 * formula (Sharma, Wu & Dalal 2005, "The CIEDE2000 color-difference formula:
 * Implementation notes, supplementary test data, and mathematical observations",
 * Color Research & Application 30(1):21–30, doi:10.1002/col.20070; standardised
 * as CIE 142-2001 / ISO/CIE 11664-6) is normalised so ΔE00 = 1.0 is the
 * threshold of human perception: pairs with ΔE00 < 1.0 are perceptually
 * indistinguishable ("near-identical") — exactly the drift the rule flags. The
 * metric changed ΔE76 → ΔE00 in Spec 70 colour directive item 4; the prior ΔE76
 * default of 2.5 was "JND-adjacent" to the ~2.3 ΔE76 JND with no written
 * citation and does not transfer, because the ΔE00 JND is 1.0, not 2.3.
 */
export const DEFAULT_COLOR_DELTA_E = 1.0;

/**
 * The validator-package vocabulary — the single source of truth for which npm
 * packages mark an imported identifier as validator-provenanced. Consumed by
 * three sites (Spec 21 R4 / R3 cross-domain validator-bypass):
 *   - `buildProvenanceContext` (`src/analyzers/provenance.ts`) — the
 *     `validatorProvenanced` map the schema/data-access analyzers and the
 *     CLI `map` command read;
 *   - the migrated `cross-domain/no-validator-reachable` rule
 *     (`src/phase/rules/crossDomain.ts`);
 *   - the legacy `CrossDomainAnalyzer` (kept for the Spec 68 parity guard).
 *
 * This replaced the hand-maintained `VALIDATOR_PACKAGES` `ReadonlySet` that
 * lived in `provenance.ts` and did the job of the deleted `validatorPackageList`
 * config key. The list must not be re-declared elsewhere: consumers read the
 * config key and fall back to this symbol (the `DEFAULT_COLOR_DELTA_E` pattern).
 */
export const DEFAULT_VALIDATOR_PACKAGES: readonly string[] = [
  'zod',
  'joi',
  'ajv',
  'valibot',
  'yup',
  'superstruct',
  'arktype',
  '@sinclair/typebox',
  'class-validator',
];

/**
 * The git-churn lookback window — the single source of truth for the top-level
 * `churn` config key (Spec 13 R1). The churn extractor
 * (`src/churn/churnExtractor.ts`) reads `churnWindowMonths` from here instead of
 * hardcoding `12`; the two extraction call sites (`deepSync` in
 * `src/codeIndexDB.ts` and the CLI `hotspots` command in `src/cli.ts`) read the
 * configured `churn` key and fall back to this symbol (the `DEFAULT_COLOR_DELTA_E`
 * pattern). The literal must not be re-declared elsewhere.
 *
 * `12` months is the window `git log --since` scans for file/function churn.
 */
export const DEFAULT_CHURN_CONFIG: ChurnConfig = {
  churnWindowMonths: 12,
};

/**
 * The health-score pass/fail floor — the single source of truth for the
 * `audit.health` (`mcp.ts`) and `audit_health` (`mcp-tools-shared.ts`) MCP
 * tools' `threshold` parameter default. `calculateHealthScore` returns a 0-100
 * score; below this floor a codebase reports `needs-attention`. Read by both
 * tool-definition `default` fields and both handler fallbacks; the literal must
 * not be re-declared elsewhere (the `DEFAULT_COLOR_DELTA_E` pattern).
 *
 * `70` is the cut below which `audit.health` reports `needs-attention`.
 */
export const DEFAULT_HEALTH_SCORE_THRESHOLD = 70;

/**
 * Resolve the health-score floor for one call. Precedence: the MCP `threshold`
 * argument, then the configured `thresholds.minHealthScore` (read from
 * `.codeauditor.json` by `loadMinHealthScore`), then the single default above.
 * This is the one place the fallback is computed, so both MCP surfaces move
 * together when the default changes. The `||` (not `??`) mirrors the historical
 * fallback: a `0` threshold (always-pass) was — and remains — indistinguishable
 * from "unset".
 *
 * @param args the MCP tool arguments carrying an optional `threshold` override
 * @param configMin the configured `thresholds.minHealthScore` floor (if any)
 * @returns the resolved floor, never below the single default above
 */
export function resolveHealthThreshold(
  args?: { threshold?: number },
  configMin?: number,
): number {
  return (args?.threshold as number) || configMin || DEFAULT_HEALTH_SCORE_THRESHOLD;
}

/**
 * The blocking gate's deterministic-work budget — the single source of truth for
 * `gateBudgetResolutions()` (Directive J). The gate (`code-audit changed`) used to
 * be budgeted in CPU time (`auditCpuMs` < 900 ms); CPU time is load-dependent, so
 * the gate jittered under sustained load. Directive J re-expresses the budget over
 * a deterministic quantity instead — the number of distinct receiver resolutions
 * the phase pipeline performed (`receiverResolutions`, the `handleVerdictCache`
 * size after the pass). A fixed file folds `identifyHandle` a fixed number of
 * times regardless of machine load, so a regression moves this count
 * deterministically, where CPU time only jittered.
 *
 * MEASURED against `src/analyzers/universal/UniversalSOLIDAnalyzer.ts`, never
 * carried over: re-measured each re-baseline with the architectural reason
 * recorded. The deterministic count is `handleVerdictCache.size` for that file:
 * 77 on every warm run (5/5 runs, zero jitter). 100 = ~30% headroom over the
 * measured 77, matching the headroom discipline of the two prior CPU re-baselines.
 * The headroom is NOT for jitter (there is none) — it is room for legitimate
 * single-site growth before the tripwire fires; a real regression moves the count
 * by 2–5×, far past 100.
 *
 * Formerly `src/gateBudget.ts`; moved here (Directive J correction 3) to sit
 * alongside the other defaults rather than in a one-constant module.
 */
export const DEFAULT_GATE_BUDGET_RESOLUTIONS = 100;

/**
 * The env override for the gate budget, or the default. The override accepts any
 * integer ≥ 0 (0 is the liveness knob, not "unset"); a non-numeric or negative
 * value falls back to the default rather than tripping the gate spuriously.
 *
 * This is the one place `CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS` is read (the
 * `env-tunable single-source` pattern): both `cli.ts:856` (the `gate work: …
 * (budget N)` display line) and the `verify:gate-budget` verifier read this one
 * resolved value — the verifier parses it out of the CLI line, so the CLI is the
 * single source and the verifier can never drift from it.
 *
 * @returns the resolved gate budget — the non-negative numeric override when
 *   set, otherwise {@link DEFAULT_GATE_BUDGET_RESOLUTIONS}.
 */
export function gateBudgetResolutions(): number {
  const raw = process.env.CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_GATE_BUDGET_RESOLUTIONS;
}

/**
 * Default analyzer configurations
 */
export const DEFAULT_ANALYZER_CONFIGS = {
  // AUTHORITATIVE source is DEFAULT_SOLID_CONFIG (UniversalSOLIDAnalyzer.ts) —
  // the pipeline and `--print-config` resolve from there (RUNTIME_DEFAULT_CONFIGS),
  // NOT from this copy. This namespace is exported from the library (`src/index.ts`)
  // but must not drift: the size thresholds below are kept identical to
  // DEFAULT_SOLID_CONFIG (re-calibrated 2026-09-12 — see the rule registry's
  // `thresholdRationale` for the per-rule rationale).
  solid: {
    maxMethodsPerClass: 20,
    maxLinesPerMethod: 200,
    maxParametersPerMethod: 6,
    maxInterfaceMembers: 25,
    // R5.1: Per-method cyclomatic complexity threshold (true McCC)
    maxMethodComplexity: 50,
    // R5.2: Class-level aggregation thresholds
    classMethodsThreshold: 20,
    classAggregateComplexity: 150,
  },
  
  // Keep in sync with `DEFAULT_DRY_CONFIG` (UniversalDRYAnalyzer.ts) — that is the
  // authoritative, *enforced* default. This namespace is exported from the library
  // (`src/index.ts`) but is NOT merged into the pipeline (the pipeline builds the
  // DRY config from the user's `analyzerConfigs.dry` only, and the analyzer falls
  // back to `DEFAULT_DRY_CONFIG`). It is kept here solely so the public export does
  // not lie about what the analyzer actually runs; a guard test
  // (defaultsRegistry.test.ts) pins these values to `DEFAULT_DRY_CONFIG`.
  dry: {
    minLineThreshold: 15,
    similarityThreshold: 0.85,
    excludePatterns: [
      '**/*.test.ts', '**/*.spec.ts',
      '**/*.test.tsx', '**/*.spec.tsx',
      '**/*.test.js', '**/*.spec.js',
      '**/*.test.jsx', '**/*.spec.jsx',
      '**/test/**', '**/tests/**',
    ],
    checkImports: false,
    checkStrings: false,
    ignoreComments: true,
    ignoreWhitespace: true,
    checkExpressionSimilarity: true,
    minShapeNames: 4,
    // Spec 13 R5 — Diverging-clone detection. The pipeline reads this from the
    // user's `analyzerConfigs.dry.divergence` (auditRunner.ts) with an identical
    // hardcoded fallback; the values here mirror that fallback.
    divergence: {
      divergenceThreshold: 0.05,
      divergenceRuns: 2,
    },
  },
  
  dataAccess: {
    // Spec 21 R3: shared detection mode — provenance-primary with name-fallback
    detection: {
      mode: 'hybrid' as const,
    },
  },

  // Secrets analyzer defaults — hardcoded credentials / API keys / tokens
  secrets: {
    checkHardcodedSecrets: true,
  },

  // Spec-17: documentation analyzer defaults
  documentation: {
    requireFunctionDocs: true,
    requireClassDocs: true,
    minDescriptionLength: 2,       // Spec 11 R3 sweep: 10 → 2 (precision-first)
    exemptPatterns: [
      '\\.test\\.',
      '\\.spec\\.',
      '\\.d\\.ts$',
      'mock',
      'fixture',
      '__tests__',
      '/tests?/',
      // #135 — UI component files and Next.js framework entry points are not
      // library API surface; skip them so the documentation signal is
      // undocumented *logic*, not undocumented markup.
      '\\.tsx$',
      '\\.jsx$',
      '/(page|layout|loading|error|route|template|not-found|default|middleware)\\.(ts|tsx|js|jsx|mjs|cjs)$',
    ],
    scope: 'public',
    docsMinLines: 5,
    fileHeaders: false,
    headerSkipGlobs: [
      '**/index.{ts,tsx,js}',
      '**/*.{test,spec}.*',
      '**/__tests__/**',
      '**/migrations/**',
      '**/pages/**',
      '**/api/**',
      '**/routes/**',
      '**/*.config.*',
      '**/*.d.ts',
    ],
  },

  // Spec-17 R2: schema analyzer defaults
  schema: {
    enableTableUsageTracking: true,
    checkMissingReferences: true,
    checkNamingConventions: true,
    validateQueryPatterns: true,
    reportUnresolvedQueries: true,
    maxQueriesPerFunction: 1,      // Spec 11 R3 sweep: 5 → 1 (precision-first)
    requiredSchemas: [],
    sqlTagNames: ['sql', 'db'],
    dbBindingNames: ['env.DB'],
    fileGateGlobs: ['**/*.sql', '**/migrations/**'],
    schemaFiles: [],
    // Spec 21 R3: shared detection mode — provenance-primary with name-fallback
    detection: {
      mode: 'hybrid' as const,
    },
    // Spec 29: Declarative table-source registry — Tier 2 (ORM detection).
    // Adding an ORM becomes a config entry, not code.
    tableSources: [
      { kind: 'callee', name: 'pgTable', arg: 0, description: 'Drizzle PostgreSQL table' },
      { kind: 'callee', name: 'mysqlTable', arg: 0, description: 'Drizzle MySQL table' },
      { kind: 'callee', name: 'sqliteTable', arg: 0, description: 'Drizzle SQLite table' },
    ],
  },

  // Spec 10 R3: style intelligence analyzer defaults
  styles: {
    colorDeltaE: DEFAULT_COLOR_DELTA_E,
    scaleProperties: [
      'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'gap', 'row-gap', 'column-gap', 'font-size',
    ],
    zIndexMaxDistinct: 6,
    mechanismFragmentationMinMechanisms: 3,
    declarationSetMinDeclarations: 5,
    declarationSetSimilarityThreshold: 0.9,
    offScaleMinDeclarations: 20,
    categoricalPropertyExclusions: [
      'display', 'position', 'flex-direction', 'flex-wrap',
      'align-items', 'align-content', 'justify-content', 'justify-items',
      'text-align', 'vertical-align', 'overflow', 'overflow-x', 'overflow-y',
      'white-space', 'cursor', 'pointer-events', 'visibility',
      'float', 'clear', 'box-sizing', 'text-transform', 'font-style',
    ],
  },

  // Spec 12 R2: convention mining analyzer defaults
  conventions: {
    minCorpus: 30,
    pairConfidence: 0.95,
    modeShare: 0.8,
    maxConventionsPerDomain: 200,
  },

  // Spec 15: cross-domain analysis defaults
  crossDomain: {
    schemaLifecycle: {
      enableWrittenNeverRead: true,
      enableReadNeverWritten: true,
      enableTransactionBoundaryRisk: true,
      txnTableMax: 4,
    },
    validatorBypass: {
      validators: [],
      // The package vocabulary for provenanced-validator detection (Spec 21 R4).
      // Overridable via `analyzerConfigs["cross-domain"].validatorBypass.validatorPackageList`.
      validatorPackageList: DEFAULT_VALIDATOR_PACKAGES,
      modeShare: 0.8,
      minCorpus: 20,
      depth: 3,
    },
    coverage: {
      testGlobs: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
      staticReachDepth: 2,
      topRiskDecile: 0.1,
    },
  },
};

/**
 * No built-in path profiles ship with the tool. The "scripts-and-tests" profile
 * that excluded scripts, tests, and fixtures from the blocking gate (Spec 36 R4)
 * is removed: a compiled-in glob list that marks `gateExcluded: true` is a
 * hand-maintained exemption list baked into the binary — the same defect as a
 * suppression file, just shipped instead of written per project. A script with a
 * hardcoded connection string or a fixture with dynamic SQL gates like any other
 * file; teams that want an opt-out declare it explicitly in their own
 * `.codeauditor.json` as a user path profile.
 *
 * There is therefore no built-in/user merge to perform, and the `builtin` config
 * key that once selected a built-in profile is inert — it is still accepted (so
 * a config that sets `builtin: false` validates and behaves as before) but it
 * selects nothing, because there is nothing to select. The `BUILTIN_PATH_PROFILES`
 * list and the built-in name-replacement machinery are deleted rather than left
 * as an empty seam: an empty list invites the neighbouring reading "there are
 * built-ins, there just happen to be zero today", when the truth is the
 * mechanism itself is gone.
 *
 * @param userProfiles The user-configured path profiles to pass through.
 * @param _builtinEnabled Inert — no built-in profile ships; retained only so a
 *   config that sets `builtin: false` validates and behaves as before.
 * @returns The user profiles when non-empty, otherwise undefined.
 */
export function mergePathProfiles(
  userProfiles: PathProfile[] | undefined,
  _builtinEnabled: boolean | undefined
): PathProfile[] | undefined {
  return userProfiles && userProfiles.length > 0 ? userProfiles : undefined;
}

/**
 * Default code index configuration
 */
export const DEFAULT_CODE_INDEX_CONFIG = {
  // Not a literal path: the persisted index lives in a user-level OS cache
  // (project-scoped) — see resolvePersistedIndexPath. Kept as a config surface
  // only so an explicit `CODE_INDEX_DB_PATH` override can be reported as user-set.
  databasePath: '(user-level OS cache, project-scoped)',
  maxBatchSize: 1000,
  searchResultLimit: 100,
  enableAutoIndex: false
};