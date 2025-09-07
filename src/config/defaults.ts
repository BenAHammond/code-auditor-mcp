/**
 * Default configurations for the code auditor
 */

import { AuditConfig } from '../types.js';

/**
 * Get default configuration
 */
export function getDefaultConfig(): AuditConfig {
  return {
    includePaths: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
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
  solid: {
    maxMethodsPerClass: 10,
    maxLinesPerMethod: 50,
    maxParametersPerMethod: 4,
    maxImportsPerFile: 20,
    maxComplexity: 10
  },
  
  dry: {
    minLineThreshold: 5,
    similarityThreshold: 0.85,
    excludePatterns: ['**/*.test.ts', '**/*.spec.ts'],
    checkImports: true,
    checkStrings: true
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
  }
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