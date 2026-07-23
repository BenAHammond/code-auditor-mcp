/**
 * Default configurations for the code auditor
 */

import { AuditConfig, PathProfile } from '../types.js';

/**
 * Get default configuration
 */
export function getDefaultConfig(): AuditConfig {
  return {
    includePaths: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.go'],
    excludePaths: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.test.{ts,tsx,js,jsx}',
      '**/*.spec.{ts,tsx,js,jsx}'
    ],
    enabledAnalyzers: ['solid', 'dry', 'security', 'component', 'data-access'],
    outputFormats: ['html', 'json'],
    outputDirectory: './audit-reports',
    minSeverity: 'suggestion',
    failOnCritical: false,
    showProgress: true,
    thresholds: {
      maxCritical: 0,
      maxWarnings: 100,
      minHealthScore: 75
    }
  };
}

/**
 * Get project type specific defaults
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
        includePaths: ['src/**/*.{ts,js}', 'lib/**/*.{ts,js}'],
        outputFormats: ['json', 'csv']
      };
    
    default:
      return {};
  }
}

/**
 * Get environment-specific defaults
 */
export function getEnvironmentDefaults(env: string): Partial<AuditConfig> {
  switch (env) {
    case 'ci':
      return {
        outputFormats: ['json'],
        failOnCritical: true,
        showProgress: false
      };
    
    case 'development':
      return {
        outputFormats: ['html'],
        showProgress: true,
        minSeverity: 'suggestion'
      };
    
    case 'production':
      return {
        minSeverity: 'warning',
        failOnCritical: true
      };
    
    default:
      return {};
  }
}

/**
 * Default analyzer configurations
 */
