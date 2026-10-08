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
  getCallExpressionCallee,
  getMemberExpressionReceiver,
  extractMemberExpressionProperty,
  resolveSiteDialect,
  type ProvenanceContext,
  type ProvenanceEvidence,
  type DetectionMode,
} from '../provenance.js';
import { extractStaticSql, extractGoStaticSql, isTemplateLiteral, isTaggedTemplateSqlCall } from '../sqlLiteral.js';
import { isOrmMethod, handleTypesForPackage } from '../tsEcosystem.js';
import { identifyHandle, type HandleVerdict } from '../handleIdentification.js';
import {
  buildBindingEnv,
  extractInterfaceFields,
  resolveReceiverRoot,
  isDbShapedRoot,
  findEnclosingClassHeritage,
  type RootResolutionEnv,
} from '../receiverRoot.js';
import {
  buildGoBindingEnv,
  buildGoImportMap,
  classifyGoRootIdentifier,
  type GoResolutionEnv,
} from '../../languages/go/goResolution.js';
import {
  DB_BINDING_NAMES,
  DB_WRAPPER_NAMES,
  SQL_TAG_NAMES,
} from './UniversalSchemaAnalyzer.js';
import { findEnclosingFunctionIdentity, functionIdentityLabel } from './schema/codeAnalysis.js';
import { isTestOrSpecPath } from '../../languages/testConventions.js';
import {
  buildOrgFilterTierSet,
  tableRequiresOrgFilter,
  DEFAULT_ORG_PREDICATE_PATTERNS,
  hasOrganizationFilter,
} from '../orgFilterTiers.js';
import { resolveWhereBinding } from '../../phase/localBinding.js';
import type { ResolvedWhere, DataAccessCallCandidate, LoopQueryRawCandidate } from '../../phase/types.js';
import type { Dialect } from '../../mcp-tools/discoveryQueries.js';
import type { AST as SqlAst } from 'node-sql-parser';
import {
  parseSql,
  DEFAULT_SQL_DIALECT,
  extractTableNames,
  whereFacts,
  isWriteStatement,
  isMassWriteStatement,
  isUpsertStatement,
  whereColumnRefs,
} from '../../languages/sql/sqlAst.js';

/**
 * SQL keywords recognized as evidence that a *dynamically-constructed* string is
 * an injection surface — the host-language dataflow gate in `checkQuerySecurity`
 * (site #11, not converted by R2). This list is NOT the SQL-ness admission gate:
 * that decision is provenance/shape/tag-based (see `isSqlPosition` in
 * `buildDatabaseCall`), and a keyword name list must not decide whether a string
 * is SQL — it would silently drop keyword-less SQL (`PRAGMA`, `VACUUM`,
 * `ANALYZE`) that provenance already establishes as SQL. `containsSQLStructure`
 * is gone (R2 site #4); this list now feeds only `checkQuerySecurity`.
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

  /** Spec 55 R3 — exclude the query-shape rules (loop-query, unfiltered-query)
   *  from test files. Defaults true; set false to analyze test files (used by
   *  the oracle fixtures, which assert positive loop-query detections). */
  skipTestFiles?: boolean;

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

  // Table extraction patterns — host-language ORM/query-builder shape only.
  // SQL-content table names come from the parsed AST (Spec 70 R2, site #1); the
  // `sql` regex list is deleted, not kept as a fallback.
  tablePatterns?: {
    orm?: RegExp[];
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

  /** DB binding names for provenance detection (e.g. env.DB — Cloudflare D1 bindings). */
  dbBindingNames?: string[];

  /** Tagged-template tag names that denote raw SQL (e.g. `sql`, `db`) — the
   *  `sql\`…\`` / `db\`…\`` Drizzle idiom. Recognized by *name*, independent of
   *  provenance, so a tag whose receiver is an unresolved local wrapper is not
   *  invisible to the data-access rules. Defaults to SQL_TAG_NAMES. */
  sqlTagNames?: string[];

  /** Provenance detection mode: 'hybrid' | 'provenance' | 'names'. */
  detection?: { mode: DetectionMode };

  /**
   * Spec 70 R1 — the corpus's named SQL dialect, or null when undetermined.
   * SQL-content facts (tables, filter, write-verb, tenant predicate) are derived
   * from a parsed SQL AST; when the dialect is null the argument cannot be parsed
   * and those facts `cannot-fire` (empty / false) rather than falling back to a
   * regex over text. ORM-shape table extraction (`.from('users')`, Kysely verbs,
   * Drizzle `db.<table>.<method>()`) is host-language shape, not SQL, and does
   * not consult this field.
   */
  dialect?: Dialect | null;

  /** SQL sanitizer function names — interpolation wrapped in one of these
   *  (e.g. escapeSql(x)) is not raw.  Kept in sync with the provenance system's
   *  dbWrapperNames: any list the detector learns about, the FP guards must also consult. */
  sanitizerNames?: string[];
}

export const DEFAULT_DATA_ACCESS_CONFIG: DataAccessAnalyzerConfig = {
  checkOrgFilters: true,
  checkSQLInjection: true,
  skipTestFiles: true,

  organizationPatterns: [...DEFAULT_ORG_PREDICATE_PATTERNS],
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
  dbBindingNames: [...DB_BINDING_NAMES],
  sqlTagNames: [...SQL_TAG_NAMES],
  detection: { mode: 'hybrid' },
  // Spec 70 R1 — no dialect until the corpus names one; the SQL-content facts
  // then `cannot-fire` rather than being regex-derived.
  dialect: null,
  // SQL sanitizer functions — interpolation via escapeSql(x) is not raw.
  sanitizerNames: ['escapeSql'],
};

export interface DatabaseCall {
  type: string;
  /** The resolved method/property name, or null when the callee shape cannot be
   *  walked to a name (no method name — never a guessed one). */
  method: string | null;
  file: string;
  line: number;
  column: number;
  tables: string[];
  /** The query statement's own text (the candidate node's text, comments
   *  stripped) — query-scoped for filter/write-verb detection. NOT the whole
   *  file: the old `analyzeQuery` read two unrelated queries in one file as one
   *  statement. */
  queryText: string;
  hasOrganizationFilter: boolean;
  /** True when the query carries a limiting clause (WHERE/HAVING/LIMIT) —
   *  broader than the tenant-isolation org filter, used for the performance
   *  `unfiltered-query` rule. */
  hasFilter: boolean;
  /** Spec 70 R2 — AST-derived SQL facts, parsed from the call's static SQL
   *  argument. Each is absent (false / empty / null) when the corpus named no
   *  dialect or the argument failed to parse: that is `cannot-fire`, not a
   *  negative verdict. */
  isWrite: boolean;
  isMassWrite: boolean;
  isUpsert: boolean;
  isRawInsert: boolean;
  insertColumns: string[] | null;
  sqlWhereColumns: string[] | null;
  hasParameterizedQuery: boolean;
  hasSqlInjectionRisk: boolean;
  /** True when the injection risk is defended (manual quote-escaping) rather
   *  than raw unescaped interpolation — downgrades the finding to high. */
  sqlEscaped: boolean;
  /** Enclosing function name for stable fingerprinting (Spec 18 Gap 2). */
  enclosingFunction?: string;
  /** Spec 69 R3 — the resolved WHERE predicate when the `.where(...)` spreads a
   *  local array binding (`and(...conditions)`); null/undefined otherwise. */
  resolvedWhere?: ResolvedWhere;
  /** Spec 70 R1.2 — the handle verdict from `identifyHandle` (`handle` with its
   *  `via`, or `unproven` with its reason). Present only when the call was
   *  admitted through handle identification; absent for shape-only / ORM /
   *  tagged-template / variable-assignment candidates. A `not-handle` site is
   *  rejected at admission and never reaches a DatabaseCall. */
  handleVerdict?: HandleVerdict;
}

interface QueryAnalysis {
  complexity: 'simple' | 'moderate' | 'complex';
  tables: string[];
  hasJoins: boolean;
  hasOrganizationFilter: boolean;
  hasFilter: boolean;
  performanceRisk: 'low' | 'medium' | 'high';
}

// ── Diagnostic infrastructure (one-time v3.4.12 adjuciation) ──────────────

/**
 * Bundled classification for a data-access violation — `severity`, `rule`,
 * and an optional `symbol` travel together so `makeViolation` stays a 4-arg
 * call rather than a 6-arg one (Spec 34 param-count bundling).
 */
interface DataAccessViolationClassification {
  severity: 'critical' | 'severe' | 'high';
  rule: string;
  symbol?: string;
  /** Spec 37 R1 — structured next action carried on gating findings. */
  resolution?: Resolution;
}

/**
 * Per-file analysis context threaded through the data-access helper chain.
 * Bundles `adapter` / `sourceCode` / `config` / `provenanceContext` into one
 * object so the helpers that previously took 5–6 positional params
 * (buildDatabaseCall, extractDatabaseCalls, checkQuerySecurity, …) clear the
 * 4-parameter gate without each defining its own bespoke context type.
 */
interface DataAccessScanContext {
  adapter: LanguageAdapter;
  sourceCode: string;
  config: DataAccessAnalyzerConfig;
  /** The parsed file AST — `handleCallSiteIdentity` reads it to resolve the
   *  enclosing class's base-class field types (Spec 70 Q3 heritage). */
  ast: AST;
  provenanceContext?: ProvenanceContext;
  /** Per-file TypeScript binding environment `identifyHandle` reads for
   *  declaration resolution. Built once per file; absent for Go / non-code. */
  handleEnv?: RootResolutionEnv;
  /** Per-file Go binding environment `identifyHandle` reads for Go declaration
   *  resolution. Built once per file; absent for TS / non-code. */
  goEnv?: GoResolutionEnv;
}

/**
 * Bundled inputs for checkViolations — file path, config, and the mutable
 * symbol-ordinal map are threaded together so the helper stays a 3-arg call.
 */
interface ViolationCheckContext {
  filePath: string;
  config: DataAccessAnalyzerConfig;
  symbolOrdinals: Map<string, number>;
  /** Spec 55 R3 — test/spec files skip the query-shape rules (unfiltered-query). */
  skipTestRules: boolean;
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
  if (classification.symbol) v.symbol = classification.symbol;
  if (classification.resolution) v.resolution = classification.resolution;
  return v;
}

/**
 * The four companion pairs of the query-builder chain grammar (Spec 68 Thing 2,
 * #312). A verb admits a chain only when one of its required companions appears
 * LATER in the same callee — this is the Drizzle/Kysely grammar and is pure
 * syntax (no catalog, no name list).
 */
const QUERY_BUILDER_COMPANIONS: ReadonlyArray<{ verb: RegExp; companions: RegExp[] }> = [
  // `.select` also admits Drizzle's `.selectDistinct(…)` / `.selectDistinctOn(…)`
  // — the same select verb followed by `.from(`; `.select\b` alone would miss the
  // `Distinct` suffix (a word character breaks the boundary).
  { verb: /\.select(?:DistinctOn|Distinct)?\b/, companions: [/\.from\b/] },
  { verb: /\.insert\b/, companions: [/\.values\b/] },
  { verb: /\.update\b/, companions: [/\.set\b/, /\.where\b/] },
  { verb: /\.delete\b/, companions: [/\.where\b/] },
];

/**
 * Admitter 1 — verb plus required companion, tested on the CALLEE text. The
 * callee of the outermost call in a chain carries every earlier verb with its
 * argument (e.g. `db.select({…}).from(users).where(…)` → callee text
 * `db.select({…}).from(users).where`), so a single substring scan over the
 * callee sees the whole grammar. The trailing verb appears without its paren
 * (the arguments belong to the outermost call), so companions are matched with
 * a word boundary, not `\(`. `map.delete(k)`, `createHash().update(b)`,
 * `cookies.delete(n)` and `stripe.customers.update(id, data)` all lack the
 * companion and fail.
 */
function hasChainCompanion(calleeText: string): boolean {
  for (const { verb, companions } of QUERY_BUILDER_COMPANIONS) {
    const verbIdx = calleeText.search(verb);
    if (verbIdx < 0) continue;
    const rest = calleeText.slice(verbIdx + 1);
    if (companions.some((companion) => companion.test(rest))) return true;
  }
  return false;
}

/** Prisma CRUD verbs admitted by the object-form shape (admitter 2). */
const PRISMA_VERBS = new Set([
  'create', 'createMany', 'update', 'updateMany', 'upsert',
  'delete', 'deleteMany', 'findUnique', 'findFirst', 'findMany',
  'findUniqueOrThrow', 'findFirstOrThrow', 'findRaw', 'count', 'groupBy', 'aggregate',
]);

/** Collect the property keys of an object literal, including its nested objects. */
function collectObjectLiteralKeys(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string[] {
  const keys: string[] = [];
  const stack: ASTNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    const t = adapter.getNodeType(n);
    if (t === 'shorthand_property_identifier' || t === 'property_identifier') {
      const txt = adapter.getNodeText(n, sourceCode)?.trim();
      if (txt) keys.push(txt);
      continue;
    }
    for (const c of adapter.getChildren(n) ?? []) stack.push(c);
  }
  return keys;
}

/**
 * Admitter 2 — Prisma's object form: `<recv>.<Model>.<verb>({ … })` where the
 * object-literal argument carries a `where` or `data` key. Option 1 (chained
 * companions) misses this because the `where`/`data` are keys inside an object
 * literal, not chained calls (blitz `prisma.user.update({ where, data })`).
 */
function isPrismaObjectForm(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const callee = getCallExpressionCallee(node, adapter);
  if (!callee || adapter.getNodeType(callee) !== 'member_expression') return false;
  const calleeText = stripComments(adapter.getNodeText(callee, sourceCode) ?? '').trim();
  const parts = calleeText.split('.');
  if (parts.length < 3) return false;
  if (!PRISMA_VERBS.has(parts[parts.length - 1])) return false;

  const args = adapter.getChildren(node).find((c) => adapter.getNodeType(c) === 'arguments');
  if (!args) return false;
  for (const arg of adapter.getChildren(args)) {
    const keys = collectObjectLiteralKeys(arg, adapter, sourceCode);
    if (keys.includes('where') || keys.includes('data')) return true;
  }
  return false;
}

/**
 * Spec 68 Thing 2 (#312) — the query-builder shape test.
 *
 * Answers "is this a DB query?" structurally, from the call's own grammar,
 * instead of by the receiver's name. A chain that shapes like a Drizzle/Kysely
 * builder or a Prisma CRUD call is a query regardless of whether its receiver
 * is named `db`, `appDb`, `tx`, or `prisma`. This replaces the receiver-name
 * blind spot (`DB_RECEIVER_NAMES`) without growing the name list — the raw-SQL
 * path (`db.exec(sql)`) still relies on receiver/import provenance because it
 * has no chain grammar to lean on.
 *
 * Two admitting conditions, union (not intersection):
 *   1. verb + companion chain grammar — {@link hasChainCompanion};
 *   2. Prisma object form — {@link isPrismaObjectForm}.
 *
 * A third admitter — catalog-resolved argument (a bare `.from(table)` /
 * `.query(table)` whose verb argument resolves to a `resolution` table) —
 * was evaluated and REJECTED. The residual gap after admitter 1+2 contains no
 * such chain: the real misses are *variable-split* builders (the companion verb
 * lives in a prior statement, e.g. `const q = baseQuery.where(…)`), which
 * catalog resolution does not address. Gating on an under-discovered catalog
 * would just rebuild the receiver-name failure one layer up. See the
 * extraction-completeness gate (scripts/verify-extraction-completeness.ts) for
 * the pinned residual.
 *
 * @param node the candidate call node to classify
 * @param adapter the language adapter used to read the callee
 * @param sourceCode the file source text for reading callee text
 * @returns true when the call is query-builder shaped (chain companion or Prisma object form)
 */
export function isQueryBuilderShape(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  if (node.type !== 'call_expression') return false;
  const callee = getCallExpressionCallee(node, adapter);
  if (!callee) return false;
  const calleeText = stripComments(adapter.getNodeText(callee, sourceCode) ?? '');
  return hasChainCompanion(calleeText) || isPrismaObjectForm(node, adapter, sourceCode);
}

/**
 * The single admission seam for a candidate node: resolve its handle-ness through
 * `identifyHandle` (Spec 70 R1.2) and return the tri-state verdict, or `null`
 * when the node is not a query-shaped DB/ORM call in the TypeScript family.
 *
 * The candidate *filter* (a DB/ORM method, or a provenanced wrapper name) is
 * query-shape vocabulary — the same surface `isDBMethodCall` admitted — not a
 * handle test. Handle-ness is decided once, here: a `handle` verdict admits the
 * site (carrying `via`); `not-handle` rejects it; `unproven` admits it *as
 * unproven* (carrying the reason) so downstream rules see the site and report
 * `cannot-fire` rather than never seeing it. Admission is tri-state, not boolean.
 */
