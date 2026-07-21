/**
 * Universal Schema Analyzer — Spec 17 R2
 *
 * R2.1: SQL-context-only extraction (AST-based, not regex scan-all-strings).
 * R2.2: File gate — only analyze files with DB usage indicators.
 * R2.3: Template expressions resolve to wildcards for known-table matching.
 * R2.4: Unknown-table findings include SQL kind, line, and Levenshtein suggestions.
 * R2.5: Legacy scan-all-strings path DELETED.
 * R7:   schema/unknown-table severity is "suggestion".
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode, NodePattern } from '../../languages/types.js';
import picomatch from 'picomatch';

/**
 * Configuration for Schema analyzer
 */
export interface SchemaAnalyzerConfig {
  // Database schema analysis
  enableTableUsageTracking?: boolean;
  checkMissingReferences?: boolean;
  checkNamingConventions?: boolean;
  detectUnusedTables?: boolean;
  validateQueryPatterns?: boolean;
  maxQueriesPerFunction?: number;
  requiredSchemas?: string[];
  // In-memory schemas for testing
  schemas?: Array<{
    name: string;
    tables: Array<{
      name: string;
      columns: Array<{ name: string; type: string; }>;
    }>;
  }>;

  // JSON Schema validation
  validateJsonSchemas?: boolean;
  jsonSchemaVersion?: 'draft-04' | 'draft-06' | 'draft-07' | '2019-09' | '2020-12';
  allowedJsonTypes?: string[];

  // Schema validation options
  schemaFilePatterns?: string[];
  dataFilePatterns?: string[];
  schemaDataPairs?: Array<{
    schema: string;
    data: string | string[];
  }>;
  strictMode?: boolean;
  allowAdditionalProperties?: boolean;

  // Spec-17 R2 additions — SQL context detection
  sqlTagNames?: string[];           // default ['sql', 'db'] — R2.1
  dbReceiverNames?: string[];       // default ['db', 'database', 'sql', 'stmt'] — R2.2
  dbCallMethods?: string[];         // default ['exec', 'prepare', 'batch', 'run', 'all', 'first']
  dbBindingNames?: string[];        // default ['env.DB'] — R2.2 file gate
  fileGateGlobs?: string[];         // default ['**/*.sql', '**/migrations/**'] — R2.2
}

export const DEFAULT_SCHEMA_CONFIG: SchemaAnalyzerConfig = {
  enableTableUsageTracking: true,
  checkMissingReferences: true,
  checkNamingConventions: true,
  detectUnusedTables: false,
  validateQueryPatterns: true,
  maxQueriesPerFunction: 5,
  requiredSchemas: [],
  schemas: [],
  validateJsonSchemas: true,
  jsonSchemaVersion: 'draft-07',
  allowedJsonTypes: ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'],
  schemaFilePatterns: ['*.schema.json', '*-schema.json'],
  dataFilePatterns: ['*.data.json', '*.example.json'],
  strictMode: false,
  allowAdditionalProperties: true,
  // Spec-17 R2 defaults
  sqlTagNames: ['sql', 'db'],
  dbReceiverNames: ['db', 'database', 'sql', 'stmt', 'connection', 'pool', 'client'],
  dbCallMethods: ['exec', 'prepare', 'batch', 'run', 'all', 'first', 'query', 'get', 'each'],
  dbBindingNames: ['env.DB'],
  fileGateGlobs: ['**/*.sql', '**/migrations/**'],
};

interface TableReference {
  table: string;
  type: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'reference';
  location: { line: number; column: number };
  context: string;
}

interface ColumnReference {
  table: string;
  column: string;
  location: { line: number; column: number };
}

import { promises as fs } from 'fs';
import type { Violation as BaseViolation, AnalyzerResult } from '../../types.js';

export class UniversalSchemaAnalyzer extends UniversalAnalyzer {
  readonly name = 'schema';
  readonly description = 'Analyzes code against database schemas and validates JSON schemas';
  readonly category = 'database';

  // Track references across files
  private tableReferences = new Map<string, TableReference[]>();
  private columnReferences = new Map<string, ColumnReference[]>();

