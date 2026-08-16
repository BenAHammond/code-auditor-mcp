/**
 * Universal Data Access Analyzer
 * Works across multiple programming languages using the adapter pattern
 * Analyzes database access patterns and data layer interactions
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { withRuleTiming } from '../ruleTiming.js';
import type { Violation, Resolution } from '../../types.js';
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
 * Bundled classification for a data-access violation — `severity`, `rule`,
 * and an optional `symbol` travel together so `makeViolation` stays a 4-arg
 * call rather than a 6-arg one (Spec 34 param-count bundling).
 */
interface DataAccessViolationClassification {
  severity: 'critical' | 'warning' | 'suggestion';
  rule: string;
  symbol?: string;
  /** Spec 37 R1 — structured next action carried on gating findings. */
  resolution?: Resolution;
}

/**
 * Per-file analysis context threaded through the data-access helper chain.
 * Bundles `adapter` / `sourceCode` / `dbImports` / `config` / `provenanceContext`
 * into one object so the helpers that previously took 5–6 positional params
 * (buildDatabaseCall, extractDatabaseCalls, checkQuerySecurity, …) clear the
 * 4-parameter gate without each defining its own bespoke context type.
 */
interface DataAccessScanContext {
  adapter: LanguageAdapter;
  sourceCode: string;
  dbImports: Map<string, { hasImports: boolean; patterns: string[] }>;
  config: DataAccessAnalyzerConfig;
  provenanceContext?: ProvenanceContext;
}

/**
 * Bundled inputs for checkViolations — file path, config, and the mutable
 * symbol-ordinal map are threaded together so the helper stays a 3-arg call.
 */
