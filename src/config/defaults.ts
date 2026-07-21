/**
 * Default configurations for the code auditor
 */

import { AuditConfig } from '../types.js';

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
    }
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
  },
};

/**
 * Default code index configuration
 */
export const DEFAULT_CODE_INDEX_CONFIG = {
  databasePath: './.code-index/index.db',
  maxBatchSize: 1000,
  searchResultLimit: 100,
  enableAutoIndex: false
};