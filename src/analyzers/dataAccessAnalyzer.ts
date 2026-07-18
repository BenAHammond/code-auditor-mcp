/**
 * Data Access Analyzer (Functional)
 * Analyzes database access patterns and data layer interactions
 *
 * Detects database usage, query patterns, performance risks,
 * and security concerns in data access code
 */

import {
  DataAccessPattern,
  QueryInfo,
  DatabaseType,
  AnalyzerDefinition,
  Violation
} from '../types.js';
import {
  processFiles,
  createViolation
} from './analyzerUtils.js';
import {
  getImports,
  findNodesByKind,
  getLineAndColumn
} from '../utils/astUtils.js';
import type { AST, ASTNode } from '../languages/types.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get raw text from a tree-sitter node stored on ASTNode.raw. */
function rawText(node: ASTNode): string {
  return (node.raw as TreeSitterNode)?.text ?? '';
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for Data Access analyzer
 */
export interface DataAccessAnalyzerConfig {
  // Database configurations
  databases?: {
    [key: string]: {
      name: string;
      importPatterns: string[];
      queryPatterns: string[];
      ormPatterns?: string[];
    };
  };

  // Organization/tenant filtering patterns
  organizationPatterns?: string[];

  // Table extraction patterns for different ORMs/query builders
  tablePatterns?: {
    orm?: RegExp[];
    sql?: RegExp[];
    queryBuilder?: RegExp[];
  };

  // Performance thresholds
  performanceThresholds?: {
    complexQueryCount?: number;
    unfilteredQueryCount?: number;
    joinedTableCount?: number;
  };

  // Security patterns
  securityPatterns?: {
    sqlInjectionRisks?: string[];
    parameterizedQueries?: string[];
  };

  // Source type detection (e.g., API routes vs pages)
  sourcePatterns?: {
    api?: string[];
    page?: string[];
    service?: string[];
  };
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: DataAccessAnalyzerConfig = {
  databases: {
    'primary': {
      name: 'Primary Database',
      importPatterns: ['/database/', '/db/', 'drizzle', 'prisma', 'typeorm'],
      queryPatterns: ['select', 'insert', 'update', 'delete', 'query'],
      ormPatterns: ['from', 'where', 'join', 'orderBy', 'groupBy']
    },
    'secondary': {
      name: 'Secondary Database',
      importPatterns: ['/analytics/', '/reporting/'],
      queryPatterns: ['query', 'execute', 'run'],
      ormPatterns: []
    }
  },
  organizationPatterns: [
    'organizationId',
    'organization_id',
    'orgId',
    'org_id',
    'tenantId',
    'tenant_id',
    'companyId',
    'company_id',
    'filterByOrganization',
    'whereOrganization',
    'scopeToOrg'
  ],
  tablePatterns: {
    orm: [
      /\.from\(['"`]?(\w+)['"`]?\)/g,
      /\.table\(['"`]?(\w+)['"`]?\)/g,
      /\.into\(['"`]?(\w+)['"`]?\)/g,
      /\.update\(['"`]?(\w+)['"`]?\)/g
    ],
    sql: [
      /(?:FROM|JOIN|INTO|UPDATE)\s+['"`]?(\w+)['"`]?/gi,
      /(?:INSERT\s+INTO)\s+['"`]?(\w+)['"`]?/gi,
      /(?:DELETE\s+FROM)\s+['"`]?(\w+)['"`]?/gi
    ],
    queryBuilder: [
      /table:\s*['"`](\w+)['"`]/g,
      /from:\s*['"`](\w+)['"`]/g
    ]
  },
  performanceThresholds: {
    complexQueryCount: 3,
    unfilteredQueryCount: 5,
    joinedTableCount: 2
  },
  securityPatterns: {
    sqlInjectionRisks: [
      'concatenation',
      '${',
      'string interpolation',
      '+ variable',
      'raw(',
      'unsafeRaw'
    ],
    parameterizedQueries: [
      'prepared',
      'parameterized',
      'bind',
      '?',
      '$1',
      ':param'
    ]
  },
  sourcePatterns: {
    api: ['/api/', '/routes/', '/endpoints/'],
    page: ['/pages/', '/app/', '/views/'],
    service: ['/services/', '/lib/', '/utils/']
  }
};

/**
 * Database call information
 */
interface DatabaseCall {
  type: string;
  method: string;
  file: string;
  line: number;
  column: number;
  tables: string[];
  hasOrganizationFilter: boolean;
  hasParameterizedQuery: boolean;
  hasSqlInjectionRisk: boolean;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a single file for data access patterns.
 * Now accepts a pre-parsed AST (from processFiles) instead of parsing internally.
 */
async function analyzeFile(
  filePath: string,
  ast: AST,
  config: DataAccessAnalyzerConfig,
  sourceCode?: string
): Promise<{ patterns: DataAccessPattern[]; violations: Violation[] }> {
  const imports = getImports(ast.root);
  const patterns: DataAccessPattern[] = [];
  const violations: Violation[] = [];

  // Extract database calls
  const dbCalls = extractDatabaseCalls(ast.root, imports, filePath, config, sourceCode);

  // Group calls by database type
  const callsByDb = new Map<string, DatabaseCall[]>();
  dbCalls.forEach(call => {
    if (!callsByDb.has(call.type)) {
      callsByDb.set(call.type, []);
    }
    callsByDb.get(call.type)!.push(call);
  });

  // Create patterns for each database type used
  callsByDb.forEach((calls, dbType) => {
    const allTables = new Set<string>();
    const queries: QueryInfo[] = [];
    let hasOrgFilter = false;
    let hasSqlInjectionRisk = false;

    calls.forEach(call => {
      call.tables.forEach(table => allTables.add(table));
      hasOrgFilter = hasOrgFilter || call.hasOrganizationFilter;
      hasSqlInjectionRisk = hasSqlInjectionRisk || call.hasSqlInjectionRisk;

      // Create query info with enhanced analysis
      const queryInfo = extractQueryInfo(call, config);
      queries.push(queryInfo);
    });

    const pattern: DataAccessPattern = {
      source: detectSourceType(filePath, config),
      filePath,
      database: dbType as DatabaseType,
      tables: Array.from(allTables),
      queries,
      hasOrganizationFilter: hasOrgFilter,
      performanceRisk: assessPerformanceRisk(queries, config),
      hasSqlInjectionRisk
    };

    patterns.push(pattern);

    // Check for violations
    violations.push(...checkDataAccessViolations(pattern));
  });

  return { patterns, violations };
}

/**
 * Detect source type based on file path
 */
function detectSourceType(filePath: string, config: DataAccessAnalyzerConfig): DataAccessPattern['source'] {
  if (config.sourcePatterns!.api!.some(pattern => filePath.includes(pattern))) {
    return 'api';
  } else if (config.sourcePatterns!.page!.some(pattern => filePath.includes(pattern))) {
    return 'component';
  } else if (config.sourcePatterns!.service!.some(pattern => filePath.includes(pattern))) {
    return 'service';
  }
  return 'service';
}

/**
 * Extract database calls from the AST.
 * Uses tree-sitter call_expression nodes instead of TS API.
 */
function extractDatabaseCalls(
  ast: ASTNode,
  imports: ReturnType<typeof getImports>,
  filePath: string,
  config: DataAccessAnalyzerConfig,
  sourceCode?: string
): DatabaseCall[] {
  const calls: DatabaseCall[] = [];

  // Map imports to database types
  const dbImports = mapDatabaseImports(imports, config);

  // Find all call expressions using tree-sitter node type
  const callExpressions = findNodesByKind(ast, 'call_expression');

  callExpressions.forEach(callExpr => {
    const callText = rawText(callExpr);
    const { line, column } = getLineAndColumn(callExpr);

    // Check each configured database
    Object.entries(dbImports).forEach(([dbType, importInfo]) => {
      if (importInfo.hasImports && isDatabaseCall(callText, importInfo)) {
        const tables = extractTablesFromCall(callText, config);
        const hasOrgFilter = checkOrganizationFilter(callText, config);
        const securityCheck = checkQuerySecurity(callText, config);

        calls.push({
          type: dbType,
          method: extractMethodName(callExpr),
          file: filePath,
          line,
          column,
          tables,
          hasOrganizationFilter: hasOrgFilter,
          hasParameterizedQuery: securityCheck.parameterized,
          hasSqlInjectionRisk: securityCheck.injectionRisk
        });
      }
    });
  });

  return calls;
}

/**
 * Map imports to database types
 */
function mapDatabaseImports(
  imports: ReturnType<typeof getImports>,
  config: DataAccessAnalyzerConfig
): {
  [dbType: string]: {
    hasImports: boolean;
    importNames: string[];
    patterns: string[];
  };
} {
  const result: any = {};

  Object.entries(config.databases!).forEach(([key, dbConfig]) => {
    const importNames: string[] = [];
    let hasImports = false;

    imports.forEach(imp => {
      if ((dbConfig as any).importPatterns.some((pattern: string) => imp.moduleSpecifier.includes(pattern))) {
        hasImports = true;
        importNames.push(...imp.importedNames);
      }
    });

    result[key] = {
      hasImports,
      importNames,
      patterns: [...(dbConfig as any).queryPatterns, ...importNames]
    };
  });

  return result;
}

/**
 * Check if a call is a database call
 */
function isDatabaseCall(
  callText: string,
  importInfo: { hasImports: boolean; patterns: string[] }
): boolean {
  if (!importInfo.hasImports) return false;
  return importInfo.patterns.some(pattern => callText.includes(pattern));
}

/**
 * Extract method name from a tree-sitter call_expression node.
 *
 * call_expression node structure:
 *   children[0] = identifier           (e.g., "query()")
 *   OR
 *   children[0] = member_expression    (e.g., "db.query()")
 *     children[0] = identifier         (e.g., "db")
 *     children[1] = "."
 *     children[2] = property_identifier (e.g., "query")
 */
function extractMethodName(callExpr: ASTNode): string {
  const expression = callExpr.children?.[0];
  if (!expression) return 'unknown';

  if (expression.type === 'member_expression') {
    // e.g., db.query() — the property_identifier child holds the method name
    const propId = expression.children?.find(
      c => c.type === 'property_identifier'
    );
    if (propId) {
      return rawText(propId);
    }
  } else if (expression.type === 'identifier') {
    // e.g., query()
    return rawText(expression);
  }

  return 'unknown';
}

/**
 * Extract table names from call
 */
function extractTablesFromCall(callText: string, config: DataAccessAnalyzerConfig): string[] {
  const tables = new Set<string>();

  // Try all table extraction patterns
  Object.values(config.tablePatterns!).forEach(patterns => {
    (patterns as RegExp[]).forEach(pattern => {
      const matches = Array.from(callText.matchAll(pattern));
      matches.forEach(match => {
        if (match[1]) {
          tables.add(match[1].toLowerCase());
        }
      });
    });
  });

  return Array.from(tables);
}

/**
 * Check for organization filtering
 */
function checkOrganizationFilter(callText: string, config: DataAccessAnalyzerConfig): boolean {
  return config.organizationPatterns!.some(pattern =>
    callText.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Check query security
 */
function checkQuerySecurity(
  callText: string,
  config: DataAccessAnalyzerConfig
): {
  parameterized: boolean;
  injectionRisk: boolean;
} {
  const hasParameterized = config.securityPatterns!.parameterizedQueries!.some(pattern =>
    callText.includes(pattern)
  );

  const hasInjectionRisk = config.securityPatterns!.sqlInjectionRisks!.some(pattern =>
    callText.includes(pattern)
  );

  return {
    parameterized: hasParameterized,
    injectionRisk: hasInjectionRisk && !hasParameterized
  };
}

/**
 * Extract query info from database call
 */
function extractQueryInfo(call: DatabaseCall, config: DataAccessAnalyzerConfig): QueryInfo {
  return {
    type: inferQueryType(call.method),
    tables: call.tables,
    line: call.line,
    hasJoins: detectJoins(call.method),
    hasOrganizationFilter: call.hasOrganizationFilter,
    complexity: analyzeQueryComplexity(call, config)
  };
}

/**
 * Infer query type from method name
 */
function inferQueryType(method: string): QueryInfo['type'] {
  const methodLower = method.toLowerCase();

  if (methodLower.includes('select') || methodLower.includes('find') || methodLower.includes('get')) {
    return 'select';
  } else if (methodLower.includes('insert') || methodLower.includes('create')) {
    return 'insert';
  } else if (methodLower.includes('update')) {
    return 'update';
  } else if (methodLower.includes('delete') || methodLower.includes('remove')) {
    return 'delete';
  }

  return 'other';
}

/**
 * Detect if a query has joins
 */
function detectJoins(method: string): boolean {
  const joinPatterns = [
    'join',
    'leftJoin',
    'rightJoin',
    'innerJoin',
    'outerJoin',
    'fullJoin'
  ];

  return joinPatterns.some(pattern =>
    method.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Analyze query complexity
 */
function analyzeQueryComplexity(call: DatabaseCall, config: DataAccessAnalyzerConfig): QueryInfo['complexity'] {
  let complexityScore = 0;

  // Table count factor
  if (call.tables.length > config.performanceThresholds!.joinedTableCount!) {
    complexityScore += 2;
  } else if (call.tables.length > 1) {
    complexityScore += 1;
  }

  // Method complexity
  if (detectJoins(call.method)) {
    complexityScore += 2;
  }

  // Security risk adds complexity
  if (call.hasSqlInjectionRisk) {
    complexityScore += 3;
  }

  // Missing org filter in multi-tenant context
  if (!call.hasOrganizationFilter && call.tables.length > 0) {
    complexityScore += 1;
  }

  // Determine complexity level
  if (complexityScore >= 5) return 'complex';
  if (complexityScore >= 2) return 'moderate';
  return 'simple';
}

/**
 * Assess performance risk based on queries
 */
function assessPerformanceRisk(
  queries: QueryInfo[],
  config: DataAccessAnalyzerConfig
): DataAccessPattern['performanceRisk'] {
  // Count complex queries
  const complexQueries = queries.filter(q =>
    q.hasJoins ||
    q.tables.length > config.performanceThresholds!.joinedTableCount! ||
    q.complexity === 'complex'
  ).length;

  // Count queries without org filter
  const unfiltered = queries.filter(q => !q.hasOrganizationFilter).length;

  if (complexQueries > config.performanceThresholds!.complexQueryCount! ||
      unfiltered > config.performanceThresholds!.unfilteredQueryCount!) {
    return 'high';
  } else if (complexQueries > 1 || unfiltered > 2) {
    return 'medium';
  }

  return 'low';
}

/**
 * Check for data access violations
 */
function checkDataAccessViolations(pattern: DataAccessPattern): Violation[] {
  const violations: Violation[] = [];

  // Check for missing organization filter in multi-tenant scenarios
  if (!pattern.hasOrganizationFilter && pattern.tables.length > 0) {
    violations.push(createViolation({
      analyzer: 'data-access',
      severity: 'warning',
      type: 'data-access',
      file: pattern.filePath,
      line: 1,
      column: 1,
      message: 'Database queries may be missing tenant/organization filtering',
      recommendation: 'Add appropriate filtering to ensure data isolation in multi-tenant environments',
      estimatedEffort: 'small'
    }));
  }

  // Check for SQL injection risks
  if (pattern.hasSqlInjectionRisk) {
    violations.push(createViolation({
      analyzer: 'data-access',
      severity: 'critical',
      type: 'data-access',
      file: pattern.filePath,
      line: 1,
      column: 1,
      message: 'Potential SQL injection vulnerability detected',
      recommendation: 'Use parameterized queries or prepared statements instead of string concatenation',
      estimatedEffort: 'medium'
    }));
  }

  // Check for performance risks
  if (pattern.performanceRisk === 'high') {
    violations.push(createViolation({
      analyzer: 'data-access',
      severity: 'warning',
      type: 'data-access',
      file: pattern.filePath,
      line: 1,
      column: 1,
      message: 'High performance risk detected in data access patterns',
      recommendation: 'Optimize queries, add indexes, implement caching, or paginate results',
      estimatedEffort: 'medium'
    }));
  }

  // Check for direct database access in presentation layer
  if (pattern.source === 'component') {
    violations.push(createViolation({
      analyzer: 'data-access',
      severity: 'suggestion',
      type: 'data-access',
      file: pattern.filePath,
      line: 1,
      column: 1,
      message: 'Direct database access detected in presentation layer',
      recommendation: 'Consider moving data access to service layer or API endpoints for better separation of concerns',
      estimatedEffort: 'medium'
    }));
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Analyzer definition
// ---------------------------------------------------------------------------

/**
 * Data Access Analyzer definition
 */
export const dataAccessAnalyzer: AnalyzerDefinition = {
  name: 'data-access',
  defaultConfig: DEFAULT_CONFIG,
  analyze: async (files, config, options, progressCallback) => {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };

    // Custom processor to handle patterns collection
    const patterns: DataAccessPattern[] = [];
    const allViolations: Violation[] = [];

    const result = await processFiles(
      files,
      async (filePath, ast, procConfig, sourceCode) => {
        const fileResult = await analyzeFile(filePath, ast, mergedConfig, sourceCode);
        patterns.push(...fileResult.patterns);
        allViolations.push(...fileResult.violations);
        return fileResult.violations;
      },
      'data-access',
      mergedConfig,
      progressCallback ?
        (current, total, file) => progressCallback({ current, total, analyzer: 'data-access', file }) :
        undefined
    );

    // Override violations with our collected ones
    result.violations = allViolations;

    return result;
  }
};
