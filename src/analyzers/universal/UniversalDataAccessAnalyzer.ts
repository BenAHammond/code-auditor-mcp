/**
 * Universal Data Access Analyzer
 * Works across multiple programming languages using the adapter pattern
 * Analyzes database access patterns and data layer interactions
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';
import { IS_DEV_MODE } from '../../constants.js';

/**
 * Configuration for Data Access analyzer
 */
export interface DataAccessAnalyzerConfig {
  // Enable/disable checks
  checkOrgFilters?: boolean;
  checkSQLInjection?: boolean;

  // R4.3: direct access detection mode — "flag" (default) or "allow"
  directAccess?: 'flag' | 'allow';

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
  
  // Table extraction patterns
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
}

export const DEFAULT_DATA_ACCESS_CONFIG: DataAccessAnalyzerConfig = {
  checkOrgFilters: true,
  checkSQLInjection: true,
  // R4.3: default "flag" — report direct-access violations
  directAccess: 'flag',
  databases: {
    'primary': {
      name: 'Primary Database',
      importPatterns: ['/database/', '/db/', './db', './schema', 'drizzle', 'prisma', 'typeorm', 'knex', 'sequelize'],
      queryPatterns: ['select', 'insert', 'update', 'delete', 'query', 'execute'],
      ormPatterns: ['from', 'where', 'join', 'orderBy', 'groupBy']
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
    'company_id'
  ],
  tablePatterns: {
    orm: [
      /from\s*\(\s*["'`]?(\w+)["'`]?\s*\)/gi, 
      /table\s*[:=]\s*["'`]?(\w+)["'`]?/gi,
      /\.from\s*\(\s*(\w+)\s*\)/gi,  // Handle .from(users) where users is a variable
      /join\s*\(\s*(\w+)\s*,/gi,      // Handle joins
      /leftJoin\s*\(\s*(\w+)\s*,/gi,
      /rightJoin\s*\(\s*(\w+)\s*,/gi,
      /innerJoin\s*\(\s*(\w+)\s*,/gi
    ],
    sql: [/FROM\s+["'`]?(\w+)["'`]?/gi, /JOIN\s+["'`]?(\w+)["'`]?/gi, /UPDATE\s+["'`]?(\w+)["'`]?/gi],
    queryBuilder: [/\.from\s*\(\s*["'`]?(\w+)["'`]?\s*\)/gi]
  },
  performanceThresholds: {
    complexQueryCount: 3,
    unfilteredQueryCount: 3,
    joinedTableCount: 4
  },
  securityPatterns: {
    sqlInjectionRisks: ['${', 'concat', 'string interpolation'],
    parameterizedQueries: ['?', ':param', '$1', 'prepared', 'parameterized']
  }
};

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

interface QueryAnalysis {
  complexity: 'simple' | 'moderate' | 'complex';
  tables: string[];
  hasJoins: boolean;
  hasSubquery: boolean;
  hasOrganizationFilter: boolean;
  performanceRisk: 'low' | 'medium' | 'high';
}

export class UniversalDataAccessAnalyzer extends UniversalAnalyzer {
  readonly name = 'data-access';
  readonly description = 'Analyzes database access patterns and data layer interactions';
  readonly category = 'security';
  
  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: DataAccessAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_DATA_ACCESS_CONFIG, ...config };
    
    if (IS_DEV_MODE) {
      console.error('[DEBUG] Data access config merge:', {
        defaultPatterns: DEFAULT_DATA_ACCESS_CONFIG.organizationPatterns,
        inputConfig: config,
        finalPatterns: finalConfig.organizationPatterns
      });
    }
    
    // Check imports for database libraries
    const imports = adapter.extractImports(ast);
    const dbImports = this.mapDatabaseImports(imports, finalConfig);
    
    // Find database calls
    const calls = this.extractDatabaseCalls(ast, adapter, sourceCode, dbImports, finalConfig);
    
    // Analyze each call
    for (const call of calls) {
      const analysis = this.analyzeQuery(call, sourceCode, finalConfig);

      // Check for violations
      violations.push(...this.checkViolations(call, analysis, ast.filePath, finalConfig));
    }

    // R4.1: Check for database queries inside loops (N+1 detection)
    violations.push(...this.checkLoopQueries(ast, adapter, sourceCode, finalConfig));

    // Check for general data access patterns
    violations.push(...this.checkGeneralPatterns(ast, adapter, sourceCode, finalConfig));
    
    return violations;
  }
  
  /**
   * Map imports to database types
   */
  private mapDatabaseImports(
    imports: Array<{ source: string }>,
    config: DataAccessAnalyzerConfig
  ): Map<string, { hasImports: boolean; patterns: string[] }> {
    const dbImports = new Map<string, { hasImports: boolean; patterns: string[] }>();
    
    Object.entries(config.databases || {}).forEach(([dbType, dbConfig]) => {
      const hasImports = imports.some(imp => 
        dbConfig.importPatterns.some(pattern => imp.source.includes(pattern))
      );
      
      dbImports.set(dbType, {
        hasImports,
        patterns: [...dbConfig.queryPatterns, ...(dbConfig.ormPatterns || [])]
      });
    });
    
    return dbImports;
  }
  
  /**
   * Extract database calls from AST
   */
  private extractDatabaseCalls(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    dbImports: Map<string, { hasImports: boolean; patterns: string[] }>,
    config: DataAccessAnalyzerConfig
  ): DatabaseCall[] {
    const calls: DatabaseCall[] = [];
    
    // Find all relevant nodes
    const allNodes = adapter.findNodes(ast, {
      custom: (node) => {
        const nodeText = adapter.getNodeText(node, sourceCode);
        
        // Check if it's a function call that might be database-related
        if (this.isFunctionCall(node, adapter)) {
          // Check for ORM patterns or database method calls
          const dbPatterns = ['select', 'insert', 'update', 'delete', 'from', 'where', 'execute', 'query', 'find', 'aggregate', 'count', 'distinct'];
          const hasDbPattern = dbPatterns.some(pattern => nodeText.toLowerCase().includes(pattern));
          if (hasDbPattern) {
            // Ensure we get the full method call including arguments
            // For method calls like db.users.find(...), we want the entire expression
            return true;
          }
        }
        
        // Check if it's a template literal with SQL
        if (this.isTemplateLiteral(node, adapter)) {
          return this.containsSQLKeywords(nodeText);
        }
        
        // Check if it's a variable declaration with SQL (but not if it contains a template literal)
        if (this.isVariableAssignment(node, adapter)) {
          if (!this.containsSQLKeywords(nodeText)) return false;
          
          // Skip parent nodes if they contain template literals we'll analyze separately
          const children = adapter.getChildren(node);
          const hasRelevantChild = children.some(child => 
            this.isTemplateLiteral(child, adapter) &&
            this.containsSQLKeywords(adapter.getNodeText(child, sourceCode))
          );
          return !hasRelevantChild;
        }
        
        return false;
      }
    });
    
    // Deduplicate by line, preferring the most specific node
    const nodesByLine = new Map<number, ASTNode[]>();
    allNodes.forEach(node => {
      const line = node.location.start.line;
      if (!nodesByLine.has(line)) {
        nodesByLine.set(line, []);
      }
      nodesByLine.get(line)!.push(node);
    });
    
    // For each line, pick the most specific node
    const uniqueNodes: ASTNode[] = [];
    nodesByLine.forEach(nodes => {
      if (nodes.length === 1) {
        uniqueNodes.push(nodes[0]);
      } else {
        // Prefer template literals over variable declarations
        const templateLiteral = nodes.find(n => this.isTemplateLiteral(n, adapter));
        if (templateLiteral) {
          uniqueNodes.push(templateLiteral);
        } else {
          // Otherwise take the first one
          uniqueNodes.push(nodes[0]);
        }
      }
    });
    
    for (const node of uniqueNodes) {
      const nodeText = adapter.getNodeText(node, sourceCode);
      
      // Skip if the node text is too short or doesn't contain meaningful content
      if (!nodeText || nodeText.trim().length < 10) continue;
      
      // Determine if this is a database-related call
      const isSqlQuery = this.containsSQLKeywords(nodeText);
      const isOrmCall = this.isOrmPattern(nodeText);
      
      if (isSqlQuery || isOrmCall) {
        const tables = this.extractTables(nodeText, config);
        const hasOrgFilter = this.hasOrganizationFilter(nodeText, config);
        
        // Debug: Log the analysis
        if (IS_DEV_MODE) {
          console.error('[DEBUG] Database call analysis:', {
            line: node.location.start.line,
            nodeText: nodeText.substring(0, 100),
            tables,
            hasOrgFilter,
            patterns: config.organizationPatterns || []
          });
        }
        const security = this.checkQuerySecurity(nodeText, config);
        
        // Debug: Log extracted tables
        if (tables.length === 0 && isOrmCall) {
          console.error('[DataAccess Debug] No tables extracted from ORM call:', {
            line: node.location.start.line,
            nodeText: nodeText.substring(0, 100)
          });
        }
        
        // Determine the type based on imports or patterns
        let callType = 'unknown';
        if (isSqlQuery) {
          callType = 'sql';
        } else if (isOrmCall) {
          // Check which ORM based on imports
          for (const [dbType, importInfo] of dbImports) {
            if (importInfo.hasImports) {
              callType = dbType;
              break;
            }
          }
        }
        
        calls.push({
          type: callType,
          method: this.extractMethodName(node, adapter, sourceCode),
          file: ast.filePath,
          line: node.location.start.line,
          column: node.location.start.column,
          tables,
          hasOrganizationFilter: hasOrgFilter,
          hasParameterizedQuery: security.parameterized,
          hasSqlInjectionRisk: security.injectionRisk
        });
      }
    }
    
    return calls;
  }
  
  /**
   * Analyze a database query
   */
  private analyzeQuery(
    call: DatabaseCall,
    sourceCode: string,
    config: DataAccessAnalyzerConfig
  ): QueryAnalysis {
    const hasJoins = call.tables.length > 1;
    const hasSubquery = sourceCode.includes('SELECT') && sourceCode.includes('FROM') && 
                       sourceCode.lastIndexOf('SELECT') !== sourceCode.indexOf('SELECT');
    
    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
    if (hasSubquery || call.tables.length > 3) {
      complexity = 'complex';
    } else if (hasJoins || call.tables.length > 1) {
      complexity = 'moderate';
    }
    
    let performanceRisk: 'low' | 'medium' | 'high' = 'low';
    if (call.tables.length > (config.performanceThresholds?.joinedTableCount || 4)) {
      performanceRisk = 'high';
    } else if (!call.hasOrganizationFilter && call.tables.length > 0) {
      performanceRisk = 'medium';
    }
    
    return {
      complexity,
      tables: call.tables,
      hasJoins,
      hasSubquery,
      hasOrganizationFilter: call.hasOrganizationFilter,
      performanceRisk
    };
  }
  
  /**
   * Check for violations in a database call
   */
  private checkViolations(
    call: DatabaseCall,
    analysis: QueryAnalysis,
    filePath: string,
    config: DataAccessAnalyzerConfig
  ): Violation[] {
    const violations: Violation[] = [];
    
    // Security: SQL Injection Risk
    // Spec 11 (calibration): Detection uses AST-level heuristics (string
    // concatenation in query construction) without type information. Findings
    // are high-signal but not proof of exploitable injection. Severity demoted
    // from critical → warning in Spec 17. Spec 11 will measure true-positive
    // rate on ExcAlDraw and Gin corpora to decide whether heuristics should be
    // tightened or severity re-escalated.
    if (config.checkSQLInjection && call.hasSqlInjectionRisk) {
      violations.push(this.createViolation(
        filePath,
        { line: call.line, column: call.column },
        `Potential SQL injection risk in ${call.method}. Use parameterized queries.`,
        'warning',
        'sql-injection-risk'
      ));
    }
    
    // Security: Missing Organization Filter
    if (config.checkOrgFilters && !call.hasOrganizationFilter && call.tables.length > 0 && this.requiresOrgFilter(call.tables)) {
      violations.push(this.createViolation(
        filePath,
        { line: call.line, column: call.column },
        `Query on ${call.tables.join(', ')} missing organization/tenant filter`,
        'warning',
        'missing-org-filter'
      ));
    }
    
    // Performance: Complex Query
    if (analysis.performanceRisk === 'high') {
      violations.push(this.createViolation(
        filePath,
        { line: call.line, column: call.column },
        `Complex query with ${call.tables.length} tables may have performance issues`,
        'warning',
        'complex-query'
      ));
    }
    
    // Performance: Unfiltered Query
    if (!call.hasOrganizationFilter && analysis.performanceRisk === 'medium') {
      violations.push(this.createViolation(
        filePath,
        { line: call.line, column: call.column },
        `Unfiltered query on ${call.tables.join(', ')} may cause performance issues`,
        'suggestion',
        'unfiltered-query'
      ));
    }
    
    return violations;
  }
  
  /**
   * Check general data access patterns
   */
  private checkGeneralPatterns(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: DataAccessAnalyzerConfig
  ): Violation[] {
    const violations: Violation[] = [];

    // R4.3: Skip direct-access violations when directAccess is "allow"
    if (config.directAccess === 'allow') {
      return violations;
    }

    // Check for hardcoded connection strings
    const stringNodes = adapter.findNodes(ast, {
      custom: (node) => this.isStringLiteral(node, adapter)
    });

    for (const node of stringNodes) {
      const text = adapter.getNodeText(node, sourceCode);
      if (this.isConnectionString(text)) {
        violations.push(this.createViolation(
          ast.filePath,
          node.location.start,
          'Hardcoded database connection string detected. Use environment variables. (On Cloudflare Workers/D1, connection strings are injected via bindings.)',
          'suggestion',                                         // R7: direct-access → suggestion
          'hardcoded-connection'
        ));
      }
    }

    // Check for direct SQL execution without ORM
    const sqlPatterns = [/execute\s*\(\s*['"`]SELECT/i, /query\s*\(\s*['"`]SELECT/i];
    for (const pattern of sqlPatterns) {
      if (pattern.test(sourceCode)) {
        violations.push(this.createViolation(
          ast.filePath,
          { line: 1, column: 1 },
          'Direct SQL execution detected. Consider using an ORM or query builder.',
          'suggestion',                                         // R7: direct-access → suggestion
          'direct-sql'
        ));
        break;
      }
    }

    return violations;
  }
  
  /**
   * Helper methods
   */
  private isFunctionCall(node: ASTNode, adapter: LanguageAdapter): boolean {
    return node.type === 'call_expression' ||
           node.type === 'new_expression';
  }

  private isTemplateLiteral(node: ASTNode, adapter: LanguageAdapter): boolean {
    return node.type === 'template_string';
  }

  private isVariableAssignment(node: ASTNode, adapter: LanguageAdapter): boolean {
    // Only get the actual variable declaration, not the statement
    return node.type === 'variable_declaration' ||
           node.type === 'binary_expression' && (node.children?.some(child =>
             adapter.getNodeText(child, '').includes('=')) ?? false);
  }
  
  private containsSQLKeywords(text: string): boolean {
    const sqlKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN'];
    const upperText = text.toUpperCase();
    return sqlKeywords.some(keyword => upperText.includes(keyword));
  }
  
  private isOrmPattern(text: string): boolean {
    // Common ORM method patterns
    const ormPatterns = [
      /\.find\s*\(/,
      /\.findOne\s*\(/,
      /\.findMany\s*\(/,
      /\.findFirst\s*\(/,
      /\.findUnique\s*\(/,
      /\.select\s*\(/,
      /\.insert\s*\(/,
      /\.update\s*\(/,
      /\.updateOne\s*\(/,
      /\.updateMany\s*\(/,
      /\.delete\s*\(/,
      /\.deleteOne\s*\(/,
      /\.deleteMany\s*\(/,
      /\.from\s*\(/,
      /\.where\s*\(/,
      /\.join\s*\(/,
      /\.leftJoin\s*\(/,
      /\.rightJoin\s*\(/,
      /\.innerJoin\s*\(/,
      /\.create\s*\(/,
      /\.createMany\s*\(/,
      /\.aggregate\s*\(/,
      /\.count\s*\(/,
      /\.distinct\s*\(/
    ];
    
    return ormPatterns.some(pattern => pattern.test(text));
  }
  
  private isDatabaseCall(text: string, patterns: string[]): boolean {
    return patterns.some(pattern => text.toLowerCase().includes(pattern.toLowerCase()));
  }
  
  private extractTables(text: string, config: DataAccessAnalyzerConfig): string[] {
    const tables = new Set<string>();
    
    // Check ORM patterns
    config.tablePatterns?.orm?.forEach(pattern => {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) tables.add(match[1]);
      }
    });
    
    // Check SQL patterns
    config.tablePatterns?.sql?.forEach(pattern => {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) tables.add(match[1]);
      }
    });
    
    // Additional check for common ORM patterns that might be missed
    // Handle patterns like db.select().from(users) where 'users' is a variable
    const ormVariablePattern = /\.from\s*\(\s*([a-zA-Z_]\w*)\s*\)/g;
    const ormMatches = text.matchAll(ormVariablePattern);
    for (const match of ormMatches) {
      if (match[1] && !match[1].includes('"') && !match[1].includes("'")) {
        tables.add(match[1]);
      }
    }
    
    // Handle patterns like db.users.find() or db.orders.findOne()
    const dbTablePattern = /db\.([a-zA-Z_]\w*)\.\w+\s*\(/g;
    const dbMatches = text.matchAll(dbTablePattern);
    for (const match of dbMatches) {
      if (match[1]) {
        tables.add(match[1]);
      }
    }
    
    return Array.from(tables);
  }
  
  private hasOrganizationFilter(text: string, config: DataAccessAnalyzerConfig): boolean {
    const patterns = config.organizationPatterns || [];
    const lowerText = text.toLowerCase();
    
    if (IS_DEV_MODE) {
      console.error('[DEBUG] hasOrganizationFilter called with:', {
        text: text.substring(0, 100),
        patternsFromConfig: patterns,
        patternsLength: patterns.length
      });
    }
    
    // If no patterns provided, check for hardcoded common patterns as fallback
    const fallbackPatterns = patterns.length === 0 ? [
      'organizationid', 'organization_id', 'orgid', 'org_id', 
      'tenantid', 'tenant_id', 'companyid', 'company_id'
    ] : patterns;
    
    if (IS_DEV_MODE) {
      console.error('[DEBUG] Using fallback patterns:', fallbackPatterns);
    }
    
    // Check for simple pattern matches first
    const hasSimpleMatch = fallbackPatterns.some(pattern => {
      const match = lowerText.includes(pattern.toLowerCase());
      if (IS_DEV_MODE) {
        console.error(`[DEBUG] Pattern "${pattern}" -> "${pattern.toLowerCase()}" in "${lowerText}": ${match}`);
      }
      return match;
    });
    
    if (hasSimpleMatch) {
      if (IS_DEV_MODE) {
        console.error('[DEBUG] Found simple match, returning true');
      }
      return true;
    }
    
    // Enhanced pattern matching for object properties and SQL WHERE clauses
    for (const pattern of fallbackPatterns) {
      const lowerPattern = pattern.toLowerCase();
      
      // Check for object property patterns: { organizationId: ... }
      if (lowerText.includes(`${lowerPattern}:`)) {
        return true;
      }
      
      // Check for object property patterns with quotes: { "organizationId": ... }
      if (lowerText.includes(`"${lowerPattern}"`)) {
        return true;
      }
      
      // Check for object property patterns with single quotes: { 'organizationId': ... }
      if (lowerText.includes(`'${lowerPattern}'`)) {
        return true;
      }
      
      // Check for SQL WHERE clause patterns: WHERE organizationId = 
      if (lowerText.includes(`where ${lowerPattern} =`) || 
          lowerText.includes(`where ${lowerPattern}=`)) {
        return true;
      }
      
      // Check for SQL AND clause patterns: AND organizationId =
      if (lowerText.includes(`and ${lowerPattern} =`) || 
          lowerText.includes(`and ${lowerPattern}=`)) {
        return true;
      }
    }
    
    // Debug logging
    if (IS_DEV_MODE) {
      console.error('[DEBUG] hasOrganizationFilter check:', {
        text: text.substring(0, 150),
        patterns,
        fallbackPatterns,
        hasFilter: false
      });
    }
    
    return false;
  }
  
  private checkQuerySecurity(text: string, config: DataAccessAnalyzerConfig): {
    parameterized: boolean;
    injectionRisk: boolean;
  } {
    const parameterized = (config.securityPatterns?.parameterizedQueries || []).some(pattern =>
      text.includes(pattern)
    );
    
    // Enhanced SQL injection detection
    const sqlInjectionPatterns = [
      '${',        // Template literal interpolation
      'concat',    // String concatenation  
      '+',         // String concatenation with +
      "'${",       // Template literal in quotes
      '"${',       // Template literal in double quotes
      '` + ',      // String concatenation
      '" + ',      // String concatenation
      "' + "       // String concatenation
    ];
    
    const configPatterns = config.securityPatterns?.sqlInjectionRisks || [];
    const allPatterns = [...sqlInjectionPatterns, ...configPatterns];
    
    const injectionRisk = allPatterns.some(pattern => text.includes(pattern)) &&
                          this.containsSQLKeywords(text);
    
    return { parameterized, injectionRisk };
  }
  
  private extractMethodName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string {
    const text = adapter.getNodeText(node, sourceCode);
    const match = text.match(/(\w+)\s*\(/);
    return match ? match[1] : 'unknown';
  }
  
  private requiresOrgFilter(tables: string[]): boolean {
    // Tables that typically need organization filtering
    const orgTables = ['users', 'projects', 'orders', 'customers', 'accounts', 'teams'];
    return tables.some(table => {
      // Handle both actual table names and variable names that likely represent tables
      const tableName = table.toLowerCase();
      // Check exact match or if the table variable name matches (e.g., 'users' variable for 'users' table)
      return orgTables.includes(tableName) || orgTables.some(orgTable => tableName === orgTable);
    });
  }
  
  private isStringLiteral(node: ASTNode, adapter: LanguageAdapter): boolean {
    return node.type === 'string' || node.type === 'template_string';
  }
  
  private isConnectionString(text: string): boolean {
    const patterns = [
      /mongodb:\/\//i,
      /postgres:\/\//i,
      /mysql:\/\//i,
      /Server=.*;Database=/i,
      /Data Source=.*;Initial Catalog=/i
    ];

    return patterns.some(pattern => pattern.test(text));
  }

  // ── R4.1: Loop-query detection ──────────────────────────────────────

  /**
   * R4.1: Find database queries inside loops and flag them as N+1 risks.
   * Each finding carries the query call location (never line 1).
   */
  private checkLoopQueries(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: DataAccessAnalyzerConfig
  ): Violation[] {
    const violations: Violation[] = [];

    // Find all nodes that look like database calls
    const dbNodes = adapter.findNodes(ast, {
      custom: (node) => this.isDbCallNode(node, adapter, sourceCode),
    });

    // Track reported line+loop combos to avoid duplicates
    const reported = new Set<string>();

    for (const node of dbNodes) {
      const nodeText = adapter.getNodeText(node, sourceCode);
      if (!nodeText || nodeText.trim().length < 10) continue;

      const loopInfo = this.findEnclosingLoop(node, adapter);
      if (!loopInfo) continue;

      // R4.1: Use query node's actual location (never line 1)
      const queryLine = node.location.start.line;

      // Deduplicate: same line + same loop line = already reported
      const dedupKey = `${queryLine}:${loopInfo.loopNode.location.start.line}`;
      if (reported.has(dedupKey)) continue;
      reported.add(dedupKey);

      // R4.2: Nested-loop attribution
      const depthMsg = loopInfo.depth > 1
        ? ` (nested ${loopInfo.depth} levels deep)`
        : '';

      violations.push(this.createViolation(
        ast.filePath,
        node.location.start,                                   // query-call line, never line 1
        `Database query inside loop${depthMsg} ` +
        `(loop at line ${loopInfo.loopNode.location.start.line}). ` +
        `This may cause N+1 performance issues. Consider batching queries or using a join.`,
        'warning',                                             // R7: loop-query → warning
        'loop-query'
      ));
    }

    return violations;
  }

  /**
   * R4.1: Determine if a node is a database call expression.
   * Lightweight check — reused from extractDatabaseCalls logic.
   */
  private isDbCallNode(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): boolean {
    const nodeText = adapter.getNodeText(node, sourceCode);

    // Call-expression with DB patterns
    if (this.isFunctionCall(node, adapter)) {
      const dbPatterns = ['select', 'insert', 'update', 'delete', 'from', 'where', 'execute', 'query', 'find', 'aggregate', 'count', 'distinct'];
      if (dbPatterns.some(pattern => nodeText.toLowerCase().includes(pattern))) {
        return true;
      }
    }

    // Template literal with SQL keywords
    if (this.isTemplateLiteral(node, adapter)) {
      return this.containsSQLKeywords(nodeText);
    }

    return false;
  }

  /**
   * R4.1/R4.2: Walk the parent chain to find the innermost enclosing loop.
   * Returns the loop node and nesting depth.
   *
   * Detects:
   *   - for / while / do loops via adapter.isLoop()
   *   - .forEach / .map / .filter callbacks via AST pattern matching
   */
  private findEnclosingLoop(
    node: ASTNode,
    adapter: LanguageAdapter
  ): { loopNode: ASTNode; depth: number } | null {
    let current: ASTNode | null = node;
    let depth = 0;
    const foundLoops: ASTNode[] = [];

    while (current) {
      const parent = adapter.getParent(current);
      if (!parent) break;

      // Check for language-level loops (for, while, do)
      if (adapter.isLoop(parent)) {
        foundLoops.push(parent);
      }

      // Check for iterator callbacks (.forEach, .map, .filter, etc.)
      if (this.isIteratorCallback(parent, adapter)) {
        foundLoops.push(parent);
      }

      current = parent;
    }

    if (foundLoops.length === 0) return null;

    // R4.1: Innermost is the first one we found (closest to node)
    // R4.2: Total count is the nesting depth
    return {
      loopNode: foundLoops[0],
      depth: foundLoops.length,
    };
  }

  /**
   * R4.1: Check if a node is a call_expression invoking an iterator method
   * (.forEach, .map, .filter, .reduce, .some, .every) — these create
   * implicit loops where a DB query inside the callback is an N+1 risk.
   */
  private isIteratorCallback(node: ASTNode, adapter: LanguageAdapter): boolean {
    // Must be a call_expression
    if (node.type !== 'call_expression') return false;

    // Callee must be a member_expression whose property matches iterator method names
    const children = adapter.getChildren(node);
    const callee = children.find(c => c.type === 'member_expression');
    if (!callee) return false;

    const calleeChildren = adapter.getChildren(callee);
    const propertyNode = calleeChildren.find(c =>
      c.type === 'property_identifier' || c.type === 'string'
    );
    if (!propertyNode) return false;

    const methodName = adapter.getNodeType(propertyNode) === 'property_identifier'
      ? (propertyNode as any).text ?? adapter.getNodeText(propertyNode, '')
      : '';

    // Normalize: the method name might come from the node type or need text extraction
    const iteratorMethods = ['forEach', 'map', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'flatMap'];

    // Try multiple ways to get the method name
    const propText = methodName || this.getPropertyName(propertyNode, adapter);

    return iteratorMethods.includes(propText);
  }

  /**
   * Extract the property name from a property_identifier node.
   */
  private getPropertyName(node: ASTNode, adapter: LanguageAdapter): string {
    // Try named children
    if ((node as any).name) return (node as any).name;
    if ((node as any).text) return (node as any).text;

    // Try to get it from children
    const children = adapter.getChildren(node);
    for (const child of children) {
      if ((child as any).name) return (child as any).name;
      if ((child as any).text) return (child as any).text;
    }

    return '';
  }
}