/**
 * SQL-context code analysis — table-reference extraction, SQL parsing, naming/
 * query/injection checks, and AST/source helper functions.
 *
 * Spec 34 — extracted from UniversalSchemaAnalyzer.ts so the SQL-context
 * analysis is importable and testable independently of the analyzer class.
 * Every function here is a module-level free function with a signature
 * identical to the original class method (minus `this`). Violations are built
 * with `createSchemaViolation` instead of `this.createViolation`.
 */

import type { Violation } from '../../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../../languages/types.js';
import { isDBProvenanced, DB_CALL_METHODS, type ProvenanceContext } from '../../provenance.js';
import { OrmAdapterRegistry } from '../../orm/index.js';
import { SQL_TAG_NAMES, DB_CALL_METHOD_NAMES, DB_RECEIVER_NAMES } from './config.js';
import type { SchemaAnalyzerConfig, TableReference } from './types.js';
import { createSchemaViolation } from './violations.js';

/**
 * Extract table references from a TypeScript/JavaScript AST.
 *
 * Four extraction strategies: (1) tagged-template SQL, (2) DB-call string
 * arguments, (3) full-source scan for `.sql` files, (4) ORM adapter extraction.
 */
export function findTableReferences(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: SchemaAnalyzerConfig,
  provenanceContext?: ProvenanceContext,
  allTables?: Set<string>,
): TableReference[] {
  const references: TableReference[] = [];
  const sqlTags = config.sqlTagNames ?? [...SQL_TAG_NAMES];

  // (1) Tagged template SQL — e.g. sql`SELECT * FROM heroes`
  // This is a syntax feature, not a naming convention — keep the sqlTagNames gate.
  const taggedTemplates = adapter.findNodes(ast, {
    custom: (node: ASTNode) => {
      if (node.type !== 'call_expression') return false;
      // Callee must be an identifier matching sqlTagNames
      const callee = getCallee(node, adapter, sourceCode);
      if (!callee || !sqlTags.includes(callee)) return false;
      // Must have a template string argument
      return hasTemplateArgument(node, adapter);
    },
  });

  for (const callNode of taggedTemplates) {
    const templateText = getTemplateText(callNode, adapter, sourceCode);
    if (!templateText) continue;
    const location = getCallLocation(callNode);
    const tableRefs = parseSqlTables(templateText, location, sourceCode, allTables);
    references.push(...tableRefs);
  }

  // (2) DB-call patterns — e.g. db.exec("SELECT * FROM heroes")
  // Spec 21: Replace name-based isDbMemberCall with provenance-based isDBProvenanced.
  const dbCalls = adapter.findNodes(ast, {
    custom: (node: ASTNode) => {
      if (node.type !== 'call_expression') return false;
      // Spec 21: Use provenance when available, fall back to name-based check
      if (provenanceContext && provenanceContext.mode !== 'names') {
        return isDBProvenanced(node, adapter, sourceCode, provenanceContext, DB_CALL_METHODS);
      }
      // Legacy name-based check for names mode / no context
      const callee = getCallee(node, adapter, sourceCode);
      if (!callee) return false;
      const dbMethods = config.dbCallMethods ?? [...DB_CALL_METHOD_NAMES];
      const dbReceivers = config.dbReceiverNames ?? [...DB_RECEIVER_NAMES];
      return isDbMemberCall(node, callee, dbMethods, dbReceivers, adapter, sourceCode);
    },
  });

  for (const callNode of dbCalls) {
    const firstArg = getFirstStringArgument(callNode, adapter, sourceCode);
    if (!firstArg) continue;
    const location = getCallLocation(callNode);
    const tableRefs = parseSqlTables(firstArg, location, sourceCode, allTables);
    references.push(...tableRefs);
  }

  // (3) .sql files — scan the entire source (the whole file IS SQL).
  // `.ts`/`.js` migration files are NOT full-source scanned: their SQL lives
  // inside tagged templates (step 1), DB-call string arguments (step 2), or
  // ORM builder calls (step 4). Full-source scanning a code file matches SQL
  // keywords in comments, string literals, and import specifiers, producing
  // unknown-table / lifecycle false positives (e.g. `// update again`,
  // `import x from 'mod'`, `logger.warn('...from field ${...}')`).
  if (ast.filePath.endsWith('.sql')) {
    const fileRefs = parseSqlTables(sourceCode, { line: 1, column: 1 }, sourceCode, allTables);
    references.push(...fileRefs);
  }

  // (4) Spec 15 R2 — ORM-aware extraction (Drizzle + Prisma)
  // Run ORM adapter extraction for files that match a registered adapter.
  // This complements raw-SQL extraction by picking up ORM-specific patterns
  // like db.select().from(users) and prisma.user.findMany().
  const ormRegistry = OrmAdapterRegistry.getInstance();
  const ormAdapter = ormRegistry.getAdapterForFile(ast.filePath);
  if (ormAdapter) {
    try {
      const ormRefs = ormAdapter.extractTableReferences(ast, adapter, sourceCode);
      for (const ormRef of ormRefs) {
        references.push({
          table: ormRef.table,
          type: ormRef.type,
          location: ormRef.location,
          context: ormRef.context,
        });
      }
    } catch {
      // ORM extraction is best-effort — failures don't block raw-SQL extraction.
    }
  }

  return references;
}