  async analyze(files: string[], config: any): Promise<AnalyzerResult> {
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const codeFiles = files.filter(f => !f.endsWith('.json'));

    const codeResult = codeFiles.length > 0 ? await super.analyze(codeFiles, config) : {
      violations: [],
      errors: [],
      filesProcessed: 0,
      executionTime: 0
    };

    const jsonResult = await this.analyzeJsonSchemas(jsonFiles, config);

    return {
      violations: [...codeResult.violations, ...jsonResult.violations],
      errors: [...(codeResult.errors || []), ...(jsonResult.errors || [])],
      filesProcessed: codeResult.filesProcessed + jsonResult.filesProcessed,
      executionTime: (codeResult.executionTime || 0) + (jsonResult.executionTime || 0)
    };
  }

  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: SchemaAnalyzerConfig,
    sourceCode: string
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_SCHEMA_CONFIG, ...config };

    // R2.2 — File gate: only analyze files with DB context
    if (!this.passesFileGate(ast.filePath, sourceCode, finalConfig)) {
      return violations;
    }

    // Get available schemas
    const schemas = finalConfig.schemas || [];
    const allTables = new Set<string>();
    const tableColumns = new Map<string, Set<string>>();

    for (const schema of schemas) {
      for (const table of schema.tables) {
        allTables.add(table.name);
        const columns = new Set<string>(table.columns.map(c => c.name));
        tableColumns.set(table.name, columns);
      }
    }

    if (finalConfig.requiredSchemas && finalConfig.requiredSchemas.length > 0 && schemas.length === 0) {
      violations.push(this.createViolation(
        ast.filePath,
        { line: 1, column: 1 },
        'No database schemas loaded for analysis',
        'warning',
        'missing-schemas'
      ));
      return violations;
    }

    // R2.1 — AST-based table reference extraction (replaces legacy regex scan-all-strings)
    const tableRefs = this.findTableReferences(ast, adapter, sourceCode, finalConfig);
    const columnRefs = this.findColumnReferences(ast, adapter, sourceCode);

    // Check for missing table references — R2.4: Levenshtein suggestions
    if (finalConfig.checkMissingReferences) {
      for (const ref of tableRefs) {
        if (!allTables.has(ref.table) && !this.isSystemTable(ref.table)) {
          const suggestions = this.getNearestTableSuggestions(ref.table, allTables, 2);
          const msg = suggestions.length > 0
            ? `Reference to unknown table '${ref.table}' (${ref.type}). Did you mean: ${suggestions.join(', ')}?`
            : `Reference to unknown table '${ref.table}' (${ref.type})`;

          violations.push(this.createViolation(
            ast.filePath,
            ref.location,
            msg,
            'suggestion',  // R7
            'unknown-table'
          ));
        }
      }

      for (const ref of columnRefs) {
        const columnSet = tableColumns.get(ref.table);
        if (columnSet && !columnSet.has(ref.column)) {
          violations.push(this.createViolation(
            ast.filePath,
            ref.location,
            `Reference to unknown column '${ref.column}' in table '${ref.table}'`,
            'warning',
            'unknown-column'
          ));
        }
      }
    }

    // Check naming conventions
    if (finalConfig.checkNamingConventions) {
      violations.push(...this.checkNamingConventions(tableRefs, ast.filePath));
    }

    // Check query patterns
    if (finalConfig.validateQueryPatterns) {
      violations.push(...this.checkQueryPatterns(ast, adapter, sourceCode, finalConfig));
    }

    // Check for SQL injection patterns — R7: no critical by default
    violations.push(...this.checkSQLInjection(ast, adapter, sourceCode));

    return violations;
  }

  // ---------------------------------------------------------------------------
  // R2.2 — File gate
  // ---------------------------------------------------------------------------

  /**
   * Pre-filter: only analyze files that show DB usage.
   * Checks: .sql/migration glob, D1/SQL imports, env-binding patterns, DB calls.
   */
  private passesFileGate(
    filePath: string,
    sourceCode: string,
    config: SchemaAnalyzerConfig
  ): boolean {
    // Always pass .sql files and migration directories
    const gateGlobs = config.fileGateGlobs ?? ['**/*.sql', '**/migrations/**'];
    for (const glob of gateGlobs) {
      if (picomatch.isMatch(filePath, glob)) {
        return true;
      }
    }

    // Check for D1 or SQL API imports
    const importPatterns = [
      /import\s+.*\b(D1Database|D1PreparedStatement|D1Result)\b/,
      /import\s+.*from\s+['"].*d1['"]/,
      /import\s+.*from\s+['"].*pg['"]/,
      /import\s+.*from\s+['"].*mysql['"]/,
      /import\s+.*from\s+['"].*sqlite['"]/,
      /import\s+.*from\s+['"].*knex['"]/,
      /import\s+.*from\s+['"].*drizzle['"]/,
      /import\s+.*from\s+['"].*prisma['"]/,
    ];
    for (const pat of importPatterns) {
      if (pat.test(sourceCode)) return true;
    }

    // Check for env-binding patterns (e.g., env.DB in Cloudflare Workers)
    const bindingNames = config.dbBindingNames ?? ['env.DB'];
    for (const binding of bindingNames) {
      if (sourceCode.includes(binding)) return true;
    }

    // Check for DB call patterns (receiver.method)
    const receivers = config.dbReceiverNames ?? ['db', 'database', 'sql', 'stmt'];
    const methods = config.dbCallMethods ?? ['exec', 'prepare', 'batch', 'run', 'all', 'first'];
    for (const receiver of receivers) {
      for (const method of methods) {
        const pattern = new RegExp(`\\b${escapeRegex(receiver)}\\.${escapeRegex(method)}\\s*\\(`);
        if (pattern.test(sourceCode)) return true;
      }
    }

    // Check for SQL tagged template literals
    const sqlTags = config.sqlTagNames ?? ['sql', 'db'];
    for (const tag of sqlTags) {
      const pattern = new RegExp(`\\b${escapeRegex(tag)}\`\\s*SELECT|\\b${escapeRegex(tag)}\`\\s*INSERT|\\b${escapeRegex(tag)}\`\\s*UPDATE|\\b${escapeRegex(tag)}\`\\s*DELETE|\\b${escapeRegex(tag)}\`\\s*CREATE`, 'i');
      if (pattern.test(sourceCode)) return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // R2.1 — AST-based table reference extraction (replaces legacy regex)
  // ---------------------------------------------------------------------------

  /**
   * Extract table references exclusively from SQL contexts in the AST.
   * R2.1: Only tagged template SQL and DB-call patterns produce candidates.
   * R2.3: Template expressions (${var}) resolved to wildcards.
   */
  private findTableReferences(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: SchemaAnalyzerConfig
  ): TableReference[] {
    const references: TableReference[] = [];
    const sqlTags = config.sqlTagNames ?? ['sql', 'db'];
    const dbMethods = config.dbCallMethods ?? ['exec', 'prepare', 'batch', 'run', 'all', 'first', 'query'];
    const dbReceivers = config.dbReceiverNames ?? ['db', 'database', 'sql', 'stmt'];

    // (1) Tagged template SQL — e.g. sql`SELECT * FROM heroes`
    const taggedTemplates = adapter.findNodes(ast, {
      custom: (node: ASTNode) => {
        if (node.type !== 'call_expression') return false;
        // Callee must be an identifier matching sqlTagNames
        const callee = this.getCallee(node, adapter, sourceCode);
        if (!callee || !sqlTags.includes(callee)) return false;
        // Must have a template string argument
        return this.hasTemplateArgument(node, adapter);
      },
    });

    for (const callNode of taggedTemplates) {
      const templateText = this.getTemplateText(callNode, adapter, sourceCode);
      if (!templateText) continue;
      const location = this.getCallLocation(callNode);
      const tableRefs = this.parseSqlTables(templateText, location, sourceCode);
      references.push(...tableRefs);
    }

    // (2) DB-call patterns — e.g. db.exec("SELECT * FROM heroes")
    const dbCalls = adapter.findNodes(ast, {
      custom: (node: ASTNode) => {
        if (node.type !== 'call_expression') return false;
        const callee = this.getCallee(node, adapter, sourceCode);
        if (!callee) return false;
        // Check if callee is a member expression like db.exec or db.prepare
        return this.isDbMemberCall(node, callee, dbMethods, dbReceivers, adapter, sourceCode);
      },
    });

    for (const callNode of dbCalls) {
      const firstArg = this.getFirstStringArgument(callNode, adapter, sourceCode);
      if (!firstArg) continue;
      const location = this.getCallLocation(callNode);
      const tableRefs = this.parseSqlTables(firstArg, location, sourceCode);
      references.push(...tableRefs);
    }

    // (3) .sql files and migration directories — scan the entire source
    if (
      ast.filePath.endsWith('.sql') ||
      ast.filePath.includes('/migrations/') ||
      ast.filePath.includes('\\migrations\\')
    ) {
      const fileRefs = this.parseSqlTables(sourceCode, { line: 1, column: 1 }, sourceCode);
      references.push(...fileRefs);
    }

    return references;
  }

  /**
   * Parse SQL table names from a SQL text string.
   * R2.3: Template expressions (${...}) resolve portions to wildcards.
   */
  private parseSqlTables(
    sqlText: string,
    baseLocation: { line: number; column: number },
    sourceCode: string
  ): TableReference[] {
    const references: TableReference[] = [];

    // R2.3: Strip template expressions — `${prefix}_builds` → `_builds`
    // (the prefix is replaced with empty, the suffix remains for matching)
    const cleaned = this.resolveTemplateExpressions(sqlText);

    // SQL patterns anchored to SQL keywords (not arbitrary substrings)
    const sqlPatterns: Array<{ regex: RegExp; type: TableReference['type'] }> = [
      { regex: /\bFROM\s+([`"']?)([a-zA-Z_]\w*)\1\b/gi, type: 'select' },
      { regex: /\bJOIN\s+([`"']?)([a-zA-Z_]\w*)\1\b/gi, type: 'select' },
      { regex: /\bINSERT\s+INTO\s+([`"']?)([a-zA-Z_]\w*)\1\b/gi, type: 'insert' },
      { regex: /\bUPDATE\s+([`"']?)([a-zA-Z_]\w*)\1\b/gi, type: 'update' },
      { regex: /\bDELETE\s+FROM\s+([`"']?)([a-zA-Z_]\w*)\1\b/gi, type: 'delete' },
      { regex: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?)([a-zA-Z_]\w*)\1\b/gi, type: 'create' },
    ];

    for (const { regex, type } of sqlPatterns) {
      let match;
      // Create fresh regex since we might consume with exec
      const re = new RegExp(regex.source, regex.flags);
      while ((match = re.exec(cleaned)) !== null) {
        const table = match[2]; // The table name (capture group 2)
        if (!table || this.isSystemTable(table)) continue;

        // Skip common false positives: common variable names, keywords
        if (this.isSqlKeyword(table)) continue;

        // Calculate position in original source
        const offset = sqlText.indexOf(match[0]);
        const location = offset >= 0
          ? this.offsetToLocation(sourceCode, sourceCode.indexOf(cleaned) + offset, baseLocation)
          : baseLocation;

        references.push({
          table,
          type,
          location,
          context: match[0].trim(),
        });
      }
    }

    return references;
  }

  /**
   * R2.3: Resolve template expressions in SQL text.
   * `${prefix}_builds` → `_builds` (dynamic prefix removed, suffix kept).
   * `${identifier}` (fully dynamic) → empty string (no finding produced).
   */
  private resolveTemplateExpressions(text: string): string {
    // Replace dynamic segments with wildcard-aware placeholders
    // ${var} alone → consume the entire segment (no table name to extract)
    // ${p}_suffix → keep "_suffix" for matching
    return text.replace(/\$\{[^}]+\}/g, '');
  }

  // ---------------------------------------------------------------------------
  // R2.4 — Levenshtein suggestions
  // ---------------------------------------------------------------------------

  /**
   * Return known table names within edit distance ≤ maxDist.
   */
  private getNearestTableSuggestions(
    name: string,
    knownTables: Set<string>,
    maxDist: number
  ): string[] {
    const results: Array<{ table: string; distance: number }> = [];
    for (const known of knownTables) {
      const dist = this.levenshteinDistance(name.toLowerCase(), known.toLowerCase());
      if (dist <= maxDist) {
        results.push({ table: known, distance: dist });
      }
    }
    // Sort by distance ascending
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, 3).map(r => `'${r.table}'`);
  }

  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    // Optimize: early exit if length difference exceeds threshold
    if (Math.abs(m - n) > 3) return Infinity;

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }
    return dp[m][n];
  }

  // ---------------------------------------------------------------------------
  // Column references (unchanged for now)
  // ---------------------------------------------------------------------------

  private findColumnReferences(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): ColumnReference[] {
    const references: ColumnReference[] = [];
    const patterns = [
      /(\w+)\.(\w+)\s*[=<>]/gi,
      /SELECT\s+.*?(\w+)\.(\w+)/gi,
      /WHERE\s+.*?(\w+)\.(\w+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sourceCode)) !== null) {
        const table = match[1];
        const column = match[2];
        const index = match.index;
        const lines = sourceCode.substring(0, index).split('\n');
        const line = lines.length;
        const col = lines[lines.length - 1].length + 1;

        references.push({
          table,
          column,
          location: { line, column: col }
        });
      }
    }

    return references;
  }

  // ---------------------------------------------------------------------------
  // Naming conventions
  // ---------------------------------------------------------------------------

  private checkNamingConventions(
    references: TableReference[],
    filePath: string
  ): Violation[] {
    const violations: Violation[] = [];

    for (const ref of references) {
      if (/[A-Z]/.test(ref.table) && !ref.table.endsWith('Table')) {
        violations.push(this.createViolation(
          filePath,
          ref.location,
          `Table name '${ref.table}' should use snake_case convention`,
          'suggestion',
          'naming-convention'
        ));
      }

      const reserved = ['user', 'order', 'group', 'table', 'column', 'index'];
      if (reserved.includes(ref.table.toLowerCase())) {
        violations.push(this.createViolation(
          filePath,
          ref.location,
          `Table name '${ref.table}' is a reserved word. Consider using a different name.`,
          'warning',
          'reserved-word'
        ));
      }
    }

    return violations;
  }

  // ---------------------------------------------------------------------------
  // Query patterns
  // ---------------------------------------------------------------------------

  private checkQueryPatterns(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
    config: SchemaAnalyzerConfig
  ): Violation[] {
    const violations: Violation[] = [];

    const functions = adapter.extractFunctions(ast);

    for (const func of functions) {
      const funcNode = this.findNodeByLocation(ast.root, func.location.start);
      if (!funcNode) continue;

      const funcText = adapter.getNodeText(funcNode, sourceCode);
      const queryCount = this.countQueries(funcText);

      if (queryCount > (config.maxQueriesPerFunction || 5)) {
        violations.push(this.createViolation(
          ast.filePath,
          func.location.start,
          `Function '${func.name}' has ${queryCount} queries, exceeding the maximum of ${config.maxQueriesPerFunction}`,
          'warning',
          'too-many-queries'
        ));
      }
    }

    // N+1 query check — only flag if we have actual DB calls, not grep
    if (sourceCode.includes('.map') && (sourceCode.includes('.query') || sourceCode.includes('SELECT'))) {
      violations.push(this.createViolation(
        ast.filePath,
        { line: 1, column: 1 },
        'Potential N+1 query pattern detected. Consider using a join or batch query.',
        'warning',
        'n-plus-one'
      ));
    }

    return violations;
  }

  // ---------------------------------------------------------------------------
  // SQL injection — R7: severity changed from critical to warning
  // ---------------------------------------------------------------------------

  private checkSQLInjection(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string
  ): Violation[] {
    const violations: Violation[] = [];

    const dangerousPatterns = [
      /query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g,
      /query\s*\(\s*['"][^'"]*['"]?\s*\+/g,
      /execute\s*\(\s*['"][^'"]*['"]?\s*\+/g,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(sourceCode)) {
        violations.push(this.createViolation(
          ast.filePath,
          { line: 1, column: 1 },
          'Potential SQL injection vulnerability. Use parameterized queries.',
          'warning',  // R7: was 'critical'
          'sql-injection'
        ));
        break;
      }
    }

    return violations;
  }

  // ---------------------------------------------------------------------------
  // AST helpers for R2.1
  // ---------------------------------------------------------------------------

  /**
   * Extract the callee text from a call_expression node.
   */
  private getCallee(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
    // For db.exec() → callee is "db.exec"
    if (!node.children) return null;
    for (const child of node.children) {
      const type = adapter.getNodeType(child);
      if (
        type === 'identifier' ||
        type === 'member_expression' ||
        type === 'call_expression'
      ) {
        return adapter.getNodeText(child, sourceCode).trim();
      }
    }
    return null;
  }

  /**
   * Check if call_expression has a template string argument.
   */
  private hasTemplateArgument(node: ASTNode, adapter: LanguageAdapter): boolean {
    if (!node.children) return false;
    for (const child of node.children) {
      const type = adapter.getNodeType(child);
      if (type === 'template_string' || type === 'template_literal') {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the text of the first template string argument.
   */
  private getTemplateText(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
    if (!node.children) return null;
    for (const child of node.children) {
      const type = adapter.getNodeType(child);
      if (type === 'template_string' || type === 'template_literal') {
        return adapter.getNodeText(child, sourceCode).trim();
      }
    }
    return null;
  }

  /**
   * Get the first string/template argument from a call expression.
   */
  private getFirstStringArgument(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string
  ): string | null {
    if (!node.children) return null;
    // Look for 'arguments' child first
    for (const child of node.children) {
      const type = adapter.getNodeType(child);
      if (type === 'arguments' && child.children) {
        for (const arg of child.children) {
          const argType = adapter.getNodeType(arg);
          if (
            argType === 'string' ||
            argType === 'template_string' ||
            argType === 'template_literal'
          ) {
            const text = adapter.getNodeText(arg, sourceCode).trim();
            // Strip surrounding quotes from string literals
            if (
              (text.startsWith("'") && text.endsWith("'")) ||
              (text.startsWith('"') && text.endsWith('"')) ||
              (text.startsWith('`') && text.endsWith('`'))
            ) {
              return text.slice(1, -1);
            }
            return text;
          }
        }
      }
    }
    return null;
  }

  /**
   * Check if a callee is a DB member call like db.exec, database.query, etc.
   */
  private isDbMemberCall(
    node: ASTNode,
    calleeText: string,
    methods: string[],
    receivers: string[],
    adapter: LanguageAdapter,
    sourceCode: string
  ): boolean {
    // calleeText might be like "db.exec"
    const dotIdx = calleeText.indexOf('.');
    if (dotIdx === -1) return false;
    const receiver = calleeText.substring(0, dotIdx);
    const method = calleeText.substring(dotIdx + 1);
    return receivers.includes(receiver) && methods.includes(method);
  }

  /**
   * Get the line/column location of the call expression.
   */
  private getCallLocation(node: ASTNode): { line: number; column: number } {
    return node.location.start;
  }

  /**
   * Convert a character offset to a line/column location.
   */
  private offsetToLocation(
    sourceCode: string,
    offset: number,
    base: { line: number; column: number }
  ): { line: number; column: number } {
    if (offset < 0 || offset >= sourceCode.length) return base;
    const before = sourceCode.substring(0, offset);
    const lineOffset = before.split('\n').length - 1;
    const lastNewline = before.lastIndexOf('\n');
    const column = lastNewline >= 0 ? offset - lastNewline : offset + 1;
    return { line: base.line + lineOffset, column };
  }

  // ---------------------------------------------------------------------------
  // General helpers
  // ---------------------------------------------------------------------------

  private isSystemTable(table: string): boolean {
    const systemTables = [
      'information_schema',
      'pg_catalog',
      'mysql',
      'performance_schema',
      'sys',
      'sqlite_master',
      'sqlite_sequence',
    ];
    return systemTables.some(st => table.toLowerCase() === st || table.toLowerCase().startsWith(st + '.'));
  }

  /**
   * Common SQL keywords and identifiers that are not real table names.
   */
  private isSqlKeyword(word: string): boolean {
    const keywords = new Set([
      'select', 'from', 'where', 'join', 'inner', 'outer', 'left', 'right',
      'full', 'cross', 'on', 'and', 'or', 'not', 'in', 'as', 'is', 'null',
      'like', 'between', 'order', 'group', 'by', 'having', 'limit', 'offset',
      'union', 'all', 'distinct', 'case', 'when', 'then', 'else', 'end',
      'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
      'table', 'alter', 'drop', 'index', 'view', 'if', 'exists', 'primary',
      'key', 'foreign', 'references', 'constraint', 'default', 'unique',
      'check', 'asc', 'desc', 'count', 'sum', 'avg', 'min', 'max',
      'integer', 'text', 'varchar', 'text', 'boolean', 'float', 'blob',
      'real', 'timestamp', 'date', 'time', 'datetime', 'serial', 'bigint',
      'the', 'a', 'an',
    ]);
    return keywords.has(word.toLowerCase());
  }

  private getQueryType(context: string): TableReference['type'] {
    const upper = context.toUpperCase();
    if (upper.includes('SELECT')) return 'select';
    if (upper.includes('INSERT')) return 'insert';
    if (upper.includes('UPDATE')) return 'update';
    if (upper.includes('DELETE')) return 'delete';
    if (upper.includes('CREATE')) return 'create';
    return 'reference';
  }

  private countQueries(text: string): number {
    const patterns = [
      /\.query\s*\(/g,
      /\.execute\s*\(/g,
      /SELECT\s+/gi,
      /INSERT\s+INTO/gi,
      /UPDATE\s+/gi,
      /DELETE\s+FROM/gi,
    ];

    let count = 0;
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) count += matches.length;
    }

    return count;
  }

  private findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
    const queue: ASTNode[] = [root];

    while (queue.length > 0) {
      const node = queue.shift()!;

      if (node.location.start.line === location.line &&
          node.location.start.column === location.column) {
        return node;
      }

      if (node.children) {
        queue.push(...node.children);
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // JSON Schema validation (unchanged from original)
  // ---------------------------------------------------------------------------

  private async analyzeJsonSchemas(
    files: string[],
    config: SchemaAnalyzerConfig
  ): Promise<AnalyzerResult> {
    const violations: BaseViolation[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let filesProcessed = 0;
    const startTime = Date.now();

    const finalConfig = { ...DEFAULT_SCHEMA_CONFIG, ...config };

    if (!finalConfig.validateJsonSchemas) {
      return { violations, errors, filesProcessed, executionTime: 0 };
    }

    const schemaFiles = this.identifySchemaFiles(files, finalConfig);
    const dataFiles = this.identifyDataFiles(files, finalConfig);
    const unknownJsonFiles = files.filter(f => !schemaFiles.includes(f) && !dataFiles.includes(f));

    const schemas = new Map<string, any>();
    for (const file of schemaFiles) {
      try {
        const content = await fs.readFile(file, 'utf8');
        const schema = JSON.parse(content);
        schemas.set(file, schema);

        const fileViolations = this.validateJsonSchema(schema, file, finalConfig);
        violations.push(...fileViolations);

        filesProcessed++;
      } catch (error) {
        if (error instanceof SyntaxError) {
          violations.push({
            file,
            line: 1,
            column: 1,
            severity: 'warning',
            message: `Invalid JSON: ${error.message}`,
            rule: 'invalid-json',
            analyzer: 'schema'
          });
        } else {
          errors.push({
            file,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        filesProcessed++;
      }
    }

    if (finalConfig.schemaDataPairs) {
      for (const pair of finalConfig.schemaDataPairs) {
        const schema = schemas.get(pair.schema) || await this.loadSchema(pair.schema);
        if (schema) {
          const dataFiles = Array.isArray(pair.data) ? pair.data : [pair.data];
          for (const dataFile of dataFiles) {
            if (files.includes(dataFile)) {
              const dataViolations = await this.validateDataAgainstSchema(dataFile, schema, finalConfig);
              violations.push(...dataViolations);
              filesProcessed++;
            }
          }
        }
      }
    } else {
      for (const dataFile of [...dataFiles, ...unknownJsonFiles]) {
        const matchedSchema = this.findMatchingSchema(dataFile, schemas, finalConfig);
        if (matchedSchema) {
          const dataViolations = await this.validateDataAgainstSchema(dataFile, matchedSchema, finalConfig);
          violations.push(...dataViolations);
        } else if (unknownJsonFiles.includes(dataFile)) {
          try {
            const content = await fs.readFile(dataFile, 'utf8');
            JSON.parse(content);
          } catch (error) {
            violations.push({
              file: dataFile,
              line: 1,
              column: 1,
              severity: 'warning',
              message: `Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`,
              rule: 'invalid-json',
              analyzer: 'schema'
            });
          }
        }
        filesProcessed++;
      }
    }

    return {
      violations,
      errors,
      filesProcessed,
      executionTime: Date.now() - startTime
    };
  }

  private validateJsonSchema(
    schema: any,
    filePath: string,
    config: SchemaAnalyzerConfig
  ): BaseViolation[] {
    const violations: BaseViolation[] = [];

    if (!schema.$schema && config.jsonSchemaVersion) {
      violations.push({
        file: filePath,
        line: 1,
        column: 1,
        severity: 'suggestion',
        message: 'JSON Schema missing $schema declaration',
        rule: 'missing-schema-declaration',
        analyzer: 'schema'
      });
    }

    this.validateSchemaTypes(schema, filePath, config, violations);

    if (schema.type === 'object' && schema.properties) {
      if (schema.required && Array.isArray(schema.required)) {
        for (const field of schema.required) {
          if (!schema.properties[field]) {
            violations.push({
              file: filePath,
              line: 1,
              column: 1,
              severity: 'warning',
              message: `Required field "${field}" not defined in properties`,
              rule: 'undefined-required-field',
              analyzer: 'schema'
            });
          }
        }
      }
    }

    return violations;
  }

  private validateSchemaTypes(
    schema: any,
    filePath: string,
    config: SchemaAnalyzerConfig,
    violations: BaseViolation[],
    path: string = ''
  ): void {
    if (!schema || typeof schema !== 'object') return;

    if (schema.type && config.allowedJsonTypes) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      for (const type of types) {
        if (!config.allowedJsonTypes.includes(type)) {
          violations.push({
            file: filePath,
            line: 1,
            column: 1,
            severity: 'warning',
            message: `Invalid type "${type}" at ${path || 'root'}. Allowed types: ${config.allowedJsonTypes.join(', ')}`,
            rule: 'invalid-type',
            analyzer: 'schema'
          });
        }
      }
    }

    if (schema.type === 'integer' || schema.type === 'number') {
      if (schema.minimum !== undefined && schema.maximum !== undefined) {
        if (schema.minimum > schema.maximum) {
          violations.push({
            file: filePath,
            line: 1,
            column: 1,
            severity: 'warning',
            message: `Invalid range at ${path}: minimum (${schema.minimum}) > maximum (${schema.maximum})`,
            rule: 'invalid-range',
            analyzer: 'schema'
          });
        }
      }
    }

    if (schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        this.validateSchemaTypes(value, filePath, config, violations, `${path}.${key}`);
      }
    }

    if (schema.items) {
      this.validateSchemaTypes(schema.items, filePath, config, violations, `${path}[items]`);
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      this.validateSchemaTypes(
        schema.additionalProperties,
        filePath,
        config,
        violations,
        `${path}[additionalProperties]`
      );
    }
  }

  private identifySchemaFiles(files: string[], config: SchemaAnalyzerConfig): string[] {
    if (!config.schemaFilePatterns) return [];

    return files.filter(file => {
      const fileName = file.split('/').pop() || '';
      return config.schemaFilePatterns!.some(pattern => {
        const regex = new RegExp(pattern.replace('*', '.*'));
        return regex.test(fileName);
      });
    });
  }

  private identifyDataFiles(files: string[], config: SchemaAnalyzerConfig): string[] {
    if (!config.dataFilePatterns) return [];

    return files.filter(file => {
      const fileName = file.split('/').pop() || '';
      return config.dataFilePatterns!.some(pattern => {
        const regex = new RegExp(pattern.replace('*', '.*'));
        return regex.test(fileName);
      });
    });
  }

  private async loadSchema(schemaPath: string): Promise<any | null> {
    try {
      const content = await fs.readFile(schemaPath, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private findMatchingSchema(
    dataFile: string,
    schemas: Map<string, any>,
    config: SchemaAnalyzerConfig
  ): any | null {
    const dataFileName = dataFile.split('/').pop() || '';
    const dataBaseName = dataFileName.replace(/\.(data|example|test)\.json$/, '');

    for (const [schemaFile, schema] of schemas) {
      const schemaFileName = schemaFile.split('/').pop() || '';
      const schemaBaseName = schemaFileName.replace(/[.-]?schema\.json$/, '');

      if (dataBaseName === schemaBaseName) {
        return schema;
      }
    }

    if (schemas.size === 1) {
      return schemas.values().next().value;
    }

    return null;
  }

  private async validateDataAgainstSchema(
    dataFile: string,
    schema: any,
    config: SchemaAnalyzerConfig
  ): Promise<BaseViolation[]> {
    const violations: BaseViolation[] = [];

    try {
      const content = await fs.readFile(dataFile, 'utf8');
      const data = JSON.parse(content);
      this.validateAgainstSchema(data, schema, dataFile, violations, config);
    } catch (error) {
      if (error instanceof SyntaxError) {
        violations.push({
          file: dataFile,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Invalid JSON: ${error.message}`,
          rule: 'invalid-json',
          analyzer: 'schema'
        });
      } else {
        violations.push({
          file: dataFile,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`,
          rule: 'file-error',
          analyzer: 'schema'
        });
      }
    }

    return violations;
  }

  private validateAgainstSchema(
    data: any,
    schema: any,
    filePath: string,
    violations: BaseViolation[],
    config: SchemaAnalyzerConfig,
    path: string = ''
  ): void {
    if (schema.type) {
      const actualType = Array.isArray(data) ? 'array' :
                        data === null ? 'null' :
                        typeof data;

      const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];

      const isValidType = allowedTypes.some((type: string) => {
        if (type === 'integer') {
          return typeof data === 'number' && Number.isInteger(data);
        }
        return type === actualType;
      });

      if (!isValidType) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Type mismatch at ${path || 'root'}: expected ${allowedTypes.join(' | ')}, got ${actualType}`,
          rule: 'type-mismatch',
          analyzer: 'schema'
        });
        return;
      }
    }

    if (schema.type === 'string' && typeof data === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `String at ${path} too short: ${data.length} < ${schema.minLength}`,
          rule: 'string-too-short',
          analyzer: 'schema'
        });
      }

      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `String at ${path} too long: ${data.length} > ${schema.maxLength}`,
          rule: 'string-too-long',
          analyzer: 'schema'
        });
      }

      if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(data)) {
          violations.push({
            file: filePath,
            line: 1,
            column: 1,
            severity: 'warning',
            message: `String at ${path} doesn't match pattern: ${schema.pattern}`,
            rule: 'pattern-mismatch',
            analyzer: 'schema'
          });
        }
      }

      if (schema.format) {
        switch (schema.format) {
          case 'email':
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data)) {
              violations.push({
                file: filePath,
                line: 1,
                column: 1,
                severity: 'warning',
                message: `Invalid email format at ${path}`,
                rule: 'invalid-format',
                analyzer: 'schema'
              });
            }
            break;
          case 'uuid':
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data)) {
              violations.push({
                file: filePath,
                line: 1,
                column: 1,
                severity: 'warning',
                message: `Invalid UUID format at ${path}`,
                rule: 'invalid-format',
                analyzer: 'schema'
              });
            }
            break;
        }
      }
    }

    if ((schema.type === 'number' || schema.type === 'integer') && typeof data === 'number') {
      if (schema.minimum !== undefined && data < schema.minimum) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Value at ${path} below minimum: ${data} < ${schema.minimum}`,
          rule: 'below-minimum',
          analyzer: 'schema'
        });
      }

      if (schema.maximum !== undefined && data > schema.maximum) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Value at ${path} above maximum: ${data} > ${schema.maximum}`,
          rule: 'above-maximum',
          analyzer: 'schema'
        });
      }
    }

    if (schema.type === 'array' && Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Array at ${path} has too few items: ${data.length} < ${schema.minItems}`,
          rule: 'too-few-items',
          analyzer: 'schema'
        });
      }

      if (schema.maxItems !== undefined && data.length > schema.maxItems) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Array at ${path} has too many items: ${data.length} > ${schema.maxItems}`,
          rule: 'too-many-items',
          analyzer: 'schema'
        });
      }

      if (schema.items) {
        data.forEach((item, index) => {
          this.validateAgainstSchema(
            item,
            schema.items,
            filePath,
            violations,
            config,
            `${path}[${index}]`
          );
        });
      }
    }

    if (schema.type === 'object' && typeof data === 'object' && data !== null) {
      if (schema.required && Array.isArray(schema.required)) {
        for (const requiredField of schema.required) {
          if (!(requiredField in data)) {
            violations.push({
              file: filePath,
              line: 1,
              column: 1,
              severity: 'warning',
              message: `Missing required field "${requiredField}" at ${path}`,
              rule: 'missing-required-field',
              analyzer: 'schema'
            });
          }
        }
      }

      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in data) {
            this.validateAgainstSchema(
              data[key],
              propSchema,
              filePath,
              violations,
              config,
              path ? `${path}.${key}` : key
            );
          }
        }
      }

      if (schema.additionalProperties === false || (config.strictMode && !schema.additionalProperties)) {
        const definedKeys = new Set(Object.keys(schema.properties || {}));
        const actualKeys = Object.keys(data);

        for (const key of actualKeys) {
          if (!definedKeys.has(key)) {
            violations.push({
              file: filePath,
              line: 1,
              column: 1,
              severity: 'warning',
              message: `Unexpected property "${key}" at ${path}`,
              rule: 'unexpected-property',
              analyzer: 'schema'
            });
          }
        }
      } else if (typeof schema.additionalProperties === 'object') {
        const definedKeys = new Set(Object.keys(schema.properties || {}));
        for (const [key, value] of Object.entries(data)) {
          if (!definedKeys.has(key)) {
            this.validateAgainstSchema(
              value,
              schema.additionalProperties,
              filePath,
              violations,
              config,
              path ? `${path}.${key}` : key
            );
          }
        }
      }
    }

    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.includes(data)) {
        violations.push({
          file: filePath,
          line: 1,
          column: 1,
          severity: 'warning',
          message: `Value at ${path} not in enum: ${JSON.stringify(data)}. Allowed: ${schema.enum.join(', ')}`,
          rule: 'enum-mismatch',
          analyzer: 'schema'
        });
      }
    }
  }
}

/**
 * Escape regex special characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
