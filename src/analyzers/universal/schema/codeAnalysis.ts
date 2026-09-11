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
import { SQL_TAG_NAMES, DB_CALL_METHOD_NAMES, DB_RECEIVER_NAMES, DEFAULT_SCHEMA_CONFIG } from './config.js';
import type { SchemaAnalyzerConfig, TableReference } from './types.js';
import { createSchemaViolation } from './violations.js';

/**
 * Bundled inputs for `findTableReferences`: config, provenance context, and the
 * known-table catalog travel together so the signature stays under the param cap.
 */
export interface FindTableReferencesContext {
  config: SchemaAnalyzerConfig;
  provenanceContext?: ProvenanceContext;
  allTables?: Set<string>;
}

/**
 * Extract table references from a TypeScript/JavaScript AST.
 *
 * Four extraction strategies: (1) tagged-template SQL, (2) DB-call string
 * arguments, (3) full-source scan for `.sql` files, (4) ORM adapter extraction.
 *
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @param ctx Bundled config / provenance / known-table catalog.
 * @returns Table references extracted via all four strategies.
 */
export function findTableReferences(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  ctx: FindTableReferencesContext,
): TableReference[] {
  const references: TableReference[] = [];

  // (1) Tagged template SQL — e.g. sql`SELECT * FROM heroes`
  references.push(...extractTaggedTemplateRefs(ast, adapter, sourceCode, ctx));

  // (2) DB-call patterns — e.g. db.exec("SELECT * FROM heroes")
  references.push(...extractDbCallRefs(ast, adapter, sourceCode, ctx));

  // (3) .sql files — scan the entire source (the whole file IS SQL).
  if (ast.filePath.endsWith('.sql')) {
    const fileRefs = parseSqlTables(sourceCode, { line: 1, column: 1 }, sourceCode, ctx.allTables);
    references.push(...fileRefs);
  }

  // (4) Spec 15 R2 — ORM-aware extraction (Drizzle + Prisma)
  references.push(...extractOrmRefs(ast, adapter, sourceCode));

  return references;
}

/**
 * Strategy (1): tagged-template SQL — e.g. sql`SELECT * FROM heroes`.
 * This is a syntax feature, not a naming convention — keep the sqlTagNames gate.
 */
function extractTaggedTemplateRefs(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  ctx: FindTableReferencesContext,
): TableReference[] {
  const { config, allTables } = ctx;
  const references: TableReference[] = [];
  const sqlTags = config.sqlTagNames ?? [...SQL_TAG_NAMES];

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
    references.push(...parseSqlTables(templateText, location, sourceCode, allTables));
  }

  return references;
}

/**
 * Strategy (2): DB-call patterns — e.g. db.exec("SELECT * FROM heroes").
 * Spec 21: provenance-based isDBProvenanced when available, falling back to
 * the name-based isDbMemberCall for `names` mode / no context.
 */
function extractDbCallRefs(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  ctx: FindTableReferencesContext,
): TableReference[] {
  const { config, provenanceContext, allTables } = ctx;
  const references: TableReference[] = [];

  const dbCalls = adapter.findNodes(ast, {
    custom: (node: ASTNode) => {
      if (node.type !== 'call_expression') return false;
      // Spec 21: Use provenance when available, fall back to name-based check
      if (provenanceContext && provenanceContext.mode !== 'names') {
        return isDBProvenanced(node, { adapter, sourceCode, context: provenanceContext, methods: DB_CALL_METHODS });
      }
      // Legacy name-based check for names mode / no context
      const callee = getCallee(node, adapter, sourceCode);
      if (!callee) return false;
      const dbMethods = config.dbCallMethods ?? [...DB_CALL_METHOD_NAMES];
      const dbReceivers = config.dbReceiverNames ?? [...DB_RECEIVER_NAMES];
      return isDbMemberCall(callee, dbMethods, dbReceivers);
    },
  });

  for (const callNode of dbCalls) {
    const firstArg = getFirstStringArgument(callNode, adapter, sourceCode);
    if (!firstArg) continue;
    const location = getCallLocation(callNode);
    references.push(...parseSqlTables(firstArg, location, sourceCode, allTables));
  }

  return references;
}