export const DEFAULT_ANALYZER_CONFIGS = {
  // Spec-17 R5: maxComplexity (old heuristic) deprecated; use maxMethodComplexity
  // and classAggregateComplexity for true cyclomatic complexity.
  solid: {
    maxMethodsPerClass: 10,
    maxLinesPerMethod: 50,
    maxParametersPerMethod: 4,
    maxImportsPerFile: 20,
    maxComplexity: 10,                   // DEPRECATED — old heuristic
    // R5.1: Per-method cyclomatic complexity threshold (true McCC)
    maxMethodComplexity: 50,
    // R5.2: Class-level aggregation thresholds
    classMethodsThreshold: 15,
    classAggregateComplexity: 100,
  },
  
  // Spec-17 R3: minLineThreshold raised from 5 → 15
  dry: {
    minLineThreshold: 15,
    similarityThreshold: 0.85,
    excludePatterns: ['**/*.test.ts', '**/*.spec.ts'],
    checkImports: true,
    checkStrings: true,
    ignoreComments: true,
    ignoreWhitespace: true,
  },
  
  security: {
    authPatterns: ['withAuth', 'requireAuth', 'isAuthenticated'],
    adminPatterns: ['withAdmin', 'requireAdmin', 'isAdmin'],
    rateLimitPatterns: ['rateLimit', 'withRateLimit'],
    publicPatterns: ['public', 'noAuth', 'skipAuth']
  },
  
  component: {
    frameworkPatterns: {
      react: {
        components: ['*.tsx', '*.jsx'],
        hooks: ['use*'],
        context: ['*Context', '*Provider']
      }
    },
    checkErrorBoundaries: true,
    maxComplexity: 15,
    maxNesting: 4
  },
  
  dataAccess: {
    // R4.3: directAccess — "flag" (report direct-sql/hardcoded-connection) or "allow" (skip)
    directAccess: 'flag',
    databasePatterns: {
      postgres: ['pg', 'postgres', 'postgresql'],
      mysql: ['mysql', 'mysql2'],
      mongodb: ['mongodb', 'mongoose']
    },
    securityPatterns: {
      parameterized: ['?', '$1', ':param'],
      sanitized: ['sanitize', 'escape', 'clean']
    },
    performanceThresholds: {
      maxJoins: 5,
      warnOnSelectStar: true
    },
    // Spec 21 R3: shared detection mode — provenance-primary with name-fallback
    detection: {
      mode: 'hybrid' as const,
    },
  },

  // Spec-17: documentation analyzer defaults
  documentation: {
    requireFunctionDocs: true,
    requireClassDocs: true,
    requireParamDocs: true,
    requireReturnDocs: true,
    minDescriptionLength: 10,
    exemptPatterns: [
      '\\.test\\.',
      '\\.spec\\.',
      '\\.d\\.ts$',
      'mock',
      'fixture',
      '__tests__',
      '/tests?/',
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
    detectUnusedTables: false,
    validateQueryPatterns: true,
    maxQueriesPerFunction: 5,
    requiredSchemas: [],
    sqlTagNames: ['sql', 'db'],
    dbReceiverNames: ['db', 'database', 'sql', 'stmt', 'connection', 'pool', 'client'],
    dbCallMethods: ['exec', 'prepare', 'batch', 'run', 'all', 'first', 'query', 'get', 'each'],
    dbBindingNames: ['env.DB'],
    fileGateGlobs: ['**/*.sql', '**/migrations/**'],
    // Spec 21 R3: shared detection mode — provenance-primary with name-fallback
    detection: {
      mode: 'hybrid' as const,
    },
    // Spec 21 R4: validator package list for provenanced validator detection
    validatorPackageList: [
      'zod', 'joi', 'ajv', 'valibot', 'yup', 'superstruct', 'arktype',
      '@sinclair/typebox', 'class-validator',
    ],
  },
};

/**
 * Built-in path profiles shipped with the tool.
 *
 * "scripts-and-tests" caps scripts, tests, and test fixtures to
 * "suggestion" severity — grounded in the Spec 11 triage numbers
 * showing these directories produce noise, not signal.
 *
 * Disable entirely via `"builtin": false` in .codeauditor.json.
 * Replace a specific built-in via a user profile with the same name
 * and `"builtin": false`.
 */
export const BUILTIN_PATH_PROFILES: PathProfile[] = [
  {
    name: 'scripts-and-tests',
    paths: [
      'scripts/**',
      'tests/**',
      'test/**',
      '__tests__/**',
      'fixtures/**',
      '*.test.*',
      '*.spec.*',
    ],
    overrides: { severityCap: 'suggestion' },
  },
];

/**
 * Merge built-in path profiles with user-configured profiles.
 *
 * - `builtin: false` at top level → no built-ins
 * - User profile with `builtin: false` → replaces built-in of same name
 * - Otherwise: built-ins come first, user profiles appended after
 *   (later wins on conflict)
 *
 * @returns The merged profile array, or undefined if no profiles active
 */
export function mergePathProfiles(
  userProfiles: PathProfile[] | undefined,
  builtinEnabled: boolean | undefined
): PathProfile[] | undefined {
  // builtin: false disables all built-in profiles
  if (builtinEnabled === false) {
    return userProfiles && userProfiles.length > 0 ? userProfiles : undefined;
  }

  if (!userProfiles || userProfiles.length === 0) {
    // No user profiles — use built-ins only
    return BUILTIN_PATH_PROFILES.length > 0 ? [...BUILTIN_PATH_PROFILES] : undefined;
  }

  // Merge: built-ins first, user profiles appended (later wins)
  const userReplaced = new Set(
    userProfiles.filter((p) => p.builtin === false).map((p) => p.name)
  );

  const activeBuiltins = BUILTIN_PATH_PROFILES.filter(
    (b) => !userReplaced.has(b.name)
  );

  return [...activeBuiltins, ...userProfiles];
}

/**
 * Default code index configuration
 */
export const DEFAULT_CODE_INDEX_CONFIG = {
  databasePath: './.code-index/index.db',
  maxBatchSize: 1000,
  searchResultLimit: 100,
  enableAutoIndex: false
};