/**
 * Parse SQL table names from a SQL text string.
 * R2.3: Template expressions (${...}) resolve portions to wildcards.
 */
export function parseSqlTables(
  sqlText: string,
  baseLocation: { line: number; column: number },
  sourceCode: string,
  allTables?: Set<string>,
): TableReference[] {
  let references: TableReference[] = [];

  // R2.3: Strip template expressions — `${prefix}_builds` → `_builds`
  // (the prefix is replaced with empty, the suffix remains for matching)
  const cleaned = resolveTemplateExpressions(sqlText);

  // SQL patterns anchored to SQL keywords (not arbitrary substrings).
  // Uses Unicode-aware \p{L} so non-Latin table names (日, 注文, пользователи)
  // are correctly matched — \w is ASCII-only. Spec 21 R5.
  const sqlPatterns: Array<{ regex: RegExp; type: TableReference['type'] }> = [
    // Note: no trailing \b — greedy [\p{L}\p{N}_]* consumes the full identifier and
    // \b after a closing quote (non-word char) fails, blocking quoted-table extraction.
    { regex: /\bFROM\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'select' },
    { regex: /\bJOIN\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'select' },
    { regex: /\bINSERT\s+INTO\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'insert' },
    { regex: /\bUPDATE\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'update' },
    { regex: /\bDELETE\s+FROM\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'delete' },
    { regex: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'create' },
  ];

  for (const { regex, type } of sqlPatterns) {
    let match;
    // Create fresh regex since we might consume with exec
    const re = new RegExp(regex.source, regex.flags);
    while ((match = re.exec(cleaned)) !== null) {
      const table = match[2]; // The table name (capture group 2)
      if (!table || isSystemTable(table) || isTableValuedFunction(table)) continue;

      // Skip JS/TS module specifiers (`import x from 'mod'`) that step (3)'s
      // full-source scan of migration `.ts` files otherwise captures as tables.
      if (isModuleImportFrom(cleaned, match.index)) continue;

      // v3.4.8: Skip very short identifiers (likely CTE names like 'x', 't',
      // aliases like 'o', 'c') unless they are known table names.
      // Single-char identifiers matched by FROM/JOIN regex capture short
      // CTE names that extractAliasIdentifiers() may miss (WITH x AS (...));
      // subquery bare aliases (FROM (SELECT ...) t) likewise. The guard
      // catches false positives from both gaps.
      if (!isSqlKeyword(table) && table.length < 3 && !allTables?.has(table.toLowerCase())) continue;

      // Skip common false positives: common variable names, keywords
      if (isSqlKeyword(table)) continue;

      // Calculate position in original source
      const offset = sqlText.indexOf(match[0]);
      const location = offset >= 0
        ? offsetToLocation(sourceCode, sourceCode.indexOf(cleaned) + offset, baseLocation)
        : baseLocation;

      references.push({
        table,
        type,
        location,
        context: match[0].trim(),
      });
    }
  }

  // Template sentinel filter: resolveTemplateExpressions() replaces
  // ${...} with __TMPL__. Strip these before alias extraction and
  // before returning — __TMPL__ is never a real table name.
  references = references.filter(ref => !ref.table.startsWith('__TMPL__'));

  // Spec 22 R4.3: Filter out alias identifiers.
  // "FROM x AS t" defines t as an alias; later references like "JOIN t.posts"
  // would capture t via the JOIN regex. Scan for explicit AS aliases.
  const aliasIds = extractAliasIdentifiers(cleaned);
  if (aliasIds.size > 0) {
    return references.filter(ref => !aliasIds.has(ref.table.toLowerCase()));
  }

  return references;
}

