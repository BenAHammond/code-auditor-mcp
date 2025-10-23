/**
 * Universal Data Access Analyzer
 * Works across multiple programming languages using the adapter pattern
 * Analyzes database access patterns and data layer interactions
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';

/**
 * Configuration for Data Access analyzer
 */
export interface DataAccessAnalyzerConfig {
  // Enable/disable checks
  checkOrgFilters?: boolean;
  checkSQLInjection?: boolean;
  
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
      /from\s*\(\s*["'`]?(\w+)["'`]?\s*\)/i, 
      /table\s*[:=]\s*["'`]?(\w+)["'`]?/i,
      /\.from\s*\(\s*(\w+)\s*\)/i,  // Handle .from(users) where users is a variable
      /join\s*\(\s*(\w+)\s*,/i,      // Handle joins
      /leftJoin\s*\(\s*(\w+)\s*,/i,
      /rightJoin\s*\(\s*(\w+)\s*,/i,
      /innerJoin\s*\(\s*(\w+)\s*,/i
    ],
    sql: [/FROM\s+["'`]?(\w+)["'`]?/i, /JOIN\s+["'`]?(\w+)["'`]?/i, /UPDATE\s+["'`]?(\w+)["'`]?/i],
    queryBuilder: [/\.from\s*\(\s*["'`]?(\w+)["'`]?\s*\)/i]
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
    
    console.log('[DEBUG] Data access config merge:', {
      defaultPatterns: DEFAULT_DATA_ACCESS_CONFIG.organizationPatterns,
      inputConfig: config,
      finalPatterns: finalConfig.organizationPatterns
    });
    
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
        console.log('[DEBUG] Database call analysis:', {
          line: node.location.start.line,
          nodeText: nodeText.substring(0, 100),
          tables,
          hasOrgFilter,
          patterns: config.organizationPatterns || []
        });
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
    if (config.checkSQLInjection && call.hasSqlInjectionRisk) {
      violations.push(this.createViolation(
        filePath,
        { line: call.line, column: call.column },
        `Potential SQL injection risk in ${call.method}. Use parameterized queries.`,
        'critical',
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
          'Hardcoded database connection string detected. Use environment variables.',
          'critical',
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
          'suggestion',
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
    return node.type === 'CallExpression' || 
           node.type === 'MethodCallExpression' ||
           node.type === 'NewExpression';
  }
  
  private isTemplateLiteral(node: ASTNode, adapter: LanguageAdapter): boolean {
    return node.type === 'TemplateExpression' ||
           node.type === 'NoSubstitutionTemplateLiteral';
  }
  
  private isVariableAssignment(node: ASTNode, adapter: LanguageAdapter): boolean {
    // Only get the actual variable declaration, not the statement
    return node.type === 'VariableDeclaration' ||
           node.type === 'BinaryExpression' && node.children?.some(child => 
             adapter.getNodeText(child, '').includes('='));
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
    
    console.log('[DEBUG] hasOrganizationFilter called with:', {
      text: text.substring(0, 100),
      patternsFromConfig: patterns,
      patternsLength: patterns.length
    });
    
    // If no patterns provided, check for hardcoded common patterns as fallback
    const fallbackPatterns = patterns.length === 0 ? [
      'organizationid', 'organization_id', 'orgid', 'org_id', 
      'tenantid', 'tenant_id', 'companyid', 'company_id'
    ] : patterns;
    
    console.log('[DEBUG] Using fallback patterns:', fallbackPatterns);
    
    // Check for simple pattern matches first
    const hasSimpleMatch = fallbackPatterns.some(pattern => {
      const match = lowerText.includes(pattern.toLowerCase());
      console.log(`[DEBUG] Pattern "${pattern}" -> "${pattern.toLowerCase()}" in "${lowerText}": ${match}`);
      return match;
    });
    
    if (hasSimpleMatch) {
      console.log('[DEBUG] Found simple match, returning true');
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
    console.log('[DEBUG] hasOrganizationFilter check:', {
      text: text.substring(0, 150),
      patterns,
      fallbackPatterns,
      hasFilter: false
    });
    
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
    return node.type.includes('StringLiteral') || node.type.includes('TemplateLiteral');
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
}