interface ViolationCheckContext {
  filePath: string;
  config: DataAccessAnalyzerConfig;
  symbolOrdinals: Map<string, number>;
}

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
  classification: DataAccessViolationClassification,
): Violation {
  const v: Violation = {
    file,
    line: location.line,
    column: location.column,
    severity: classification.severity,
    message,
    rule: classification.rule,
    analyzer: 'data-access'
  };
  if (classification.symbol) v.functionName = classification.symbol;
  if (classification.resolution) v.resolution = classification.resolution;
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
      if (isDBProvenanced(node, { adapter, sourceCode, context: provenanceContext, methods: DB_CALL_METHODS })) {
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
  ast: AST,
  scan: DataAccessScanContext,
): DatabaseCall | null {
  const { adapter, sourceCode, dbImports, config } = scan;
  const nodeText = adapter.getNodeText(node, sourceCode);
  if (!nodeText || nodeText.trim().length < 10) return null;

  // Skip when a call_expression like db.prepare(`...`) is rediscovered via
  // its template argument (path 2) — the template string is the precise target.
  if (shouldSkipCallForTemplateArg(node, adapter)) return null;

  const isSqlQuery = containsSQLKeywords(nodeText);
  const isOrmCall = isOrmPattern(nodeText);
  if (!isSqlQuery && !isOrmCall) return null;

  const tables = extractTables(nodeText, config);
  const hasOrgFilter = hasOrganizationFilter(nodeText, config);
  const security = withRuleTiming('sql-injection-risk', () =>
    checkQuerySecurity(node, nodeText, ast, scan));

  let callType = 'unknown';
  if (isSqlQuery) {
    callType = 'sql';
  } else if (isOrmCall) {
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
 * True when a call_expression node carries a template-literal argument and so
 * should be skipped in favour of the template string (path 2) itself.
 */
function shouldSkipCallForTemplateArg(node: ASTNode, adapter: LanguageAdapter): boolean {
  if (!isFunctionCall(node, adapter)) return false;
  const args = adapter.getChildren(node).find(
    c => adapter.getNodeType(c) === 'arguments',
  );
  if (!args) return false;
  return adapter.getChildren(args).some(c => isTemplateLiteral(c, adapter));
}

/**
 * Extract database calls from AST
 */
function extractDatabaseCalls(
  ast: AST,
  scan: DataAccessScanContext,
): DatabaseCall[] {
  const { adapter, sourceCode, provenanceContext } = scan;
  const allNodes = adapter.findNodes(ast, {
    custom: (node) => isDbCallCandidate(node, adapter, sourceCode, provenanceContext),
  });

  const uniqueNodes = dedupeCandidateNodes(allNodes, adapter);

  const calls: DatabaseCall[] = [];
  for (const node of uniqueNodes) {
    const call = buildDatabaseCall(node, ast, scan);
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
  ctx: ViolationCheckContext,
): Violation[] {
  const { filePath, config, symbolOrdinals } = ctx;
  const violations: Violation[] = [];

  const symbol = nextSymbol(call.enclosingFunction ?? 'top-level', call.method, symbolOrdinals);
  const push = (message: string, opts: Omit<DataAccessViolationClassification, 'symbol'>) =>
    violations.push(makeViolation(filePath, { line: call.line, column: call.column }, message, { ...opts, symbol }));

  // Security: SQL injection — AST heuristics, high-signal not proof, so
  // `warning` not `critical`; manual quote-escaping is not sanitization.
  if (config.checkSQLInjection && call.hasSqlInjectionRisk) {
    push(`Potential SQL injection risk in ${call.method}. Use parameterized queries.`, {
      severity: 'warning',
      rule: 'sql-injection-risk',
      resolution: {
        action: 'parameterize',
        summary: `Replace the string-interpolated SQL in ${call.method} with a parameterized query — bind values via the driver's placeholder form (\`?\`, \`$1\`, or \`:name\`) instead of concatenating them into the statement.`,
        symbols: [call.method],
        files: [filePath],
        lines: [call.line],
      },
    });
  }

  // Security: Missing Organization Filter
  if (config.checkOrgFilters && !call.hasOrganizationFilter && call.tables.length > 0 && requiresOrgFilter(call.tables, config)) {
    push(`Query on ${call.tables.join(', ')} missing organization/tenant filter`, { severity: 'warning', rule: 'missing-org-filter' });
  }

  // Performance: Complex Query
  if (analysis.performanceRisk === 'high') {
    push(`Complex query with ${call.tables.length} tables may have performance issues`, { severity: 'warning', rule: 'complex-query' });
  }

  // Performance: Unfiltered Query
  if (!call.hasOrganizationFilter && analysis.performanceRisk === 'medium') {
    push(`Unfiltered query on ${call.tables.join(', ')} may cause performance issues`, { severity: 'suggestion', rule: 'unfiltered-query' });
  }

  return violations;
}

/** Compute the next stable violation symbol key for a (function, method) pair. */
function nextSymbol(
  fnName: string,
  method: string,
  symbolOrdinals: Map<string, number>,
): string {
  const baseSymbol = `${fnName}:${method}`;
  const ordinal = (symbolOrdinals.get(baseSymbol) ?? 0) + 1;
  symbolOrdinals.set(baseSymbol, ordinal);
  return ordinal > 1 ? `${baseSymbol}:${ordinal}` : baseSymbol;
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
        { severity: 'suggestion', rule: 'hardcoded-connection', symbol: sym } // R7: direct-access → suggestion
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
      return isDBProvenanced(callExpr, { adapter, sourceCode, context: provenanceContext, methods: DB_CALL_METHODS });
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
  const prepareCall = findCallFromEntry(node, adapter);
  if (!prepareCall) return false;

  const callee = findMemberCallee(prepareCall, adapter);
  if (!callee || !hasProperty(callee, 'prepare', adapter, sourceCode)) return false;

  // Direct chain: prepareCall.parent is a .bind member whose parent is a call.
  if (isDirectBindChain(prepareCall, adapter, sourceCode)) return true;

  // Two-statement pattern: const stmt = db.prepare(sql); stmt.bind(x).all();
  if (isPrepareAssignedToVariable(prepareCall, adapter, sourceCode)) return true;

  return false;
}

/** Locate the call_expression a node belongs to, if any. */
function findCallFromEntry(node: ASTNode, adapter: LanguageAdapter): ASTNode | null {
  const type = adapter.getNodeType(node);
  if (type === 'template_string') {
    const args = adapter.getParent(node);
    if (!args || adapter.getNodeType(args) !== 'arguments') return null;
    const call = adapter.getParent(args);
    return call && adapter.getNodeType(call) === 'call_expression' ? call : null;
  }
  if (type === 'call_expression') return node;
  return null;
}

/** Find a call's member_expression callee, unwrapping await_expression if present. */
function findMemberCallee(call: ASTNode, adapter: LanguageAdapter): ASTNode | null {
  const direct = adapter.getChildren(call).find(
    c => adapter.getNodeType(c) === 'member_expression',
  );
  if (direct) return direct;
  const awaitExpr = adapter.getChildren(call).find(
    c => adapter.getNodeType(c) === 'await_expression',
  );
  if (!awaitExpr) return null;
  return adapter.getChildren(awaitExpr).find(
    c => adapter.getNodeType(c) === 'member_expression',
  ) ?? null;
}

/** True when `node`'s property_identifier equals `prop`. */
function hasProperty(node: ASTNode, prop: string, adapter: LanguageAdapter, sourceCode: string): boolean {
  return memberPropertyName(node, adapter, sourceCode) === prop;
}

/** The property_identifier text of a member_expression, or null. */
function memberPropertyName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const prop = adapter.getChildren(node).find(
    c => adapter.getNodeType(c) === 'property_identifier',
  );
  return prop ? adapter.getNodeText(prop, sourceCode) : null;
}

/** True when a call's arguments contain a spread_element (…binds). */
function hasSpreadArgument(call: ASTNode, adapter: LanguageAdapter): boolean {
  const args = adapter.getChildren(call).find(
    c => adapter.getNodeType(c) === 'arguments',
  );
  if (!args) return false;
  return adapter.getChildren(args).some(
    c => adapter.getNodeType(c) === 'spread_element',
  );
}

/** Count real (non-punctuation) arguments in a call. */
function countArgs(call: ASTNode, adapter: LanguageAdapter): number {
  const args = adapter.getChildren(call).find(
    c => adapter.getNodeType(c) === 'arguments',
  );
  if (!args) return 0;
  return adapter.getChildren(args).filter(
    c => !['(', ')', ',', 'comment'].includes(adapter.getNodeType(c)),
  ).length;
}

/** True when a prepare() call is directly followed by a `.bind()` invocation. */
function isDirectBindChain(
  prepareCall: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const memberExpr = adapter.getParent(prepareCall);
  if (!memberExpr || adapter.getNodeType(memberExpr) !== 'member_expression') return false;
  if (!hasProperty(memberExpr, 'bind', adapter, sourceCode)) return false;
  const bindCall = adapter.getParent(memberExpr);
  return !!bindCall && adapter.getNodeType(bindCall) === 'call_expression';
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
  const execCall = findCallFromEntry(node, adapter);
  if (!execCall) return false;

  const callee = findMemberCallee(execCall, adapter);
  if (!callee || !hasProperty(callee, 'exec', adapter, sourceCode)) return false;

  // `sql.exec(template, ...binds)` — spread element means parameterized.
  // Without it, there are no runtime binds: template interpolation is
  // query-composition-time and checkQuerySecurity decides if it's dynamic.
  return hasSpreadArgument(execCall, adapter);
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

  const call = findCallFromEntry(node, adapter);
  if (!call) return false;

  const callee = findMemberCallee(call, adapter);
  const method = callee ? memberPropertyName(callee, adapter, sourceCode) : null;
  if (!method || !D1_CONVENIENCE.has(method)) return false;

  // Bind params as a second argument → fully parameterized and safe.
  return countArgs(call, adapter) >= 2;
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
  const patterns = config.organizationPatterns ?? [];
  const lowerText = text.toLowerCase();

  // No patterns → hardcoded common fallback set.
  const candidates = patterns.length
    ? patterns
    : ['organizationid', 'organization_id', 'orgid', 'org_id',
       'tenantid', 'tenant_id', 'companyid', 'company_id'];

  return candidates.some(p => matchesOrganizationPattern(lowerText, p.toLowerCase()));
}

/** True when `p` appears in `lowerText` as a bare token, object property, or SQL clause. */
function matchesOrganizationPattern(lowerText: string, p: string): boolean {
  return (
    lowerText.includes(p) ||
    lowerText.includes(`${p}:`) ||
    lowerText.includes(`"${p}"`) ||
    lowerText.includes(`'${p}'`) ||
    lowerText.includes(`where ${p} =`) || lowerText.includes(`where ${p}=`) ||
    lowerText.includes(`and ${p} =`) || lowerText.includes(`and ${p}=`)
  );
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
  scan: DataAccessScanContext,
): boolean {
  const { adapter, sourceCode, config } = scan;
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
  scan: DataAccessScanContext,
): { parameterized: boolean; injectionRisk: boolean; message?: string } {
  const { adapter, sourceCode, config } = scan;

  // Parameterized chains (.prepare().bind(), .exec() spread, D1 convenience,
  // DB wrappers) and explicit parameterization are always safe.
  if (isParameterizedByChain(node, adapter, sourceCode, config)) {
    return { parameterized: true, injectionRisk: false };
  }
  if ((config.securityPatterns?.parameterizedQueries || []).some(p => text.includes(p))) {
    return { parameterized: true, injectionRisk: false };
  }

  // No dynamic-string capability → can't prove unsafe; err quiet.
  if (!adapter.isDynamicStringConstruction || !adapter.getDynamicParts) {
    return { parameterized: false, injectionRisk: false };
  }
  // Only a dynamically-constructed string carrying SQL keywords can inject.
  if (!adapter.isDynamicStringConstruction(node) || !containsSQLKeywords(text)) {
    return { parameterized: false, injectionRisk: false };
  }

  const unresolved = adapter.getDynamicParts(node, sourceCode)
    .filter(part => !isSafeDynamicPart(part, ast, scan))
    .map(part => part.text);
  if (unresolved.length === 0) {
    return { parameterized: false, injectionRisk: false };
  }

  return {
    parameterized: false,
    injectionRisk: true,
    message: `Cannot protect interpolated content: ${unresolved.map(id => '${' + id + '}').join(', ')}`,
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
  scan: DataAccessScanContext,
): Violation[] {
  const { adapter, sourceCode, provenanceContext } = scan;
  const violations: Violation[] = [];

  // Spec 21: provenance-gated detection of database calls.
  const dbNodes = adapter.findNodes(ast, {
    custom: (node) => isDbCallNode(node, adapter, sourceCode, provenanceContext),
  });

  const reported = new Set<string>();
  const loopOrdinals = new Map<string, number>();

  for (const node of dbNodes) {
    const nodeText = adapter.getNodeText(node, sourceCode);
    if (!nodeText || nodeText.trim().length < 10) continue;

    const loopInfo = findEnclosingLoop(node, adapter);
    if (!loopInfo) continue;

    // R4.1: query node's actual location (never line 1) + runtime dedup.
    const queryLine = node.location.start.line;
    const dedupKey = `${queryLine}:${loopInfo.loopNode.location.start.line}`;
    if (reported.has(dedupKey)) continue;
    reported.add(dedupKey);

    const sym = nextSymbol(findEnclosingFunctionName(node, adapter), 'loop-query', loopOrdinals);
    // R4.2: Nested-loop attribution.
    const depthMsg = loopInfo.depth > 1 ? ` (nested ${loopInfo.depth} levels deep)` : '';

    violations.push(makeViolation(
      ast.filePath,
      node.location.start,
      `Database query inside loop${depthMsg} ` +
      `(loop at line ${loopInfo.loopNode.location.start.line}). ` +
      `This may cause N+1 performance issues. Consider batching queries or using a join.`,
      { severity: 'warning', rule: 'loop-query', symbol: sym },
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
      if (isDBProvenanced(node, { adapter, sourceCode, context: provenanceContext, methods: DB_CALL_METHODS })) {
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
          return isDBProvenanced(callExpr, { adapter, sourceCode, context: provenanceContext, methods: DB_CALL_METHODS });
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

    // Spec 21 R1: provenance-primary detection (names owned by THIS analyzer).
    const detectionMode: DetectionMode = finalConfig.detection?.mode ?? 'hybrid';
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

    // Spec 34: bundle per-file context to stay under the 4-parameter gate.
    const scan: DataAccessScanContext = {
      adapter,
      sourceCode,
      dbImports: mapDatabaseImports(adapter.extractImports(ast), finalConfig),
      config: finalConfig,
      provenanceContext,
    };

    // Analyze each database call, tracking symbol ordinals for stable fingerprints.
    const symbolOrdinals = new Map<string, number>();
    for (const call of extractDatabaseCalls(ast, scan)) {
      const analysis = analyzeQuery(call, sourceCode, finalConfig);
      violations.push(...checkViolations(call, analysis, {
        filePath: ast.filePath,
        config: finalConfig,
        symbolOrdinals,
      }));
    }

    // R4.1: loop-query (N+1) detection + general patterns.
    violations.push(...checkLoopQueries(ast, scan));
    violations.push(...checkGeneralPatterns(ast, adapter, sourceCode, finalConfig));

    return violations;
  }
}