/**
 * Spec 22 R4.3: Extract alias identifiers from SQL text.
 *
 * Detects both explicit (`FROM x AS t`) and bare (`FROM x t`) aliases
 * so they can be filtered from table-references in parseSqlTables().
 * Without this, "JOIN t.posts" captures t via the JOIN regex when t is
 * an alias for the real table x.
 */
export function extractAliasIdentifiers(sqlText: string): Set<string> {
  const aliases = new Set<string>();

  // CTE: WITH <name> AS ( — the CTE name is an alias, not a real table.
  // Without this, "WITH fresh AS (SELECT ...)" causes 'fresh' to be
  // captured by FROM/JOIN/subquery patterns and flagged as unknown-table.
  const cteRe = /\bWITH\s+([\p{L}_][\p{L}\p{N}_]*)\s+AS\s*\(/giu;
  let m: RegExpExecArray | null;
  while ((m = cteRe.exec(sqlText)) !== null) {
    aliases.add(m[1].toLowerCase());
  }

  // Explicit: FROM/JOIN <table> AS <alias>
  const explicitRe = /\b(?:FROM|JOIN)\s+[\p{L}_][\p{L}\p{N}_]*\s+AS\s+([\p{L}_][\p{L}\p{N}_]*)\b/giu;
  while ((m = explicitRe.exec(sqlText)) !== null) {
    aliases.add(m[1].toLowerCase());
  }

  // Subquery bare alias: FROM (SELECT ...) <alias>
  // The '(' stops the bare FROM/JOIN regex below because \w+ can't match it.
  // Pattern: FROM/JOIN \s* \( ... \) \s* <alias>
  const subqueryRe = /\b(?:FROM|JOIN)\s*\([^)]*\)\s+([\p{L}_][\p{L}\p{N}_]*)\b/giu;
  while ((m = subqueryRe.exec(sqlText)) !== null) {
    const alias = m[1];
    if (!isSqlKeyword(alias)) {
      aliases.add(alias.toLowerCase());
    }
  }

  // Bare: FROM/JOIN <table> <alias> (alias is a bare identifier, not a keyword)
  // Pattern: keyword + table + word — the third word is the alias if it's
  // not a SQL keyword and not followed by '.' (table.column reference).
  const bareRe = /\b(?:FROM|JOIN)\s+([\p{L}_][\p{L}\p{N}_]*)\s+([\p{L}_][\p{L}\p{N}_]*)\b/giu;
  while ((m = bareRe.exec(sqlText)) !== null) {
    const alias = m[2];
    // Don't add if it looks like a keyword or is followed by '.' (table ref)
    if (!isSqlKeyword(alias)) {
      const afterMatch = sqlText.substring(m.index + m[0].length);
      if (!/^\s*\./.test(afterMatch)) {
        aliases.add(alias.toLowerCase());
      }
    }
  }

  return aliases;
}

/**
 * R2.3: Resolve template expressions in SQL text.
 *
 * Uses the sentinel `__TMPL__` instead of an empty string. An empty
 * replacement produces whitespace artifacts (e.g. `FROM   t WHERE`
 * when `${tableName}` is stripped), which causes the bare-alias regex
 * in extractAliasIdentifiers() to misalign: `t` lands in the table-name
 * capture group instead of the alias group, and is never denylisted.
 *
 * `__TMPL__` keeps the token boundaries intact so alias extraction
 * correctly identifies `t` as the alias. `__TMPL__` table references
 * are filtered in parseSqlTables().
 */
export function resolveTemplateExpressions(text: string): string {
  return text.replace(/\$\{[^}]+\}/g, '__TMPL__');
}

/**
 * Return known table names within edit distance ≤ maxDist.
 */
export function getNearestTableSuggestions(
  name: string,
  knownTables: Set<string>,
  maxDist: number
): string[] {
  const results: Array<{ table: string; distance: number }> = [];
  for (const known of knownTables) {
    const dist = levenshteinDistance(name.toLowerCase(), known.toLowerCase());
    if (dist <= maxDist) {
      results.push({ table: known, distance: dist });
    }
  }
  // Sort by distance ascending
  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, 3).map(r => `'${r.table}'`);
}