function handleVerdictForCall(
  node: ASTNode,
  scan: DataAccessScanContext,
): HandleVerdict | null {
  const { adapter, sourceCode, config, provenanceContext, handleEnv } = scan;
  if (!provenanceContext) return null;

  // Go: declaration resolution runs through Go's own binding/import environment
  // (provenance seed + bindings + imports), routed through the same
  // `identifyHandle` seam. `classifyGoRootIdentifier` checks the provenance seed
  // first, so a cross-file-resolved `db *sql.DB` proves `handle`; the seed also
  // carries the receiver's package, so an unrecognized import stays `unproven`
  // (cannot-fire) rather than being guessed `not-handle` (Spec 70 R4).
  if (adapter.name === 'go') {
    return goHandleVerdictForCall(node, scan);
  }

  if (!handleEnv) return null;

  // A template literal is admitted via the call whose argument it is.
  const callNode = isTemplateLiteral(node, adapter) ? enclosingCallOf(node, adapter) : node;
  if (!callNode || !isFunctionCall(callNode, adapter)) return null;

  // A constructor call (`new Pool()`) is an instantiation — how a handle is
  // *created* — not a data-access call itself. Its provenanced constructor
  // proves the *binding* (`const db = new Pool()`); the constructor expression
  // is never a query site, so admit nothing here. (Spec 70 R4)
  if (callNode.type === 'new_expression') return null;

  const callee = getCallExpressionCallee(callNode, adapter);
  if (!callee) return null;

  const dialect =
    resolveSiteDialect(callNode, adapter, sourceCode, provenanceContext) ??
    config.dialect ?? null;

  const facts = (): Parameters<typeof identifyHandle>[1] => ({
    imports: new Map(),
    typeAnnotations: new Map(),
    bindings: new Map(),
    withinFileProvenance: new Map(),
    sqlDialect: dialect,
    resolution: { dialect: 'ts', env: handleEnv },
  });

  // Bare-identifier call (`query(…)` / `d1(…)`): admit a provenanced wrapper or a
  // type-annotated handle (`const query: D1Database = …`), and let `identifyHandle`
  // decide handle / not-handle / unproven on the one entry point. A truly unbound
  // name (an ambient global like `someFunction`) is rejected here — not because its
  // name proves non-handle, but because its SQL argument must not be allowed to
  // *prove* handle-ness (R3) on a name with no DB signal at all. The candidate
  // filter is a DB/ORM *shape* test (provenance or an explicit type annotation),
  // never a handle decision.
  if (callee.type === 'identifier') {
    const name = adapter.getNodeText(callee, sourceCode);
    if (!name) return null;
    const binding = handleEnv.bindings.get(name);
    const isProvenanced = provenanceContext.dbProvenanced.has(name);
    const isTypeAnnotated =
      !!binding &&
      (binding.kind === 'variable' || binding.kind === 'field' || binding.kind === 'parameter') &&
      !!binding.typeText;
    // A named import from a manifest DB package (`import { eq } from
    // 'drizzle-orm'`) is a DB *signal* even when the name isn't a handle — it
    // must reach `identifyHandle` so it can be proven `not-handle`, not dropped
    // here on the negative for want of evidence (Spec 70 — a site that stops
    // being reported has to be proven not-a-handle).
    const isDbPackageImport =
      !!binding && binding.kind === 'import' && handleTypesForPackage(binding.source ?? '') !== undefined;
    if (!isProvenanced && !isTypeAnnotated && !isDbPackageImport) return null;
    return identifyHandle(
      {
        format: 'typescript',
        root: name,
        receiver: name,
        method: name,
        sqlArgument: extractStaticSql(callNode, adapter, sourceCode),
        thisField: false,
      },
      facts(),
    );
  }

  if (callee.type !== 'member_expression' && callee.type !== 'selector_expression') {
    return null;
  }

  const method = extractMemberExpressionProperty(callee, adapter, sourceCode);
  if (!method) return null;
  const root = resolveReceiverRoot(callee, adapter, sourceCode);
  if (root === null) return null;
  const sqlArg = extractStaticSql(callNode, adapter, sourceCode);
  const thisRooted = receiverIsThisRooted(callee, adapter);
  // Candidacy is the package discriminant — the receiver root's disposition, not
  // the method name (`join` is `Array.prototype.join` and also `SQL JOIN`). A
  // call is query-shaped when its receiver resolves handle/unproven, OR its
  // argument is a static SQL literal (which `identifyHandle`'s sql-argument arm
  // can prove). A provably non-DB receiver (JS global, primitive, Node builtin)
  // with no static SQL is rejected here. A `this.<field>` root is a field
  // reference, not an ambient global, so it stays `unproven` (admitted) rather
  // than dropped as a phantom global.
  if (sqlArg === null && !isDbShapedRoot(root, handleEnv, { thisField: thisRooted })) return null;
  const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? root;

  return identifyHandle(
    {
      format: 'typescript',
      root,
      receiver,
      method,
      sqlArgument: sqlArg,
      thisField: thisRooted,
    },
    facts(),
  );
}

/**
 * The Go arm of the admission seam: resolve a Go `selector_expression` call
 * (`db.Query(…)`) through `identifyHandle` with Go's own resolution environment,
 * instead of abstaining. Candidacy is a string-resolvable argument with a
 * query-shaped-method backstop for the no-argument case; handle-ness is then
 * decided once by the seam (`handle` via provenance seed, `unproven` via an
 * unrecognized package, `not-handle` via a non-DB binding), never by a name list
 * here.
 */
function goHandleVerdictForCall(
  node: ASTNode,
  scan: DataAccessScanContext,
): HandleVerdict | null {
  const { adapter, sourceCode, config, goEnv } = scan;
  if (!goEnv) return null;
  if (!isFunctionCall(node, adapter)) return null;

  const callee = getCallExpressionCallee(node, adapter);
  if (!callee || callee.type !== 'selector_expression') return null;

  const method = extractMemberExpressionProperty(callee, adapter, sourceCode);
  if (!method) return null;
  const root = resolveReceiverRoot(callee, adapter, sourceCode);
  if (root === null) return null;
  const sqlArg = extractGoStaticSql(node, adapter, sourceCode, goEnv);
  // Candidacy is the package discriminant — the receiver root's disposition, not
  // the method name. A call is query-shaped when its receiver resolves
  // handle/unproven, OR its argument is a static SQL literal (which
  // `identifyHandle`'s sql-argument arm can prove). A provably non-DB receiver
  // (stdlib package, primitive, non-DB binding) with no static SQL is rejected.
  if (sqlArg === null && classifyGoRootIdentifier(root, goEnv) === 'not-handle') return null;
  const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? root;

  return identifyHandle(
    {
      format: 'go',
      root,
      receiver,
      method,
      sqlArgument: sqlArg,
      thisField: false,
    },
    {
      imports: new Map(),
      typeAnnotations: new Map(),
      bindings: new Map(),
      withinFileProvenance: new Map(),
      sqlDialect: config.dialect ?? null,
      resolution: { dialect: 'go', env: goEnv },
    },
  );
}

/** Walk parents until an enclosing call/new expression, or null. */
function enclosingCallOf(node: ASTNode, adapter: LanguageAdapter): ASTNode | null {
  // A template literal is the SQL argument of a call only when it sits directly
  // in that call's argument list (`db.prepare(\`…\`)`). A literal nested inside an
  // arrow body, object literal, or array (`{ message: () => \`…is written (…)\` }`)
  // is prose/config, not a query — walking past those boundaries attributes it to
  // an unrelated enclosing call (`runUsageDirectionCheck(…, { message: … })`) and
  // lets human-readable text reach the SQL parser. Only the immediate `arguments`
  // admits the enclosing call; anything else is not a direct query argument.
  let cur = adapter.getParent(node);
  while (cur) {
    const t = adapter.getNodeType(cur);
    if (t === 'arguments') {
      const call = adapter.getParent(cur);
      return call && (adapter.getNodeType(call) === 'call_expression' || adapter.getNodeType(call) === 'new_expression')
        ? call
        : null;
    }
    // Tagged templates carry the literal as a direct child of the call (no
    // `arguments`), but they are admitted separately by `isTaggedTemplateSqlCall`,
    // never through this path — a literal not directly in `arguments` is not a
    // positional SQL argument.
    return null;
  }
  return null;
}

/** True when a receiver chain bottoms out at `this`/`super` (a field reference). */
function receiverIsThisRooted(callee: ASTNode, adapter: LanguageAdapter): boolean {
  let current: ASTNode = callee;
  while (current.type === 'member_expression' || current.type === 'selector_expression') {
    const children = adapter.getChildren(current);
    const firstChild = children.find(
      (c) => c.type !== '.' && c.type !== 'property_identifier' && c.type !== 'field_identifier',
    );
    if (!firstChild) return false;
    current = firstChild;
  }
  return current.type === 'this' || current.type === 'super';
}

/**
 * Predicate for the node-discovery pass of extractDatabaseCalls.  A node is a
 * candidate when it is a DB/ORM-method call whose receiver is handle-or-unproven,
 * a tagged-template SQL call, a variable assignment holding SQL-shaped text
 * (Spec 17 R2 — content scanning is removed in favour of provenance), or a
 * query-builder chain discovered by shape (Spec 68 Thing 2, #312).
 */
