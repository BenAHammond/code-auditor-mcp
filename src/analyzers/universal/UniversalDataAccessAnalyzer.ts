/**
 * Universal Data Access Analyzer
 * Works across multiple programming languages using the adapter pattern
 * Analyzes database access patterns and data layer interactions
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode, DynamicPart } from '../../languages/types.js';
import {
  buildProvenanceContext,
  isDBProvenanced,
  DB_CALL_METHODS,
  type ProvenanceContext,
  type DetectionMode,
} from '../provenance.js';
import {
  DB_RECEIVER_NAMES,
  DB_CALL_METHOD_NAMES,
  DB_BINDING_NAMES,
  DB_WRAPPER_NAMES,
} from './UniversalSchemaAnalyzer.js';

/**
 * SQL keywords recognized as evidence that a string is a SQL query.
 * Includes DML verbs (SELECT/INSERT/UPDATE/DELETE) and DDL verbs
 * (CREATE/DROP/ALTER/TRUNCATE) so DDL injection — e.g. a raw schema
 * migration built by concatenating an interpolated identifier — is
 * recognized as SQL rather than silently passing the keyword gate.
 * Single source of truth for both containsSQLKeywords and
 * containsSQLStructure to prevent drift.
 */
const SQL_KEYWORDS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE',
];

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

  // Spec 21 R6.2: three-tier org-filter detection
  // Tier 1: config-primary — user declares multi-tenant tables
  orgFilterTables?: string[];
  // Tier 2: usage-inference — column names indicating org/tenant scope
  orgFilterColumns?: string[];
  // Tier 2: schema definitions for column-based inference
  schemas?: Array<{
    name: string;
    tables: Array<{
      name: string;
      columns: Array<{ name: string; type: string; }>;
    }>;
  }>;

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

  /** DB wrapper function names that represent parameterized calls (e.g. d1Query, d1Exec).
   *  These functions accept a SQL template + bind params array — same pattern as
   *  .prepare().bind() but expressed as a simple function call rather than a method chain. */
  dbWrapperNames?: string[];

  /** DB receiver variable names for provenance detection (e.g. db, database, sql, stmt).
   *  Defaults to the same canonical list as the schema analyzer (DB_RECEIVER_NAMES),
   *  but lives in THIS analyzer's namespace so the two never share config keys. */
  dbReceiverNames?: string[];

  /** DB call method names for provenance detection (e.g. exec, prepare, batch, run, all, first). */
  dbCallMethods?: string[];

  /** DB binding names for provenance detection (e.g. env.DB — Cloudflare D1 bindings). */
  dbBindingNames?: string[];

  /** Provenance detection mode: 'hybrid' | 'provenance' | 'names'. */
  detection?: { mode: DetectionMode };

  /** SQL sanitizer function names — interpolation wrapped in one of these
   *  (e.g. escapeSql(x)) is not raw.  Kept in sync with the provenance system's
   *  dbWrapperNames: any list the detector learns about, the FP guards must also consult. */
  sanitizerNames?: string[];
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
  // Spec 21 R6.2: three-tier org-filter detection
  orgFilterTables: [],  // Tier 1: empty — user must declare
  orgFilterColumns: ['org_id', 'tenant_id', 'organization_id', 'workspace_id'],  // Tier 2
  schemas: [],           // Tier 2: schema definitions for column-based inference
  tablePatterns: {
    orm: [
      /from\s*\(\s*["'`]?([\p{L}\p{N}_]+)["'`]?\s*\)/giu,
      /table\s*[:=]\s*["'`]?([\p{L}\p{N}_]+)["'`]?/giu,
      /\.from\s*\(\s*([\p{L}\p{N}_]+)\s*\)/giu,  // Handle .from(users) where users is a variable
      /join\s*\(\s*([\p{L}\p{N}_]+)\s*,/giu,      // Handle joins
      /leftJoin\s*\(\s*([\p{L}\p{N}_]+)\s*,/giu,
      /rightJoin\s*\(\s*([\p{L}\p{N}_]+)\s*,/giu,
      /innerJoin\s*\(\s*([\p{L}\p{N}_]+)\s*,/giu
    ],
    sql: [/INSERT\s+INTO\s+["'`]?([\p{L}\p{N}_]+)["'`]?/giu, /DELETE\s+FROM\s+["'`]?([\p{L}\p{N}_]+)["'`]?/giu, /FROM\s+["'`]?([\p{L}\p{N}_]+)["'`]?/giu, /JOIN\s+["'`]?([\p{L}\p{N}_]+)["'`]?/giu, /UPDATE\s+["'`]?([\p{L}\p{N}_]+)["'`]?/giu],
    queryBuilder: [/\.from\s*\(\s*["'`]?([\p{L}\p{N}_]+)["'`]?\s*\)/giu]
  },
  performanceThresholds: {
    complexQueryCount: 3,
    unfilteredQueryCount: 3,
    joinedTableCount: 4
  },
  securityPatterns: {
    sqlInjectionRisks: ['${', 'concat', 'string interpolation'],
    parameterizedQueries: ['?', ':param', '$1', 'prepared', 'parameterized']
  },
  // DB wrapper functions that accept (sql, params) — same as .prepare().bind()
  // but expressed as a simple function call.  Must match the provenance system's
  // dbWrapperNames so the FP guards see the same capability list the detector does.
  dbWrapperNames: [...DB_WRAPPER_NAMES],
  // DB detection patterns — values shared with the schema analyzer, but owned by
  // THIS analyzer's namespace (no cross-analyzer fallback in analyzeAST).
  dbReceiverNames: [...DB_RECEIVER_NAMES],
  dbCallMethods: [...DB_CALL_METHOD_NAMES],
  dbBindingNames: [...DB_BINDING_NAMES],
  detection: { mode: 'hybrid' },
  // SQL sanitizer functions — interpolation via escapeSql(x) is not raw.
  sanitizerNames: ['escapeSql'],
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
  /** Enclosing function name for stable fingerprinting (Spec 18 Gap 2). */
  enclosingFunction?: string;
}

interface QueryAnalysis {
  complexity: 'simple' | 'moderate' | 'complex';
  tables: string[];
  hasJoins: boolean;
  hasSubquery: boolean;
  hasOrganizationFilter: boolean;
  performanceRisk: 'low' | 'medium' | 'high';
}

// ── Diagnostic infrastructure (one-time v3.4.12 adjuciation) ──────────────

/**
 * Build a violation attributed to this analyzer's fixed name.  Replaces the
 * base-class `createViolation` so every helper can be a module-level free
 * function (which keeps the analyzer class a thin orchestrator and collapses
 * its class-size / cyclomatic-complexity findings).
 */
function makeViolation(
  file: string,
  location: { line: number; column: number },
  message: string,
  severity: 'critical' | 'warning' | 'suggestion',
  rule: string,
  symbol?: string
): Violation {
  const v: Violation = {
    file,
    line: location.line,
    column: location.column,
    severity,
    message,
    rule,
    analyzer: 'data-access'
  };
  if (symbol) v.functionName = symbol;
  return v;
}

/**
 * Map imports to database types
 */
function mapDatabaseImports(
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
 * Predicate for the node-discovery pass of extractDatabaseCalls.  A node is a
 * candidate when it is a DB-provenanced function call, a template literal in a
 * DB-provenanced call's arguments, or a variable assignment holding SQL-shaped
 * text (Spec 17 R2 — content scanning is removed in favour of provenance).
 */
function isDbCallCandidate(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceContext?: ProvenanceContext,
): boolean {
  const nodeText = adapter.getNodeText(node, sourceCode);

  // Check if it's a function call whose callee is DB-related
  if (isFunctionCall(node, adapter)) {
    // Spec 21: Use provenance when available, fall back to name-based check
    if (provenanceContext) {
      if (isDBProvenanced(node, adapter, sourceCode, provenanceContext, DB_CALL_METHODS)) {
        return true;
      }
    }
  }

  // Spec 17 R2: Template literals are SQL candidates because of where they sit
  // (DB-provenanced call arguments), not what their body contains.
  if (isTemplateLiteral(node, adapter)) {
    return isTemplateInDBProvenancedCall(node, adapter, sourceCode, provenanceContext);
  }

  // Variable assignment with SQL structure — no child template check: the
  // template-literal path is now provenance-only (Spec 17 R2), so there is no
  // overlap risk from child template detection.
  if (isVariableAssignment(node, adapter)) {
    return containsSQLStructure(nodeText);
  }

  return false;
}

/**
 * Deduplicate discovered candidate nodes by line, preferring the most specific
 * node (a template literal over a variable declaration) when several share a line.
 */
function dedupeCandidateNodes(nodes: ASTNode[], adapter: LanguageAdapter): ASTNode[] {
  const nodesByLine = new Map<number, ASTNode[]>();
  nodes.forEach(node => {
    const line = node.location.start.line;
    if (!nodesByLine.has(line)) {
      nodesByLine.set(line, []);
    }
    nodesByLine.get(line)!.push(node);
  });

  const uniqueNodes: ASTNode[] = [];
  nodesByLine.forEach(nodesOnLine => {
    if (nodesOnLine.length === 1) {
      uniqueNodes.push(nodesOnLine[0]);
    } else {
      // Prefer template literals over variable declarations
      const templateLiteral = nodesOnLine.find(n => isTemplateLiteral(n, adapter));
      if (templateLiteral) {
        uniqueNodes.push(templateLiteral);
      } else {
        uniqueNodes.push(nodesOnLine[0]);
      }
    }
  });

  return uniqueNodes;
}

/**
 * Classify a single candidate node into a DatabaseCall, or null when it does not
 * look like a DB-related query.
 */
function buildDatabaseCall(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  ast: AST,
  dbImports: Map<string, { hasImports: boolean; patterns: string[] }>,
  config: DataAccessAnalyzerConfig,
): DatabaseCall | null {
  const nodeText = adapter.getNodeText(node, sourceCode);

  // Skip if the node text is too short or doesn't contain meaningful content
  if (!nodeText || nodeText.trim().length < 10) return null;

  // When a call_expression like db.prepare(`...`) spans multiple lines,
  // findNodes discovers both the call_expression (via path 1) and the
  // template_string inside its arguments (via path 2).  The template string
  // is the more precise target for injection checks, and isDynamicString-
  // Construction on a call_expression delegates to its template arguments
  // anyway.  Skip the call_expression here so we don't double-report the
  // same injection risk.
  if (isFunctionCall(node, adapter)) {
    const args = adapter.getChildren(node).find(
      c => adapter.getNodeType(c) === 'arguments',
    );
    if (args) {
      const hasTemplate = adapter.getChildren(args).some(
        c => isTemplateLiteral(c, adapter),
      );
      if (hasTemplate) return null;
    }
  }

  // Determine if this is a database-related call
  const isSqlQuery = containsSQLKeywords(nodeText);
  const isOrmCall = isOrmPattern(nodeText);

  if (!isSqlQuery && !isOrmCall) return null;

  const tables = extractTables(nodeText, config);
  const hasOrgFilter = hasOrganizationFilter(nodeText, config);
  const security = checkQuerySecurity(node, nodeText, ast, adapter, sourceCode, config);

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

  return {
    type: callType,
    method: extractMethodName(node, adapter, sourceCode),
    file: ast.filePath,
    line: node.location.start.line,
    column: node.location.start.column,
    tables,
    hasOrganizationFilter: hasOrgFilter,
    hasParameterizedQuery: security.parameterized,
    hasSqlInjectionRisk: security.injectionRisk,
    enclosingFunction: findEnclosingFunctionName(node, adapter),
  };
}

/**
 * Extract database calls from AST
 */
function extractDatabaseCalls(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbImports: Map<string, { hasImports: boolean; patterns: string[] }>,
  config: DataAccessAnalyzerConfig,
  provenanceContext?: ProvenanceContext,
): DatabaseCall[] {
  const allNodes = adapter.findNodes(ast, {
    custom: (node) => isDbCallCandidate(node, adapter, sourceCode, provenanceContext),
  });

  const uniqueNodes = dedupeCandidateNodes(allNodes, adapter);

  const calls: DatabaseCall[] = [];
  for (const node of uniqueNodes) {
    const call = buildDatabaseCall(node, adapter, sourceCode, ast, dbImports, config);
    if (call) calls.push(call);
  }

  return calls;
}

/**
 * Analyze a database query
 */
function analyzeQuery(
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
function checkViolations(
  call: DatabaseCall,
  analysis: QueryAnalysis,
  filePath: string,
  config: DataAccessAnalyzerConfig,
  symbolOrdinals: Map<string, number>,
): Violation[] {
  const violations: Violation[] = [];

  // Build a stable base symbol key — enclosing function + callee method.
  // Ordinal added for genuine repeats within the same function.
  const fnName = call.enclosingFunction ?? 'top-level';
  const baseSymbol = `${fnName}:${call.method}`;

  const ordinal = (symbolOrdinals.get(baseSymbol) ?? 0) + 1;
  symbolOrdinals.set(baseSymbol, ordinal);
  const symbol = ordinal > 1 ? `${baseSymbol}:${ordinal}` : baseSymbol;

  // Security: SQL Injection Risk
  // Spec 11 (calibration): Detection uses AST-level heuristics (string
  // concatenation in query construction) without type information. Findings
  // are high-signal but not proof of exploitable injection. Severity demoted
  // from critical → warning in Spec 17. Spec 11 will measure true-positive
  // rate on ExcAlDraw and Gin corpora to decide whether heuristics should be
  // tightened or severity re-escalated.
  if (config.checkSQLInjection && call.hasSqlInjectionRisk) {
    violations.push(makeViolation(
      filePath,
      { line: call.line, column: call.column },
      `Potential SQL injection risk in ${call.method}. Use parameterized queries.`,
      'suggestion',
      'sql-injection-risk',
      symbol
    ));
  }

  // Security: Missing Organization Filter
  if (config.checkOrgFilters && !call.hasOrganizationFilter && call.tables.length > 0 && requiresOrgFilter(call.tables, config)) {
    violations.push(makeViolation(
      filePath,
      { line: call.line, column: call.column },
      `Query on ${call.tables.join(', ')} missing organization/tenant filter`,
      'warning',
      'missing-org-filter',
      symbol
    ));
  }


  // Performance: Complex Query
  if (analysis.performanceRisk === 'high') {
    violations.push(makeViolation(
      filePath,
      { line: call.line, column: call.column },
      `Complex query with ${call.tables.length} tables may have performance issues`,
      'warning',
      'complex-query',
      symbol
    ));
  }

  // Performance: Unfiltered Query
  if (!call.hasOrganizationFilter && analysis.performanceRisk === 'medium') {
    violations.push(makeViolation(
      filePath,
      { line: call.line, column: call.column },
      `Unfiltered query on ${call.tables.join(', ')} may cause performance issues`,
      'suggestion',
      'unfiltered-query',
      symbol
    ));
  }

  return violations;
}

/**
 * Check general data access patterns
 */
function checkGeneralPatterns(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: DataAccessAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];


  // Check for hardcoded connection strings
  const stringNodes = adapter.findNodes(ast, {
    custom: (node) => isStringLiteral(node, adapter)
  });

  const hardcodedOrdinals = new Map<string, number>();

  for (const node of stringNodes) {
    const text = adapter.getNodeText(node, sourceCode);
    if (isConnectionString(text)) {
      const fnName = findEnclosingFunctionName(node, adapter);
      const baseSym = `${fnName}:hardcoded-connection`;
      const count = (hardcodedOrdinals.get(baseSym) ?? 0) + 1;
      hardcodedOrdinals.set(baseSym, count);
      const sym = count > 1 ? `${baseSym}:${count}` : baseSym;

      violations.push(makeViolation(
        ast.filePath,
        node.location.start,
        'Hardcoded database connection string detected. Use environment variables. (On Cloudflare Workers/D1, connection strings are injected via bindings.)',
        'suggestion',                                         // R7: direct-access → suggestion
        'hardcoded-connection',
        sym
      ));
    }
  }

  return violations;
}

/**
 * Helper methods
 */
function isFunctionCall(node: ASTNode, adapter: LanguageAdapter): boolean {
  return node.type === 'call_expression' ||
         node.type === 'new_expression';
}

function isTemplateLiteral(node: ASTNode, adapter: LanguageAdapter): boolean {
  return node.type === 'template_string';
}

function isVariableAssignment(node: ASTNode, adapter: LanguageAdapter): boolean {
  // Only get the actual variable declaration, not the statement
  return node.type === 'variable_declaration' ||
         node.type === 'binary_expression' && (node.children?.some(child =>
           adapter.getNodeText(child, '').includes('=')) ?? false);
}

function containsSQLKeywords(text: string): boolean {
  const upperText = text.toUpperCase();
  return SQL_KEYWORDS.some(keyword => upperText.includes(keyword));
}

/**
 * Spec 22 R4.2: Requires ≥2 SQL keywords for variable-assignment detection.
 *
 * Single-keyword substring matches (e.g. "FROM" inside "Array.from") produce
 * ~120 false positives on the recall corpus. Genuine SQL in variable
 * assignments (string literals, ORM chains) almost always has ≥2 keywords
 * (SELECT+FROM, INSERT+INTO, DELETE+FROM, etc.).
 *
 * This is only used for the variable-assignment fallback path — template
 * literals and function calls use separate, context-aware gating.
 */
function containsSQLStructure(text: string): boolean {
  const upperText = text.toUpperCase();
  const found = SQL_KEYWORDS.filter(keyword => upperText.includes(keyword));
  return found.length >= 2;
}

/**
 * Spec 17 R2 provenance gate: a template literal is a SQL candidate
 * because of where it sits (inside a DB-provenanced call's arguments),
 * NOT because its body contains SQL-shaped substrings.
 *
 * Content scanning with substring matching is removed — template bodies
 * containing natural-language words like "from" or "select" are no longer
 * misclassified. The cost: template literals assigned to variables whose
 * values eventually flow to DB calls are not detected (requires dataflow
 * analysis, which is outside the product's stated scope per Spec 15 R3).
 */
function isTemplateInDBProvenancedCall(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceContext?: ProvenanceContext,
): boolean {
  const parent = adapter.getParent(node);
  if (!parent) return false;
  const parentType = adapter.getNodeType(parent);

  // Only the arguments-of-DB-call path survives the Spec 17 R2 cut.
  // Variable-assignment and statement-level conservative passes are
  // removed — they were the primary source of false positives.
  if (parentType === 'arguments') {
    const callExpr = adapter.getParent(parent);
    if (!callExpr || adapter.getNodeType(callExpr) !== 'call_expression') return false;
    if (provenanceContext) {
      return isDBProvenanced(callExpr, adapter, sourceCode, provenanceContext, DB_CALL_METHODS);
    }
    // Without provenance context, can't determine DB association —
    // do not speculate.
    return false;
  }

  return false;
}

/**
 * Detect that a node sits inside a D1 .prepare() call — the standard safe
 * pattern for SQL in Cloudflare Workers.
 *
 * D1's parameterized API is `db.prepare(sql).bind(a, b, c).first()`.
 * This method also recognises `.prepare()` WITHOUT a subsequent `.bind()`
 * as safe: a prepared statement with no bind step has zero runtime
 * parameters, so template interpolation in the SQL text is query
 * composition with compile-time constants, not user input.
 *
 * Handles these patterns:
 *   • Direct chain:   `db.prepare(sql).bind(a).all()`
 *   • Two-statement:  `const stmt = db.prepare(sql); stmt.bind(a).all();`
 *   • No-param:       `db.prepare(sql).first()`  (no bind needed)
 *
 * Entry points:
 *   - a `template_string` node inside prepare()'s arguments
 *   - the prepare() call_expression itself
 */
function isInPrepareBindChain(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  // Step 1: Find the prepare call_expression from the node.
  let prepareCall: ASTNode | null;

  if (adapter.getNodeType(node) === 'template_string') {
    // Walk up through arguments → call_expression
    const args = adapter.getParent(node);
    if (!args || adapter.getNodeType(args) !== 'arguments') return false;
    prepareCall = adapter.getParent(args);
  } else if (adapter.getNodeType(node) === 'call_expression') {
    // Node is the call_expression itself — check if it's a prepare() call.
    prepareCall = node;
  } else {
    return false;
  }

  if (!prepareCall || adapter.getNodeType(prepareCall) !== 'call_expression') {
    return false;
  }

  // Step 2: Verify the call_expression is .prepare() by inspecting its
  // callee — the first child that is a member_expression, which may be
  // wrapped inside an await_expression (await db.prepare(sql)).
  let prepareCallee = adapter.getChildren(prepareCall).find(
    c => adapter.getNodeType(c) === 'member_expression',
  );
  if (!prepareCallee) {
    const awaitExpr = adapter.getChildren(prepareCall).find(
      c => adapter.getNodeType(c) === 'await_expression',
    );
    if (awaitExpr) {
      prepareCallee = adapter.getChildren(awaitExpr).find(
        c => adapter.getNodeType(c) === 'member_expression',
      );
    }
  }
  if (!prepareCallee) return false;

  const hasPrepareProp = adapter.getChildren(prepareCallee).some(
    c =>
      adapter.getNodeType(c) === 'property_identifier' &&
      adapter.getNodeText(c, sourceCode) === 'prepare',
  );
  if (!hasPrepareProp) return false;

  // Step 3: Walk up from the prepare call_expression to find .bind()
  // chained onto it.  The parent of prepareCall should be a
  // member_expression whose property is "bind".
  const memberExpr = adapter.getParent(prepareCall);
  if (memberExpr && adapter.getNodeType(memberExpr) === 'member_expression') {
    const hasBindProp = adapter.getChildren(memberExpr).some(
      c =>
        adapter.getNodeType(c) === 'property_identifier' &&
        adapter.getNodeText(c, sourceCode) === 'bind',
    );
    if (hasBindProp) {
      // Step 4: The member_expression's parent must be a call_expression
      // (the actual .bind() invocation).
      const bindCall = adapter.getParent(memberExpr);
      if (bindCall && adapter.getNodeType(bindCall) === 'call_expression') {
        return true;
      }
    }
  }

  // Step 5 (two-statement pattern): The direct-chain check failed.  Check
  // whether the prepare() result is assigned to a variable that is later
  // .bind()'ed in the same function scope.
  //   Pattern:  const stmt = db.prepare(sql);
  //             stmt.bind(x).all();
  if (isPrepareAssignedToVariable(prepareCall, adapter, sourceCode)) {
    return true;
  }

  // Step 6 (no-param prepare): Node is inside .prepare() with no .bind()
  // found in the direct chain or local scope.  Without .bind() the query
  // has no runtime parameterisation at the statement level.  Fall through
  // to let checkQuerySecurity determine whether template interpolation
  // makes the query dynamic.
  return false;
}

/**
 * Detect that a node sits inside a Durable Object .exec() call —
 * Cloudflare's internal SQLite interface for Durable Objects.
 *
 * `storage.sql.exec(query, ...bindings)` accepts *spread* bind parameters
 * after the query string.  A call WITH spread binds is fully parameterized
 * and safe.  A call WITHOUT spread binds has no runtime parameters, so
 * template interpolation is query-composition-time.
 *
 * Entry points: same as isInPrepareBindChain — a template_string inside
 * the arguments, or the call_expression itself.
 */
function isInExecChain(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  // Step 1: Find the exec call_expression from the node.
  let execCall: ASTNode | null;

  if (adapter.getNodeType(node) === 'template_string') {
    const args = adapter.getParent(node);
    if (!args || adapter.getNodeType(args) !== 'arguments') return false;
    execCall = adapter.getParent(args);
  } else if (adapter.getNodeType(node) === 'call_expression') {
    execCall = node;
  } else {
    return false;
  }

  if (!execCall || adapter.getNodeType(execCall) !== 'call_expression') {
    return false;
  }

  // Step 2: Verify the call_expression is .exec() — the member_expression
  // may be inside an await_expression wrapper (await sql.exec(query)).
  let execCallee = adapter.getChildren(execCall).find(
    c => adapter.getNodeType(c) === 'member_expression',
  );
  if (!execCallee) {
    const awaitExpr = adapter.getChildren(execCall).find(
      c => adapter.getNodeType(c) === 'await_expression',
    );
    if (awaitExpr) {
      execCallee = adapter.getChildren(awaitExpr).find(
        c => adapter.getNodeType(c) === 'member_expression',
      );
    }
  }
  if (!execCallee) return false;

  const hasExecProp = adapter.getChildren(execCallee).some(
    c =>
      adapter.getNodeType(c) === 'property_identifier' &&
      adapter.getNodeText(c, sourceCode) === 'exec',
  );
  if (!hasExecProp) return false;

  // Step 3: Check for spread bind parameters after the template.
  // `sql.exec(template, ...binds)` — the spread element in arguments
  // means values are parameterized.
  const args = adapter.getChildren(execCall).find(
    c => adapter.getNodeType(c) === 'arguments',
  );
  if (args) {
    const argChildren = adapter.getChildren(args);
    const hasSpread = argChildren.some(
      c => adapter.getNodeType(c) === 'spread_element',
    );
    if (hasSpread) {
      return true; // Parameterized via spread binds
    }
  }

  // Step 4: No spread binds — the query has no runtime bind parameters.
  // Fall through so checkQuerySecurity determines whether template
  // interpolation makes the query dynamic.  The "in-process SQLite"
  // argument does not make dynamic interpolation safe — if user-supplied
  // values reach the SQL text they are still injectable regardless of
  // whether the DB is remote or in-process.
  return false;
}

/**
 * Detect D1's convenience SQL methods — .all(), .first(), .run() —
 * called with bind parameters as a second argument.
 *
 * `db.all(query, ...params)` is shorthand for
 * `db.prepare(query).bind(...params).all()`.  If there's a second argument
 * (the bind params), the call is fully parameterized and safe.
 */
function isD1ConvenienceCall(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const D1_CONVENIENCE = new Set(['all', 'first', 'run']);

  // Find the call_expression.
  let call: ASTNode | null;
  if (adapter.getNodeType(node) === 'template_string') {
    const args = adapter.getParent(node);
    if (!args || adapter.getNodeType(args) !== 'arguments') return false;
    call = adapter.getParent(args);
  } else if (adapter.getNodeType(node) === 'call_expression') {
    call = node;
  } else {
    return false;
  }

  if (!call || adapter.getNodeType(call) !== 'call_expression') return false;

  // Verify the callee is one of .all / .first / .run — the
  // member_expression may be inside an await_expression wrapper
  // (await db.all(query, params)).
  let callee = adapter.getChildren(call).find(
    c => adapter.getNodeType(c) === 'member_expression',
  );
  if (!callee) {
    const awaitExpr = adapter.getChildren(call).find(
      c => adapter.getNodeType(c) === 'await_expression',
    );
    if (awaitExpr) {
      callee = adapter.getChildren(awaitExpr).find(
        c => adapter.getNodeType(c) === 'member_expression',
      );
    }
  }
  if (!callee) return false;

  const methodName = adapter.getChildren(callee).find(
    c =>
      adapter.getNodeType(c) === 'property_identifier' &&
      D1_CONVENIENCE.has(adapter.getNodeText(c, sourceCode)),
  );
  if (!methodName) return false;

  // Check for bind parameters — must have more than one argument.
  // The first argument is the query text; any subsequent argument
  // carries bind values for the ? placeholders.
  const args = adapter.getChildren(call).find(
    c => adapter.getNodeType(c) === 'arguments',
  );
  if (!args) return false;

  const argChildren = adapter.getChildren(args);
  // Filter out commas and whitespace; count real argument nodes.
  const realArgs = argChildren.filter(
    c => !['(', ')', ',', 'comment'].includes(adapter.getNodeType(c)),
  );
  return realArgs.length >= 2;
}

/**
 * Detect simple-function-call DB wrappers with bind parameters.
 *
 * dbWrapperNames (d1Query, d1Exec) are function wrappers that accept
 * (sqlTemplate, bindParams) — the same pattern as .prepare().bind() but
 * expressed as a direct function call rather than a method chain.
 *
 * `d1Query(\`SELECT ... WHERE x = ?\`, [value])` — bind params as second arg
 * means the call is fully parameterized, even though the template literal
 * text contains `${}` interpolation for table/column names.
 *
 * Entry point: a template_string inside the wrapper's arguments.
 */
function isWrapperFunctionWithBindParams(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  wrapperNames: string[],
): boolean {
  if (wrapperNames.length === 0) return false;
  if (adapter.getNodeType(node) !== 'template_string') return false;

  // Walk up from template_string → arguments → call_expression
  const args = adapter.getParent(node);
  if (!args || adapter.getNodeType(args) !== 'arguments') return false;
  const call = adapter.getParent(args);
  if (!call || adapter.getNodeType(call) !== 'call_expression') return false;

  // Check if the callee is a simple identifier (not member expression)
  // matching one of the wrapper names.
  const children = adapter.getChildren(call);
  const callee = children.find(c => adapter.getNodeType(c) === 'identifier');
  if (!callee) return false;
  const calleeName = adapter.getNodeText(callee, sourceCode);
  if (!wrapperNames.includes(calleeName)) return false;

  // Check for a second argument — the bind params.  A single-arg call
  // like d1Query(sql) without params has no runtime parameterization.
  const realArgs = adapter.getChildren(args).filter(
    c => !['(', ')', ','].includes(adapter.getNodeType(c)),
  );
  return realArgs.length >= 2;
}

/**
 * Check the two-statement prepare→bind pattern: db.prepare() is assigned to
 * a variable whose value is later .bind()'ed in the same function scope.
 *
 *   const stmt = db.prepare(sql);
 *   const result = stmt.bind(x).all();
 *
 * The direct-chain check (isInPrepareBindChain Step 3) only catches the
 * single-expression form `db.prepare(sql).bind(x).all()`.  This method
 * catches the common idiom where the prepared statement is stored in a local
 * before being bound.
 */
function isPrepareAssignedToVariable(
  prepareCall: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  // The parent of the prepare call_expression reveals how the result is used.
  const parent = adapter.getParent(prepareCall);
  if (!parent) return false;

  const parentType = adapter.getNodeType(parent);
  let varName: string | null = null;

  if (parentType === 'variable_declarator') {
    // const stmt = db.prepare(sql)
    const children = adapter.getChildren(parent);
    const nameChild = children.find(
      c => adapter.getNodeType(c) === 'identifier',
    );
    if (nameChild) {
      varName = adapter.getNodeText(nameChild, sourceCode);
    }
  } else if (parentType === 'assignment_expression') {
    // stmt = db.prepare(sql)
    const children = adapter.getChildren(parent);
    const left = children.find(
      c =>
        adapter.getNodeType(c) === 'identifier' ||
        adapter.getNodeType(c) === 'member_expression',
    );
    if (left) {
      varName = adapter.getNodeText(left, sourceCode);
    }
  }

  if (!varName) return false;

  // Scan the enclosing function scope for `.bind()` on this variable.
  const fnNode = findEnclosingFunctionNode(prepareCall, adapter);
  if (!fnNode) return false;

  const fnText = adapter.getNodeText(fnNode, sourceCode);
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bindPattern = new RegExp(
    String.raw`\b${escaped}\.bind\s*\(`,
    'u',
  );

  return bindPattern.test(fnText);
}

/**
 * Walk up the AST to find the enclosing function node (function_declaration,
 * arrow_function, or method_definition).  Returns null if we reach the
 * program root.
 */
function findEnclosingFunctionNode(
  node: ASTNode,
  adapter: LanguageAdapter,
): ASTNode | null {
  let current: ASTNode | null = node;
  while (current) {
    const type = adapter.getNodeType(current);
    if (
      type === 'function_declaration' ||
      type === 'function_expression' ||
      type === 'arrow_function' ||
      type === 'method_definition'
    ) {
      return current;
    }
    current = adapter.getParent(current);
  }
  return null;
}

function isOrmPattern(text: string): boolean {
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

function extractTables(text: string, config: DataAccessAnalyzerConfig): string[] {
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
  const ormVariablePattern = /\.from\s*\(\s*([\p{L}_][\p{L}\p{N}_]*)\s*\)/gu;
  const ormMatches = text.matchAll(ormVariablePattern);
  for (const match of ormMatches) {
    if (match[1] && !match[1].includes('"') && !match[1].includes("'")) {
      tables.add(match[1]);
    }
  }

  // Handle patterns like db.users.find() or db.orders.findOne()
  const dbTablePattern = /db\.([\p{L}_][\p{L}\p{N}_]*)\.\p{L}[\p{L}\p{N}_]*\s*\(/gu;
  const dbMatches = text.matchAll(dbTablePattern);
  for (const match of dbMatches) {
    if (match[1]) {
      tables.add(match[1]);
    }
  }

  return Array.from(tables);
}

function hasOrganizationFilter(text: string, config: DataAccessAnalyzerConfig): boolean {
  const patterns = config.organizationPatterns || [];
  const lowerText = text.toLowerCase();

  // If no patterns provided, check for hardcoded common patterns as fallback
  const fallbackPatterns = patterns.length === 0 ? [
    'organizationid', 'organization_id', 'orgid', 'org_id',
    'tenantid', 'tenant_id', 'companyid', 'company_id'
  ] : patterns;

  // Check for simple pattern matches first
  const hasSimpleMatch = fallbackPatterns.some(pattern => {
    const match = lowerText.includes(pattern.toLowerCase());
    return match;
  });

  if (hasSimpleMatch) {
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

  return false;
}

/**
 * True when the query is already parameterized by one of the four chain
 * shapes (.prepare().bind(), .exec() spread, D1 convenience call, or a DB
 * wrapper function with bind params).  All four short-circuit checkQuerySecurity
 * to a "safe" result.
 */
function isParameterizedByChain(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: DataAccessAnalyzerConfig,
): boolean {
  if (isInPrepareBindChain(node, adapter, sourceCode)) return true;
  if (isInExecChain(node, adapter, sourceCode)) return true;
  if (isD1ConvenienceCall(node, adapter, sourceCode)) return true;
  if (isWrapperFunctionWithBindParams(node, adapter, sourceCode, config.dbWrapperNames ?? [])) return true;
  return false;
}

/**
 * True when a single dynamic interpolation part is provably safe — via a
 * config-driven sanitizer allowlist, the adapter's cross-function safety
 * analysis, or a static-constant resolution for bare identifiers.  Otherwise
 * the part counts as unresolved (a candidate injection).
 */
function isSafeDynamicPart(
  part: DynamicPart,
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: DataAccessAnalyzerConfig,
): boolean {
  // Config-driven sanitizer allowlist (escapeSql(x), …) applies to
  // non-identifier expressions — an interpolation wrapped in a known
  // sanitizer isn't raw (same pattern as dbWrapperNames for provenance).
  if (!part.isIdentifier) {
    const normalized = part.text.trim();
    const sanitized = (config.sanitizerNames ?? []).some(name =>
      normalized.startsWith(name + '(') || normalized.startsWith(name + ' ('),
    );
    if (sanitized) return true;
  }

  // Prefer the adapter's cross-function safety analysis when available.  It
  // supersedes (and, for identifiers, subsumes) the static-constant check:
  // it clears quote-escape sanitizers, safe ternaries, static-array
  // `.map().join()` chains, safe local helper calls, and guard-validated /
  // call-site-provenanced parameters — without weakening raw-input detection.
  if (part.node && adapter.isSafeInterpolation) {
    if (adapter.isSafeInterpolation(part.node, ast, sourceCode)) return true;
    return false;
  }

  // Fallback for adapters without isSafeInterpolation: resolve identifiers
  // to compile-time constants only.
  if (part.isIdentifier) {
    const resolved = part.node && adapter.resolveLocalConstant
      ? adapter.resolveLocalConstant(part.node, ast, sourceCode)
      : null;
    if (resolved && resolved.isStatic) return true;
    return false;
  }

  // A non-identifier expression with no safety analysis available — can't
  // prove it safe, so treat it as unresolved.
  return false;
}

function checkQuerySecurity(
  node: ASTNode,
  text: string,
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: DataAccessAnalyzerConfig
): {
  parameterized: boolean;
  injectionRisk: boolean;
  message?: string;
} {
  // Check for the four parameterized-chain shapes (D1 .prepare().bind(),
  // Durable Objects .exec() spread, D1 convenience methods, and DB wrapper
  // functions) — each means the query is safe without further analysis.
  if (isParameterizedByChain(node, adapter, sourceCode, config)) {
    return { parameterized: true, injectionRisk: false };
  }

  const parameterized = (config.securityPatterns?.parameterizedQueries || []).some(pattern =>
    text.includes(pattern)
  );

  if (parameterized) {
    return { parameterized: true, injectionRisk: false };
  }

  // If the adapter doesn't implement the dynamic-string capability, we can't
  // determine whether the query text was constructed unsafely.  Err on the
  // quiet side — no capability means no injection-risk finding.
  if (!adapter.isDynamicStringConstruction || !adapter.getDynamicParts) {
    return { parameterized: false, injectionRisk: false };
  }

  // Only a dynamically-constructed string (template literal, binary +, etc.)
  // can be an injection risk.  Plain string literals are always safe.
  if (!adapter.isDynamicStringConstruction(node)) {
    return { parameterized: false, injectionRisk: false };
  }

  // Still require SQL keywords in the text — a dynamic string without them
  // isn't a SQL injection.
  if (!containsSQLKeywords(text)) {
    return { parameterized: false, injectionRisk: false };
  }

  // Extract the dynamic sub-parts and check whether they're provably safe.
  const dynamicParts = adapter.getDynamicParts(node, sourceCode);
  const unresolved = dynamicParts
    .filter(part => !isSafeDynamicPart(part, ast, adapter, sourceCode, config))
    .map(part => part.text);

  if (unresolved.length === 0) {
    // All dynamic parts are provably safe — no injection risk.
    return { parameterized: false, injectionRisk: false };
  }

  const names = unresolved.map(id => '${' + id + '}').join(', ');
  return {
    parameterized: false,
    injectionRisk: true,
    message: `Cannot protect interpolated content: ${names}`,
  };
}

function extractCallExpressionMethod(
  callExpr: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string {
  // Extract the method name from the callee of a call expression.
  // For `sql.exec(...)` the callee is a member_expression whose
  // property_identifier is "exec".  Walking the AST avoids picking up SQL
  // keywords (COUNT, JOIN, WHERE, ...) that appear inside template literals
  // in the call arguments, which a regex scan of the full call-expression
  // text would incorrectly match.
  const children = adapter.getChildren(callExpr);
  const callee = children.find(c => {
    const t = adapter.getNodeType(c);
    return t === 'member_expression' || t === 'identifier';
  });
  if (callee) {
    const calleeType = adapter.getNodeType(callee);
    if (calleeType === 'member_expression') {
      const mc = adapter.getChildren(callee);
      const prop = mc.find(c => adapter.getNodeType(c) === 'property_identifier');
      if (prop) return adapter.getNodeText(prop, sourceCode);
    } else {
      // Bare identifier call (e.g. `exec(...)`)
      return adapter.getNodeText(callee, sourceCode);
    }
  }
  // Fallback: regex on just the callee portion of the text
  const callText = adapter.getNodeText(callExpr, sourceCode);
  const m = callText.match(/\.(\w+)\s*[<(]/);
  return m ? m[1] : 'unknown';
}

function extractMethodName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string {
  const nodeType = adapter.getNodeType(node);

  // For template literals inside a DB-provenanced call, extract the method
  // name from the enclosing call expression instead of the template body.
  if (nodeType === 'template_string' || nodeType === 'template_literal') {
    const parent = adapter.getParent(node);
    if (parent && adapter.getNodeType(parent) === 'arguments') {
      const callExpr = adapter.getParent(parent);
      if (callExpr && adapter.getNodeType(callExpr) === 'call_expression') {
        return extractCallExpressionMethod(callExpr, adapter, sourceCode);
      }
    }
  }

  // For call expressions themselves, extract from the callee child. The
  // full node text includes the arguments (which may contain template
  // literals with SQL keywords), so a naive regex scan of the whole text
  // can match COUNT, JOIN, WHERE, etc. instead of the real method name.
  if (nodeType === 'call_expression') {
    return extractCallExpressionMethod(node, adapter, sourceCode);
  }

  const text = adapter.getNodeText(node, sourceCode);
  const match = text.match(/([\p{L}\p{N}_]+)\s*\(/u);
  return match ? match[1] : 'unknown';
}

/**
 * Spec 21 R6.2: Three-tier org-filter detection.
 *
 * Tier 1 (config-primary): `orgFilterTables` — the user's explicit declaration
 *   of which tables are multi-tenant. Tenancy is policy; this is the
 *   declaration of record.
 *
 * Tier 2 (usage-inference secondary): A table requires the filter if the
 *   project's own corpus shows it scoped — i.e., a column matching
 *   `orgFilterColumns` (default: org_id/tenant_id/organization_id/workspace_id)
 *   exists on it in the schema definitions in config.
 *   This is what makes non-English table names (e.g., 注文) detectable
 *   with zero explicit orgFilterTables declaration.
 *
 * Tier 3 (fallback): English table list retained as defaults, evidence-tagged
 *   `fallback` like every other name list in Spec 21.
 */
function requiresOrgFilter(tables: string[], config: DataAccessAnalyzerConfig): boolean {
  const orgFilterTables = config.orgFilterTables ?? [];
  const orgFilterColumns = config.orgFilterColumns ?? ['org_id', 'tenant_id', 'organization_id', 'workspace_id'];
  const schemas = config.schemas ?? [];
  const fallbackOrgTables = ['users', 'projects', 'orders', 'customers', 'accounts', 'teams'];

  // Build a lookup set of tables from schema definitions that have an
  // org-filter column — this is the usage-inference tier.
  const schemaOrgTables = new Set<string>();
  for (const schema of schemas) {
    for (const table of schema.tables) {
      if (table.columns.some(c => orgFilterColumns.includes(c.name.toLowerCase()))) {
        schemaOrgTables.add(table.name.toLowerCase());
      }
    }
  }

  return tables.some(table => {
    const tableLower = table.toLowerCase();

    // Tier 1: config-primary — explicit user declaration
    if (orgFilterTables.some(t => t.toLowerCase() === tableLower)) {
      return true;
    }

    // Tier 2: schema-based inference — table has an org-filter column
    if (schemaOrgTables.has(tableLower)) {
      return true;
    }

    // Tier 3: English fallback
    return fallbackOrgTables.includes(tableLower);
  });
}

function isStringLiteral(node: ASTNode, adapter: LanguageAdapter): boolean {
  return node.type === 'string' || node.type === 'template_string';
}

function isConnectionString(text: string): boolean {
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
function checkLoopQueries(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: DataAccessAnalyzerConfig,
  provenanceContext?: ProvenanceContext,
): Violation[] {
  const violations: Violation[] = [];

  // Find all nodes that look like database calls (Spec 21: provenance-gated)
  const dbNodes = adapter.findNodes(ast, {
    custom: (node) => isDbCallNode(node, adapter, sourceCode, provenanceContext),
  });

  // Track reported line+loop combos to avoid duplicates (runtime dedup only)
  const reported = new Set<string>();
  // Track symbol ordinals per enclosing function for fingerprint stability
  const loopOrdinals = new Map<string, number>();

  for (const node of dbNodes) {
    const nodeText = adapter.getNodeText(node, sourceCode);
    if (!nodeText || nodeText.trim().length < 10) continue;

    const loopInfo = findEnclosingLoop(node, adapter);
    if (!loopInfo) continue;

    // R4.1: Use query node's actual location (never line 1)
    const queryLine = node.location.start.line;

    // Deduplicate: same line + same loop line = already reported
    const dedupKey = `${queryLine}:${loopInfo.loopNode.location.start.line}`;
    if (reported.has(dedupKey)) continue;
    reported.add(dedupKey);

    // Stable fingerprint symbol: enclosing function + ordinal
    const enclosingFn = findEnclosingFunctionName(node, adapter);
    const baseSym = `${enclosingFn}:loop-query`;
    const count = (loopOrdinals.get(baseSym) ?? 0) + 1;
    loopOrdinals.set(baseSym, count);
    const sym = count > 1 ? `${baseSym}:${count}` : baseSym;

    // R4.2: Nested-loop attribution
    const depthMsg = loopInfo.depth > 1
      ? ` (nested ${loopInfo.depth} levels deep)`
      : '';

    violations.push(makeViolation(
      ast.filePath,
      node.location.start,                                   // query-call line, never line 1
      `Database query inside loop${depthMsg} ` +
      `(loop at line ${loopInfo.loopNode.location.start.line}). ` +
      `This may cause N+1 performance issues. Consider batching queries or using a join.`,
      'warning',                                             // R7: loop-query → warning
      'loop-query',
      sym
    ));
  }

  return violations;
}

/**
 * R4.1: Determine if a node is a database call expression.
 * Spec 21: When provenance context is available, uses provenance-based detection
 * (conjunctive guard — never name alone). In names mode or without context,
 * falls back to the legacy dbPatterns text match.
 */
function isDbCallNode(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceContext?: ProvenanceContext,
): boolean {
  // Spec 21: Provenance-first detection when context is available
  if (provenanceContext && provenanceContext.mode !== 'names') {
    // In provenance or hybrid mode, use provenance check
    if (isFunctionCall(node, adapter)) {
      if (isDBProvenanced(node, adapter, sourceCode, provenanceContext, DB_CALL_METHODS)) {
        return true;
      }
    }
    // Spec 17 R2: Template literal is a DB node only when it sits
    // inside a DB-provenanced call's arguments — no content scan.
    if (isTemplateLiteral(node, adapter)) {
      const parent = adapter.getParent(node);
      if (parent && adapter.getNodeType(parent) === 'arguments') {
        const callExpr = adapter.getParent(parent);
        if (callExpr && adapter.getNodeType(callExpr) === 'call_expression') {
          return isDBProvenanced(callExpr, adapter, sourceCode, provenanceContext, DB_CALL_METHODS);
        }
      }
      return false;
    }
    return false;
  }

  // Legacy fallback: name-based matching for names mode / no context.
  // Template-literal content scanning is removed (Spec 17 R2) — without
  // provenance context, we can't determine if a template literal is SQL;
  // function-call-based SQL detection still works via dbPatterns match.
  const nodeText = adapter.getNodeText(node, sourceCode);

  if (isFunctionCall(node, adapter)) {
    const dbPatterns = ['select', 'insert', 'update', 'delete', 'from', 'where', 'execute', 'query', 'find', 'aggregate', 'count', 'distinct'];
    if (dbPatterns.some(pattern => nodeText.toLowerCase().includes(pattern))) {
      return true;
    }
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
function findEnclosingLoop(
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
    if (isIteratorCallback(parent, adapter)) {
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
function isIteratorCallback(node: ASTNode, adapter: LanguageAdapter): boolean {
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
  const propText = methodName || getPropertyName(propertyNode, adapter);

  return iteratorMethods.includes(propText);
}

/**
 * Extract the property name from a property_identifier node.
 */
function getPropertyName(node: ASTNode, adapter: LanguageAdapter): string {
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

/**
 * Walk the parent chain to find the enclosing function/method/arrow name.
 * Returns 'top-level' if no enclosing function is found.
 *
 * Used for stable fingerprint symbols — the enclosing function name is
 * immune to line drift (Spec 18 Gap 2).
 */
function findEnclosingFunctionName(node: ASTNode, adapter: LanguageAdapter): string {
  let current = adapter.getParent(node);
  while (current) {
    const type = adapter.getNodeType(current);

    // Arrow functions, function declarations, function expressions
    if (
      type === 'arrow_function' ||
      type === 'function_declaration' ||
      type === 'function_expression' ||
      type === 'generator_function_declaration' ||
      type === 'generator_function_expression'
    ) {
      const name = getNodeName(current, adapter);
      if (name) return name;
    }

    // Method definitions on classes/objects
    if (type === 'method_definition' || adapter.isMethod(current)) {
      const name = getNodeName(current, adapter);
      if (name) return name;
    }

    current = adapter.getParent(current);
  }
  return 'top-level';
}

/**
 * Extract the name/identifier from a function or method AST node.
 */
function getNodeName(node: ASTNode, adapter: LanguageAdapter): string {
  // Try named children first
  if ((node as any).name && typeof (node as any).name === 'string') return (node as any).name;
  if ((node as any).text && typeof (node as any).text === 'string') return (node as any).text;
  // Fall back to the raw tree-sitter node's text content (leaf identifiers etc.)
  const rawText = (node.raw as any)?.text;
  if (typeof rawText === 'string' && rawText.length > 0) return rawText;

  // Walk children for identifier / property_identifier
  if (node.children) {
    for (const child of node.children) {
      const childType = adapter.getNodeType(child);
      if (
        childType === 'identifier' ||
        childType === 'property_identifier'
      ) {
        const name = getNodeName(child, adapter);
        if (name) return name;
      }
    }
  }

  return '';
}

/**
 * Universal data access analyzer.
 */
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

    // Spec 21: Build provenance context for this file (R1 — provenance-primary detection).
    // DB-detection patterns come from THIS analyzer's own defaults (finalConfig),
    // not the schema analyzer's — each analyzer owns its own namespace of keys.
    const detectionMode: DetectionMode =
      finalConfig.detection?.mode ?? 'hybrid';
    const p0 = performance.now();
    const provenanceContext = buildProvenanceContext(ast, adapter, sourceCode, {
      mode: detectionMode,
      dbReceiverNames: finalConfig.dbReceiverNames,
      dbBindingNames: finalConfig.dbBindingNames,
      dbCallMethods: finalConfig.dbCallMethods,
      dbWrapperNames: finalConfig.dbWrapperNames,
    });
    const timingAcc: { totalMs: number } | undefined = (config as any)._provenanceTiming;
    if (timingAcc) timingAcc.totalMs += performance.now() - p0;

    // Check imports for database libraries
    const imports = adapter.extractImports(ast);
    const dbImports = mapDatabaseImports(imports, finalConfig);

    // Find database calls (Spec 21: uses provenance context)
    const calls = extractDatabaseCalls(ast, adapter, sourceCode, dbImports, finalConfig, provenanceContext);

    // Analyze each call — track symbol ordinals for fingerprint stability
    const symbolOrdinals = new Map<string, number>();
    for (const call of calls) {
      const analysis = analyzeQuery(call, sourceCode, finalConfig);

      // Check for violations
      violations.push(...checkViolations(call, analysis, ast.filePath, finalConfig, symbolOrdinals));
    }

    // R4.1: Check for database queries inside loops (N+1 detection, Spec 21: provenance-gated)
    violations.push(...checkLoopQueries(ast, adapter, sourceCode, finalConfig, provenanceContext));

    // Check for general data access patterns
    violations.push(...checkGeneralPatterns(ast, adapter, sourceCode, finalConfig));

    return violations;
  }
}