/**
 * Levenshtein distance.
 */
export function levenshteinDistance(a: string, b: string): number {
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

/**
 * Check naming conventions.
 */
export function checkNamingConventions(
  references: TableReference[],
  filePath: string
): Violation[] {
  const violations: Violation[] = [];

  for (const ref of references) {
    if (/[A-Z]/.test(ref.table) && !ref.table.endsWith('Table')) {
      violations.push(createSchemaViolation(
        filePath,
        ref.location,
        `Table name '${ref.table}' should use snake_case convention`,
        'suggestion',
        'naming-convention',
        ref.table
      ));
    }

    const reserved = ['user', 'order', 'group', 'table', 'column', 'index'];
    if (reserved.includes(ref.table.toLowerCase())) {
      violations.push(createSchemaViolation(
        filePath,
        ref.location,
        `Table name '${ref.table}' is a reserved word. Consider using a different name.`,
        'warning',
        'reserved-word',
        ref.table
      ));
    }
  }

  return violations;
}

/**
 * Check query patterns.
 */
export function checkQueryPatterns(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: SchemaAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];

  const functions = adapter.extractFunctions(ast);

  for (const func of functions) {
    const funcNode = findNodeByLocation(ast.root, func.location.start);
    if (!funcNode) continue;

    const funcText = adapter.getNodeText(funcNode, sourceCode);
    const queryCount = countQueries(funcText);

    if (queryCount > (config.maxQueriesPerFunction || 5)) {
      violations.push(createSchemaViolation(
        ast.filePath,
        func.location.start,
        `Function '${func.name}' has ${queryCount} queries, exceeding the maximum of ${config.maxQueriesPerFunction}`,
        'warning',
        'too-many-queries',
        func.name
      ));
    }
  }

  // N+1 query detection is handled by the data-access analyzer (loop-query rule).
  // The two were consolidated in Spec-19 Corrective Batch Item 3 — see CHANGELOG.

  return violations;
}

/**
 * Check sql injection.
 */
export function checkSQLInjection(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string
): Violation[] {
  const violations: Violation[] = [];
  const symbolOrdinals = new Map<string, number>();

  // Use regex with global flag to find individual call sites
  const dangerousPatterns = [
    /query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g,
    /query\s*\(\s*['"][^'"]*['"]?\s*\+/g,
    /execute\s*\(\s*['"][^'"]*['"]?\s*\+/g,
  ];

  for (const pattern of dangerousPatterns) {
    // Clone regex to reset state (global regexes track lastIndex)
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(sourceCode)) !== null) {
      // Parameterized queries pass a bound-params argument (`query(sql, params)`).
      // When the matched literal is followed by `, params` the interpolated
      // `${...}` segments are compile-time clauses whose `?` placeholders are
      // bound by that argument — not an injection vector. The data-access
      // analyzer's checkQuerySecurity applies the same signal.
      const afterMatch = sourceCode.slice(match.index + match[0].length);
      if (/^\s*,/.test(afterMatch)) continue;

      const location = offsetToLocation(sourceCode, match.index, { line: 1, column: 1 });

      // Find enclosing function from the AST at this position
      const node = findClosestNodeAt(ast.root, location, adapter);
      const enclosingFn = node ? findEnclosingFunctionName(node, adapter) : 'top-level';

      const baseSymbol = `${enclosingFn}:sql-injection`;
      const ordinal = (symbolOrdinals.get(baseSymbol) ?? 0) + 1;
      symbolOrdinals.set(baseSymbol, ordinal);
      const symbol = ordinal > 1 ? `${baseSymbol}:${ordinal}` : baseSymbol;

      violations.push(createSchemaViolation(
        ast.filePath,
        location,
        'Potential SQL injection vulnerability. Use parameterized queries.',
        'suggestion',  // Spec 11 R4 blanket demotion: all survivors → suggestion
        'sql-injection',
        symbol
      ));
    }
  }

  return violations;
}