/**
 * Strategy (4): ORM-aware extraction (Drizzle + Prisma) via the registered
 * adapter. Complements raw-SQL extraction by picking up ORM-specific patterns
 * like db.select().from(users) and prisma.user.findMany().
 */
function extractOrmRefs(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): TableReference[] {
  const references: TableReference[] = [];
  const ormRegistry = OrmAdapterRegistry.getInstance();
  const ormAdapter = ormRegistry.getAdapterForFile(ast.filePath);
  if (!ormAdapter) return references;

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

  return references;
}

/**
 * Parse SQL table names from a SQL text string.
 * R2.3: Template expressions (${...}) resolve portions to wildcards.
 *
 * @param sqlText The SQL text to scan.
 * @param baseLocation The line/column of the SQL text's start in `sourceCode`.
 * @param sourceCode The full source text (for offset-to-location mapping).
 * @param allTables Known-table catalog used to keep short CTE/alias identifiers.
 * @returns Table references found in the SQL text.
 */
/** Bundled inputs for the SQL-pattern match loop inside `parseSqlTables`. */
interface SqlParseContext {
  sqlText: string;
  cleaned: string;
  baseLocation: { line: number; column: number };
  sourceCode: string;
  allTables?: Set<string>;
}

/**
 * SQL patterns anchored to SQL keywords (not arbitrary substrings).
 *
 * Uses Unicode-aware \p{L} so non-Latin table names (日, 注文, пользователи)
 * are correctly matched — \w is ASCII-only. Spec 21 R5. No trailing \b:
 * greedy [\p{L}\p{N}_]* consumes the full identifier and \b after a closing
 * quote (non-word char) fails, blocking quoted-table extraction.
 */