function isDbCallCandidate(
  node: ASTNode,
  scan: DataAccessScanContext,
  tagNames: readonly string[] = SQL_TAG_NAMES,
): boolean {
  const { adapter, sourceCode } = scan;

  // Spec 70 R1.2: a DB/ORM-method call whose receiver resolves handle-or-unproven.
  // `not-handle` (e.g. lodash `get`) and `null` (not query-shaped) are rejected.
  const verdict = handleVerdictForCall(node, scan);
  if (verdict !== null && verdict.kind !== 'not-handle') return true;

  // A query-builder chain is discovered by shape, not receiver name.
  if (isQueryBuilderShape(node, adapter, sourceCode)) {
    return true;
  }

  // Tagged-template SQL is a data-access call by tag name — no provenance needed.
  if (isTaggedTemplateSqlCall(node, adapter, sourceCode, tagNames)) {
    return true;
  }

  // Variable assignment whose RHS is a static string/template literal — the
  // string parses as a statement or it does not (Spec 70 R2 site #4, obviated):
  // the candidate check is now the presence of a static literal, and
  // `buildDatabaseCall` parses it. No SQL-keyword content scan here.
  if (isVariableAssignment(node, adapter)) {
    return extractStaticSql(node, adapter, sourceCode) !== null;
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

/** The explicit lowercased column list of a raw-SQL INSERT/REPLACE, or null for
 *  a positional INSERT (`INSERT INTO t VALUES (…)`, no column list). Mirrors
 *  sqlAst's `insertColumns` but preserves the null-vs-empty distinction the
 *  tenant-predicate rule needs.
 * @param sqlAst - The parsed SQL statement to read the column list from.
 * @returns The lowercased explicit column list, or `null` for a positional
 *   insert or a non-INSERT/REPLACE statement. */
export function rawInsertColumnsFromAst(sqlAst: SqlAst): string[] | null {
  if (sqlAst.type !== 'insert' && sqlAst.type !== 'replace') return null;
  const columns = (sqlAst as { columns?: unknown }).columns;
  if (!Array.isArray(columns)) return null;
  return columns.filter((c): c is string => typeof c === 'string').map((c) => c.toLowerCase());
}

/** The Kysely builder write verb carried as a camelCase method name — a
 *  host-language chain shape, not SQL.  `selectFrom`/`selectAll` are reads. */
export function builderWriteVerb(text: string): 'insert' | 'update' | 'delete' | null {
  if (/\.insertInto\s*\(/.test(text)) return 'insert';
  if (/\.updateTable\s*\(/.test(text)) return 'update';
  if (/\.deleteFrom\s*\(/.test(text)) return 'delete';
  return null;
}

/** True when an ORM chain carries a row-limiting shape (`.where(...)`, `.having(...)`,
 *  `.limit(...)`, `.andWhere(...)`, `.orWhere(...)`) — the host-language analog of
 *  SQL's WHERE/HAVING/LIMIT that the AST walk cannot see because there is no SQL. */
export function hasOrmFilterShape(text: string): boolean {
  return /\.(?:where|andWhere|orWhere|having|limit)\s*\(/.test(text);
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
  const { adapter, sourceCode, config, provenanceContext } = scan;
  const nodeText = stripComments(adapter.getNodeText(node, sourceCode));
  if (!nodeText || nodeText.trim().length < 10) return null;

  // Skip when a call_expression like db.prepare(`...`) is rediscovered via
  // its template argument (path 2) — the template string is the precise target.
  if (shouldSkipCallForTemplateArg(node, adapter)) return null;

  // The candidate's static SQL argument (unquoted), or null when it has none
  // or is dynamically interpolated.
  const sqlArg = extractStaticSql(node, adapter, sourceCode);

  // Spec 70 R2 — parse the static SQL once and derive every SQL-content fact from
  // the AST. The dialect is per-call-site (Spec 70): `pool.query(…)` where `pool`
  // resolves to `pg` parses as postgres even in a repo that also names `mysql2`;
  // the repo-level detection result is only the fallback when the receiver
  // doesn't resolve to a single-dialect package. R2 does not condition parsing on
  // proving the dialect, so when none resolves the static SQL is still attempted
  // under {@link DEFAULT_SQL_DIALECT}; a literal that parses yields its facts, and
  // only a genuine parse failure (under the resolved dialect, or the default with
  // the dialect undetermined) leaves the facts absent (`cannot-fire`).
  const siteDialect = resolveSiteDialect(node, adapter, sourceCode, provenanceContext);
  const dialect = siteDialect ?? config.dialect ?? null;
  const parsed = sqlArg !== null ? parseSql(sqlArg, dialect ?? DEFAULT_SQL_DIALECT) : null;
  const sqlOk = parsed && parsed.ok ? parsed : null;

  const isOrmCall = isOrmPattern(nodeText);
  const tagNames = config.sqlTagNames ?? SQL_TAG_NAMES;
  // A tagged-template SQL call (`sql\`…\`` / `this.sql\`…\``) is a SQL query by
  // tag name, whether its template is static or interpolated. Its static body
  // parses normally; an interpolated body is `cannot-fire` on the SQL facts but
  // is still the injection surface sql-injection-risk (site #11) reads.
  const isTaggedSqlCall = isTaggedTemplateSqlCall(node, adapter, sourceCode, tagNames);
  // A call is a SQL candidate when its static argument parsed as a statement, or
  // it sits in a SQL position — a handle-or-unproven receiver, a query-builder
  // chain, or a tagged template — regardless of whether its argument is static or
  // dynamically interpolated. A parse-failed static argument in a SQL position is
  // `cannot-fire` (facts absent), never silently dropped. (Spec 70 R2 — the
  // keyword name-list gate `containsSQLKeywords` is deleted from this decision: it
  // dropped keyword-less SQL like `PRAGMA`/`VACUUM`/`ANALYZE` that provenance
  // already establishes as SQL, the opposite of honest `cannot-fire`.)
  //
  // Spec 70 R1.2 — handle-ness is decided once, by `identifyHandle`, and the site
  // is admitted on the tri-state verdict: `handle` and `unproven` both admit (the
  // latter carrying its reason, recorded on the call below); only `not-handle`
  // rejects. `null` means "not a query-shaped DB/ORM call", not "not a handle" —
  // a type-annotated `db: D1Database` with a dynamic template argument now stays
  // visible instead of being dropped before the rules can see it.
  const handleVerdict = handleVerdictForCall(node, scan);
  const handleAdmits = handleVerdict !== null && handleVerdict.kind !== 'not-handle';
  const isSqlPosition = handleAdmits || isQueryBuilderShape(node, adapter, sourceCode);
  const isSqlQuery = sqlOk !== null || isSqlPosition || isTaggedSqlCall;

  if (!isSqlQuery && !isOrmCall) return null;

  const sqlAstNode = sqlOk ? sqlOk.ast : null;
  const builderVerb = sqlAstNode ? null : builderWriteVerb(nodeText);

  // Tables: SQL relations from the AST ∪ ORM-shaped references from the text.
  const sqlTables = sqlAstNode ? extractTableNames(sqlAstNode) : [];
  const ormTables = isOrmCall ? extractOrmTables(nodeText, config) : [];
  const tables = [...new Set([...sqlTables, ...ormTables])];

  // Row-limiting filter: SQL WHERE/HAVING/LIMIT from the AST, or the ORM chain
  // shape when there is no SQL to walk.
  const facts = sqlAstNode ? whereFacts(sqlAstNode) : null;
  const hasFilter = (facts
    ? (facts.hasWhere && !facts.whereIsTautology) || facts.hasHaving || facts.hasLimit
    : false)
    || (isOrmCall && hasOrmFilterShape(nodeText));

  const hasOrgFilter = hasOrganizationFilter(nodeText, config);

  const security = withRuleTiming('sql-injection-risk', () =>
    checkQuerySecurity(node, nodeText, ast, scan));

  // Spec 70 R4 — a sql-injection finding asserts the receiver is actually a DB
  // handle. `unproven` (resolution reached a declaration whose origin it cannot
  // tie to a database client, e.g. a Worker env binding like `D1Database`) is
  // `cannot-fire`: the site stays visible but no vulnerability is asserted. Only
  // a proven `handle` — a parsed SQL argument (R3) or a package in the manifest
  // (R4) — fires. A type name proves nothing under criterion 9, so there is no
  // type-annotation signal to consult.
  const injectionRisk = security.injectionRisk && handleVerdict?.kind === 'handle';

  const callType = classifyCallType(isSqlQuery, isOrmCall);

  return {
    type: callType,
    method: extractMethodName(node, adapter, sourceCode),
    file: ast.filePath,
    line: node.location.start.line,
    column: node.location.start.column,
    tables,
    queryText: nodeText,
    hasOrganizationFilter: hasOrgFilter,
    hasFilter,
    isWrite: sqlAstNode ? isWriteStatement(sqlAstNode) : builderVerb !== null,
    isMassWrite: sqlAstNode ? isMassWriteStatement(sqlAstNode) : builderVerb === 'update',
    isUpsert: sqlAstNode
      ? isUpsertStatement(sqlAstNode) || sqlOk?.conflictClauseTruncated === true
      : false,
    isRawInsert: sqlAstNode ? (sqlAstNode.type === 'insert' || sqlAstNode.type === 'replace') : false,
    insertColumns: sqlAstNode ? rawInsertColumnsFromAst(sqlAstNode) : null,
    sqlWhereColumns: sqlAstNode ? [...whereColumnRefs(sqlAstNode)] : null,
    hasParameterizedQuery: security.parameterized,
    hasSqlInjectionRisk: injectionRisk,
    sqlEscaped: security.escaped,
    enclosingFunction: enclosingIdentity(node, adapter, ast.filePath),
    resolvedWhere: resolveWhereBinding(node, sourceCode, adapter) ?? undefined,
    handleVerdict: handleVerdict ?? undefined,
  };
}

/**
 * Classify a SQL/ORM candidate as a broad call-type label: `sql` for a raw SQL
 * query, `orm` for a query-builder-shaped call, `unknown` otherwise. This is a
 * non-decision label (no rule reads it); the receiver's DB provenance — resolved
 * separately — is what decides whether the call is a data-access violation.
 */
function classifyCallType(isSqlQuery: boolean, isOrmCall: boolean): string {
  if (isSqlQuery) return 'sql';
  if (isOrmCall) return 'orm';
  return 'unknown';
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
  const { adapter, config } = scan;
  const tagNames = config.sqlTagNames ?? SQL_TAG_NAMES;
  const allNodes = adapter.findNodes(ast, {
    custom: (node) => isDbCallCandidate(node, scan, tagNames),
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
 * Analyze a database query.
 *
 * Spec 55 R5 — `performanceRisk` is the single driver for both query-shape rules:
 *   * `high`   → many tables (`complex-query`).  A subquery is NOT complex —
 *     it is an ordinary, well-optimized SQLite/D1 idiom (indexed `EXISTS`,
 *     `NOT IN`, correlated `COUNT(*)`, window functions), so it no longer
 *     contributes.  Only a genuinely join-heavy query is flagged.
 *   * `medium` → an unfiltered write (`unfiltered-query`).  See
 *     {@link isUnfilteredWrite}.
 */
function analyzeQuery(
  call: DatabaseCall,
  config: DataAccessAnalyzerConfig
): QueryAnalysis {
  const hasJoins = call.tables.length > 1;

  let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
  if (call.tables.length > 3) {
    complexity = 'complex';
  } else if (hasJoins) {
    complexity = 'moderate';
  }

  let performanceRisk: 'low' | 'medium' | 'high' = 'low';
  if (call.tables.length > (config.performanceThresholds?.joinedTableCount || 4)) {
    performanceRisk = 'high';
  } else if (isUnfilteredWrite(call) && call.tables.length > 0) {
    // Guard: a write must target a named table to be a meaningful mass-write.
    // A `DELETE`/`UPDATE` verb on a call that extracts no table (e.g. a plain
    // JS `this.update({...})` / `set.delete(x)`, or a Drizzle `db.delete(schema.t)`
    // whose table is a schema-object reference, not a string) is not a SQL mass
    // mutation — the old read-rule carried this same `tables.length > 0` guard
    // and the write-rule must too. (Spec 55 R5 fix.)
    performanceRisk = 'medium';
  } else if (isUnfilteredRead(call, config) && call.tables.length > 0) {
    // Read case (tenant-scoped): a filterless read of a tenant table.
    performanceRisk = 'medium';
  }

  return {
    complexity,
    tables: call.tables,
    hasJoins,
    hasOrganizationFilter: call.hasOrganizationFilter,
    hasFilter: call.hasFilter,
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
  const { filePath, config, symbolOrdinals, skipTestRules } = ctx;
  const violations: Violation[] = [];

  const symbol = nextSymbol(call.enclosingFunction ?? 'top-level', call.method ?? '', symbolOrdinals);
  const push = (message: string, opts: Omit<DataAccessViolationClassification, 'symbol'>) =>
    violations.push(makeViolation(filePath, { line: call.line, column: call.column }, message, { ...opts, symbol }));

  // Security: SQL injection.  Raw unescaped interpolation of input is a live
  // vulnerability now → `critical`.  Manual quote-escaping
  // (`.replace(/'/g, "''")`) is *defended* — single-quote doubling handles only
  // the single-quote vector, not backslash escapes or unicode quote variants —
  // so it downgrades to `high` ("verify escaping") rather than asserting a
  // certified vulnerability.
  if (config.checkSQLInjection && call.hasSqlInjectionRisk) {
    if (call.sqlEscaped) {
      push(`Interpolated SQL in ${call.method} — verify escaping is sufficient. Use parameterized queries.`, {
        severity: 'high',
        rule: 'sql-injection-risk',
        resolution: {
          action: 'parameterize',
          summary: `The SQL in ${call.method} interpolates a manually quote-escaped value. Quote-doubling defends only the single-quote case (not backslash escapes, unicode quote variants, or numeric/identifier positions) — replace the interpolation with a parameterized query (\`?\`, \`$1\`, or \`:name\`) for a full guarantee.`,
          symbols: [call.method ?? ''],
          files: [filePath],
          lines: [call.line],
        },
      });
    } else {
      push(`Potential SQL injection risk in ${call.method}. Use parameterized queries.`, {
        severity: 'critical',
        rule: 'sql-injection-risk',
        resolution: {
          action: 'parameterize',
          summary: `Replace the string-interpolated SQL in ${call.method} with a parameterized query — bind values via the driver's placeholder form (\`?\`, \`$1\`, or \`:name\`) instead of concatenating them into the statement.`,
          symbols: [call.method ?? ''],
          files: [filePath],
          lines: [call.line],
        },
      });
    }
  }

  // Security: Missing Organization Filter is now a Stage-4 derived reducer
  // (Spec 62 Amendment B) — it joins per-query facts against the declared +
  // DDL-discovered tenant tiers, which Stage 2 cannot read. The data-access
  // visitor emits the query facts (`DatabaseCall`) instead; the reducer fires
  // `missing-org-filter` at the same query-site location.

  // Performance: Complex Query — a join-heavy query (many tables).  Spec 55 R5:
  // a subquery alone is no longer "complex" — it is an ordinary SQLite/D1 idiom.
  if (analysis.performanceRisk === 'high') {
    push(`Query references ${call.tables.length} tables`, { severity: 'high', rule: 'complex-query' });
  }

  // Performance: Unfiltered Query — an unfiltered write (DELETE/UPDATE with no
  // row-limiting clause), the classic mass-mutation foot-gun.  Spec 55 R3: it is
  // a query-shape rule excluded from test files; R5: it is about writes now, not
  // reads (an unfiltered SELECT is often an intentional full-set load).
  if (!skipTestRules && analysis.performanceRisk === 'medium') {
    const kind = isUnfilteredWrite(call) ? 'write' : 'read';
    const subject = kind === 'read' ? `tenant table ${call.tables.join(', ')}` : call.tables.join(', ');
    push(`Unfiltered ${kind} on ${subject} has no WHERE/HAVING/LIMIT`, { severity: 'high', rule: 'unfiltered-query' });
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
      const fnName = enclosingIdentity(node, adapter, ast.filePath);
      const baseSym = `${fnName}:hardcoded-connection`;
      const count = (hardcodedOrdinals.get(baseSym) ?? 0) + 1;
      hardcodedOrdinals.set(baseSym, count);
      const sym = count > 1 ? `${baseSym}:${count}` : baseSym;

      violations.push(makeViolation(
        ast.filePath,
        node.location.start,
        'Hardcoded database connection string detected. Use environment variables. (On Cloudflare Workers/D1, connection strings are injected via bindings.)',
        { severity: 'critical', rule: 'hardcoded-connection', symbol: sym } // R7: direct-access → critical
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

/**
 * The node types that name a variable assignment whose RHS could be a static
 * SQL literal. The previous check compared against `variable_declaration` (TS
 * `var` only) and `binary_expression` (arithmetic/comparison — never an
 * assignment), so `const`/`let`/`:=` declarations and every reassignment were
 * dead. The type is the whole signal; `extractStaticSql` then reads the RHS.
 */
const VARIABLE_ASSIGNMENT_TYPES = new Set([
  // TS/JS
  'variable_declaration',   // var q = …
  'lexical_declaration',    // const/let q = …
  'variable_declarator',    // the declarator inside either
  'assignment_expression',  // q = …
  // Go
  'short_var_declaration',  // q := …
  'var_declaration',        // var q = …
  'var_spec',               // the spec inside var_declaration
  'assignment_statement',   // q = …
]);

function isVariableAssignment(node: ASTNode, adapter: LanguageAdapter): boolean {
  return VARIABLE_ASSIGNMENT_TYPES.has(adapter.getNodeType(node));
}

function containsSQLKeywords(text: string): boolean {
  const upperText = text.toUpperCase();
  return SQL_KEYWORDS.some(keyword => upperText.includes(keyword));
}

/**
 * Strip `//` line and `/* *`/ block comments from a source slice before SQL
 * analysis.  Comments inside a node's byte range (e.g. a doc comment placed
 * inside a `pgEnum(...)` array literal) otherwise leak prose words like
 * "from under the submission" into `containsSQLStructure`/`extractTables`,
 * fabricating a phantom table and an `unfiltered-query` finding.
 *
 * String/template-literal contents are preserved so a URL or a `//` inside a
 * quoted SQL string is not mangled — only comments proper are removed.
 */
function stripComments(text: string): string {
  if (!text) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  let quote: string | null = null; // ', ", or ` when inside a quoted span
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      // Line comment — drop until end of line.
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      // Block comment — drop until closing */
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
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
    // A nested template (`${cond ? \` WHERE x = ?\` : ''}`) is a fragment of its
    // enclosing query, not a query in its own right. Resolve it through the
    // substitution/outer-template chain to the enclosing call (as
    // `enclosingCallOf` does) so it inherits that call's parameterization —
    // `.query(sql, params)` / `.prepare().bind()` — instead of being re-read as
    // a bare interpolation whose direct parent is `template_substitution` (not
    // `arguments`) and therefore wrongly reported as raw injection ("in unknown").
    return enclosingCallOf(node, adapter);
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

/**
 * True when a member_expression is the `Promise.all` global, not a D1 `.all()`
 * call. `hasEagerMethodInCallChain` walks up an argument chain, so a
 * `Promise.all([db.prepare(x).bind(y)])` would otherwise mistake `Promise.all`'s
 * "all" property for the eager D1 read method (Spec 52 R1). `Promise` is the
 * only collision in the eager set — none of run/first/raw/exec/batch are
 * Promise methods.
 */
export function isPromiseAllMember(memberExpr: ASTNode, adapter: LanguageAdapter, sourceCode: string): boolean {
  if (memberPropertyName(memberExpr, adapter, sourceCode) !== 'all') return false;
  const objectNode = adapter.getChildren(memberExpr).find(
    c => adapter.getNodeType(c) !== 'property_identifier',
  );
  if (!objectNode) return false;
  const text = adapter.getNodeText(objectNode, sourceCode);
  return text === 'Promise' || text.endsWith('.Promise');
}

/**
 * Resolve a db-call node to its call_expression. A template_string db node (the
 * SQL argument) resolves to its enclosing call; a call_expression node is
 * returned as-is. Returns null when the node is neither.
 */
function resolveDbCallNode(node: ASTNode, adapter: LanguageAdapter): ASTNode | null {
  if (adapter.getNodeType(node) === 'template_string') {
    const args = adapter.getParent(node);
    if (!args || adapter.getNodeType(args) !== 'arguments') return null;
    const parentCall = adapter.getParent(args);
    if (!parentCall || adapter.getNodeType(parentCall) !== 'call_expression') return null;
    return parentCall;
  }
  if (adapter.getNodeType(node) === 'call_expression') return node;
  return null;
}

/**
 * The DB method a db-call node invokes, or null when the node is not a member
 * call. Identifier-wrapper calls (`query(...)`, `sql(...)`) have no member
 * callee and return null; a template_string db node resolves to its parent
 * call first.
 */
function dbCallMethodName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const call = resolveDbCallNode(node, adapter);
  if (!call) return null;
  const memberExpr = findMemberCallee(call, adapter);
  return memberExpr ? memberPropertyName(memberExpr, adapter, sourceCode) : null;
}

/**
 * DB methods that execute I/O immediately (as opposed to `.prepare()`/`.bind()`,
 * which only construct a statement object). Used to decide whether a
 * prepare/bind call is chained into an eager execution.
 *
 * `.get()` is the single-row read shared by better-sqlite3, `node:sqlite`, and
 * `bun:sqlite` that D1 does not expose (D1's closest is `.first()`). It was
 * absent, so `db.prepare(…).get(…)` in a loop was misread as statement
 * construction and skipped — the exact false negative the corpus pins at
 * `n-plus-one.ts:51`/`:62`. The wider driver-method gap (`.iterate()`, bun's
 * `.values()`) is documented in specs/rule-evidence-corpus/REPORT.md; it is
 * deliberately left out until it is measured, not silently dropped.
 */
const EAGER_DB_METHODS = new Set(['run', 'all', 'first', 'raw', 'exec', 'batch', 'query', 'get']);

/**
 * True when `node` (a `.prepare()`/`.bind()` call) is chained into an eager
 * method — e.g. `db.prepare(sql).bind(x).run()`. The `.run()` at the end of the
 * chain executes I/O on every loop iteration, so the whole chain is a genuine
 * N+1, not an accumulate-then-batch false positive. Walks up the enclosing
 * expression and stops at the statement boundary; a chain never crosses one.
 */
function hasEagerMethodInCallChain(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): boolean {
  const call = resolveDbCallNode(node, adapter);
  let cur = call ? adapter.getParent(call) : adapter.getParent(node);
  while (cur) {
    const type = adapter.getNodeType(cur);
    if (type === 'call_expression') {
      const memberExpr = findMemberCallee(cur, adapter);
      const name = memberExpr ? memberPropertyName(memberExpr, adapter, sourceCode) : null;
      if (name && EAGER_DB_METHODS.has(name) && !isPromiseAllMember(memberExpr!, adapter, sourceCode)) return true;
    }
    if (
      type === 'expression_statement' ||
      type === 'variable_declarator' ||
      type === 'return_statement' ||
      type === 'lexical_declaration' ||
      type === 'for_statement' ||
      type === 'for_in_statement' ||
      type === 'while_statement' ||
      type === 'statement_block' ||
      type === 'block'
    ) {
      break;
    }
    cur = adapter.getParent(cur);
  }
  return false;
}

/**
 * True when a db-call node is statement construction only — a `.prepare()` /
 * `.bind()` that is not chained into an eager method (`.run()` / `.all()` /
 * `.first()` / `.raw()` / `.exec()` / `.batch()` / `.get()`). Such a call
 * performs no I/O, so it is not a query-in-loop on its own (Spec 52 R1).
 */
function isStatementConstructionOnly(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): boolean {
  const method = dbCallMethodName(node, adapter, sourceCode);
  return (method === 'prepare' || method === 'bind') && !hasEagerMethodInCallChain(node, adapter, sourceCode);
}

/**
 * True when a db-call node is SQL-string construction inside a query compiler:
 * an ORM *builder* method (e.g. `aggregate`, `select`, `where` — never an eager
 * I/O method) invoked on an unprovenanced `this` receiver whose result is
 * accumulated into an array via `.push(...)`. knex's query compilers build SQL
 * exactly this way — `sql.push(...this.aggregate(stmt))` inside a
 * column-iteration loop — and the call returns a string fragment, not a query
 * result, so the loop is not an N+1 (Spec 52 R1 extension). Eager methods
 * (`run`/`all`/`exec`/`query`/…) are excluded, so a genuine
 * `results.push(db.query(...))` still fires.
 */
function isSqlStringConstruction(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const method = dbCallMethodName(node, adapter, sourceCode);
  if (!method || EAGER_DB_METHODS.has(method)) return false;
  if (!isOrmMethod(method)) return false;

  const call = resolveDbCallNode(node, adapter);
  if (!call) return false;
  const memberExpr = findMemberCallee(call, adapter);
  if (!memberExpr) return false;

  // The receiver must be an unprovenanced `this`/`super` — the query-compiler
  // object itself. `this.db.aggregate(...)` (receiver `this.db`) would be a real
  // ORM query on a provenanced `db`, not a compiler fragment.
  const objectText = memberObjectText(memberExpr, adapter, sourceCode);
  if (objectText !== 'this' && objectText !== 'super') return false;

  return isConsumedByArrayPush(call, adapter, sourceCode);
}

/** The object text of a member_expression (`this.aggregate` → `this`). */
function memberObjectText(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const object = adapter.getChildren(node).find((c) => {
    const t = adapter.getNodeType(c);
    return t !== 'property_identifier' && t !== 'field_identifier' && t !== '.';
  });
  return object ? adapter.getNodeText(object, sourceCode) : null;
}

/**
 * True when a call's result is consumed by an array `.push(...)` — the call is
 * an argument (possibly spread) of a `push` invocation. The accumulation
 * signature (`sql.push(...this.aggregate(stmt))`) marks the value as a string
 * fragment being collected, not a query result being read.
 */
function isConsumedByArrayPush(
  call: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  let cur = adapter.getParent(call);
  if (cur && adapter.getNodeType(cur) === 'spread_element') {
    cur = adapter.getParent(cur);
  }
  if (!cur || adapter.getNodeType(cur) !== 'arguments') return false;
  const pushCall = adapter.getParent(cur);
  if (!pushCall || adapter.getNodeType(pushCall) !== 'call_expression') return false;
  const pushMember = findMemberCallee(pushCall, adapter);
  return !!pushMember && memberPropertyName(pushMember, adapter, sourceCode) === 'push';
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
 * Detect eager execution methods called with bind parameters as a second
 * argument — D1's `.all()`/`.first()`/`.run()`, plus the parameterized
 * `.query()`/`.execute()` form shared by node-postgres/mysql2 and the tool's
 * own `IndexHandle`.
 *
 * `db.run(query, ...params)` is shorthand for
 * `db.prepare(query).bind(...params).run()`.  If there's a second argument
 * (the bind params), the call is fully parameterized and safe — the `${}`
 * interpolations in the SQL are structural (placeholder fragments, identifiers,
 * fixed value-lists), never bound values.
 *
 * `IndexHandle.query(sql, params)` (the tool's own parameterized index-query
 * abstraction, `src/types.ts`) is this exact contract: the interpolations carry
 * `?`-placeholder clauses (`${fp.clause}`, `${inList(types)}`) and `params`
 * binds the values out-of-band. A single-arg `.query(\`…${input}\`)` — the raw
 * injection shape — stays flagged because it carries no bind argument.
 */
function isD1ConvenienceCall(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const D1_CONVENIENCE = new Set(['all', 'first', 'run', 'query', 'execute']);

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
  // matching one of the wrapper names.  Use the shared callee extractor so an
  // `await fn<T>(...)` call — whose callee is an `await_expression` wrapping the
  // identifier, plus a `type_arguments` child — resolves the same way the
  // provenance detector does.  A naive `children.find(identifier)` misses it.
  const callee = getCallExpressionCallee(call, adapter);
  if (!callee || adapter.getNodeType(callee) !== 'identifier') return false;
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
export function isPrepareAssignedToVariable(
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

/**
 * JS built-in static `.from(...)` calls — array/buffer construction, NOT a SQL
 * FROM clause.  `Array.from(x)`, `Buffer.from(x)`, `Uint8Array.from(x)`, and
 * any `*Array.from(x)` are matched; without scrubbing these, `Array.from(
 * accessibleOrgIds)` is read as `.from(accessibleOrgIds)` and its argument is
 * extracted as a table, fabricating `unfiltered-query` findings.
 */
const JS_FROM_CALL = /\b(?:Buffer|String|[A-Za-z0-9_]*Array)\s*\.\s*from\s*\(/gi;

/**
 * Drizzle's `sql.join(fragments, separator)` joins SQL fragments, not tables.
 * Without scrubbing it, the ORM `join\s*\(` pattern reads its first argument
 * (`conditions`) as a table, fabricating `Query on conditions has no filter`.
 */
const SQL_FRAGMENT_JOIN = /\bsql\s*\.\s*join\s*\(/gi;

/** Blank out JS `.from(...)` construction and Drizzle `sql.join(...)` fragment
 *  joins so the table/ORM patterns below cannot read their arguments as tables. */
function scrubNonTableCalls(text: string): string {
  return text
    .replace(JS_FROM_CALL, (m) => ' '.repeat(m.length))
    .replace(SQL_FRAGMENT_JOIN, (m) => ' '.repeat(m.length));
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
    /\.distinct\s*\(/,
    // Kysely builder verbs (camelCase SQL — not matched by the SQL-keyword path).
    /\.selectFrom\s*\(/,
    /\.selectAll\s*\(/,
    /\.insertInto\s*\(/,
    /\.updateTable\s*\(/,
    /\.deleteFrom\s*\(/,
    /\.executeTakeFirst\s*\(/,
    /\.executeTakeFirstOrThrow\s*\(/,
    /\.onConflict\s*\(/,
    /\.returning\s*\(/
  ];

  return ormPatterns.some(pattern => pattern.test(scrubNonTableCalls(text)));
}

/** Add capture-group 1 of every match of `patterns` to `tables`. */
function collectPatternTables(
  text: string,
  patterns: RegExp[] | undefined,
  tables: Set<string>,
): void {
  patterns?.forEach(pattern => {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) tables.add(match[1]);
    }
  });
}

/**
 * Extract the set of table names referenced by the ORM chain shapes — the
 * configured `orm` table patterns plus the `.from(...)` /
 * `db.<table>.<method>()` / Kysely builder-verb shapes. This is the
 * host-language shape detector only; SQL relations are derived structurally by
 * sqlAst's `extractTableNames`, not here (Spec 70 R2 site #1).
 * @param text The ORM/query-builder fragment to scan.
 * @param config The data-access analyzer config holding table patterns.
 * @returns The set of table names referenced by ORM shapes.
 */
export function extractOrmTables(text: string, config: DataAccessAnalyzerConfig): string[] {
  // JS `.from(...)` construction (Array.from / Buffer.from / Uint8Array.from)
  // and Drizzle `sql.join(...)` are not SQL table references; blank them out
  // first so their arguments aren't read as tables.
  const scrubbed = scrubNonTableCalls(text);
  const tables = new Set<string>();

  collectPatternTables(scrubbed, config.tablePatterns?.orm, tables);

  // Handle patterns like db.select().from(users) where 'users' is a variable
  const ormVariablePattern = /\.from\s*\(\s*([\p{L}_][\p{L}\p{N}_]*)\s*\)/gu;
  for (const match of scrubbed.matchAll(ormVariablePattern)) {
    if (match[1] && !match[1].includes('"') && !match[1].includes("'")) {
      tables.add(match[1]);
    }
  }

  // Kysely builder verbs carry the table as their first string arg:
  // selectFrom('users') / deleteFrom('users') / insertInto('users') /
  // updateTable('users'). The SQL-keyword path can't see camelCase verbs.
  const kyselyTablePattern = /\.(?:selectFrom|deleteFrom|insertInto|updateTable)\s*\(\s*["'`]?([\p{L}\p{N}_]+)["'`]?\s*\)/giu;
  for (const match of scrubbed.matchAll(kyselyTablePattern)) {
    if (match[1]) tables.add(match[1]);
  }

  // Handle patterns like db.users.find() or db.orders.findOne()
  const dbTablePattern = /db\.([\p{L}_][\p{L}\p{N}_]*)\.\p{L}[\p{L}\p{N}_]*\s*\(/gu;
  for (const match of scrubbed.matchAll(dbTablePattern)) {
    if (match[1]) {
      tables.add(match[1]);
    }
  }

  return Array.from(tables);
}

/**
 * True when a call should be surfaced by the `unfiltered-query` rule (Spec 55
 * R5, Spec 56 R1): a mass-write statement (`UPDATE … SET`) with no row-limiting
 * clause.  The write/upsert facts are AST-derived (Spec 70 R2 sites #2/#3): a
 * Kysely `updateTable` builder verb is folded into `isWrite`/`isMassWrite` by
 * the producer (host-language shape, not SQL).  `DELETE FROM t` is not a mass
 * write (disposition (a)); an upsert is keyed by construction, so it never fires.
 */
function isUnfilteredWrite(call: DatabaseCall): boolean {
  return !call.isUpsert
    && call.isMassWrite
    && !call.hasFilter;
}

/**
 * True when a call should be surfaced by the `unfiltered-query` rule's *read*
 * case: a filterless read (`SELECT *` with no WHERE/HAVING/LIMIT) against a
 * table that carries declared tenancy.  A filterless full-table read of a
 * tenant table is the same tenant-leak surface the write rule guards — it
 * sweeps every tenant's rows.  Non-tenant tables (lookups, config) stay out of
 * scope.  Reuses `requiresOrgFilter` for the tenancy determination so the write
 * case and this read case cannot drift to two different tenancy definitions.
 */
function isUnfilteredRead(call: DatabaseCall, config: DataAccessAnalyzerConfig): boolean {
  return !call.hasFilter
    && !call.isWrite
    && requiresOrgFilter(call.tables, config);
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
  wrapperNames: string[],
): boolean {
  if (isInPrepareBindChain(node, adapter, sourceCode)) return true;
  if (isInExecChain(node, adapter, sourceCode)) return true;
  if (isD1ConvenienceCall(node, adapter, sourceCode)) return true;
  if (isWrapperFunctionWithBindParams(node, adapter, sourceCode, wrapperNames)) return true;
  return false;
}

/**
 * The effective set of DB-wrapper names the FP guards recognize as
 * parameterized.  This is the union of the static `config.dbWrapperNames`
 * (d1Query, d1Exec) and the names the provenance detector *learned* at
 * file-scan time (`reason: 'wrapper'` — e.g. a bare `d1(sql, params)` D1 REST
 * helper).  Keeping the two in sync is what prevents a wrapper the detector
 * already treats as DB-bound from being re-flagged as raw interpolation by
 * `checkQuerySecurity`.
 */
function effectiveWrapperNames(scan: DataAccessScanContext): string[] {
  const staticNames = scan.config.dbWrapperNames ?? [];
  const learned = scan.provenanceContext
    ? [...scan.provenanceContext.dbProvenanced.values()]
        .filter(ev => ev.reason === 'wrapper')
        .map(ev => ev.identifier)
    : [];
  return [...new Set([...staticNames, ...learned])];
}

/**
 * True when a single dynamic interpolation part is provably safe — via a
 * config-driven sanitizer allowlist, the adapter's cross-function safety
 * analysis, or a static-constant resolution for bare identifiers.  Otherwise
 * the part counts as unresolved (a candidate injection).
 */
export function isSafeDynamicPart(
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

/**
 * The tagged-template call node when `node` is (or wraps) a drizzle `sql`/`db`
 * tagged template; null otherwise. Handles both candidate shapes: a bare
 * `sql\`…\`` (the candidate node IS the tag) and `db.execute(sql\`…\`)` (the
 * tag is the enclosing call's argument).
 */
function findTaggedTemplateCall(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  tagNames: readonly string[],
): ASTNode | null {
  if (isTaggedTemplateSqlCall(node, adapter, sourceCode, tagNames)) return node;
  const args = adapter.getChildren(node).find((c) => adapter.getNodeType(c) === 'arguments');
  if (!args) return null;
  for (const arg of adapter.getChildren(args)) {
    const t = adapter.getNodeType(arg);
    if (t === '(' || t === ')' || t === ',') continue;
    if (isTaggedTemplateSqlCall(arg, adapter, sourceCode, tagNames)) return arg;
  }
  return null;
}

/**
 * True when `node` is (or wraps) a drizzle `sql`/`db` tagged template whose
 * `${…}` interpolations are all bare identifiers — the parameterized-by-
 * construction form. Drizzle's `sql` tag turns a clean `${id}` into a `?`
 * placeholder, so a bare-identifier interpolation is not an injection vector.
 *
 * A non-identifier interpolation — string concatenation (`${'%' + x + '%'}`), a
 * call (`${fn(x)}`), a member access (`${session.id}`) — is raw assembly, NOT a
 * bound parameter, so it is deliberately excluded and falls through to the
 * dynamic-string construction path (§69 Fix 2).
 */
function isParameterizedTaggedTemplate(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  tagNames: readonly string[],
): boolean {
  const tagCall = findTaggedTemplateCall(node, adapter, sourceCode, tagNames);
  if (!tagCall) return false;
  const template = adapter.getChildren(tagCall).find((c) => isTemplateLiteral(c, adapter));
  if (!template) return false;
  for (const child of adapter.getChildren(template)) {
    if (adapter.getNodeType(child) !== 'template_substitution') continue;
    const inner = adapter.getChildren(child).find(
      (c) => adapter.getNodeType(c) !== 'template_substitution',
    );
    if (!inner || adapter.getNodeType(inner) !== 'identifier') return false;
  }
  return true;
}

function checkQuerySecurity(
  node: ASTNode,
  text: string,
  ast: AST,
  scan: DataAccessScanContext,
): { parameterized: boolean; injectionRisk: boolean; escaped: boolean; message?: string } {
  const { adapter, sourceCode, config } = scan;

  // Parameterized chains (.prepare().bind(), .exec() spread, D1 convenience,
  // DB wrappers) and explicit parameterization are always safe.
  if (isParameterizedByChain(node, adapter, sourceCode, config, effectiveWrapperNames(scan))) {
    return { parameterized: true, injectionRisk: false, escaped: false };
  }
  // A drizzle `sql`/`db` tagged template parameterizes bare `${id}` interpolations
  // into `?` placeholders by construction — the "right reason" a clean tagged
  // template is quiet (§69 Fix 2), not the broken recursion that used to hide it.
  if (isParameterizedTaggedTemplate(node, adapter, sourceCode, config.sqlTagNames ?? SQL_TAG_NAMES)) {
    return { parameterized: true, injectionRisk: false, escaped: false };
  }
  if ((config.securityPatterns?.parameterizedQueries || []).some(p => text.includes(p))) {
    return { parameterized: true, injectionRisk: false, escaped: false };
  }

  // No dynamic-string capability → can't prove unsafe; err quiet.
  if (!adapter.isDynamicStringConstruction || !adapter.getDynamicParts) {
    return { parameterized: false, injectionRisk: false, escaped: false };
  }
  // Only a dynamically-constructed string carrying SQL keywords can inject.
  if (!adapter.isDynamicStringConstruction(node) || !containsSQLKeywords(text)) {
    return { parameterized: false, injectionRisk: false, escaped: false };
  }

  const unresolved = adapter.getDynamicParts(node, sourceCode)
    .filter(part => !isSafeDynamicPart(part, ast, scan));
  if (unresolved.length === 0) {
    return { parameterized: false, injectionRisk: false, escaped: false };
  }

  // Manual quote-escaping (`.replace(/'/g, "''")`) is defended, not raw — every
  // unresolved part being quote-escaped downgrades the finding to high.
  const escaped = unresolved.every(part =>
    !!part.node && !!adapter.isEscapedInterpolation && adapter.isEscapedInterpolation(part.node, ast, sourceCode),
  );

  return {
    parameterized: false,
    injectionRisk: true,
    escaped,
    message: `Cannot protect interpolated content: ${unresolved.map(part => '${' + part.text + '}').join(', ')}`,
  };
}

function extractCallExpressionMethod(
  callExpr: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  // Walk the AST to the callee and read the method name as a node. The name is
  // `property_identifier` on a `member_expression` (or `field_identifier` on a Go
  // `selector_expression`); a bare `identifier` callee is a named function call.
  // There is no shape where scanning the call text for `name(` is the right
  // answer — an unrecognised callee shape is "no method name" (null), never a
  // guessed name. `getCallExpressionCallee` recurses through `await_expression`
  // and stops before `arguments`, so a keyword inside a template-literal argument
  // is never read as the name.
  const callee = getCallExpressionCallee(callExpr, adapter);
  if (!callee) return null;
  const calleeType = adapter.getNodeType(callee);
  if (calleeType === 'member_expression') {
    const prop = adapter.getChildren(callee).find(
      c => adapter.getNodeType(c) === 'property_identifier',
    );
    return prop ? adapter.getNodeText(prop, sourceCode) : null;
  }
  if (calleeType === 'selector_expression') {
    const field = adapter.getChildren(callee).find(
      c => adapter.getNodeType(c) === 'field_identifier',
    );
    return field ? adapter.getNodeText(field, sourceCode) : null;
  }
  if (calleeType === 'identifier') {
    return adapter.getNodeText(callee, sourceCode);
  }
  if (calleeType === 'call_expression') {
    return extractCallExpressionMethod(callee, adapter, sourceCode);
  }
  return null;
}

function extractMethodName(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
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
    return null;
  }

  if (nodeType === 'call_expression') {
    return extractCallExpressionMethod(node, adapter, sourceCode);
  }

  // Any other node shape has no callee to walk to: there is no method name. The
  // site abstains (null) rather than scanning the node's text for a `name(` that
  // would turn "I don't recognise this shape" into a confident wrong name.
  return null;
}

/**
 * Spec 21 R6.2 (reworked for Spec 44 — rule authenticity, and Spec 62 Amendment
 * B): declared-tenancy org-filter detection, keyed on *declared* tenancy rather
 * than a guessed English name. This is the *config-only* tenancy determination
 * used by the Stage-2 `unfiltered-query` read case — a query-shape rule that
 * stays at Stage 2 and therefore cannot read the Stage-3 DDL table catalog.
 *
 *   Tier 1 (config-primary): `orgFilterTables` — the user's explicit list of
 *     multi-tenant tables. Tenancy is policy; this is the declaration of record.
 *   Tier 2 (schema-inference): a configured schema table carrying a column that
 *     matches `orgFilterColumns` (default org_id/tenant_id/organization_id/
 *     workspace_id). Makes non-English table names (e.g. 注文) detectable with
 *     zero explicit orgFilterTables declaration.
 *
 * The DDL-discovered tier (Tier 3) is deliberately NOT read here: it lives at
 * Stage 3, and this function serves a Stage-2 rule. The full three-tier
 * predicate (Tier 3 included) lives in {@link buildOrgFilterTierSet} +
 * {@link tableRequiresOrgFilter} and is consumed by the Stage-4
 * `missing-org-filter` reducer.
 *
 * The old Tier 3 — a hardcoded English fallback list (`users`, `projects`,
 * `orders`, `customers`, `accounts`, `teams`) — was dishonest: it accused
 * queries on those tables of missing a tenant filter even when the project
 * declared no such tenancy (a `users` table with no org column is a legitimate
 * single-tenant table). It is deleted: a table requires an org filter only
 * when tenancy is *declared*, never when its name happens to be in an English
 * word list.
 */
function requiresOrgFilter(tables: string[], config: DataAccessAnalyzerConfig): boolean {
  return tableRequiresOrgFilter(tables, buildOrgFilterTierSet(config, undefined));
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
 * LLM provider / SDK namespaces. A callee whose text carries one of these is
 * an unambiguous LLM/agent invocation (e.g. `gatewayDeepseekModel`,
 * `anthropic.messages.create`, `openai.chat`).
 */
const LLM_PROVIDER_RE =
  /(?:anthropic|openai|deepseek|claude|gpt|gemini|cohere|mistral|bedrock|vertex|ollama|llm|gateway)/i;

/**
 * LLM action verbs — AI SDK methods and the wrapper names that survive the
 * provider-token check (e.g. `aiEmbed`, `chatCompletion`, `thesisEngine`).
 * Deliberately narrower than `generate`/`extract` (those collide with ordinary
 * helpers like `insertSingleGeneratedBuild`); the provider namespace and the
 * model-client argument signal cover the rest.
 */
const LLM_ACTION_RE =
  /(?:embed|reembed|completion|chat|prompt|synthesize|thesis|agent|classify|summarize|translate)/i;

/**
 * Identifier names that denote an LLM/model client when they appear as a call
 * argument (e.g. `extractBuildsFromCorpus(db, model, …)`) or as the object of a
 * member callee (e.g. `model.chat(…)`). Deliberately excludes `client`/`ai`
 * (ambiguous — a DB client is also a `client`) so we never suppress a real N+1
 * on a generic variable name.
 */
const LLM_CLIENT_ARG_NAMES = new Set([
  'model', 'llm', 'embedder', 'gateway',
  'anthropic', 'openai', 'deepseek', 'claude', 'gpt', 'gemini', 'cohere', 'mistral', 'bedrock',
]);

/**
 * Message-lifecycle methods a queue consumer invokes per message (`msg.ack()`,
 * `msg.retry()`, `msg.nack()`, …). A loop whose body acknowledges or retries the
 * item it iterates over is a queue-consumer message loop: each message is an
 * independent job that must be acked/nacked/retried in isolation, so a
 * per-iteration query is the contract, not a batchable N+1. Batching or joining
 * would regress the retry semantics. `ack`/`nack`/`acknowledge`/`deleteMessage`
 * are unambiguous queue vocabulary; `retry` is queue-contextual (a lone
 * `.retry()` inside a collection loop is overwhelmingly a per-item queue retry).
 */
const MESSAGE_LIFECYCLE_METHODS = new Set(['ack', 'nack', 'acknowledge', 'deleteMessage', 'retry']);

/**
 * One loop-query candidate: a loop whose body issues a DB call, with every
 * signal the finding needs pre-computed. The `loop-queries` producer projects
 * this into its fact; the legacy `checkLoopQueries` maps it to a violation.
 */
export interface LoopQueryCandidate {
  file: string;
  line: number;
  column: number;
  symbol: string;
  loopLine: number;
  depth: number;
}

/**
 * R4.1: Find database queries inside loops and flag them as N+1 risks.
 * Each finding carries the query call location (never line 1).
 */
function checkLoopQueries(
  ast: AST,
  scan: DataAccessScanContext,
): Violation[] {
  return collectLoopQueryCandidates(ast, scan).map((c) => {
    const depthMsg = c.depth > 1 ? ` (nested ${c.depth} levels deep)` : '';
    return makeViolation(
      c.file,
      { line: c.line, column: c.column },
      `Database query inside loop${depthMsg} ` +
      `(loop at line ${c.loopLine}). ` +
      `This may cause N+1 performance issues. Consider batching queries or using a join.`,
      { severity: 'severe', rule: 'loop-query', symbol: c.symbol },
    );
  });
}

/**
 * R4.1: the candidate-collection half of `checkLoopQueries`, factored out so the
 * `loop-queries` producer projects the same loop→query candidates without
 * producing violations. Dedup (one candidate per loop, anchored at the first
 * query) and the LLM/queue suppression live here — they need the AST.
 */
function collectLoopQueryCandidates(
  ast: AST,
  scan: DataAccessScanContext,
): LoopQueryCandidate[] {
  const { adapter, sourceCode } = scan;
  const candidates: LoopQueryCandidate[] = [];

  // Spec 21: provenance-gated detection of database calls.
  const dbNodes = adapter.findNodes(ast, {
    custom: (node) => isDbCallNode(node, scan),
  });

  const reported = new Set<string>();
  const loopOrdinals = new Map<string, number>();

  // §13.1: functions/methods this file invokes inside a `db.transaction(fn)`
  // callback have their writes already batched by the caller's transaction (see
  // the helper) — provided their statements were prepared outside the loop.
  const transactionWrappedFunctions = collectTransactionWrappedFunctions(ast, adapter, sourceCode);

  for (const node of dbNodes) {
    // A DB call and its template-literal SQL argument both satisfy isDbCallNode —
    // the call via provenance, the literal via the template-literal branch — so one
    // query site (`db.prepare(`…`)`) would otherwise emit two findings, one at the
    // call line and one at the SQL line. Collapse to the call node: it is always
    // present when its literal is (isDbCallNode only admits a literal whose
    // enclosing call is itself provenanced), so skipping the literal loses nothing.
    if (isTemplateLiteral(node, adapter)) continue;

    const nodeText = adapter.getNodeText(node, sourceCode);
    if (!nodeText || nodeText.trim().length < 10) continue;

    // Spec 52 R1 — skip statement construction (prepare/bind with no eager call);
    // an eager call or a prepare chained into one still fires.
    if (isStatementConstructionOnly(node, adapter, sourceCode)) continue;

    // Spec 52 R1 (extension) — skip SQL-string construction inside a query
    // compiler: an ORM builder method (e.g. `aggregate`) on an unprovenanced
    // `this` whose result is accumulated via `.push(...)` returns a string
    // fragment, not a query result (knex `sql.push(...this.aggregate(stmt))`).
    if (isSqlStringConstruction(node, adapter, sourceCode)) continue;

    const loopInfo = findEnclosingLoop(node, adapter, sourceCode);
    if (!loopInfo) continue;

    // §13.3 (for-of-iterable discriminator): a DB call in the iterable/header of
    // a `for…of` loop — `for (const c of loadCatalog())` where `loadCatalog`
    // memoizes a single `indexHandle.query` — is evaluated once to produce the
    // iterated array, then the body iterates it in memory. That is not
    // per-iteration I/O, so it is not an N+1 — the same subject-vs-callback
    // distinction `isIteratorCallback` draws for `db.all().map(…)`. (A DB call in
    // the *body* still fires; only the header position is exempted.)
    if (isForOfIterableDbCall(node, loopInfo.loopNode, adapter)) {
      continue;
    }

    // §13.1 (hoisted-reuse discriminator): a prepared statement executed inside a
    // loop is not an N+1 when the statement is prepared *outside* the loop — the
    // loop re-runs one compiled statement with bound parameters, which is exactly
    // the "batch the queries" remediation the finding would prescribe, so flagging
    // it is a false positive. Two shapes of "prepared outside the loop" are
    // recognized, both keyed on the *prepare* (a relation between two located
    // facts), never on a property of the call shape:
    //   (1) transaction-batched — the loop is enclosed by a single
    //       `db.transaction(fn)` callback (lexically, or via a helper invoked
    //       inside it), so every write defers to one commit;
    //   (2) hoisted re-run without a transaction — the loop re-runs a statement
    //       object prepared outside it (`const stmt = db.prepare(…);
    //       for (…) stmt.run(x)` or `stmt.bind(x).run()`). The in-loop call must
    //       be a member call whose base identifier is bound to a `.prepare()`
    //       result declared *outside* the loop (see `isHoistedStatementReRun`).
    // Both require the loop body to NOT `.prepare(...)` per iteration — a loop that
    // still calls `.prepare(...)` re-prepares every pass and remains a genuine N+1,
    // so it keeps firing. Crucially, shape (2) does NOT key on "no SQL string
    // argument": an ORM builder chain (`db.select().from(…).where(…)`,
    // `prisma.user.findUnique({ where: … })`) and a connection call whose SQL is a
    // hoisted variable both carry no SQL literal, yet the builder is a genuine
    // per-iteration N+1 and the receiver is not prepare-bound, so neither is a
    // statement re-run — they keep firing. (A per-iteration
    // `db.transaction(() => …)` *inside* the loop also still fires — that does not
    // wrap the loop, and each iteration commits separately.)
    const enclosingFnName = findEnclosingFunctionIdentity(
      loopInfo.loopNode,
      adapter,
      ast.filePath,
    ).name;
    const transactionEnclosesLoop =
      isInsideDbTransaction(loopInfo.loopNode, adapter, sourceCode) ||
      (enclosingFnName !== null && transactionWrappedFunctions.has(enclosingFnName));
    const preparesInLoop = loopBodyContainsPrepare(loopInfo.loopNode, adapter, sourceCode);
    const hoistedReuse =
      !preparesInLoop &&
      (transactionEnclosesLoop ||
        isHoistedStatementReRun(node, loopInfo.loopNode, adapter, sourceCode));
    if (hoistedReuse) {
      continue;
    }

    // §13.2 (per-batch binding discriminator): a DB call whose bound parameters
    // are a *spread of a collection-derived expression* (a `.slice()`/`.map()`/
    // chunk of the iterated set) executes one statement per batch, not per row —
    // a chunked `id IN (…)` write is not an N+1 at any chunk size. Only a scalar
    // or property read off a single loop element (`run(row.id)`) is per-row. See
    // `bindsBatchArgument`.
    if (bindsBatchArgument(node, loopInfo.loopNode, adapter, sourceCode)) {
      continue;
    }

    // R4.1 (Spec 46): LLM-pipeline discriminator. A loop whose body invokes an
    // LLM/agent (embedding, model completion, corpus extraction) is an intentional
    // *sequential pipeline* — its per-item DB calls are persistence steps gated by
    // rate limits and per-item crash-recovery, not a batchable N+1. Batching or
    // joining would regress those semantics, so suppress the finding rather than
    // emit an unfixable `severe`.
    if (loopBodyContainsLlmCall(loopInfo.loopNode, adapter, sourceCode)) continue;

    // R4.1 (queue consumer): a loop whose body acks/nacks/retries the message it
    // iterates over is a queue consumer, not a batchable N+1. Each message is an
    // independent job that must ack/retry in isolation, so batching or joining the
    // per-iteration queries would break the retry contract — suppress the finding.
    if (loopBodyContainsMessageLifecycleCall(loopInfo.loopNode, adapter, sourceCode)) continue;

    // R4.1: one finding per *loop*, not per query — an N+1 is a property of the
    // loop, so a loop issuing several queries is still one violation (defect #51).
    // Key on the loop node's start byte offset so distinct loops (including
    // nested ones) never collapse, while every query in the same loop dedups to
    // the first. The finding anchors to that first query's location below.
    const dedupKey = String(loopInfo.loopNode.range[0]);
    if (reported.has(dedupKey)) continue;
    reported.add(dedupKey);

    const sym = nextSymbol(enclosingIdentity(node, adapter, ast.filePath), 'loop-query', loopOrdinals);

    // Anchor to the resolved callee, not the raw node. For `await db.prepare(…)
    // .bind(…).all<T>(…)` tree-sitter emits an OUTER call_expression at the `await`
    // keyword (its function is an await_expression wrapping the chain) alongside the
    // inner call at `db`. Parent-before-child traversal hands the outer node to this
    // loop first, so the caret would land on `await` instead of the query. Resolving
    // the callee (which already recurses through await_expression) re-anchors to the
    // `db` receiver; for every non-await shape the callee starts at the same column
    // as the node, so nothing else moves.
    const anchor = getCallExpressionCallee(node, adapter) ?? node;

    candidates.push({
      file: ast.filePath,
      line: anchor.location.start.line,
      column: anchor.location.start.column,
      symbol: sym,
      loopLine: loopInfo.loopNode.location.start.line,
      depth: loopInfo.depth,
    });
  }

  return candidates;
}

/**
 * R4.1 (Spec 46): True when the loop's subtree contains an LLM/agent invocation.
 * Used as the discriminator between a batchable N+1 (no LLM call — the queries
 * should be batched/joined) and an intentional sequential pipeline (an LLM call
 * — the per-item DB calls are persistence steps behind rate limits and
 * crash-recovery). Walking the whole loop subtree (header + body) is safe: a
 * loop header rarely hosts an LLM call, and a body-level one is exactly the
 * signal we want.
 */
function loopBodyContainsLlmCall(
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  let found = false;
  walkSubtree(loopNode, adapter, (node) => {
    if (found || adapter.getNodeType(node) !== 'call_expression') return;
    if (isLlmCallNode(node, adapter, sourceCode)) found = true;
  });
  return found;
}

/**
 * R4.1 (queue consumer): True when the loop's subtree contains a
 * message-lifecycle call — a member call whose property is a queue lifecycle
 * method (`ack`, `nack`, `acknowledge`, `deleteMessage`, `retry`). The signature
 * of a queue consumer (`for (const msg of batch.messages) { …; msg.ack(); }`)
 * marks per-message independent jobs, not a batchable N+1. Walking the whole loop
 * subtree is safe: the header (`batch.messages`) carries no lifecycle property,
 * and a body-level `msg.ack()`/`msg.retry()` is exactly the signal we want.
 */
function loopBodyContainsMessageLifecycleCall(
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  let found = false;
  walkSubtree(loopNode, adapter, (node) => {
    if (found || adapter.getNodeType(node) !== 'member_expression') return;
    const prop = memberPropertyName(node, adapter, sourceCode);
    if (prop && MESSAGE_LIFECYCLE_METHODS.has(prop)) found = true;
  });
  return found;
}

/**
 * §13.1 (prepare-outside-loop guard): true when the loop's subtree issues a
 * `.prepare(...)` call — i.e. the statement is (re)built on every iteration, not
 * prepared once outside the loop. This is the second half of the
 * transaction-batched discriminator: a loop wrapped in a transaction is only a
 * non-N+1 when it reuses a statement prepared outside; a per-iteration
 * `db.prepare(sql).run(…)` (or `const stmt = db.prepare(…); stmt.run(…)`) still
 * re-prepares every pass and remains a genuine N+1 under a transaction. Walking
 * the whole loop subtree (header + body) is safe: a `.prepare` is only ever in
 * the body, never the header.
 */
function loopBodyContainsPrepare(
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  let found = false;
  walkSubtree(loopNode, adapter, (node) => {
    if (found || adapter.getNodeType(node) !== 'call_expression') return;
    if (dbCallMethodName(node, adapter, sourceCode) === 'prepare') found = true;
  });
  return found;
}

/**
 * §13.1 (hoisted-reuse discriminator, non-transaction shape): true when the
 * in-loop DB call re-runs a statement object prepared *outside* the loop —
 * `const stmt = db.prepare(…); for (…) stmt.run(x)` or `stmt.bind(x).run()`.
 *
 * The signal is the *prepare* — a relation between two located facts — not a
 * property of the call shape. The in-loop eager call's member chain must be
 * rooted at an identifier (`stmt`) that is declared, in an enclosing scope
 * *outside* the loop, with a `.prepare()` initializer. An ORM builder chain
 * (`db.select().from(…).where(…)`, `prisma.user.findUnique({ where: … })`),
 * a direct connection call (`db.exec("…")`), a bare DB-provenanced helper
 * (`resolveHero(db, slug)`), and a Map/Array method that provenance over-matched
 * (`counts.get(x)`, `adjudication.find(x)`) are all rooted at an identifier that
 * is NOT prepare-bound, so none of them reads as a statement re-run and each
 * keeps firing.
 */
function isHoistedStatementReRun(
  node: ASTNode,
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const base = memberChainBaseIdentifier(node, adapter, sourceCode);
  if (base && identifierBoundToPrepareOutsideLoop(base, loopNode, adapter, sourceCode)) {
    return true;
  }
  return isBarePrepareBoundHelperCall(node, loopNode, adapter, sourceCode);
}

/**
 * §13.1 (hoisted-reuse discriminator, bare-wrapper shape): true when the in-loop
 * DB call is a bare local-helper invocation (`deleteFileEntries(clears, path)`)
 * whose argument is an identifier bound, outside the loop, to a prepare result —
 * `clears = prepareStyleClearStatements(rawDb)`, then the loop body forwards
 * `clears` into a helper that runs `clears.decl.run(path)` on every pass. The
 * helper re-runs pre-prepared statements; the prepare is the signal, located via
 * the *argument's* binding rather than the call's own member chain (a bare
 * identifier callee has none). Member-shape re-runs are handled above; this is
 * the bare-call complement.
 */
function isBarePrepareBoundHelperCall(
  node: ASTNode,
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const call = resolveDbCallNode(node, adapter);
  if (!call) return false;
  const callee = getCallExpressionCallee(call, adapter);
  if (!callee || adapter.getNodeType(callee) !== 'identifier') return false;
  const argsNode = adapter.getChildren(call).find(
    (c) => adapter.getNodeType(c) === 'arguments',
  );
  if (!argsNode) return false;
  for (const arg of adapter.getChildren(argsNode)) {
    if (adapter.getNodeType(arg) !== 'identifier') continue;
    if (identifierBoundToPrepareOutsideLoop(adapter.getNodeText(arg, sourceCode), loopNode, adapter, sourceCode)) {
      return true;
    }
  }
  return false;
}

/**
 * The base identifier a member-call chain is rooted at — `stmt` for `stmt.run(x)`
 * and for `stmt.bind(x).run()` (the `.bind()` call's receiver), `db` for
 * `db.select().from(…).where(…)`, `prisma` for `prisma.user.findUnique(…)`.
 * Returns null when the chain is not a member call (a bare `helper(db, …)`) or
 * has no identifier root (an indexed access `x[i]()`).
 */
function memberChainBaseIdentifier(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const eagerCall = findEagerExecutionCall(node, adapter, sourceCode);
  if (!eagerCall) return null;
  const memberExpr = findMemberCallee(eagerCall, adapter);
  if (!memberExpr) return null;
  return baseIdentifierOfMemberExpr(memberExpr, adapter, sourceCode);
}

/**
 * Recurse down a member_expression's object side to the base identifier: the
 * object of `a.b.c` is `a.b`, whose object is `a`; the object of `stmt.bind(x)`
 * is the call, whose own member callee is `stmt.bind`, whose object is `stmt`.
 */
function baseIdentifierOfMemberExpr(
  memberExpr: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const object = adapter.getChildren(memberExpr).find((c) => {
    const t = adapter.getNodeType(c);
    return t !== 'property_identifier' && t !== 'field_identifier' && t !== '.';
  });
  if (!object) return null;
  const type = adapter.getNodeType(object);
  if (type === 'identifier') return adapter.getNodeText(object, sourceCode);
  if (type === 'member_expression') return baseIdentifierOfMemberExpr(object, adapter, sourceCode);
  if (type === 'call_expression') {
    const inner = findMemberCallee(object, adapter);
    return inner ? baseIdentifierOfMemberExpr(inner, adapter, sourceCode) : null;
  }
  return null;
}

/**
 * True when `name` is declared, in the enclosing function (or program), with a
 * `.prepare()` initializer, at a position *outside* the loop. Walking the whole
 * enclosing function is safe for this signal: the caller has already established
 * `preparesInLoop` is false, so the only `.prepare()` sites are outside the loop,
 * and requiring the declarator to sit before the loop excludes any same-named
 * declaration in a sibling scope after it. (A same-named variable in a *nested*
 * function would be a false match; that shadowing shape is not present in the
 * measured corpora and is recorded here rather than silently dropped.)
 */
function identifierBoundToPrepareOutsideLoop(
  name: string,
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const scope = findEnclosingFunctionNode(loopNode, adapter) ?? loopNode;
  const loopStart = loopNode.range[0];
  let found = false;
  walkSubtree(scope, adapter, (n) => {
    if (found) return;
    if (n === loopNode) return;
    if (adapter.getNodeType(n) !== 'variable_declarator') return;
    if (n.range[0] >= loopStart) return;
    const { name: declaredName, value } = splitDeclarator(n, adapter, sourceCode);
    if (declaredName !== name) return;
    if (value && subtreeContainsPrepare(value, adapter, sourceCode)) found = true;
  });
  if (found) return true;
  // A parameter typed as a prepared-statement bundle (`stmts: StyleStatements`,
  // `stmt: SqliteStatement`) is prepare-bound by construction — its members are
  // the `.prepare()` results the caller hoisted before the loop. Re-running
  // `stmts.decl.run(x)` is therefore the same hoisted-reuse signal as a local
  // `const stmt = db.prepare(…)` re-run. A handle parameter (`SqliteDatabase`,
  // `IndexHandle`, `any`) does not name a Statement type and keeps firing.
  return scope !== loopNode && parameterBoundToStatementType(name, scope, adapter, sourceCode);
}

/**
 * True when `name` is a parameter of `fnNode` whose type annotation names a
 * prepared-statement type. The type is the signal (mirroring how a local
 * declarator's `.prepare()` initializer is), never the parameter's name: a
 * `*Statement`/`*Statements` annotation means the value is a compiled statement
 * (or a bundle of them), so a loop that re-runs it re-runs pre-prepared SQL.
 */
export function parameterBoundToStatementType(
  name: string,
  fnNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const params = adapter.getChildren(fnNode).find((c) => adapter.getNodeType(c) === 'formal_parameters');
  if (!params) return false;
  for (const p of adapter.getChildren(params)) {
    const t = adapter.getNodeType(p);
    if (t !== 'required_parameter' && t !== 'optional_parameter') continue;
    const text = adapter.getNodeText(p, sourceCode);
    if (!text) continue;
    // `stmts: StyleStatements` → name `stmts`, type `StyleStatements`. Ignore a
    // default-value tail (`stmts: StyleStatements = …`); a statement bundle has
    // no default.
    const m = text.match(/^([A-Za-z_$][\w$]*)\s*:\s*([^=]+)/);
    if (!m) continue;
    // Match `Statement`, `StyleStatements` (plural), `SqliteStatement`, etc.
    // No `\b` prefix: `StyleStatements` embeds "Statement" after a word char.
    if (m[1] === name && /Statement\w*/.test(m[2])) return true;
  }
  return false;
}

/** True when a subtree contains a `.prepare()` call (an initializer that is or
 *  chains into `db.prepare(…)`, e.g. `db.prepare(sql).bind(…)`) or a `prepare*`
 *  factory call (`prepareStyleClearStatements(rawDb)`) — a function whose whole
 *  job is to return pre-prepared statement objects, so its name carries the same
 *  "statement prepared here" signal the `.prepare()` member call does. */
function subtreeContainsPrepare(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  let found = false;
  walkSubtree(node, adapter, (n) => {
    if (found || adapter.getNodeType(n) !== 'call_expression') return;
    if (dbCallMethodName(n, adapter, sourceCode) === 'prepare') { found = true; return; }
    const callee = getCallExpressionCallee(n, adapter);
    if (callee && adapter.getNodeType(callee) === 'identifier') {
      const name = adapter.getNodeText(callee, sourceCode);
      if (name && /^prepare/i.test(name)) found = true;
    }
  });
  return found;
}

/**
 * §13.1: True when `node` sits inside a `db.transaction(fn)` callback. Walks the
 * parent chain looking for a `call_expression` whose callee is a
 * `member_expression` with a `transaction` property. The loop is the input (not
 * the DB call) so a transaction that wraps only a single per-iteration call —
 * `for (…) { db.transaction(() => run()) }` — does not read as "batched": there
 * the loop itself is outside the transaction and every iteration commits
 * separately, so it must still fire.
 */
function isInsideDbTransaction(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  let current: ASTNode | null = node;
  while (current) {
    const parent = adapter.getParent(current);
    if (!parent) break;
    if (adapter.getNodeType(parent) === 'call_expression') {
      const callee = adapter.getChildren(parent).find(
        (c) => adapter.getNodeType(c) === 'member_expression',
      );
      if (callee && memberPropertyName(callee, adapter, sourceCode) === 'transaction') {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

/**
 * §13.1 (transaction-wrapped-helper discriminator): names of the functions this
 * file invokes *inside* a `db.transaction(fn)` callback — either as a
 * `this.method(...)` call (`this.db.transaction(() => this.syncFileIndexRow(...))`)
 * or as a free function reference/call (`rawDb.transaction(insertAll)`, or
 * `rawDb.transaction(() => { … insertOne(…) })`). A private helper written to run
 * inside the caller's transaction has its per-iteration writes already batched
 * into the caller's single commit, so its internal loops are not a batchable N+1
 * *provided their statements are prepared outside the loop* (see the
 * no-`.prepare()`-in-loop guard at the call site). This mirrors the textual
 * {@link isInsideDbTransaction} check but bridges the call boundary: the loop
 * lives in the helper's body while the transaction wraps the *call*, which the
 * purely lexical check cannot see. A per-iteration `db.transaction(() => …)`
 * *inside* a loop is unaffected — the helper is only recognized when it is the
 * thing being invoked within a transaction callback.
 */
function collectTransactionWrappedFunctions(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Set<string> {
  const wrapped = new Set<string>();
  for (const callNode of adapter.findNodes(ast, {
    custom: (n) => adapter.getNodeType(n) === 'call_expression',
  })) {
    const callee = adapter.getChildren(callNode).find(
      (c) => adapter.getNodeType(c) === 'member_expression',
    );
    if (!callee || memberPropertyName(callee, adapter, sourceCode) !== 'transaction') continue;

    // (1) A bare function reference handed straight to `transaction` — the
    // reducer shape `rawDb.transaction(insertAll)()`. The callback argument is
    // the helper's name, not a call inside it.
    const args = adapter.getChildren(callNode).find(
      (c) => adapter.getNodeType(c) === 'arguments',
    );
    if (args) {
      for (const arg of adapter.getChildren(args)) {
        if (adapter.getNodeType(arg) !== 'identifier') continue;
        const name = adapter.getNodeText(arg, sourceCode);
        if (name) wrapped.add(name);
      }
    }

    // (2) Calls inside the callback: `this.method(...)` and free-function calls
    // (`insertOne(...)`).
    walkSubtree(callNode, adapter, (n) => {
      if (n === callNode) return;
      if (adapter.getNodeType(n) !== 'call_expression') return;
      const innerCallee = getCallExpressionCallee(n, adapter);
      if (!innerCallee) return;
      if (adapter.getNodeType(innerCallee) === 'identifier') {
        const name = adapter.getNodeText(innerCallee, sourceCode);
        if (name) wrapped.add(name);
        return;
      }
      if (adapter.getNodeType(innerCallee) !== 'member_expression') return;
      const obj = adapter.getChildren(innerCallee).find(
        (c) => adapter.getNodeType(c) !== 'property_identifier',
      );
      const objText = obj ? adapter.getNodeText(obj, sourceCode) : '';
      if (objText !== 'this') return;
      const prop = memberPropertyName(innerCallee, adapter, sourceCode);
      if (prop) wrapped.add(prop);
    });
  }
  return wrapped;
}

/** Depth-first walk over an ASTNode subtree (children only, no parent links). */
function walkSubtree(
  node: ASTNode,
  adapter: LanguageAdapter,
  visitor: (n: ASTNode) => void,
): void {
  visitor(node);
  for (const child of adapter.getChildren(node)) {
    walkSubtree(child, adapter, visitor);
  }
}

/**
 * Array methods that transform one collection into another collection (a batch):
 * the elements of a `.slice()`/`.splice()`/`.map()`/`.filter()`/`.concat()`/
 * `.flatMap()` result are a *sub*-collection, not a single row.
 */
const COLLECTION_TRANSFORM_METHODS = new Set(['slice', 'splice', 'map', 'filter', 'concat', 'flatMap']);

/**
 * Free-function callee names that chunk a collection into batches — `chunk(ids,
 * n)`, `chunkArray(ids, n)`, `partition(rows, p)`. Recognized by name (not by a
 * slice call) because a chunking helper is a user-written function whose internal
 * shape the analyzer cannot see; the name is the only stable signal.
 */
const CHUNK_HELPER_RE = /^(chunk|chunks|chunkArray|chunkBy|partition|paginate|paged)$/i;

/** Split a `variable_declarator` into its name text and initializer (value) node. */
function splitDeclarator(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): { name: string | null; value: ASTNode | null } {
  let name: string | null = null;
  let value: ASTNode | null = null;
  let pastEquals = false;
  for (const child of adapter.getChildren(node)) {
    const t = adapter.getNodeType(child);
    if (t === '=' || t === 'equals') { pastEquals = true; continue; }
    if (t === ':' || t === 'type_annotation') continue;
    if (!pastEquals && !name && (t === 'identifier' || t === 'object_pattern' || t === 'array_pattern')) {
      name = adapter.getNodeText(child, sourceCode);
      continue;
    }
    if ((pastEquals || name) && !value) value = child;
  }
  return { name, value };
}

/**
 * §13.2: resolve a bare identifier to the initializer of the `const`/`let` that
 * declares it inside the loop subtree (`const chunk = ids.slice(…)` → the slice
 * call). Scoped to the loop so a same-named variable elsewhere in the function is
 * not mistaken for the loop's chunk. Returns null when the identifier is the
 * loop's own element (declared in a `for…of` header, not a `variable_declarator`).
 */
function resolveLoopLocalBinding(
  identifierNode: ASTNode,
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): ASTNode | null {
  const target = adapter.getNodeText(identifierNode, sourceCode);
  if (!target) return null;
  let result: ASTNode | null = null;
  walkSubtree(loopNode, adapter, (n) => {
    if (result) return;
    if (adapter.getNodeType(n) !== 'variable_declarator') return;
    const { name, value } = splitDeclarator(n, adapter, sourceCode);
    if (name === target) result = value;
  });
  return result;
}

/**
 * §13.2: true when `expr` denotes a collection-derived array — a batch of rows —
 * rather than a single row's scalar. Three shapes qualify:
 *   (a) a call to an array-transform method (`ids.slice(…)`, `rows.map(…)`);
 *   (b) a call to a chunking helper (`chunkArray(ids, n)`);
 *   (c) a local `const chunk = <one of the above>` bound inside the loop.
 */
function isCollectionDerivedExpression(
  expr: ASTNode,
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const type = adapter.getNodeType(expr);
  if (type === 'call_expression') {
    const memberExpr = findMemberCallee(expr, adapter);
    if (memberExpr) {
      const method = memberPropertyName(memberExpr, adapter, sourceCode);
      if (method && COLLECTION_TRANSFORM_METHODS.has(method)) return true;
    }
    const callee = getCallExpressionCallee(expr, adapter);
    if (callee && adapter.getNodeType(callee) === 'identifier') {
      const name = adapter.getNodeText(callee, sourceCode);
      if (name && CHUNK_HELPER_RE.test(name)) return true;
    }
    return false;
  }
  if (type === 'identifier') {
    const value = resolveLoopLocalBinding(expr, loopNode, adapter, sourceCode);
    return value !== null && isCollectionDerivedExpression(value, loopNode, adapter, sourceCode);
  }
  return false;
}

/**
 * §13.3: true when a DB call sits in the iterable/header of a `for…of` loop
 * rather than its body. `for (const c of loadCatalog())` runs `loadCatalog` once
 * (it memoizes the query) and iterates the returned array in memory — the query
 * is not per-iteration. Only the header position qualifies; a DB call in the
 * `statement_block` body still executes once per pass and keeps firing.
 */
function isForOfIterableDbCall(
  node: ASTNode,
  loopNode: ASTNode,
  adapter: LanguageAdapter,
): boolean {
  if (adapter.getNodeType(loopNode) !== 'for_in_statement') return false;
  let body: ASTNode | null = null;
  for (const child of adapter.getChildren(loopNode)) {
    if (adapter.getNodeType(child) === 'statement_block') { body = child; break; }
  }
  if (!body) return false;
  return !isDescendantOf(node, body, adapter);
}

/** True when `node` is `ancestor` or a descendant of it (parent-chain walk). */
function isDescendantOf(
  node: ASTNode,
  ancestor: ASTNode,
  adapter: LanguageAdapter,
): boolean {
  let cur: ASTNode | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = adapter.getParent(cur);
  }
  return false;
}

/**
 * §13.2: the element and iterated-collection shape of a `for…of` loop. Needed to
 * distinguish `for (const chunk of chunkArray(ids)) { run(…chunk) }` — spreading
 * the loop element is a *batch* here because the collection itself is chunked —
 * from `for (const row of rows) { run(…row) }` — spreading the element is a
 * per-row write because the collection is a plain array.
 */
function forOfIteration(
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): { elementNames: Set<string>; iteratesChunkedCollection: boolean } {
  const elementNames = new Set<string>();
  let iteratesChunkedCollection = false;
  if (adapter.getNodeType(loopNode) !== 'for_in_statement') {
    return { elementNames, iteratesChunkedCollection };
  }
  let element: ASTNode | null = null;
  let collection: ASTNode | null = null;
  for (const child of adapter.getChildren(loopNode)) {
    const t = adapter.getNodeType(child);
    if (t === 'statement_block') break; // the body — nothing after it matters
    if (!element && (t === 'identifier' || t === 'object_pattern' || t === 'array_pattern')) {
      element = child;
    } else if (element && !collection) {
      collection = child;
    }
  }
  if (element) {
    const name = adapter.getNodeText(element, sourceCode);
    if (name) elementNames.add(name);
  }
  if (collection) {
    iteratesChunkedCollection = isCollectionDerivedExpression(collection, loopNode, adapter, sourceCode);
  }
  return { elementNames, iteratesChunkedCollection };
}

/**
 * §13.2 (per-batch binding discriminator): true when the DB call executes I/O
 * that binds a *batch* — a spread of a collection-derived expression — rather
 * than per-row scalars, so it is not an N+1. The eager call (`stmt.run(…)`, or
 * the `.run(…)` chained off `db.prepare(…)`) is where parameters are bound; its
 * arguments decide the row-vs-batch question.
 */
function bindsBatchArgument(
  node: ASTNode,
  loopNode: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const eagerCall = findEagerExecutionCall(node, adapter, sourceCode);
  if (!eagerCall) return false;
  const argsNode = adapter.getChildren(eagerCall).find(
    (c) => adapter.getNodeType(c) === 'arguments',
  );
  if (!argsNode) return false;
  const { elementNames, iteratesChunkedCollection } = forOfIteration(loopNode, adapter, sourceCode);

  for (const arg of adapter.getChildren(argsNode)) {
    if (adapter.getNodeType(arg) === 'spread_element') {
      const operand = adapter.getChildren(arg).find((c) => adapter.getNodeType(c) !== '...');
      if (!operand) continue;
      // Spreading the loop's own element is per-row (`…row`) unless the element
      // is itself a chunk of a chunked collection (`for (const chunk of chunkArray(ids))`).
      if (
        adapter.getNodeType(operand) === 'identifier' &&
        elementNames.has(adapter.getNodeText(operand, sourceCode))
      ) {
        if (iteratesChunkedCollection) return true;
        continue;
      }
      if (isCollectionDerivedExpression(operand, loopNode, adapter, sourceCode)) return true;
      continue;
    }
    // A bare collection-derived argument (no spread) is also a batch:
    // `run(rows.map(…))`, or a chunk bound inside the loop (`const chunk =
    // rows.slice(…)` then `run(chunk)` — the identifier resolves to the slice).
    // A bare loop-element identifier (`for (const row of rows) run(row)`) is NOT
    // collection-derived: `resolveLoopLocalBinding` only sees `variable_declarator`
    // bindings, and a `for…of` element is declared in the header, so `row` stays
    // unresolved and the call keeps firing as per-row.
    if (
      (adapter.getNodeType(arg) === 'call_expression' ||
        adapter.getNodeType(arg) === 'identifier') &&
      isCollectionDerivedExpression(arg, loopNode, adapter, sourceCode)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * §13.2: the eager I/O call that actually binds parameters for a DB call — the
 * call itself when it is eager (`stmt.run(…)`, `db.query(…)`), or the eager call
 * chained off a statement-construction call (`db.prepare(sql).run(…)`). Returns
 * null when the call never executes I/O (already filtered upstream).
 */
function findEagerExecutionCall(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): ASTNode | null {
  const call = resolveDbCallNode(node, adapter);
  if (!call) return null;
  const direct = dbCallMethodName(call, adapter, sourceCode);
  if (direct && EAGER_DB_METHODS.has(direct)) {
    const memberExpr = findMemberCallee(call, adapter);
    if (!(memberExpr && isPromiseAllMember(memberExpr, adapter, sourceCode))) return call;
  }
  let cur = adapter.getParent(call);
  while (cur) {
    const type = adapter.getNodeType(cur);
    if (type === 'call_expression') {
      const memberExpr = findMemberCallee(cur, adapter);
      const name = memberExpr ? memberPropertyName(memberExpr, adapter, sourceCode) : null;
      if (name && EAGER_DB_METHODS.has(name) && !isPromiseAllMember(memberExpr!, adapter, sourceCode)) {
        return cur;
      }
    }
    if (
      type === 'expression_statement' ||
      type === 'variable_declarator' ||
      type === 'return_statement' ||
      type === 'lexical_declaration' ||
      type === 'for_statement' ||
      type === 'for_in_statement' ||
      type === 'while_statement' ||
      type === 'statement_block' ||
      type === 'block'
    ) {
      break;
    }
    cur = adapter.getParent(cur);
  }
  return null;
}

/**
 * Classify a call_expression as an LLM/agent invocation via three unambiguous
 * signals: a provider/SDK namespace in the callee text, an LLM action verb in the
 * callee text, or a model-client identifier passed as an argument / used as the
 * member-callee object.
 */
function isLlmCallNode(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  const children = adapter.getChildren(node);
  const callee = children.find(c => adapter.getNodeType(c) !== 'arguments');
  if (callee) {
    const calleeText = adapter.getNodeText(callee, sourceCode);
    if (LLM_PROVIDER_RE.test(calleeText) || LLM_ACTION_RE.test(calleeText)) return true;
    // Member callee whose object is an LLM client: `model.chat(…)`, `llm.invoke(…)`.
    if (adapter.getNodeType(callee) === 'member_expression') {
      const obj = adapter.getChildren(callee).find(c => adapter.getNodeType(c) === 'identifier');
      if (obj && LLM_CLIENT_ARG_NAMES.has(adapter.getNodeText(obj, sourceCode))) return true;
    }
  }

  // Argument signal: an LLM client identifier passed into the call, e.g.
  // `extractBuildsFromCorpus(db, model, …)`.
  const args = children.find(c => adapter.getNodeType(c) === 'arguments');
  if (args) {
    for (const arg of adapter.getChildren(args)) {
      if (adapter.getNodeType(arg) === 'identifier' &&
          LLM_CLIENT_ARG_NAMES.has(adapter.getNodeText(arg, sourceCode))) {
        return true;
      }
      // Member access argument (`client.messages`) — check its object identifier.
      if (adapter.getNodeType(arg) === 'member_expression') {
        const obj = adapter.getChildren(arg).find(c => adapter.getNodeType(c) === 'identifier');
        if (obj && LLM_CLIENT_ARG_NAMES.has(adapter.getNodeText(obj, sourceCode))) return true;
      }
    }
  }

  return false;
}

/**
 * R4.1: Determine if a node is a database call expression.
 * Spec 21: When provenance context is available, uses provenance-based detection
 * (conjunctive guard — never name alone). In names mode or without context,
 * falls back to the legacy dbPatterns text match.
 *
 * Spec 70 R3/R4: handle-ness is decided once, by `identifyHandle` (via
 * `handleVerdictForCall`); only a proven `handle` — a parsed SQL argument (R3)
 * or a package in the manifest (R4) — is a DB node for the loop walk. `unproven`
 * is `cannot-fire` (visible, never a finding), so a `map.delete()` / `set.join()`
 * on an unresolved receiver does not read as a DB call inside a loop.
 */
export function isDbCallNode(
  node: ASTNode,
  scan: DataAccessScanContext,
): boolean {
  const { adapter, sourceCode, provenanceContext } = scan;

  // Spec 21: Provenance-first detection when context is available
  if (provenanceContext && provenanceContext.mode !== 'names') {
    const verdict = handleVerdictForCall(node, scan);
    return verdict !== null && verdict.kind === 'handle';
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
  adapter: LanguageAdapter,
  sourceCode: string,
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
    if (isIteratorCallback(parent, current, adapter, sourceCode)) {
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
 *
 * `child` is the node one level below `node` on the walk-up path from the query.
 * An iterator call only encloses the query when the query sits *inside the
 * callback argument* (an arrow/function expression), not when the query is the
 * *subject* the method is called on. `this.db.prepare(sql).all().map(r => …)`
 * runs the query once and maps the rows in memory — a single query, not an N+1
 * — yet without this check the `.map` call would read as an enclosing loop
 * because the query is a descendant of the call expression. Only a query inside
 * the callback body executes once per iteration.
 */
function isIteratorCallback(
  node: ASTNode,
  child: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): boolean {
  // Must be a call_expression
  if (adapter.getNodeType(node) !== 'call_expression') return false;

  // Callee must be a member_expression whose property matches iterator method names
  const children = adapter.getChildren(node);
  const callee = children.find(c => adapter.getNodeType(c) === 'member_expression');
  if (!callee) return false;

  const calleeChildren = adapter.getChildren(callee);
  const propertyNode = calleeChildren.find(c =>
    adapter.getNodeType(c) === 'property_identifier' || adapter.getNodeType(c) === 'string'
  );
  if (!propertyNode) return false;

  const iteratorMethods = ['forEach', 'map', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'flatMap'];

  // The property text must come from the source slice (web-tree-sitter nodes
  // carry no `.text`/`.name` payload; `getNodeText` with the real source is the
  // established extraction — cf. `memberPropertyName`). Passing an empty string
  // here returned '' for every node, so iterator callbacks were never matched.
  const propText = adapter.getNodeText(propertyNode, sourceCode);

  if (!iteratorMethods.includes(propText)) return false;

  // The direct child on the path from the query must be the call's `arguments`
  // list (the callback), not the callee/subject the method is invoked on. The
  // child is the immediate descendant of the call_expression that the query sits
  // under: `arguments` when the query is inside the callback, the `member_expression`
  // callee when the query is the *subject* (`db.prepare(sql).all().map(r => …)`
  // runs once and maps rows in memory). Checking the child's node type directly —
  // rather than the callback function's — is what survives the `arguments` node
  // tree-sitter inserts between the call and its arrow/function argument.
  return adapter.getNodeType(child) === 'arguments';
}

/**
 * The enclosing-function identity used for stable fingerprint symbols. The
 * coordinate (start line + column) keeps anonymous handlers distinct; the single
 * definition lives in codeAnalysis.ts (Spec 61 Amendment A).
 */
const enclosingIdentity = (node: ASTNode, adapter: LanguageAdapter, filePath: string): string =>
  functionIdentityLabel(findEnclosingFunctionIdentity(node, adapter, filePath));

/** Build the shared data-access scan context (config + provenance + imports). */
/**
 * Build the TypeScript binding environment `identifyHandle` reads for declaration
 * resolution, keyed to the file's own imports/declarations plus the within-file
 * provenance set. Absent (undefined) for Go, which resolves cross-file and has no
 * `RootResolutionEnv`.
 */
function buildHandleEnv(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceContext: ProvenanceContext,
): RootResolutionEnv | undefined {
  if (adapter.name === 'go') return undefined;
  return {
    provenance: provenanceContext.dbProvenanced,
    bindings: buildBindingEnv(ast, adapter, sourceCode),
    interfaceFields: extractInterfaceFields(ast, adapter, sourceCode),
    adapter,
    sourceCode,
  };
}

/** Build the Go binding environment `identifyHandle` reads for Go declaration
 *  resolution. The provenance seed (cross-file `db *sql.DB` resolution) is what
 *  proves `handle`; bindings + imports let `classifyGoRootIdentifier` dispose a
 *  non-seeded receiver (`unproven` for an unrecognized package, `not-handle` for
 *  a non-DB binding). Absent (undefined) for non-Go formats. */
function buildGoEnv(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceContext: ProvenanceContext,
): GoResolutionEnv | undefined {
  if (adapter.name !== 'go') return undefined;
  return {
    provenance: provenanceContext.dbProvenanced,
    bindings: buildGoBindingEnv(ast, adapter, sourceCode),
    imports: buildGoImportMap(ast, adapter),
    adapter,
    sourceCode,
  };
}

function buildDataAccessScan(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config: DataAccessAnalyzerConfig | undefined,
): DataAccessScanContext {
  const finalConfig = { ...DEFAULT_DATA_ACCESS_CONFIG, ...config };
  const detectionMode: DetectionMode = finalConfig.detection?.mode ?? 'hybrid';
  const seedProvenance = (config as any)?._receiverProvenance as
    | Map<string, ProvenanceEvidence>
    | undefined;
  const provenanceContext = buildProvenanceContext(ast, adapter, sourceCode, {
    mode: detectionMode,
    dbBindingNames: finalConfig.dbBindingNames,
    dbWrapperNames: finalConfig.dbWrapperNames,
    seedProvenance,
    // Spec 70 criterion 8 — thread the corpus's dialect so R3 proves a receiver
    // whose (now-deleted) type annotation was its only signal, and so wrapper
    // detection (detectDbWrappers) sees the proven receiver in helper bodies.
    sqlDialect: finalConfig.dialect ?? null,
  });
  return {
    adapter,
    sourceCode,
    config: finalConfig,
    ast,
    provenanceContext,
    handleEnv: buildHandleEnv(ast, adapter, sourceCode, provenanceContext),
    goEnv: buildGoEnv(ast, adapter, sourceCode, provenanceContext),
  };
}

/**
 * Spec 68 §3.2 — the `data-access-calls` FileProcessor extraction, factored out
 * of `analyzeWithFacts` so the phase-model producer can obtain the per-file
 * resolved calls synchronously (the analyzer method is `async` but does no real
 * awaits — its body is entirely synchronous). Returns the `DatabaseCall[]` the
 * missing-org-filter / unfiltered-query / sql-injection-risk rules read, with no
 * violation production and no side effects. Config is the §10 tuning surface;
 * omitted here, the extraction runs on {@link DEFAULT_DATA_ACCESS_CONFIG}.
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @param config The data-access analyzer config (defaults when omitted).
 * @returns The database calls extracted from the file.
 */
export function extractDataAccessCalls(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config?: DataAccessAnalyzerConfig,
): DatabaseCall[] {
  return extractDatabaseCalls(ast, buildDataAccessScan(ast, adapter, sourceCode, config));
}

/**
 * Extract the loop-query candidates (loops whose body issues a DB call) as the
 * serializable `LoopQueryCandidate[]` the `loop-queries` producer projects. The
 * candidate set is exactly what `checkLoopQueries` reduces to findings, computed
 * on the same provenance context — so detection parity holds by construction,
 * not by re-implementation. Config is the §10 tuning surface; omitted here, the
 * extraction runs on {@link DEFAULT_DATA_ACCESS_CONFIG}.
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @param config The data-access analyzer config (defaults when omitted).
 * @returns The loop-query candidates extracted from the file.
 */
export function extractLoopQueries(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config?: DataAccessAnalyzerConfig,
): LoopQueryCandidate[] {
  return collectLoopQueryCandidates(ast, buildDataAccessScan(ast, adapter, sourceCode, config));
}

// ── Spec 70 Item 4 (step 3) — raw candidate extractors ───────────────────────
//
// The two remaining receiver consumers (`data-access-calls`, `loop-queries`) are
// converted to corpus producers: while the AST lives, these extractors project the
// *provenance-free* half of `buildDatabaseCall` / `collectLoopQueryCandidates` into
// serializable candidates, and the corpus producers re-fold the provenance-dependent
// half (the `identifyHandle` verdict → admission + injection-risk gate, the site
// dialect → the SQL parse, and the loop dedup) over the re-derived `dbProvenanced`.
// They run on an EMPTY-provenance scan so `checkQuerySecurity`'s wrapper arm sees
// only `config.dbWrapperNames` (the learned wrappers are corrected corpus-side).

/** Build a scan with an empty provenance context — the raw producer's discovery and
 *  static-security arms must not read the cross-file seed (which only the corpus
 *  producer sees), so every provenance-dependent signal is captured as an identity
 *  and re-folded later. `handleEnv`/`goEnv` still build their provenance-free
 *  bindings/imports, which the structural discovery predicates read. */
function buildCandidateScan(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config?: DataAccessAnalyzerConfig,
): DataAccessScanContext {
  const finalConfig = { ...DEFAULT_DATA_ACCESS_CONFIG, ...config };
  const provenanceContext: ProvenanceContext = {
    dbProvenanced: new Map(),
    validatorProvenanced: new Map(),
    mode: finalConfig.detection?.mode ?? 'hybrid',
    dbActivity: new Set(),
  };
  return {
    adapter,
    sourceCode,
    config: finalConfig,
    ast,
    provenanceContext,
    handleEnv: buildHandleEnv(ast, adapter, sourceCode, provenanceContext),
    goEnv: buildGoEnv(ast, adapter, sourceCode, provenanceContext),
  };
}

// ── Structural discovery (empty-provenance supersets) ────────────────────────

/** True when `node` is a bare-identifier call whose callee name has any binding —
 *  the raw-side superset of `handleVerdictForCall`'s identifier arm. A provenanced
 *  wrapper, a type-annotated handle, or a propagated local are all *bound*, so a
 *  name with no binding is provably not a handle candidate and is dropped here. */
function isBoundIdentifierCall(node: ASTNode, scan: DataAccessScanContext): boolean {
  const { adapter, sourceCode, handleEnv } = scan;
  if (!handleEnv) return false;
  if (adapter.getNodeType(node) !== 'call_expression') return false;
  const callee = getCallExpressionCallee(node, adapter);
  if (!callee || callee.type !== 'identifier') return false;
  const name = adapter.getNodeText(callee, sourceCode);
  return !!name && handleEnv.bindings.has(name);
}

/** True when `node` is a member/selector call whose receiver root is DB-shaped
 *  (handle or unproven) or that carries a static SQL argument — the structural
 *  superset of `handleVerdictForCall`'s member arm (and Go's selector arm, which
 *  is the same shape). The package discriminant — not the method name — admits a
 *  receiver (`join` is `Array.prototype.join` and also `SQL JOIN`); the empty
 *  provenance of the candidate scan makes more roots `unproven`, so this stays a
 *  strict superset of the corpus-side re-fold. */
function isMemberShapeCall(node: ASTNode, scan: DataAccessScanContext): boolean {
  const { adapter, sourceCode, handleEnv, goEnv } = scan;
  if (adapter.getNodeType(node) !== 'call_expression') return false;
  const callee = getCallExpressionCallee(node, adapter);
  if (!callee || (callee.type !== 'member_expression' && callee.type !== 'selector_expression')) return false;
  const root = resolveReceiverRoot(callee, adapter, sourceCode);
  if (root === null) return false;
  const sqlArg = adapter.name === 'go'
    ? extractGoStaticSql(node, adapter, sourceCode, goEnv)
    : extractStaticSql(node, adapter, sourceCode);
  if (sqlArg === null) {
    return adapter.name === 'go'
      ? !!goEnv && classifyGoRootIdentifier(root, goEnv) !== 'not-handle'
      : !!handleEnv && isDbShapedRoot(root, handleEnv, { thisField: receiverIsThisRooted(callee, adapter) });
  }
  return true;
}

/** True when `node` is a template literal whose enclosing call is a bound-identifier
 *  or member-shape call — the raw-side superset of `handleVerdictForCall`'s template
 *  branch (`callNode = enclosingCallOf(template)`). */
function isTemplateOfDbCall(node: ASTNode, scan: DataAccessScanContext): boolean {
  const { adapter, sourceCode, config } = scan;
  if (!isTemplateLiteral(node, adapter)) return false;
  const callNode = enclosingCallOf(node, adapter);
  if (!callNode) return false;
  // A tagged template (`this.sql`…``, `sql`…``) carries its template as its own
  // body, not as a template *argument* to a DB call. The tag is already a
  // candidate via `isTaggedTemplateSqlCall`; re-admitting the body here would
  // double-discover the site and let the body (method `unknown`) shadow the tag
  // (method `sql`) in line dedup.
  const tagNames = config.sqlTagNames ?? SQL_TAG_NAMES;
  if (isTaggedTemplateSqlCall(callNode, adapter, sourceCode, tagNames)) return false;
  return isBoundIdentifierCall(callNode, scan) || isMemberShapeCall(callNode, scan);
}

/** The broadened data-access discovery — a strict superset of `isDbCallCandidate`
 *  over the same pre-order. The three shape arms (query-builder, tagged template,
 *  variable assignment) are provenance-free; the identifier/member/template arms
 *  cover every `handleVerdictForCall` shape with the empty seed. */
function isBroadenedDataAccessCandidate(
  node: ASTNode,
  scan: DataAccessScanContext,
  tagNames: readonly string[],
): boolean {
  const { adapter, sourceCode } = scan;
  if (isQueryBuilderShape(node, adapter, sourceCode)) return true;
  if (isTaggedTemplateSqlCall(node, adapter, sourceCode, tagNames)) return true;
  if (isVariableAssignment(node, adapter) && extractStaticSql(node, adapter, sourceCode) !== null) return true;
  if (isBoundIdentifierCall(node, scan)) return true;
  if (isMemberShapeCall(node, scan)) return true;
  if (isTemplateOfDbCall(node, scan)) return true;
  return false;
}

/** The broadened loop-query discovery — a strict superset of `isDbCallNode` (which
 *  is `handleVerdictForCall(node).kind === 'handle'`). The template-literal branch is
 *  skipped later (as in `collectLoopQueryCandidates`), so only the two structural
 *  call arms remain. */
function isBroadenedLoopCandidate(node: ASTNode, scan: DataAccessScanContext): boolean {
  return isBoundIdentifierCall(node, scan) || isMemberShapeCall(node, scan);
}

// ── Identity extraction (the provenance-dependent halves travel as identity) ──

/** The handle-verdict identity of `handleVerdictForCall`'s `CallSite` — the
 *  enclosing-call callee for a template, the node's own callee otherwise — captured
 *  raw-side so the corpus producer re-folds `identifyHandle` over the re-derived
 *  `dbProvenanced`. `sqlArg` is `extractStaticSql(callNode)` (the verdict's
 *  sql-argument source); `siteReceiver` is the raw nullable `getMemberExpressionReceiver`
 *  of the callee (the `resolveSiteDialect` member arm's input, distinct from
 *  `receiver` which is `receiver ?? root`). */
interface HandleCallSiteIdentity {
  calleeType: 'identifier' | 'member' | null;
  name: string | null;
  root: string | null;
  receiver: string | null;
  method: string | null;
  thisField: boolean;
  thisHeritage: string | null;
  sqlArg: string | null;
  siteReceiver: string | null;
  /** The receiver reference's enclosing scope (start byte offset of the enclosing
   *  function, `0` for top-level) — disambiguates same-named bindings in different
   *  functions when the corpus-side classifier keys bindings on scope. */
  scope: number;
}

const NULL_HANDLE_IDENTITY: HandleCallSiteIdentity = {
  calleeType: null, name: null, root: null, receiver: null, method: null,
  thisField: false, thisHeritage: null, sqlArg: null, siteReceiver: null, scope: 0,
};

/** Project `handleVerdictForCall`'s structural gates (without `identifyHandle`) into
 *  the identity the corpus producer re-folds. Mirrors the TS identifier/member arms
 *  and the Go selector arm exactly — same method/root gates, same template → enclosing
 *  call resolution, same `extractStaticSql(callNode)` argument. */
function handleCallSiteIdentity(node: ASTNode, scan: DataAccessScanContext): HandleCallSiteIdentity {
  const { adapter, sourceCode } = scan;

  if (adapter.name === 'go') {
    // Go selector arm (goHandleVerdictForCall) — node is always a call_expression.
    if (!isFunctionCall(node, adapter)) return NULL_HANDLE_IDENTITY;
    const callee = getCallExpressionCallee(node, adapter);
    if (!callee || callee.type !== 'selector_expression') return NULL_HANDLE_IDENTITY;
    const method = extractMemberExpressionProperty(callee, adapter, sourceCode);
    if (!method) return NULL_HANDLE_IDENTITY;
    const root = resolveReceiverRoot(callee, adapter, sourceCode);
    if (root === null) return NULL_HANDLE_IDENTITY;
    const sqlArg = extractGoStaticSql(node, adapter, sourceCode, scan.goEnv);
    if (sqlArg === null && (!scan.goEnv || classifyGoRootIdentifier(root, scan.goEnv) === 'not-handle')) {
      return NULL_HANDLE_IDENTITY;
    }
    const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? root;
    return {
      calleeType: 'member', name: null, root, receiver, method, thisField: false,
      thisHeritage: null,
      sqlArg,
      siteReceiver: getMemberExpressionReceiver(callee, adapter, sourceCode),
      scope: 0,
    };
  }

  const callNode = isTemplateLiteral(node, adapter) ? enclosingCallOf(node, adapter) : node;
  if (!callNode || !isFunctionCall(callNode, adapter)) return NULL_HANDLE_IDENTITY;
  if (callNode.type === 'new_expression') return NULL_HANDLE_IDENTITY;
  const callee = getCallExpressionCallee(callNode, adapter);
  if (!callee) return NULL_HANDLE_IDENTITY;

  if (callee.type === 'identifier') {
    const name = adapter.getNodeText(callee, sourceCode);
    if (!name) return NULL_HANDLE_IDENTITY;
    return {
      calleeType: 'identifier', name, root: name, receiver: name, method: name,
      thisField: false,
      thisHeritage: null,
      sqlArg: extractStaticSql(callNode, adapter, sourceCode),
      siteReceiver: null,
      scope: findEnclosingFunctionNode(callNode, adapter)?.range[0] ?? 0,
    };
  }

  if (callee.type !== 'member_expression' && callee.type !== 'selector_expression') {
    return NULL_HANDLE_IDENTITY;
  }
  const method = extractMemberExpressionProperty(callee, adapter, sourceCode);
  if (!method) return NULL_HANDLE_IDENTITY;
  const root = resolveReceiverRoot(callee, adapter, sourceCode);
  if (root === null) return NULL_HANDLE_IDENTITY;
  const sqlArg = extractStaticSql(callNode, adapter, sourceCode);
  const thisRooted = receiverIsThisRooted(callee, adapter);
  if (sqlArg === null && (!scan.handleEnv || !isDbShapedRoot(root, scan.handleEnv, { thisField: thisRooted }))) {
    return NULL_HANDLE_IDENTITY;
  }
  const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? root;
  // Spec 70 Q3 — a `this.<root>` receiver resolves to the enclosing class's
  // base-class field type (`extends WorkflowEntrypoint<Env>` → `this.env` is
  // `Env`), re-folded through the member path by the same heritage seam as the
  // build side. The raw `extends` text is carried, resolved at fold time; null
  // when not `this`-rooted or the class has no base class.
  const thisHeritage = thisRooted
    ? findEnclosingClassHeritage(scan.ast, adapter, callNode, sourceCode)
    : null;
  return {
    calleeType: 'member', name: null, root, receiver, method,
    thisField: thisRooted,
    thisHeritage,
    sqlArg,
    siteReceiver: getMemberExpressionReceiver(callee, adapter, sourceCode),
    scope: findEnclosingFunctionNode(callNode, adapter)?.range[0] ?? 0,
  };
}

/** The `resolveSiteDialect` input identity — the node's *own* callee (null for a
 *  template string), distinct from the handle identity's enclosing-call callee. */
interface SiteDialectIdentity {
  calleeType: 'identifier' | 'member' | null;
  name: string | null;
  receiver: string | null;
}

function siteDialectIdentity(node: ASTNode, scan: DataAccessScanContext): SiteDialectIdentity {
  const { adapter, sourceCode } = scan;
  const callee = getCallExpressionCallee(node, adapter);
  if (!callee) return { calleeType: null, name: null, receiver: null };
  if (callee.type === 'identifier') {
    return { calleeType: 'identifier', name: adapter.getNodeText(callee, sourceCode) || null, receiver: null };
  }
  if (callee.type === 'member_expression' || callee.type === 'selector_expression') {
    return { calleeType: 'member', name: null, receiver: getMemberExpressionReceiver(callee, adapter, sourceCode) };
  }
  return { calleeType: null, name: null, receiver: null };
}

/** The bare-identifier callee name of a template's enclosing call, only when the
 *  call carries ≥2 real args — the `isWrapperFunctionWithBindParams` shape's identity
 *  (arm 4). Captured raw-side so the corpus producer can correct the static-security
 *  result once it learns the name as a DB wrapper (`reason: 'wrapper'`). */
function wrapperCalleeNameForTemplate(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  if (adapter.getNodeType(node) !== 'template_string') return null;
  const args = adapter.getParent(node);
  if (!args || adapter.getNodeType(args) !== 'arguments') return null;
  const call = adapter.getParent(args);
  if (!call || adapter.getNodeType(call) !== 'call_expression') return null;
  const callee = getCallExpressionCallee(call, adapter);
  if (!callee || adapter.getNodeType(callee) !== 'identifier') return null;
  const realArgs = adapter.getChildren(args).filter(
    (c) => !['(', ')', ','].includes(adapter.getNodeType(c)),
  );
  if (realArgs.length < 2) return null;
  return adapter.getNodeText(callee, sourceCode) || null;
}

// ── The `data-access-calls-candidates` extractor ─────────────────────────────

/** Project one broadened candidate into the raw, provenance-free `DataAccessCallCandidate`
 *  the corpus `data-access-calls` producer re-folds. The static-security arms run here
 *  on the empty-provenance scan; only `arm4CalleeName` is corrected corpus-side. */
function buildDataAccessCallCandidate(
  node: ASTNode,
  ast: AST,
  scan: DataAccessScanContext,
): DataAccessCallCandidate | null {
  const { adapter, sourceCode, config } = scan;
  const nodeText = stripComments(adapter.getNodeText(node, sourceCode));
  if (!nodeText || nodeText.trim().length < 10) return null;

  const sqlArg = adapter.name === 'go'
    ? extractGoStaticSql(node, adapter, sourceCode, scan.goEnv)
    : extractStaticSql(node, adapter, sourceCode);
  const isOrmCall = isOrmPattern(nodeText);
  const tagNames = config.sqlTagNames ?? SQL_TAG_NAMES;
  const isTaggedSqlCall = isTaggedTemplateSqlCall(node, adapter, sourceCode, tagNames);
  const isQueryBuilder = isQueryBuilderShape(node, adapter, sourceCode);
  const isVariableAssignmentSql = isVariableAssignment(node, adapter) && sqlArg !== null;
  const isTemplate = isTemplateLiteral(node, adapter);

  const handle = handleCallSiteIdentity(node, scan);
  const site = siteDialectIdentity(node, scan);
  const security = checkQuerySecurity(node, nodeText, ast, scan);

  return {
    file: ast.filePath,
    line: node.location.start.line,
    column: node.location.start.column,
    format: adapter.name === 'go' ? 'go' : 'typescript',
    nodeText,
    method: extractMethodName(node, adapter, sourceCode),
    sqlArg,
    isOrmCall,
    isTaggedSqlCall,
    isQueryBuilderShape: isQueryBuilder,
    isVariableAssignmentSql,
    isTemplateLiteral: isTemplate,
    handleCalleeType: handle.calleeType,
    handleName: handle.name,
    handleRoot: handle.root,
    handleReceiver: handle.receiver,
    handleMethod: handle.method,
    handleThisField: handle.thisField,
    handleThisHeritage: handle.thisHeritage,
    handleSqlArg: handle.sqlArg,
    handleSiteReceiver: handle.siteReceiver,
    handleRootScope: handle.scope,
    skipCallForTemplateArg: shouldSkipCallForTemplateArg(node, adapter),
    siteCalleeType: site.calleeType,
    siteName: site.name,
    siteReceiver: site.receiver,
    hasOrganizationFilter: hasOrganizationFilter(nodeText, config),
    enclosingFunction: enclosingIdentity(node, adapter, ast.filePath),
    resolvedWhere: resolveWhereBinding(node, sourceCode, adapter),
    ormTables: isOrmCall ? extractOrmTables(nodeText, config) : [],
    builderVerb: builderWriteVerb(nodeText),
    ormHasFilter: hasOrmFilterShape(nodeText),
    staticParameterized: security.parameterized,
    staticInjectionRisk: security.injectionRisk,
    staticEscaped: security.escaped,
    arm4CalleeName: wrapperCalleeNameForTemplate(node, adapter, sourceCode),
  };
}

/**
 * Extract the raw, provenance-free `data-access-calls-candidates` for one file —
 * the extract half of the corpus `data-access-calls` reduction (Spec 70 Item 4,
 * step 3). No dedup happens here: the broadened discovery can perturb line-dedup
 * (a bound bare call and a member call on the same line), so the corpus producer
 * dedups after re-folding admission. Config is the §10 tuning surface; omitted
 * here, extraction runs on {@link DEFAULT_DATA_ACCESS_CONFIG}.
 * @param ast - The file's parsed AST.
 * @param adapter - The language adapter (drives node discovery + text reads).
 * @param sourceCode - The file's source text.
 * @param config - Optional data-access config; defaults to the shared config.
 * @returns The raw, provenance-free `data-access-calls-candidates`.
 */
export function extractDataAccessCallCandidates(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config?: DataAccessAnalyzerConfig,
): DataAccessCallCandidate[] {
  const scan = buildCandidateScan(ast, adapter, sourceCode, config);
  const tagNames = scan.config.sqlTagNames ?? SQL_TAG_NAMES;
  const nodes = adapter.findNodes(ast, {
    custom: (node) => isBroadenedDataAccessCandidate(node, scan, tagNames),
  });
  const out: DataAccessCallCandidate[] = [];
  for (const node of nodes) {
    const cand = buildDataAccessCallCandidate(node, ast, scan);
    if (cand) out.push(cand);
  }
  return out;
}

// ── The `loop-query-candidates` extractor ────────────────────────────────────

/**
 * Extract the raw, provenance-free `loop-query-candidates` for one file — the
 * extract half of the corpus `loop-queries` reduction. Mirrors `collectLoopQueryCandidates`
 * with the broadened discovery and without the three provenance-dependent steps
 * (the strict-handle filter, the per-loop dedup, the stable symbol), which the
 * corpus producer re-folds once `dbProvenanced` is re-derived. The provenance-free
 * discriminators (statement-construction, sql-string-construction, for-of-iterable,
 * hoisted-reuse, batch-argument, LLM/queue suppression) already ran here.
 * @param ast - The file's parsed AST.
 * @param adapter - The language adapter (drives node discovery + text reads).
 * @param sourceCode - The file's source text.
 * @param config - Optional data-access config; defaults to the shared config.
 * @returns The raw, provenance-free `loop-query-candidates`.
 */
export function extractLoopQueryRawCandidates(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  config?: DataAccessAnalyzerConfig,
): LoopQueryRawCandidate[] {
  const scan = buildCandidateScan(ast, adapter, sourceCode, config);
  const candidates: LoopQueryRawCandidate[] = [];

  const dbNodes = adapter.findNodes(ast, {
    custom: (node) => isBroadenedLoopCandidate(node, scan),
  });

  const transactionWrappedFunctions = collectTransactionWrappedFunctions(ast, adapter, sourceCode);

  for (const node of dbNodes) {
    // A DB call and its template-literal SQL argument both satisfy the structural
    // discovery — collapse to the call node, exactly as `collectLoopQueryCandidates`
    // does (isDbCallNode only admits a literal whose enclosing call is provenanced,
    // so skipping the literal loses nothing).
    if (isTemplateLiteral(node, adapter)) continue;

    const nodeText = adapter.getNodeText(node, sourceCode);
    if (!nodeText || nodeText.trim().length < 10) continue;

    if (isStatementConstructionOnly(node, adapter, sourceCode)) continue;
    if (isSqlStringConstruction(node, adapter, sourceCode)) continue;

    const loopInfo = findEnclosingLoop(node, adapter, sourceCode);
    if (!loopInfo) continue;

    if (isForOfIterableDbCall(node, loopInfo.loopNode, adapter)) continue;

    const enclosingFnName = findEnclosingFunctionIdentity(loopInfo.loopNode, adapter, ast.filePath).name;
    const transactionEnclosesLoop =
      isInsideDbTransaction(loopInfo.loopNode, adapter, sourceCode) ||
      (enclosingFnName !== null && transactionWrappedFunctions.has(enclosingFnName));
    const preparesInLoop = loopBodyContainsPrepare(loopInfo.loopNode, adapter, sourceCode);
    const hoistedReuse =
      !preparesInLoop &&
      (transactionEnclosesLoop || isHoistedStatementReRun(node, loopInfo.loopNode, adapter, sourceCode));
    if (hoistedReuse) continue;

    if (bindsBatchArgument(node, loopInfo.loopNode, adapter, sourceCode)) continue;
    if (loopBodyContainsLlmCall(loopInfo.loopNode, adapter, sourceCode)) continue;
    if (loopBodyContainsMessageLifecycleCall(loopInfo.loopNode, adapter, sourceCode)) continue;

    const handle = handleCallSiteIdentity(node, scan);
    const anchor = getCallExpressionCallee(node, adapter) ?? node;

    candidates.push({
      file: ast.filePath,
      line: anchor.location.start.line,
      column: anchor.location.start.column,
      enclosingFunction: enclosingIdentity(node, adapter, ast.filePath),
      loopStartOffset: loopInfo.loopNode.range[0],
      loopLine: loopInfo.loopNode.location.start.line,
      depth: loopInfo.depth,
      handleCalleeType: handle.calleeType,
      handleName: handle.name,
      handleRoot: handle.root,
      handleReceiver: handle.receiver,
      handleMethod: handle.method,
      handleThisField: handle.thisField,
      handleThisHeritage: handle.thisHeritage,
      handleSiteReceiver: handle.siteReceiver,
      sqlArg: handle.sqlArg,
      handleRootScope: handle.scope,
    });
  }

  return candidates;
}