/**
 * Check for references to tables absent from the known catalog — R2.4, with
 * Levenshtein suggestions. Spec 24 Item 4 Part B applies a 10:1 fail-open
 * ratio: when the unknown:known ratio exceeds 10 (or no known tables exist),
 * the catalog is not trustworthy enough to flag individual references, so the
 * check silently skips instead of emitting a wall of unknown-table noise.
 *
 * @param references Table references extracted from the file.
 * @param allTables The known-table catalog.
 * @param filePath The file under analysis.
 * @returns Unknown-table violations (empty when the fail-open ratio triggers).
 */
export function checkMissingReferences(
  references: TableReference[],
  allTables: Set<string>,
  filePath: string
): Violation[] {
  const violations: Violation[] = [];

  const unknownRefs = references.filter(
    ref => !allTables.has(ref.table) && !isSystemTable(ref.table) && !isTableValuedFunction(ref.table)
  );
  const knownCount = allTables.size;
  const unknownCount = unknownRefs.length;

  if (knownCount === 0 || unknownCount / Math.max(knownCount, 1) > 10) {
    // Fail-open: silently skip (the catalog is unreliable at this ratio).
    return violations;
  }

  for (const ref of unknownRefs) {
    const suggestions = getNearestTableSuggestions(ref.table, allTables, 2);
    const msg = suggestions.length > 0
      ? `Reference to unknown table '${ref.table}' (${ref.type}). Did you mean: ${suggestions.join(', ')}?`
      : `Reference to unknown table '${ref.table}' (${ref.type})`;

    violations.push(createSchemaViolation(
      filePath,
      ref.location,
      msg,
      'suggestion',
      'unknown-table',
      ref.table
    ));
  }

  return violations;
}

/**
 * Extract the callee text from a call_expression node.
 */