function sqlTablePatterns(): Array<{ regex: RegExp; type: TableReference['type'] }> {
  return [
    { regex: /\bFROM\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'select' },
    { regex: /\bJOIN\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'select' },
    // Spec 52 R2 — the four D1/SQLite upsert forms are writes. MySQL's
    // `INSERT IGNORE INTO` (no OR) and `ON DUPLICATE KEY UPDATE` are
    // deliberately out of scope: the classifier targets the D1/Workers SQLite
    // dialect, and `ON DUPLICATE KEY UPDATE col = …` (no `SET`) would otherwise
    // misfire the UPDATE pattern below onto the column name.
    { regex: /\b(?:INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?|REPLACE)\s+INTO\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'insert' },
    { regex: /\bUPDATE\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'update' },
    { regex: /\bDELETE\s+FROM\s+([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'delete' },
    { regex: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?)([\p{L}_][\p{L}\p{N}_]*)\1/giu, type: 'create' },
  ];
}

/**
 * Run the keyword-anchored SQL patterns over `cleaned`, skipping system
 * tables, table-valued functions, module-specifier FROMs, short CTE/alias
 * identifiers, and SQL keywords.
 */
function matchSqlPatterns(ctx: SqlParseContext): TableReference[] {
  const { sqlText, cleaned, baseLocation, sourceCode, allTables } = ctx;
  const references: TableReference[] = [];

  for (const { regex, type } of sqlTablePatterns()) {
    // Create fresh regex since we might consume with exec
    const re = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = re.exec(cleaned)) !== null) {
      const table = match[2]; // The table name (capture group 2)
      if (!table || isSystemTable(table) || isTableValuedFunction(table)) continue;

      // Skip JS/TS module specifiers (`import x from 'mod'`) that step (3)'s
      // full-source scan of migration `.ts` files otherwise captures as tables.
      if (isModuleImportFrom(cleaned, match.index)) continue;

      // Skip very short identifiers (likely CTE names / bare aliases like 'x',
      // 't', 'o', 'c') unless they are known table names — the guard catches
      // false positives from single-char CTE/alias identifiers.
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

  return references;
}

/**
 * Parse a SQL string (possibly with template expressions) into table references.
 *
 * @param sqlText The SQL text to parse.
 * @param baseLocation Location of the SQL text within its source file.
 * @param sourceCode The full source file contents.
 * @param allTables Optional known table set for match filtering.
 * @returns Table references discovered in the SQL text.
 */
export function parseSqlTables(
  sqlText: string,
  baseLocation: { line: number; column: number },
  sourceCode: string,
  allTables?: Set<string>,
): TableReference[] {
  // R2.3: Strip template expressions — `${prefix}_builds` → `_builds`
  // (the prefix is replaced with empty, the suffix remains for matching)
  const cleaned = resolveTemplateExpressions(sqlText);
  const ctx: SqlParseContext = { sqlText, cleaned, baseLocation, sourceCode, allTables };

  let references = matchSqlPatterns(ctx);

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
 *
 * @param sqlText The SQL text to scan for alias identifiers.
 * @returns Lowercased alias identifiers to filter from table references.
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
 *
 * @param name The candidate table name to match.
 * @param knownTables The known-table catalog.
 * @param maxDist Maximum Levenshtein edit distance to include.
 * @returns Up to three known tables within the distance, quoted, nearest first.
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
 * Levenshtein edit distance between two strings.
 *
 * @param a First string.
 * @param b Second string.
 * @returns The edit distance, or Infinity when length difference exceeds 3.
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
 * Check table naming conventions against references.
 *
 * @param references Table references extracted from the file.
 * @param filePath The file under analysis.
 * @returns Naming-convention and reserved-word violations.
 */
export function checkNamingConventions(
  references: TableReference[],
  filePath: string
): Violation[] {
  const violations: Violation[] = [];

  for (const ref of references) {
    // Conformance check instead of an uppercase-proxy: a table name is valid
    // when it is snake_case (`/^[a-z][a-z0-9_]*$/`), or when it is an ORM
    // class name following the `Table`-suffix policy (e.g. `UsersTable` for
    // table `users`).
    const isSnakeCase = /^[a-z][a-z0-9_]*$/.test(ref.table);
    const isTableSuffix = ref.table.endsWith('Table');
    if (!isSnakeCase && !isTableSuffix) {
      violations.push(createSchemaViolation(
        filePath,
        ref.location,
        `Table name '${ref.table}' should use snake_case convention`,
        { severity: 'high', rule: 'table-naming-convention', symbol: ref.table }
      ));
    }

    const reserved = ['user', 'order', 'group', 'table', 'column', 'index'];
    if (reserved.includes(ref.table.toLowerCase())) {
      violations.push(createSchemaViolation(
        filePath,
        ref.location,
        `Table name '${ref.table}' is a reserved word. Consider using a different name.`,
        { severity: 'severe', rule: 'reserved-word', symbol: ref.table }
      ));
    }
  }

  return violations;
}

/**
 * Check query patterns (per-function query-count ceiling).
 *
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @param config Schema analyzer configuration (maxQueriesPerFunction ceiling).
 * @returns Too-many-queries violations.
 */
export function checkQueryPatterns(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: SchemaAnalyzerConfig
): Violation[] {
  const violations: Violation[] = [];

  // Resolve the ceiling once — the pipeline's schema config can omit it, and
  // the message must never print "undefined". Falls back to the analyzer's
  // default (DEFAULT_SCHEMA_CONFIG.maxQueriesPerFunction) so the condition and
  // message can never disagree.
  const maxQueries = config.maxQueriesPerFunction ?? DEFAULT_SCHEMA_CONFIG.maxQueriesPerFunction ?? 5;

  const functions = adapter.extractFunctions(ast);

  for (const func of functions) {
    const funcNode = findNodeByLocation(ast.root, func.location.start);
    if (!funcNode) continue;

    const funcText = adapter.getNodeText(funcNode, sourceCode);
    const queryCount = countQueries(funcText);

    if (queryCount > maxQueries) {
      violations.push(createSchemaViolation(
        ast.filePath,
        func.location.start,
        `Function '${func.name}' has ${queryCount} queries, exceeding the maximum of ${maxQueries}`,
        { severity: 'high', rule: 'too-many-queries', symbol: func.name }
      ));
    }
  }

  // N+1 query detection is handled by the data-access analyzer (loop-query rule).
  // The two were consolidated in Spec-19 Corrective Batch Item 3 — see CHANGELOG.

  return violations;
}

/** Regexes for dangerous query/execute call sites (global flag for iteration). */
const DANGEROUS_SQL_PATTERNS: RegExp[] = [
  /query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g,
  /query\s*\(\s*['"][^'"]*['"]?\s*\+/g,
  /execute\s*\(\s*['"][^'"]*['"]?\s*\+/g,
];

/** Bundled inputs for the per-match injection check. */
interface InjectionCheckContext {
  ast: AST;
  adapter: LanguageAdapter;
  sourceCode: string;
  symbolOrdinals: Map<string, number>;
  violations: Violation[];
}

/**
 * Evaluate a single dangerous-pattern match: skip parameterized queries and
 * taint-safe dynamic strings, else emit a dynamic-sql-construction violation.
 */
function checkInjectionMatch(ctx: InjectionCheckContext, match: RegExpExecArray): void {
  const { ast, adapter, sourceCode, symbolOrdinals, violations } = ctx;

  // Parameterized queries pass a bound-params argument (`query(sql, params)`).
  // When the matched literal is followed by `, params` the interpolated
  // `${...}` segments are compile-time clauses whose `?` placeholders are
  // bound by that argument — not an injection vector. The data-access
  // analyzer's checkQuerySecurity applies the same signal.
  const afterMatch = sourceCode.slice(match.index + match[0].length);
  if (/^\s*,/.test(afterMatch)) return;

  const location = offsetToLocation(sourceCode, match.index, { line: 1, column: 1 });

  // Find enclosing function from the AST at this position
  const node = findClosestNodeAt(ast.root, location, adapter);

  // Taint-aware safety check (Spec 33 Item 11a): clear the finding when the
  // query argument's dynamic parts are all provably safe. The naive regex
  // cannot tell trusted-DDL interpolation (`query(\`CREATE TABLE ${name}...\`)`
  // with a constant/sanitized name) from raw-input interpolation, so the
  // distinction is delegated to the adapter's dynamic-string safety analysis
  // (isSafeInterpolation / resolveLocalConstant) — the same signal the
  // data-access analyzer already trusts for sql-injection-risk.
  const callNode = findEnclosingCallExpression(node, adapter);
  if (callNode && isAllDynamicPartsSafe(callNode, ast, adapter, sourceCode)) {
    return;
  }

  const enclosingFn = node ? findEnclosingFunctionName(node, adapter) : 'top-level';

  const baseSymbol = `${enclosingFn}:dynamic-sql-construction`;
  const ordinal = (symbolOrdinals.get(baseSymbol) ?? 0) + 1;
  symbolOrdinals.set(baseSymbol, ordinal);
  const symbol = ordinal > 1 ? `${baseSymbol}:${ordinal}` : baseSymbol;

  violations.push(createSchemaViolation(
    ast.filePath,
    location,
    `SQL query built via string interpolation or concatenation in ${enclosingFn}; use parameterized queries.`,
    // User-controlled SQL built by interpolation is injectable now — critical.
    { severity: 'critical', rule: 'dynamic-sql-construction', symbol }
  ));
}

/**
 * Detect potential SQL injection in query/execute calls.
 *
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @returns SQL-injection violations.
 */
export function checkSQLInjection(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string
): Violation[] {
  const violations: Violation[] = [];
  const ctx: InjectionCheckContext = {
    ast,
    adapter,
    sourceCode,
    symbolOrdinals: new Map<string, number>(),
    violations,
  };

  for (const pattern of DANGEROUS_SQL_PATTERNS) {
    // Clone regex to reset state (global regexes track lastIndex)
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(sourceCode)) !== null) {
      checkInjectionMatch(ctx, match);
    }
  }

  return violations;
}

/**
 * Walk up from a node to the enclosing call_expression, if any.  Used by
 * checkSQLInjection to map a regex match location back to the query(...)/
 * execute(...) call whose string argument is under test.
 */
function findEnclosingCallExpression(
  node: ASTNode | null,
  adapter: LanguageAdapter
): ASTNode | null {
  let current = node;
  while (current) {
    if (adapter.getNodeType(current) === 'call_expression') return current;
    current = adapter.getParent(current);
  }
  return null;
}

/**
 * True when a dynamic query/execute string argument is provably safe to embed
 * in SQL — every interpolated sub-part is a compile-time constant, quote-escaped
 * sanitizer, safe ternary/array-join, or guard-validated parameter.  Mirrors
 * UniversalDataAccessAnalyzer.isSafeDynamicPart (minus its config-driven
 * sanitizer allowlist, which checkSQLInjection has no config for); used to
 * clear trusted-DDL false positives (Spec 33 Item 11a).
 */
function isAllDynamicPartsSafe(
  callNode: ASTNode,
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string
): boolean {
  // No dynamic-string capability → cannot prove safety → keep the legacy hit.
  if (!adapter.isDynamicStringConstruction || !adapter.getDynamicParts) {
    return false;
  }
  // A non-dynamic argument (plain string literal) has no interpolation.
  if (!adapter.isDynamicStringConstruction(callNode)) return true;

  const parts = adapter.getDynamicParts(callNode, sourceCode);
  if (parts.length === 0) return true;

  for (const part of parts) {
    // Prefer the adapter's cross-function safety analysis — it clears quote-escape
    // sanitizers, safe ternaries/array-joins, safe local helper calls, and
    // guard-validated parameters, and subsumes the static-constant check.
    if (part.node && adapter.isSafeInterpolation) {
      if (!adapter.isSafeInterpolation(part.node, ast, sourceCode)) return false;
      continue;
    }
    // Fallback for adapters without isSafeInterpolation: resolve identifiers
    // to compile-time constants only.
    if (part.isIdentifier) {
      const resolved = part.node && adapter.resolveLocalConstant
        ? adapter.resolveLocalConstant(part.node, ast, sourceCode)
        : null;
      if (!(resolved && resolved.isStatic)) return false;
      continue;
    }
    // Non-identifier expression with no safety analysis → cannot prove safe.
    return false;
  }
  return true;
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
      { severity: 'critical', rule: 'unknown-table', symbol: ref.table }
    ));
  }

  return violations;
}