export function getCallee(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
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
export function hasTemplateArgument(node: ASTNode, adapter: LanguageAdapter): boolean {
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
export function getTemplateText(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
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
export function getFirstStringArgument(
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
export function isDbMemberCall(
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
export function getCallLocation(node: ASTNode): { line: number; column: number } {
  return node.location.start;
}

/**
 * Convert a character offset to a line/column location.
 */
export function offsetToLocation(
  sourceCode: string,
  offset: number,
  base: { line: number; column: number }
): { line: number; column: number } {
  if (offset < 0 || offset >= sourceCode.length) return base;
  const before = sourceCode.substring(0, offset);
  const lineOffset = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const column = lastNewline >= 0 ? offset - lastNewline : offset + 1;
  // offset is absolute in sourceCode — lineOffset is 0-based, so +1 gives
  // the correct 1-based line. base.line is the fallback guard only.
  return { line: lineOffset + 1, column };
}

/**
 * True when `table` is a well-known system table/schema name.
 */
export function isSystemTable(table: string): boolean {
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
 * True when `name` is a SQL table-valued function rather than a real table.
 * These appear after FROM/JOIN (`FROM json_each(...)`, `FROM generate_series(...)`)
 * so the keyword-anchored patterns capture them, but they are functions, not
 * tables — flagging them as unknown-table is a false positive.
 *
 * Covers the well-known SQLite (json_each/json_tree) and PostgreSQL
 * (unnest/generate_series/json_array_elements/...) set, plus DuckDB's
 * read_csv/read_parquet/parquet_scan families. Not exhaustive by design:
 * these are the function names that appear in real SELECT ... FROM fn(...).
 */
export function isTableValuedFunction(name: string): boolean {
  const tvfs = new Set([
    // SQLite
    'json_each', 'json_tree',
    // PostgreSQL
    'unnest', 'generate_series', 'generate_subscripts',
    'json_array_elements', 'jsonb_array_elements',
    'json_array_elements_text', 'jsonb_array_elements_text',
    'json_each_text', 'jsonb_each_text', 'jsonb_each',
    'json_object_keys', 'jsonb_object_keys',
    'regexp_split_to_table', 'string_to_table',
    // DuckDB / ClickHouse-ish readers
    'read_csv', 'read_csv_auto', 'read_parquet', 'read_json', 'read_json_auto',
    'parquet_scan', 'csv_scan', 'glob', 'range',
  ]);
  return tvfs.has(name.toLowerCase());
}

/**
 * Common SQL keywords and identifiers that are not real table names.
 */
export function isSqlKeyword(word: string): boolean {
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

/**
 * True when the `from` keyword at `fromIndex` is a JavaScript/TypeScript
 * module specifier (`import x from 'mod'`, `import { a } from 'mod'`,
 * `export { a } from 'mod'`, `export * from 'mod'`) rather than a SQL
 * FROM clause.
 *
 * Step (3) of findTableReferences() full-source scans `.ts` files under
 * `migrations/`, where a case-insensitive `\bFROM\s+([`"']?)...` pattern
 * matches `from 'typeorm'` / `from 'path'` / `from 'dotenv'` and records the
 * module name as an unknown table. SQL never introduces FROM with
 * `import`/`export`, so requiring that introducer at a statement boundary is
 * unambiguous — and only checking the introducer at a line/`;` boundary
 * avoids misreading a SQL comment (`-- import data`) or a table named
 * `import_log` as a module statement.
 */
export function isModuleImportFrom(sqlText: string, fromIndex: number): boolean {
  let start = fromIndex;
  while (start > 0) {
    const prev = sqlText[start - 1];
    // Stop at a statement terminator or a blank line — a module statement's
    // `import`/`export` introducer never crosses these.
    if (prev === ';') break;
    if (prev === '\n' && start >= 2 && sqlText[start - 2] === '\n') break;
    start--;
  }
  const prefix = sqlText.slice(start, fromIndex);
  return /(?:^|[\n;])\s*(?:import|export)\b/m.test(prefix);
}

/**
 * Count query invocations (not SQL keywords) in a function body.
 */
export function countQueries(text: string): number {
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

/**
 * Breadth-first search for the AST node whose start location exactly matches
 * the given line/column.
 */
export function findNodeByLocation(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
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

/**
 * Find the nearest AST node at a source location — walks the tree looking
 * for the deepest node that contains the given line/column.
 */
export function findClosestNodeAt(
  root: ASTNode,
  location: { line: number; column: number },
  adapter: LanguageAdapter
): ASTNode | null {
  let best: ASTNode | null = null;
  let bestDepth = -1;

  const walk = (node: ASTNode, depth: number) => {
    const start = node.location.start;
    const end = node.location.end;

    // Check if node contains the location
    if (
      (start.line < location.line ||
        (start.line === location.line && start.column <= location.column)) &&
      (end.line > location.line ||
        (end.line === location.line && end.column >= location.column))
    ) {
      if (depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
      if (node.children) {
        for (const child of node.children) {
          walk(child, depth + 1);
        }
      }
    }
  };

  walk(root, 0);
  return best;
}

/**
 * Walk up the AST from a node to find the enclosing function or method name.
 * Matches the same scheme as UniversalDataAccessAnalyzer.findEnclosingFunctionName.
 */
export function findEnclosingFunctionName(node: ASTNode, adapter: LanguageAdapter): string {
  let current: ASTNode | null = node;
  while (current) {
    const type = adapter.getNodeType(current);
    if (
      type === 'arrow_function' ||
      type === 'function_declaration' ||
      type === 'function_expression' ||
      type === 'generator_function_declaration' ||
      type === 'generator_function_expression' ||
      type === 'method_definition'
    ) {
      const name = getNodeName(current, adapter);
      if (name) return name;
    }
    if (adapter.isMethod(current)) {
      const name = getNodeName(current, adapter);
      if (name) return name;
    }
    current = adapter.getParent(current);
  }
  return 'top-level';
}

/**
 * Extract a human-readable name from an AST node.
 * Matches the same scheme as UniversalDataAccessAnalyzer.getNodeName.
 */
export function getNodeName(node: ASTNode, adapter: LanguageAdapter): string {
  // Try explicit name/text on the converted ASTNode (some adapters set it)
  if ((node as any).name && typeof (node as any).name === 'string') {
    return (node as any).name;
  }
  if ((node as any).text && typeof (node as any).text === 'string') {
    return (node as any).text;
  }
  // Fall back to the raw tree-sitter node's text content (leaf identifiers etc.)
  const rawText = (node.raw as any)?.text;
  if (typeof rawText === 'string' && rawText.length > 0) {
    return rawText;
  }
  if (node.children) {
    for (const child of node.children) {
      const childType = adapter.getNodeType(child);
      if (childType === 'identifier' || childType === 'property_identifier') {
        const name = getNodeName(child, adapter);
        if (name) return name;
      }
    }
  }
  return '';
}