/**
 * Extract the callee text from a call_expression node.
 *
 * @param node The call_expression node.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @returns The callee text (e.g. "db.exec"), or null when absent.
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
 * Check whether a call_expression has a template string argument.
 *
 * @param node The call_expression node.
 * @param adapter The language adapter for the file's syntax.
 * @returns True when a template-string argument is present.
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
 *
 * @param node The call_expression node.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @returns The trimmed template text, or null when absent.
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
 *
 * @param node The call_expression node.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @returns The unquoted string/template argument, or null when absent.
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
 *
 * @param calleeText The callee text (e.g. "db.exec").
 * @param methods The allowed DB call method names.
 * @param receivers The allowed DB receiver names.
 * @returns True when the callee is a permitted receiver.method DB call.
 */
export function isDbMemberCall(
  calleeText: string,
  methods: string[],
  receivers: string[]
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
 *
 * @param node The call_expression node.
 * @returns The node's start line/column.
 */
export function getCallLocation(node: ASTNode): { line: number; column: number } {
  return node.location.start;
}

/**
 * Convert a character offset to a line/column location.
 *
 * @param sourceCode The source text the offset is relative to.
 * @param offset The character offset.
 * @param base Fallback location returned when offset is out of range.
 * @returns The 1-based line/column for the offset.
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
 *
 * @param table The candidate table name.
 * @returns True for system schemas/tables (information_schema, pg_catalog, …).
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
 *
 * @param name The candidate identifier.
 * @returns True when `name` is a known table-valued function.
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
 *
 * @param word The candidate identifier.
 * @returns True when `word` is a SQL keyword/reserved identifier.
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
    'skip', 'locked', 'nowait',
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
 *
 * @param sqlText The source text being scanned for a FROM introducer.
 * @param fromIndex The character index of the `from` keyword within `sqlText`.
 * @returns True when the introducer preceding `fromIndex` is an import/export.
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
 * Count the number of DB queries a function body issues.
 *
 * An eager execution method call (`.run()`/`.all()`/`.first()`/`.raw()`/
 * `.batch()`, plus the generic `.query()`/`.execute()` wrappers) is one query;
 * each standalone SQL keyword (SELECT, INSERT [OR …] INTO / REPLACE INTO,
 * UPDATE, DELETE FROM) outside such a call is also one query. SQL keywords
 * inside a call's argument are not counted separately — otherwise a single
 * `run('SELECT ...')` call is counted twice (once for the call, once for the
 * SQL it carries). `.prepare()` bodies are likewise stripped (Spec 52 R1):
 * preparation is statement construction, not execution, so its SQL is not a
 * query the function issues — but a `db.prepare(sql).bind(x).run()` chain still
 * counts one query for the eager `.run()`. `Promise.all(...)` is not a query
 * and is excluded from the `.all()` count. Optional TypeScript type arguments
 * (`.all<Row>()`/`.first<Row>()`) are matched. `.exec()` is deliberately
 * omitted: `regex.exec()`/`child_process.exec()` are too common to distinguish
 * from `db.exec()` in a text heuristic, and a `db.exec('SELECT …')` literal is
 * still counted via its bare SQL keyword. A bare `UPDATE` keyword is counted,
 * but not the `DO UPDATE` / `KEY UPDATE` clause of an upsert
 * (`INSERT … ON CONFLICT … DO UPDATE` / `INSERT … ON DUPLICATE KEY UPDATE`) —
 * that clause is part of the one INSERT statement, not a second query
 * (Spec 52 R2).
 *
 * @param text The function body text.
 * @returns The number of DB queries the function issues.
 */
export function countQueries(text: string): number {
  const callCount = (text.match(/\.(?:query|execute|run|first|raw|batch)\b[^()\n]*\(|(?<!Promise)\.all\b[^()\n]*\(/g) || []).length;

  const bodyless = stripQueryCallBodies(text);
  const sqlPatterns = [
    /SELECT\s+/gi,
    /INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?\s+INTO|REPLACE\s+INTO/gi,
    /(?<!DO\s)(?<!KEY\s)UPDATE\s+/gi,
    /DELETE\s+FROM/gi,
  ];
  let sqlCount = 0;
  for (const pattern of sqlPatterns) {
    const matches = bodyless.match(pattern);
    if (matches) sqlCount += matches.length;
  }

  return callCount + sqlCount;
}

/**
 * Blank out the bodies of eager execution method calls (`.run()`/`.all()`/
 * `.first()`/`.raw()`/`.batch()`/`.query()`/`.execute()`) and of `.prepare()`
 * calls (balanced-paren aware) so SQL keywords inside their arguments are not
 * double-counted. `.prepare()` carries SQL but does not execute it (Spec 52
 * R1), so its body is stripped too. `Promise.all(...)` is not a query and is
 * left intact so the DB calls it contains stay visible.
 *
 * @param text The function body text.
 * @returns The text with eager/`query`/`execute`/`prepare` call bodies replaced by spaces.
 */
function stripQueryCallBodies(text: string): string {
  const re = /\.(?:query|execute|prepare|run|first|raw|batch)\b[^()\n]*\(|(?<!Promise)\.all\b[^()\n]*\(/g;
  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const openParen = m.index + m[0].length;
    let depth = 1;
    let i = openParen;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    result += text.slice(last, openParen);
    result += ' '.repeat(Math.max(0, i - openParen));
    last = i;
    re.lastIndex = i;
  }
  result += text.slice(last);
  return result;
}

/**
 * Breadth-first search for the AST node whose start location exactly matches
 * the given line/column.
 *
 * @param root The AST root node.
 * @param location The target line/column.
 * @returns The matching node, or null when absent.
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
 *
 * @param root The AST root node.
 * @param location The target line/column.
 * @param adapter The language adapter for the file's syntax.
 * @returns The deepest node containing the location, or null.
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
 *
 * @param node The node to start the walk from.
 * @param adapter The language adapter for the file's syntax.
 * @returns The enclosing function/method name, or "top-level".
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
 *
 * @param node The AST node.
 * @param adapter The language adapter for the file's syntax.
 * @returns The node's name, or "" when none is found.
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
