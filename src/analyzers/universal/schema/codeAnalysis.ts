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

import type { Violation, CoverageDiagnostic } from '../../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../../languages/types.js';
import {
  getCallExpressionCallee,
  getMemberExpressionReceiver,
  extractMemberExpressionProperty,
  resolveSiteDialect,
  type ProvenanceContext,
} from '../../provenance.js';
import { identifyHandle, type HandleVerdict } from '../../handleIdentification.js';
import { resolveReceiverRoot, buildBindingEnv, type RootResolutionEnv } from '../../receiverRoot.js';
import { OrmAdapterRegistry } from '../../orm/index.js';
import { SQL_TAG_NAMES, DEFAULT_SCHEMA_CONFIG } from './config.js';
import type { SchemaAnalyzerConfig, TableReference } from './types.js';
import { createSchemaViolation } from './violations.js';
import { isTestOrSpecPath } from '../../../languages/testConventions.js';
import { parseSqlProgramTolerant, collectTypedRelations, DEFAULT_SQL_DIALECT, type TypedRelation } from '../../../languages/sql/sqlAst.js';
import type { Dialect } from '../../../mcp-tools/discoveryQueries.js';

/**
 * Bundled inputs for `findTableReferences`: config, provenance context, and the
 * known-table catalog travel together so the signature stays under the param cap.
 */
export interface FindTableReferencesContext {
  config: SchemaAnalyzerConfig;
  provenanceContext?: ProvenanceContext;
  allTables?: Set<string>;
  /** Spec 70 R1.2 — the TS binding environment `identifyHandle` reads for
   *  declaration-resolution, so an `unproven` (type-annotated) receiver is
   *  admitted *as unproven* rather than dropped. Absent for Go / non-code. */
  handleEnv?: RootResolutionEnv;
}

/**
 * A DB-call whose SQL argument is held in an identifier we cannot statically
 * resolve (imported constant, computed/concatenated expression, call result).
 * The query's table read/write status is unknown — reported as an
 * `unresolved-query` finding rather than silently treated as "no tables".
 */
export interface UnresolvedQuery {
  /** The identifier text at the call site (e.g. `UPSERT_SQL`). */
  identifier: string;
  /** The call-site location. */
  location: { line: number; column: number };
}

/**
 * A DB-call whose SQL argument is a static string that a named dialect cannot
 * parse (e.g. SQLite `PRAGMA table_info(x)`, `VACUUM`, `ANALYZE`). The argument
 * is in a SQL position — provenance already established the receiver is a DB
 * handle — so its table read/write status is *unreadable*, not "no tables".
 * Reported as a `cannot-fire` coverage diagnostic rather than silently emitting
 * an empty table-reference fact (Spec 70: the schema regex `parseSqlTables`
 * matched no FROM/JOIN keyword, so without this the site read as clean).
 */
export interface UnparseableSql {
  /** The static SQL text that could not be turned into table facts. */
  sqlText: string;
  /** The call-site location. */
  location: { line: number; column: number };
  /** The failure reason (parser reason, or "dialect undetermined (…) — and the
   *  SQL does not parse under the default grammar: <reason>"). */
  reason: string;
  /** Why the SQL was unreadable: `parse-failure` when a named dialect failed to
   *  parse it; `dialect-undetermined` when the dialect was undetermined *and* the
   *  default grammar also failed (the failure may be dialect-specific). */
  kind: 'parse-failure' | 'dialect-undetermined';
}

/**
 * Bundled result of `findTableReferences`: extracted table references plus any
 * unresolvable DB-call SQL arguments and unparseable static SQL encountered
 * during extraction.
 */
export interface TableReferenceResult {
  references: TableReference[];
  unresolved: UnresolvedQuery[];
  unparseable: UnparseableSql[];
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
): TableReferenceResult {
  const references: TableReference[] = [];
  const unresolved: UnresolvedQuery[] = [];
  const unparseable: UnparseableSql[] = [];

  // (1) Tagged template SQL — e.g. sql`SELECT * FROM heroes`
  const taggedRefs = extractTaggedTemplateRefs(ast, adapter, sourceCode, ctx);
  references.push(...taggedRefs.references);
  unparseable.push(...taggedRefs.unparseable);

  // (2) DB-call patterns — e.g. db.exec("SELECT * FROM heroes")
  const dbRefs = extractDbCallRefs(ast, adapter, sourceCode, ctx);
  references.push(...dbRefs.references);
  unresolved.push(...dbRefs.unresolved);
  unparseable.push(...dbRefs.unparseable);

  // (3) .sql files — scan the entire source (the whole file IS SQL).
  if (ast.filePath.endsWith('.sql')) {
    const fileRefs = parseSqlTables(
      sourceCode,
      { line: 1, column: 1 },
      sourceCode,
      ctx.allTables,
      ctx.config.sqlDialect ?? null,
      ctx.config.sqlDialectReason ?? null,
    );
    references.push(...fileRefs.references);
    unparseable.push(...fileRefs.unparseable);
  }

  // (4) Spec 15 R2 — ORM-aware extraction (Drizzle + Prisma)
  references.push(...extractOrmRefs(ast, adapter, sourceCode));

  // (5) knex-style query-builder reads — db('table').select(...) / .where(...) / .first(...)
  references.push(...extractQueryBuilderRefs(ast, adapter, sourceCode, ctx));

  // (6) table-backed collection-facade constructors — new SqliteCollectionAdapter(db, 't')
  references.push(...extractCollectionAdapterRefs(ast, adapter, sourceCode));

  return { references, unresolved, unparseable };
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
): { references: TableReference[]; unparseable: UnparseableSql[] } {
  const { config, allTables, provenanceContext } = ctx;
  const references: TableReference[] = [];
  const unparseable: UnparseableSql[] = [];
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
    // Spec 70 (per-site dialect) — a tag imported from `postgres` (the `postgres`
    // package's `sql\`…\``) is postgres, not whatever the repo-level detection
    // names. Resolves from the tag identifier's package, else falls back.
    const siteDialect = resolveSiteDialect(callNode, adapter, sourceCode, provenanceContext);
    const parsed = parseSqlTables(
      templateText,
      location,
      sourceCode,
      allTables,
      siteDialect ?? config.sqlDialect ?? null,
      siteDialect ? null : (config.sqlDialectReason ?? null),
    );
    references.push(...parsed.references);
    unparseable.push(...parsed.unparseable);
  }

  return { references, unparseable };
}

/**
 * Spec 70 R1.2 — the schema family's DB-call admission funnels through
 * `identifyHandle` (the one entry point) instead of the boolean
 * `isDBProvenanced`. A `handle` or `unproven` verdict admits the call — an
 * `unproven` receiver whose type annotation is no longer a handle test
 * (criterion 9) stays visible so `unresolved-query` / `unparseable` report its
 * SQL as unreadable rather than silently clean; `not-handle` drops it. `null`
 * means "not a query-shaped call" (a non-DB/ORM method, or a name with no DB
 * signal at all). Admission is tri-state, not boolean.
 */
function dbCallVerdict(
  node: ASTNode,
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  ctx: FindTableReferencesContext,
): HandleVerdict | null {
  const { provenanceContext, config, handleEnv } = ctx;
  if (!provenanceContext || provenanceContext.mode === 'names') return null;

  const callee = getCallExpressionCallee(node, adapter);
  if (!callee) return null;

  // The declaration-resolution env `identifyHandle` reads. Production threads it
  // (`handleEnv`); a direct caller that seeded only `dbProvenanced` (unit tests)
  // falls back to a freshly-built env over that provenance — the same evidence the
  // boolean `isDBProvenanced` gate this replaced consumed, so a seeded-provenanced
  // receiver still admits and its SQL still reaches `parseSqlTables`.
  const env: RootResolutionEnv = handleEnv ?? {
    provenance: provenanceContext.dbProvenanced,
    bindings: buildBindingEnv(ast, adapter, sourceCode),
    adapter,
    sourceCode,
  };

  const dialect =
    resolveSiteDialect(node, adapter, sourceCode, provenanceContext) ??
    config.sqlDialect ?? null;

  const facts = (): Parameters<typeof identifyHandle>[1] => ({
    imports: new Map(),
    typeAnnotations: new Map(),
    bindings: new Map(),
    withinFileProvenance: new Map(),
    sqlDialect: dialect,
    resolution: { dialect: 'ts', env },
  });

  // Bare-identifier call (`query(…)` / `d1(…)`): a provenanced wrapper or a
  // type-annotated handle — the seam decides. A truly unbound name carries no DB
  // signal, so it is rejected before its SQL argument could prove handle-ness.
  if (callee.type === 'identifier') {
    const name = adapter.getNodeText(callee, sourceCode);
    if (!name) return null;
    const binding = env.bindings.get(name);
    const isProvenanced = provenanceContext.dbProvenanced.has(name);
    const isTypeAnnotated = !!binding && !!binding.typeText;
    if (!isProvenanced && !isTypeAnnotated) return null;
    return identifyHandle(
      {
        format: 'typescript',
        root: name,
        receiver: name,
        method: name,
        sqlArgument: getFirstStringArgument(node, adapter, sourceCode),
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
  // The package discriminant — not the method name — decides handle-ness
  // (`identifyHandle` below). No method-name set gates admission here.

  const root = resolveReceiverRoot(callee, adapter, sourceCode);
  if (root === null) return null;
  const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? root;

  return identifyHandle(
    {
      format: 'typescript',
      root,
      receiver,
      method,
      sqlArgument: getFirstStringArgument(node, adapter, sourceCode),
      thisField: receiverIsThisRootedLocal(callee, adapter),
    },
    facts(),
  );
}

/**
 * Walk a member chain to see whether it bottoms out at `this`/`super`.
 * @param callee - The member/selector expression to walk.
 * @param adapter - The language adapter (drives child access).
 * @returns True when the chain's root is `this` or `super`.
 */
export function receiverIsThisRootedLocal(callee: ASTNode, adapter: LanguageAdapter): boolean {
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
 * Strategy (2): DB-call patterns — e.g. db.exec("SELECT * FROM heroes").
 * Spec 70 R1.2: admission is decided once by {@link dbCallVerdict} (via
 * `identifyHandle`); a `handle` or `unproven` receiver is a DB call, a
 * `not-handle` receiver is not. There is no name-list fallback.
 */
function extractDbCallRefs(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  ctx: FindTableReferencesContext,
): TableReferenceResult {
  const { provenanceContext, allTables, config } = ctx;
  const references: TableReference[] = [];
  const unresolved: UnresolvedQuery[] = [];
  const unparseable: UnparseableSql[] = [];

  const dbCalls = adapter.findNodes(ast, {
    custom: (node: ASTNode) => {
      if (node.type !== 'call_expression') return false;
      const verdict = dbCallVerdict(node, ast, adapter, sourceCode, ctx);
      return verdict !== null && verdict.kind !== 'not-handle';
    },
  });

  for (const callNode of dbCalls) {
    // A string/template argument is always SQL text, for *every* DB-call method:
    // node-sqlite3's `db.all(sql, cb)` / `db.run(sql, cb)` pass SQL as a literal
    // just as D1's `db.prepare(sql)` does. "Is this argument SQL" is answered by
    // the resolved value's shape, not by a method name list (Spec 70): a string
    // literal is SQL, an array/object literal is a statements array / parameter
    // object (not SQL), and anything unreadable stays `unresolved`.
    const location = getCallLocation(callNode);
    const resolved = resolveQuerySql(callNode, ast, adapter, sourceCode);
    if (resolved.sqlText !== null) {
      // §13 — a static SQL argument in a SQL position (provenanced receiver) is
      // parsed, not regex-scanned. A named dialect that cannot parse it, or no
      // dialect at all, is `cannot-fire` — surfaced by `parseSqlTables` as an
      // unreadable statement rather than a silent empty reference set that
      // `unknown-table` / `stale-table-reference` would read as clean.
      // Spec 70 (per-site dialect) — the dialect is a property of the call site's
      // receiver, not the repo: `pool.query(…)` where `pool` → `pg` parses as
      // postgres even in a repo that also names `mysql2`. Falls back to the
      // repo-level detection result only when the receiver doesn't resolve to a
      // package (or resolves to a cross-dialect ORM).
      const siteDialect = resolveSiteDialect(callNode, adapter, sourceCode, provenanceContext);
      const parsed = parseSqlTables(
        resolved.sqlText,
        location,
        sourceCode,
        allTables,
        siteDialect ?? config.sqlDialect ?? null,
        siteDialect ? null : (config.sqlDialectReason ?? null),
      );
      references.push(...parsed.references);
      unparseable.push(...parsed.unparseable);
    } else if (resolved.unresolved !== null) {
      unresolved.push(resolved.unresolved);
    }
  }

  return { references, unresolved, unparseable };
}

/**
 * Strategy (4): ORM-aware extraction (Drizzle + Prisma) via the registered
 * adapter. Complements raw-SQL extraction by picking up ORM-specific patterns
 * like db.select().from(users) and prisma.user.findMany().
 * @param ast - The file's parsed AST.
 * @param adapter - The language adapter (for ORM adapter dispatch).
 * @param sourceCode - The file's source text.
 * @returns The ORM-extracted table references (empty when no ORM adapter applies).
 */
export function extractOrmRefs(
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
 * Strategy (5): knex-style fluent builder *reads* — the query-builder form
 * `db('table').select(...)` / `db('table').where(...)` / `db('table').first(...)`.
 *
 * The table selector is a *receiver call* (`db('table')`) whose first argument
 * is a string-literal table name — distinct from the `db.method(sql)` member-call
 * form strategy (2) handles. This is the same blindness the ORM adapters close
 * for Drizzle/Prisma: a fluent builder call carries the table in a receiver-call
 * argument, not a SQL keyword, so `parseSqlTables` never sees it. Without this,
 * a knex `db('cp_test').select('name')` leaves `cp_test` "written (create) but
 * never read" — a live written-never-read false positive.
 *
 * Only *reads* are recorded. Writes (`insert`/`update`/`del`) and the
 * schema-builder `createTable` form are deliberately left unrecorded: they are
 * overwhelmingly scratch/negative-test fixtures in a test-heavy corpus, and
 * recording them floods the cross-domain lifecycle rules with one-sided
 * `create`/`write` usages whose matching read is unparseable (`ages` in a
 * create-and-drop transaction test has no read at all). The query-builder read
 * is enough to *balance* a non-builder write/create (the cp_test case) — and a
 * fluent-only table is exempted from the one-sided lifecycle rules by the
 * `origin` discriminator in the cross-domain analyzer, so the read does not
 * mirror into a `read-never-written` flood.
 *
 * References are tagged `origin: 'query-builder'` so the naming-convention,
 * unknown-table, and (via the cross-domain discriminator) lifecycle checks skip
 * them — a scratch/test table name carried in a fluent builder call is not a
 * schema violation, and feeding it into unknown-table floods a test-heavy corpus
 * and flips the fail-open ratio.
 */

/** Knex/transaction receiver names for the fluent `receiver('table').method(` form.
 *  Spec 69 §10: this is a structural knex idiom, not a name-list fallback — the
 *  generic `db`/`database`/`sql`/`stmt` names are provenanced by declaration only. */
const QUERY_BUILDER_RECEIVER_NAMES = ['trx', 'knex'] as const;

/** Strategy (5): fluent query-builder reads — `trx('table').method(` and the
 *  `knex` receiver. Records the *read* only, tagged `origin: 'query-builder'`,
 *  so a scratch/test table name carried in a fluent builder call is not a schema
 *  violation and does not flood the naming/unknown-table/lifecycle checks.
 * @param ast - The file's parsed AST.
 * @param adapter - The language adapter (drives node discovery + text reads).
 * @param sourceCode - The file's source text.
 * @param ctx - Shared table-reference extraction context.
 * @returns The query-builder table references (read-only, `origin: 'query-builder'`). */
export function extractQueryBuilderRefs(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  ctx: FindTableReferencesContext,
): TableReference[] {
  const references: TableReference[] = [];
  const receivers = new Set<string>([...QUERY_BUILDER_RECEIVER_NAMES]);

  const calls = adapter.findNodes(ast, { type: 'call_expression' });
  for (const call of calls) {
    // Only the outermost call of a query chain carries the complete text and the
    // terminal method; the inner `db('table')` receiver call is its object. A
    // call that is itself the object of a parent member_expression is chained
    // further, so its text would truncate the terminal method and misclassify.
    if (isChainedFurther(call, adapter)) continue;

    const text = adapter.getNodeText(call, sourceCode);
    // `receiver('table')` as the leftmost call, followed by a chained method
    // call (the `.method(` is required — a bare `db('table')` is ambiguous).
    const m = /^([A-Za-z_$][\w$]*)\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.exec(text);
    if (!m) continue;
    const [, receiver, rawTable] = m;
    if (!receivers.has(receiver)) continue;

    const table = normalizeQueryBuilderTable(rawTable);

    references.push({
      table,
      type: 'select',
      location: call.location.start,
      context: `${receiver}(${table})`,
      origin: 'query-builder',
    });
  }

  return references;
}

/** Strip a SQL alias from a query-builder table selector — `accounts as a1` →
 *  `accounts`. Bare table names (and knex's deliberately-weird test names like
 *  `CREATE TABLE`) pass through unchanged. */
function normalizeQueryBuilderTable(table: string): string {
  return table.split(/\s+as\s+/i)[0].trim();
}

/**
 * Strategy (6): table-backed collection-facade constructors — e.g.
 * `new SqliteCollectionAdapter(db, 'project_tasks')`.
 *
 * `SqliteCollectionAdapter` (src/codeIndex/sqliteCollection.ts) is a
 * LokiJS-`Collection`-compatible facade over a SQLite table. Every statement it
 * issues interpolates the table from an instance field — `SELECT * FROM
 * "${this.tableName}"`, `INSERT INTO "${this.tableName}" (…)`, `UPDATE
 * "${this.tableName}" …`, `DELETE FROM "${this.tableName}" …` — so the keyword-
 * anchored `parseSqlTables` never sees the table name and the facade's reads and
 * writes are both invisible to the schema-usage fact. The one place the table
 * name is a string literal is the constructor call. Recognizing it records the
 * *read* (the `find`/`findOne` SELECT) so a table seeded by a migration and then
 * read through the facade is not flagged `written-never-read` — the
 * `project_tasks` case: `new SqliteCollectionAdapter(db, 'project_tasks')` with
 * reads through `this.tasksAdapter.find(...)`.
 *
 * Only the read is recorded, mirroring strategy (5)'s read-only choice: the
 * facade's write verbs (`insert`/`update`/`remove`/`clear`) back tables that
 * migrations already `CREATE`/`INSERT` seed, so the write is already in the fact
 * and recording a second, unsourceable write from the constructor would
 * double-count. The read is the missing half of the lifecycle pair. References
 * are tagged `origin: 'collection-adapter'` — a real schema table, so naming/
 * unknown-table checks still run on it (unlike 'query-builder'), but the
 * discriminator lets the cross-domain analyzer recognise a table that is *only*
 * seen through a facade.
 */
const COLLECTION_ADAPTER_NAMES: ReadonlySet<string> = new Set(['SqliteCollectionAdapter']);

/** Strategy (6): table-backed collection-facade constructors — `new
 *  SqliteCollectionAdapter(db, 'table')`. Records the *read* the facade issues
 *  (tagged `origin: 'collection-adapter'`) so a migration-seeded table read
 *  through a facade is not flagged `written-never-read`; the facade's writes are
 *  already seeded by migrations and left unrecorded to avoid double-counting.
 * @param ast - The file's parsed AST.
 * @param adapter - The language adapter (drives `new_expression` discovery).
 * @param sourceCode - The file's source text.
 * @returns The collection-facade table references (`origin: 'collection-adapter'`). */
export function extractCollectionAdapterRefs(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): TableReference[] {
  const references: TableReference[] = [];
  const constructors = adapter.findNodes(ast, { type: 'new_expression' });
  for (const node of constructors) {
    const text = adapter.getNodeText(node, sourceCode).trim();
    // `new SqliteCollectionAdapter(db, 'project_tasks')` — the first argument is
    // the shared handle, the second is the literal table name the facade backs.
    // `[^,]+` for the handle tolerates `this.db` / `db` / any receiver expression.
    const m = /^new\s+([A-Za-z_$][\w$]*)\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]/.exec(text);
    if (!m || !COLLECTION_ADAPTER_NAMES.has(m[1])) continue;
    references.push({
      table: m[2],
      type: 'select',
      location: node.location.start,
      context: `new ${m[1]}(…, '${m[2]}')`,
      origin: 'collection-adapter',
    });
  }
  return references;
}

/** True when `call` is the object of a parent member_expression (it is chained
 *  into a further `.method(...)`), so it is not the outermost call of its chain. */
function isChainedFurther(call: ASTNode, adapter: LanguageAdapter): boolean {
  const parent = adapter.getParent(call);
  if (!parent || adapter.getNodeType(parent) !== 'member_expression') return false;
  const object = adapter.getChildren(parent).find((c) => {
    const t = adapter.getNodeType(c);
    return t !== 'property_identifier' && t !== 'field_identifier' && t !== '.';
  });
  return object === call;
}

/**
 * Parse SQL table names from a SQL text string via the node-sql-parser AST
 * (Spec 70 §13). This is the schema family's successor to the keyword-regex
 * scanner: relations come from a typed statement walk (`collectTypedRelations`),
 * so a `FROM`/`JOIN`/`INSERT INTO`/`UPDATE`/`DELETE`/`CREATE TABLE` is read
 * exactly where the grammar says it is, and a CTE name or an `ALTER … RENAME`
 * target is subtracted from the walk instead of regex-guessed.
 *
 * Contract (Spec 70): a named dialect that cannot parse the SQL is *unreadable*,
 * not "no tables". A null dialect does not skip the parse (R2: parsing a literal
 * does not require proving the site's dialect first) — the SQL is attempted under
 * {@link DEFAULT_SQL_DIALECT}; when it parses, the tables are derived; when it
 * fails, the record is `cannot-fire` naming **both** the parse failure and the
 * undetermined dialect (the failure may be dialect-specific syntax). Either way
 * a failure is returned as an `unparseable` record, never a silent empty
 * reference set that `unknown-table` / `stale-table-reference` would read clean.
 *
 * @param sqlText The SQL text to parse.
 * @param baseLocation The line/column of the SQL text's start in `sourceCode`.
 * @param sourceCode The full source text (for offset-to-location mapping).
 * @param allTables Known-table catalog used to keep short (1–2 char) identifiers.
 * @param dialect The corpus's named dialect, or null when detection named none.
 * @param dialectReason Why `dialect` is null (for the cannot-fire message).
 * @returns Table references parsed from the SQL, plus unparseable statements.
 */
export function parseSqlTables(
  sqlText: string,
  baseLocation: { line: number; column: number },
  sourceCode: string,
  allTables: Set<string> | undefined,
  dialect: Dialect | null,
  dialectReason: string | null,
): { references: TableReference[]; unparseable: UnparseableSql[] } {
  const references: TableReference[] = [];
  const unparseable: UnparseableSql[] = [];
  const trimmed = sqlText.trim();
  if (trimmed.length === 0) return { references, unparseable };

  const program = parseSqlProgramTolerant(sqlText, dialect ?? DEFAULT_SQL_DIALECT);
  for (const failure of program.failures) {
    unparseable.push({
      sqlText,
      location: baseLocation,
      reason: dialect === null
        ? `${dialectReason ?? 'dialect undetermined (no database driver in package.json or wrangler.toml)'} — and the SQL does not parse under the default ${DEFAULT_SQL_DIALECT} grammar: ${failure.reason}`
        : failure.reason,
      kind: dialect === null ? 'dialect-undetermined' : 'parse-failure',
    });
  }
  if (program.statements.length === 0) return { references, unparseable };

  // Anchor the SQL text against the source exactly once. The raw `sqlText`
  // (still carrying `${…}`) appears verbatim in the source; the normalized
  // parse input does not. An absent match is a bug, not a fallback — throw
  // rather than mis-place every reference onto a wrong line.
  const sqlAbs = sourceCode.indexOf(sqlText);
  if (sqlAbs < 0) {
    throw new Error(
      `parseSqlTables: SQL text not found in source — a table reference that cannot be anchored is a bug, not something to mis-place.`,
    );
  }

  references.push(...extractSqlTables(
    collectTypedRelations(program.statements, new Set(program.truncatedConflictIndices)),
    sqlText,
    sqlAbs,
    baseLocation,
    sourceCode,
    allTables,
  ));
  return { references, unparseable };
}

/**
 * Convert typed AST relations into `TableReference`s, applying the same guards
 * the regex scanner applied (system tables, table-valued functions, SQL
 * keywords, short 1–2-char identifiers) and anchoring each to its source line.
 */
function extractSqlTables(
  relations: readonly TypedRelation[],
  sqlText: string,
  sqlAbs: number,
  baseLocation: { line: number; column: number },
  sourceCode: string,
  allTables: Set<string> | undefined,
): TableReference[] {
  const references: TableReference[] = [];
  const lowerSql = sqlText.toLowerCase();
  for (const rel of relations) {
    const table = rel.table;
    if (isSystemTable(table)) continue;
    if (rel.db !== null && isSystemTable(`${rel.db}.${table}`)) continue;
    if (isTableValuedFunction(table)) continue;
    if (isSqlKeyword(table)) continue;
    // Short 1–2-char identifiers are almost always CTE names / bare aliases
    // (`x`, `t`, `o`) rather than real tables; keep one only when the catalog
    // names it. (CTE names are already subtracted by collectTypedRelations.)
    if (table.length < 3 && !allTables?.has(table.toLowerCase())) continue;

    const qualified = rel.db !== null ? `${rel.db}.${table}` : table;
    references.push({
      table,
      type: rel.type,
      location: anchorTable(table, lowerSql, sqlAbs, baseLocation, sourceCode),
      context: `${rel.type} ${qualified}`,
      ...(rel.conflictClauseTruncated ? { conflictClauseTruncated: true } : {}),
    });
  }
  return references;
}

/**
 * Anchor a table name to its source location. The node-sql-parser AST is
 * location-free, so the anchor is the first case-insensitive occurrence of the
 * bare name within the SQL text — a line-level attribution good enough for the
 * lifecycle rules' per-function re-homing. When the name is not found (a quoted
 * identifier the parser normalized, or a name only present via a substitution),
 * fall back to the SQL text's own start.
 */
function anchorTable(
  table: string,
  lowerSql: string,
  sqlAbs: number,
  baseLocation: { line: number; column: number },
  sourceCode: string,
): { line: number; column: number } {
  const idx = lowerSql.indexOf(table.toLowerCase());
  const rel = idx >= 0 ? idx : 0;
  return offsetToLocation(sourceCode, sqlAbs + rel, baseLocation);
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
    // Fluent-builder references carry a dynamic table string whose name is a
    // test/scratch fixture, not a declared schema name — naming conformance
    // (snake_case / reserved-word) is a property of the schema, not the call.
    if (ref.origin === 'query-builder') continue;

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

  // Spec 55 R3 — too-many-queries is a query-shape rule excluded from test files.
  // `skipTestFiles: false` overrides (oracle fixtures assert positive detections).
  if (config.skipTestFiles !== false && isTestOrSpecPath(ast.filePath)) return violations;

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

/**
 * One dynamic-SQL-construction candidate: a dangerous query/execute call site
 * that survived the parameterized-query and taint-safety filters. The
 * serializable projection the `dynamic-sql` fact carries and the
 * `dynamic-sql-construction` rule reads — `symbol` is the stable per-file key
 * (the legacy finding's `functionName`), `enclosingFn` the bare function label
 * the message interpolates.
 */
export interface DynamicSqlCandidate {
  file: string;
  line: number;
  column: number;
  enclosingFn: string;
  symbol: string;
}

/** Bundled inputs for the per-match injection check. */
interface InjectionCheckContext {
  ast: AST;
  adapter: LanguageAdapter;
  sourceCode: string;
  symbolOrdinals: Map<string, number>;
}

/**
 * Evaluate a single dangerous-pattern match: skip parameterized queries and
 * taint-safe dynamic strings, else produce a dynamic-sql-construction candidate.
 */
function collectInjectionMatch(ctx: InjectionCheckContext, match: RegExpExecArray): DynamicSqlCandidate | null {
  const { ast, adapter, sourceCode, symbolOrdinals } = ctx;

  const location = offsetToLocation(sourceCode, match.index, { line: 1, column: 1 });

  // Find enclosing function from the AST at this position
  const node = findClosestNodeAt(ast.root, location, adapter);
  const callNode = findEnclosingCallExpression(node, adapter);

  // Parameterized queries pass a bound-params argument (`query(sql, params)`).
  // When the matched literal's enclosing call carries a second argument, the
  // interpolated `${...}` segments are compile-time clauses whose `?`
  // placeholders are bound by that argument — not an injection vector.  This is
  // checked at the *call* level (two source forms below), not by looking for a
  // comma immediately after the match: a *nested* template fragment inside the
  // first argument — `query(\`...\${scope ? \` WHERE \${scope.clause}\` : ''}\`,
  // scope?.params)` — ends the regex match at the inner template's backtick, so
  // the `,` lands several characters later and a bare `^\s*,` lookahead misses
  // it.  The data-access analyzer's checkQuerySecurity applies the same signal.
  const afterMatch = sourceCode.slice(match.index + match[0].length);
  if (/^\s*,/.test(afterMatch) || (callNode && callHasBindParams(callNode, adapter))) {
    return null;
  }

  // Taint-aware safety check (Spec 33 Item 11a): clear the finding when the
  // query argument's dynamic parts are all provably safe. The naive regex
  // cannot tell trusted-DDL interpolation (`query(\`CREATE TABLE ${name}...\`)`
  // with a constant/sanitized name) from raw-input interpolation, so the
  // distinction is delegated to the adapter's dynamic-string safety analysis
  // (isSafeInterpolation / resolveLocalConstant) — the same signal the
  // data-access analyzer already trusts for sql-injection-risk.
  if (callNode && isAllDynamicPartsSafe(callNode, ast, adapter, sourceCode)) {
    return null;
  }

  const enclosingFn = node ? functionIdentityLabel(findEnclosingFunctionIdentity(node, adapter, ast.filePath)) : 'top-level';

  const baseSymbol = `${enclosingFn}:dynamic-sql-construction`;
  const ordinal = (symbolOrdinals.get(baseSymbol) ?? 0) + 1;
  symbolOrdinals.set(baseSymbol, ordinal);
  const symbol = ordinal > 1 ? `${baseSymbol}:${ordinal}` : baseSymbol;

  return { file: ast.filePath, line: location.line, column: location.column, enclosingFn, symbol };
}

/**
 * Detect potential SQL injection in query/execute calls.
 *
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @returns SQL-injection violations.
 */
export function collectDynamicSqlCandidates(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string
): DynamicSqlCandidate[] {
  const candidates: DynamicSqlCandidate[] = [];
  const ctx: InjectionCheckContext = {
    ast,
    adapter,
    sourceCode,
    symbolOrdinals: new Map<string, number>(),
  };

  for (const pattern of DANGEROUS_SQL_PATTERNS) {
    // Clone regex to reset state (global regexes track lastIndex)
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(sourceCode)) !== null) {
      const candidate = collectInjectionMatch(ctx, match);
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}

/**
 * Detect potential SQL injection in query/execute calls (legacy emission form).
 *
 * Maps the collected candidates — the exact set `collectDynamicSqlCandidates`
 * returns — to schema violations, so the legacy path and the phase path cannot
 * diverge (parity by construction).
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
  return collectDynamicSqlCandidates(ast, adapter, sourceCode).map((c) =>
    createSchemaViolation(
      c.file,
      { line: c.line, column: c.column },
      `SQL query built via string interpolation or concatenation in ${c.enclosingFn}; use parameterized queries.`,
      // User-controlled SQL built by interpolation is injectable now — critical.
      { severity: 'critical', rule: 'dynamic-sql-construction', symbol: c.symbol }
    )
  );
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

/** True when the call expression carries a second argument — the bound-params
 *  argument of a parameterized `query(sql, params)` / `execute(sql, params)`.
 *  Mirrors the argument-count signal `isWrapperFunctionWithBindParams` uses. */
function callHasBindParams(callNode: ASTNode, adapter: LanguageAdapter): boolean {
  const args = adapter.getChildren(callNode).find(c => adapter.getNodeType(c) === 'arguments');
  if (!args) return false;
  const realArgs = adapter.getChildren(args).filter(
    c => !['(', ')', ','].includes(adapter.getNodeType(c)),
  );
  return realArgs.length >= 2;
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
    ref =>
      ref.origin !== 'query-builder' &&
      !allTables.has(ref.table) &&
      !isSystemTable(ref.table) &&
      !isTableValuedFunction(ref.table)
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
      const text = adapter.getNodeText(child, sourceCode).trim();
      // A template literal's source text includes its surrounding backticks
      // (`` `SELECT …` ``). node-sql-parser rejects a statement wrapped in
      // backticks, so strip them before handing the SQL to the AST parser —
      // the same unwrap `getFirstStringArgument` already does for string args.
      if (text.startsWith('`') && text.endsWith('`')) {
        return text.slice(1, -1);
      }
      return text;
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
 * Get the first identifier argument of a call expression, or null when the
 * first argument is not a bare identifier (string/template literals, member
 * expressions, etc. are excluded — those are handled by other paths).
 *
 * @param node The call_expression node.
 * @param adapter The language adapter for the file's syntax.
 * @returns The first identifier argument node, or null.
 */
export function getFirstIdentifierArgument(node: ASTNode, adapter: LanguageAdapter): ASTNode | null {
  if (!node.children) return null;
  for (const child of node.children) {
    if (adapter.getNodeType(child) !== 'arguments') continue;
    if (!child.children) return null;
    for (const arg of child.children) {
      if (adapter.getNodeType(arg) === 'identifier') return arg;
    }
  }
  return null;
}

/**
 * Strip surrounding quotes/backticks from a string/template literal's raw text.
 * Returns null when the text is not a string literal (e.g. a call result or
 * binary expression), which is how unresolvable SQL is distinguished.
 */
function unquoteLiteral(text: string): string | null {
  const t = text.trim();
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith('`') && t.endsWith('`'))
  ) {
    return t.slice(1, -1);
  }
  return null;
}

/**
 * True when an initializer's source text is a structured literal — an array
 * (`[...]`) or object (`{...}`) — rather than a string, call result, or
 * identifier. A DB-call first argument that resolves to a structured literal
 * is a statements array / bound-parameter object, not SQL text.
 */
function isStructuredLiteral(text: string): boolean {
  const t = text.trim();
  return t.startsWith('[') || t.startsWith('{');
}

/**
 * Resolve the SQL text held by a DB call's first argument.
 *
 * Strategy: a direct string/template argument is used as-is. Otherwise, a bare
 * identifier argument is resolved via the adapter's `resolveLocalConstant`
 * capability — a same-module `const` bound to a string/template literal yields
 * its SQL text (template substitutions are left in place; `parseSqlTables`
 * resolves them).
 *
 * "Is this argument SQL" is answered by the resolved value's shape, not by a
 * method name list (Spec 70): a string/template literal is SQL; an array/object
 * literal is a statements array or parameter object (not SQL, so it is skipped
 * rather than reported as unresolvable); anything unreadable (imported constant,
 * reassigned/concatenated expression, call result, parameter, unsupported
 * language) is reported as `unresolved` so the query is not silently treated as
 * table-free.
 *
 * @param callNode The DB call_expression node.
 * @param ast The full AST (for local-constant scope traversal).
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @returns The resolved SQL text, an unresolved-query record, or neither.
 */
export function resolveQuerySql(
  callNode: ASTNode,
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): { sqlText: string | null; unresolved: UnresolvedQuery | null } {
  // Direct string/template argument — the common, fully-static path. This runs
  // for every DB-call method (node-sqlite3 `db.all(sql)` / `db.run(sql)` pass
  // SQL as a literal, not just `prepare`/`exec`).
  const direct = getFirstStringArgument(callNode, adapter, sourceCode);
  if (direct !== null) return { sqlText: direct, unresolved: null };

  // Bare identifier argument — resolve the local constant.
  const identNode = getFirstIdentifierArgument(callNode, adapter);
  if (!identNode) return { sqlText: null, unresolved: null };

  const identifier = adapter.getNodeText(identNode, sourceCode).trim();
  const location = getCallLocation(callNode);
  if (!identifier) return { sqlText: null, unresolved: null };

  if (!adapter.resolveLocalConstant) {
    // Language has no constant-resolution capability (e.g. Go) — can't resolve.
    return { sqlText: null, unresolved: { identifier, location } };
  }

  const resolved = adapter.resolveLocalConstant(identNode, ast, sourceCode);
  if (!resolved || resolved.initText === '__imported_constant__') {
    // Imported constant (initText sentinel) or unresolvable identifier.
    return { sqlText: null, unresolved: { identifier, location } };
  }

  const sqlText = unquoteLiteral(resolved.initText);
  if (sqlText === null) {
    // initText is not a string literal. A structured literal (array/object) is
    // a statements array / parameter object, not SQL — skip it. Anything else
    // (call result, binary expr, chained identifier `const B = A`) cannot be
    // statically read, so the query is genuinely unseen.
    if (isStructuredLiteral(resolved.initText)) {
      return { sqlText: null, unresolved: null };
    }
    return { sqlText: null, unresolved: { identifier, location } };
  }

  return { sqlText, unresolved: null };
}

/**
 * Build `unresolved-query` coverage diagnostics for DB calls whose SQL argument
 * could not be statically resolved. Reporting (rather than skipping) is what
 * keeps the read/written-never lifecycle rules from silently over-claiming on a
 * file whose DB access is only partly visible. These are diagnostics — "the
 * tool could not see this query" — not findings that the code is wrong, so they
 * are non-blocking (see CoverageDiagnostic).
 * @param unresolved The unresolved-query records to report.
 * @param filePath The file path the diagnostics belong to.
 * @returns Coverage diagnostics for each unresolved query.
 */
export function checkUnresolvedQueries(unresolved: UnresolvedQuery[], filePath: string): CoverageDiagnostic[] {
  return unresolved.map((u) => ({
    analyzerName: 'schema',
    kind: 'unresolved-query',
    message: `Query SQL is held in an identifier ('${u.identifier}') that cannot be statically resolved — its table read/write status is unknown, so cross-domain lifecycle rules (read-never-written, written-never-read) may be unreliable for this file.`,
    file: filePath,
    line: u.location.line,
    details: { identifier: u.identifier },
  }));
}

/**
 * Build `cannot-fire` coverage diagnostics for DB-call SQL whose static string
 * argument a named dialect cannot parse (`PRAGMA table_info(x)`, `VACUUM`,
 * `ANALYZE`, and other grammar gaps). These are the SQL-position siblings of the
 * unresolvable-identifier `unresolved-query` diagnostic: the argument *is* read,
 * but the parser cannot answer "which tables", so the table-read/write facts are
 * unreadable rather than "no tables". Reporting (rather than letting
 * `unknown-table` / `stale-table-reference` read an empty reference set as clean)
 * is what keeps an unparseable statement visibly unreadable (Spec 70 R2).
 *
 * @param unparseable The unparseable-SQL records to report.
 * @param filePath The file path the diagnostics belong to.
 * @returns One `cannot-fire` diagnostic per unparseable SQL argument.
 */
export function checkUnparseableSql(unparseable: UnparseableSql[], filePath: string): CoverageDiagnostic[] {
  return unparseable.map((u) => {
    const why =
      u.kind === 'parse-failure'
        ? `cannot be parsed ('${u.reason}')`
        : `is ${u.reason}`;
    return {
      analyzerName: 'schema',
      kind: 'cannot-fire',
      message: `SQL statement ${why} — its table read/write status is unreadable, so cross-domain lifecycle rules (unknown-table, stale-table-reference) may be unreliable for this file.`,
      file: filePath,
      line: u.location.line,
      details: { sql: u.sqlText, reason: u.reason, kind: u.kind },
    };
  });
}

/**
 * Build `cannot-fire` coverage diagnostics for DB-looking imports whose
 * specifier could not be resolved to an in-repo file. This is the Spec 69 §10
 * coverage-parity signal: the deleted `DB_RECEIVER_NAMES` name-list fallback
 * used to mark a receiver named `db`/`database`/`sql`/`stmt` as DB-provenanced
 * even without a declaration. With that gone, a receiver imported from a
 * non-resolvable `./db`-style specifier can no longer be provenanced by
 * declaration, so any DB access through it is unseen. Reporting that as
 * `cannot-fire` (rather than letting the affected rules report `clean`) is what
 * prevents a silent regression — the coverage count must rise by exactly the
 * amount the finding count falls.
 *
 * @param unresolved The unresolved-import records for this file (already
 *   filtered to the current file by the caller).
 * @param filePath The file path the diagnostics belong to.
 * @returns One `cannot-fire` diagnostic per unresolved DB-looking import.
 */
export function checkUnresolvedReceiverImports(
  unresolved: Array<{ source: string; names: string[] }>,
  filePath: string,
): CoverageDiagnostic[] {
  return unresolved.map((u) => {
    const reason =
      `import of ${u.names.length > 0 ? u.names.map((n) => `'${n}'`).join(', ') : 'a DB receiver'} ` +
      `from '${u.source}' does not resolve to an in-repo file, so its DB provenance cannot be ` +
      `established by declaration`;
    return {
      analyzerName: 'schema',
      kind: 'cannot-fire',
      message:
        `${reason}. DB access through this receiver is unseen: table-reference ` +
        `and data-access rules may report clean on access they could not observe.`,
      file: filePath,
      line: 0,
      // `reason` carries the same "why" the call-site shape (`checkUnprovenQueryReceivers`)
      // carries in `details.reason` — a consumer reading `details.reason` must never
      // see `undefined` for an unproven receiver, whichever emission path produced it.
      details: { source: u.source, names: u.names, reason },
    };
  });
}

/**
 * Build `cannot-fire` coverage diagnostics for query-shaped call sites whose
 * receiver is unproven (Spec 69 §10 S5a — disposition replaces step-failure).
 *
 * The §10 guard is keyed to *the question being unanswered*, not to a resolution
 * step failing: an unproven receiver — whether an unresolved import, a runtime
 * binding (`env.DB`), an unannotated parameter, or a `new <wrapper-class>()` the
 * resolution does not trace — must report `cannot-fire` with a reason, never
 * `clean`. This is the per-call-site complement to
 * {@link checkUnresolvedReceiverImports} (which is keyed to the import alone).
 *
 * @param unproven The unproven-query-receiver records for this file.
 * @param filePath The file path the diagnostics belong to.
 * @returns One `cannot-fire` diagnostic per unproven query receiver.
 */
export function checkUnprovenQueryReceivers(
  unproven: Array<{ receiver: string; method: string; line: number; reason: string }>,
  filePath: string,
): CoverageDiagnostic[] {
  return unproven.map((u) => ({
    analyzerName: 'schema',
    kind: 'cannot-fire',
    message:
      `Query-shaped call \`.${u.method}()\` on ${u.receiver}: ${u.reason}`,
    file: filePath,
    line: u.line,
    details: { receiver: u.receiver, method: u.method, reason: u.reason },
  }));
}

/**
 * Deduplicate `cannot-fire` diagnostics so one receiver gets one disposition
 * (Spec 69 §10 Q3).
 *
 * Two emission paths can both report the same unanswered question — "is this
 * receiver a DB handle?" — for one receiver:
 *
 *   - {@link checkUnresolvedReceiverImports} — keyed to the *import* (`line: 0`,
 *     `details.names`) for a receiver imported from an unresolvable `./db`-style
 *     specifier.
 *   - {@link checkUnprovenQueryReceivers} — keyed to the *call site* (real line,
 *     `details.receiver`) for a query-shaped call through an unproven receiver.
 *
 * A receiver imported from an unresolvable specifier *and* called at a query
 * site therefore produced two diagnostics for one unanswered question, doubling
 * the coverage count and making the §10 finding↔coverage arithmetic reconcile
 * when it should not.
 *
 * The call-site diagnostic wins: it carries the precise line and method. The
 * import-level diagnostic is dropped for each name the call-site path already
 * dispositioned (compared by bare receiver name — `this.db` → `db`), and
 * survives only for names imported but never called, where it is the sole
 * signal that a receiver is unseen.
 *
 * @param diagnostics The merged `cannot-fire` diagnostics for one file.
 * @returns The same diagnostics, with redundant import-level signals removed.
 */
export function dedupeCannotFireByReceiver(diagnostics: CoverageDiagnostic[]): CoverageDiagnostic[] {
  const callSiteReceivers = new Set<string>();
  for (const d of diagnostics) {
    const receiver = d.details?.receiver;
    if (typeof receiver !== 'string' || receiver.length === 0) continue;
    const bare = receiver.split('.').pop() ?? receiver;
    callSiteReceivers.add(`${d.file} ${bare}`);
  }

  const out: CoverageDiagnostic[] = [];
  for (const d of diagnostics) {
    const names = d.details?.names;
    if (Array.isArray(names) && d.line === 0) {
      const remaining = names.filter(
        (n) => typeof n === 'string' && !callSiteReceivers.has(`${d.file} ${n}`),
      );
      if (remaining.length === 0) continue; // fully dispositioned by the call-site path
      out.push({ ...d, details: { ...d.details, names: remaining } });
    } else {
      out.push(d);
    }
  }
  return out;
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

const TABLE_VALUED_FUNCTIONS: ReadonlySet<string> = new Set([
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

const SQL_KEYWORDS: ReadonlySet<string> = new Set([
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
  return TABLE_VALUED_FUNCTIONS.has(name.toLowerCase());
}

/**
 * Common SQL keywords and identifiers that are not real table names.
 *
 * @param word The candidate identifier.
 * @returns True when `word` is a SQL keyword/reserved identifier.
 */
export function isSqlKeyword(word: string): boolean {
  return SQL_KEYWORDS.has(word.toLowerCase());
}

/**
 * SQL statement keyword patterns that mark a query. Shared by the standalone
 * SQL-keyword pass and the `.exec`-body probe so the two can never drift. A
 * bare `UPDATE` keyword is counted, but not the `DO UPDATE` / `KEY UPDATE`
 * clause of an upsert (`INSERT … ON CONFLICT … DO UPDATE` /
 * `INSERT … ON DUPLICATE KEY UPDATE`) — that clause is part of the one INSERT
 * statement, not a second query (Spec 52 R2).
 */
const SQL_QUERY_PATTERNS: ReadonlyArray<{ keyword: string; pattern: RegExp }> = [
  { keyword: 'SELECT', pattern: /SELECT\s+/gi },
  { keyword: 'INSERT', pattern: /INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?\s+INTO|REPLACE\s+INTO/gi },
  { keyword: 'UPDATE', pattern: /(?<!DO\s)(?<!KEY\s)UPDATE\s+/gi },
  { keyword: 'DELETE', pattern: /DELETE\s+FROM/gi },
];

/** Number of SQL-statement keyword occurrences a text slice contains.
 *
 * @param text The text slice to count SQL keywords over.
 * @returns The number of SQL-statement keyword occurrences.
 */
export function countSqlKeywordOccurrences(text: string): number {
  let count = 0;
  for (const { pattern } of SQL_QUERY_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

/** Located SQL-keyword occurrences — the offset form of
 *  {@link countSqlKeywordOccurrences}, returning each keyword's start offset and
 *  its label. The caller passes call-body-stripped text (same length as the
 *  original, so offsets map 1:1 onto it). */
function findSqlKeywordOffsets(text: string): QuerySiteOffset[] {
  const sites: QuerySiteOffset[] = [];
  for (const { keyword, pattern } of SQL_QUERY_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      sites.push({ offset: m.index, method: keyword });
    }
  }
  return sites;
}

/** A located query site: the character offset of the site's method name plus a
 *  mechanism label. The producer converts the offset to a line/column. */
export interface QuerySiteOffset {
  offset: number;
  method: string;
}

/**
 * Locate every DB-query site in a source slice — the located counterpart of
 * {@link countQueries}. The three components match `countQueries` exactly (the
 * eager execution-method call sites, the `.exec`-with-SQL sites, and the
 * standalone SQL-keyword sites over the call-body-stripped text), so the two can
 * never drift: `countQueries` is `extractQuerySiteOffsets(...).length`. Each
 * site's `offset` points at the method name (for a call) or keyword start (for a
 * standalone keyword), and `method` is the label the fact carries.
 *
 * @param text The source slice to scan.
 * @returns One located site per query the slice issues.
 */
export function extractQuerySiteOffsets(text: string): QuerySiteOffset[] {
  const sites: QuerySiteOffset[] = [];

  // Eager execution-method call sites.
  const callRe = /\.(query|execute|run|first|raw|batch)\b[^()\n]*\(|(?<!Promise)\.(all)\b[^()\n]*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    sites.push({ offset: m.index + 1, method: m[1] ?? m[2] });
  }

  // `.exec(...)` sites whose balanced body carries a SQL keyword.
  const execRe = /\.exec\b[^()\n]*\(/g;
  while ((m = execRe.exec(text)) !== null) {
    const openParen = m.index + m[0].length;
    const i = scanBalancedParens(text, openParen);
    if (countSqlKeywordOccurrences(text.slice(openParen, i - 1)) > 0) {
      sites.push({ offset: m.index + 1, method: 'exec' });
    }
    execRe.lastIndex = i;
  }

  // Standalone SQL keywords outside recognized call bodies.
  sites.push(...findSqlKeywordOffsets(stripQueryCallBodies(text)));

  return sites;
}

/**
 * Count the number of DB queries a function body issues — by *call site*, not
 * by SQL literal (defect #47: counting literals made parameterizing a query into
 * a ternary of three template strings read as three queries).
 *
 * - An eager execution method call (`.run()`/`.all()`/`.first()`/`.raw()`/
 *   `.batch()`, plus the generic `.query()`/`.execute()` wrappers) is one query.
 * - Each `.exec()` whose body carries a SQL keyword is one query. `.exec` is
 *   matched this way — not as a bare eager method — because `regex.exec()` and
 *   `child_process.exec()` are too common to distinguish by name; the SQL-keyword
 *   probe keeps those at zero while collapsing a parameterized
 *   `db.exec(a ? 'SELECT x' : b ? 'SELECT y' : 'SELECT z')` to a single call site.
 * - A standalone SQL keyword outside any recognized DB-call body is one query.
 *
 * SQL keywords inside a recognized call's argument are NOT counted separately —
 * otherwise a single `run('SELECT ...')` is counted twice (once for the call,
 * once for the SQL it carries). `.prepare()` bodies are stripped too (Spec 52
 * R1): preparation is statement construction, not execution, so its SQL is not
 * a query — but `db.prepare(sql).bind(x).run()` still counts one for the eager
 * `.run()`. `Promise.all(...)` is not a query and is excluded from the `.all()`
 * count. Optional TypeScript type arguments (`.all<Row>()`/`.first<Row>()`) are
 * matched.
 *
 * @param text The function body text.
 * @returns The number of DB queries the function issues.
 */
export function countQueries(text: string): number {
  return extractQuerySiteOffsets(text).length;
}

/**
 * Scan forward from just after an opening `(` (at `openParen`) to the matching
 * closing `)`, honouring nested parens. Returns the index just past the closing
 * paren — the position scanning should resume from. Shared by the `.exec`-body
 * probe and the eager-call body stripper so their balanced-paren walks cannot
 * drift.
 */
function scanBalancedParens(text: string, openParen: number): number {
  let depth = 1;
  let i = openParen;
  while (i < text.length && depth > 0) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    i++;
  }
  return i;
}

/**
 * Count `.exec(...)` calls whose balanced body carries a SQL statement keyword.
 * This is the only way `.exec` is counted: `db.exec('SELECT …')` is one query,
 * while `regex.exec(str)` and `child_process.exec('ls')` carry no SQL keyword and
 * stay at zero. A parameterized ternary (`db.exec(a ? 'SELECT x' : b ? 'SELECT y' : 'SELECT z')`)
 * is one call site, so its three literals collapse to a single count.
 */
function countExecCallsWithSql(text: string): number {
  const re = /\.exec\b[^()\n]*\(/g;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const openParen = m.index + m[0].length;
    const i = scanBalancedParens(text, openParen);
    if (countSqlKeywordOccurrences(text.slice(openParen, i - 1)) > 0) count++;
    re.lastIndex = i;
  }
  return count;
}

/**
 * Blank out the bodies of eager execution method calls (`.run()`/`.all()`/
 * `.first()`/`.raw()`/`.batch()`/`.query()`/`.execute()`) and of `.prepare()`
 * and `.exec()` calls (balanced-paren aware) so SQL keywords inside their
 * arguments are not double-counted. `.prepare()` carries SQL but does not
 * execute it (Spec 52 R1), so its body is stripped too. `.exec()` is stripped
 * because its SQL is counted by `countExecCallsWithSql` instead of leaking into
 * the standalone-keyword pass. `Promise.all(...)` is not a query and is left
 * intact so the DB calls it contains stay visible.
 *
 * @param text The function body text.
 * @returns The text with eager/`query`/`execute`/`prepare`/`exec` call bodies replaced by spaces.
 */
function stripQueryCallBodies(text: string): string {
  const re = /\.(?:query|execute|exec|prepare|run|first|raw|batch)\b[^()\n]*\(|(?<!Promise)\.all\b[^()\n]*\(/g;
  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const openParen = m.index + m[0].length;
    const i = scanBalancedParens(text, openParen);
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
 * Identity of the function enclosing a node: its 1-based start coordinate plus
 * an optional declaration name. Function identity is a *coordinate*, not a name
 * — the source position is what uniquely and stably distinguishes one anonymous
 * arrow from another on the same line, where a name (or the full body text)
 * cannot. Display name is a separate, nullable field.
 *
 * The coordinate is never null: a top-level usage (outside any function) carries
 * its own start coordinate rather than NULL, so two top-level usages in the same
 * file are distinct keys instead of collapsing into one absent-coordinate bucket.
 * `filePath` makes the coordinate self-contained across files.
 */
export interface FunctionIdentity {
  /** Absolute path of the source file — makes the coordinate self-contained. */
  filePath: string;
  /** Enclosing function's 1-based start line; for a top-level usage, the usage's own line. */
  startLine: number;
  /** Enclosing function's 1-based start column; for a top-level usage, the usage's own column. */
  startColumn: number;
  /** Declaration name (e.g. `function foo`, `method bar`); null when anonymous or top level. */
  name: string | null;
  /** True when the node is outside any function (the coordinate is then the usage's own). */
  topLevel: boolean;
}

const FUNCTION_NODE_TYPES = new Set([
  'arrow_function',
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function_expression',
  'method_definition',
]);

/**
 * Walk up the AST from `node` to the enclosing function or method and return its
 * identity (start coordinate + nullable declaration name). A top-level identity
 * means the node is outside any function; it carries the node's own coordinate
 * (so top-level usages stay distinct) rather than NULL.
 *
 * This is the single definition — UniversalDataAccessAnalyzer imports it rather
 * than carrying a divergent copy (the old copies differed only in whether the
 * walk started at `node` or `parent(node)`, which is equivalent for every real
 * call site, all of which hand in a leaf or call node, never a function node).
 * @param node The AST node to start walking from.
 * @param adapter The language adapter for parent/type traversal.
 * @param filePath The file path recorded in the identity.
 * @returns The enclosing function's identity (or a top-level identity).
 */
export function findEnclosingFunctionIdentity(
  node: ASTNode,
  adapter: LanguageAdapter,
  filePath: string,
): FunctionIdentity {
  let current: ASTNode | null = node;
  while (current) {
    const type = adapter.getNodeType(current);
    if (FUNCTION_NODE_TYPES.has(type) || adapter.isMethod(current)) {
      return {
        filePath,
        startLine: current.location.start.line,
        startColumn: current.location.start.column,
        name: adapter.getNodeName(current),
        topLevel: false,
      };
    }
    current = adapter.getParent(current);
  }
  return {
    filePath,
    startLine: node.location.start.line,
    startColumn: node.location.start.column,
    name: null,
    topLevel: true,
  };
}

/**
 * Stable symbol component for an identity: the declaration name when present,
 * else a coordinate fallback (`fn:<line>:<column>`), else "top-level". Used by
 * analyzers that key symbols on the enclosing function; never source text.
 */
export function functionIdentityLabel(id: FunctionIdentity): string {
  if (id.topLevel) return 'top-level';
  return id.name ?? `fn:${id.startLine}:${id.startColumn}`;
}

/** The serializable projection of one enclosing-function node — the start/end
 *  coordinate plus the declaration name. The corpus `schema-usage` producer
 *  re-homes a reference to its innermost enclosing function from this list,
 *  reproducing `findClosestNodeAt` + `findEnclosingFunctionIdentity` with no AST. */
export interface FunctionSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  name: string | null;
}

/**
 * Project every node `findEnclosingFunctionIdentity` would match — the six
 * `FUNCTION_NODE_TYPES` plus `adapter.isMethod` — into a `FunctionSpan`. The set
 * and the `adapter.getNodeName` text are byte-identical to the identity walk, so
 * a corpus-side "innermost span containing the location" reproduces the walk's
 * result (a nested function's start is inside its parent's span, hence later, so
 * the containing span with the latest start is the deepest one).
 *
 * @param ast The parsed AST whose enclosing functions are projected.
 * @param adapter The language adapter for type/name traversal.
 * @returns One `FunctionSpan` per enclosing-function node, in walk pre-order.
 */
export function extractEnclosingFunctionSpans(ast: AST, adapter: LanguageAdapter): FunctionSpan[] {
  const spans: FunctionSpan[] = [];
  const walk = (node: ASTNode) => {
    const type = adapter.getNodeType(node);
    if (FUNCTION_NODE_TYPES.has(type) || adapter.isMethod(node)) {
      spans.push({
        startLine: node.location.start.line,
        startColumn: node.location.start.column,
        endLine: node.location.end.line,
        endColumn: node.location.end.column,
        name: adapter.getNodeName(node),
      });
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  };
  walk(ast.root);
  return spans;
}

/** The serializable projection of one `string_fragment` leaf — the start/end
 *  coordinate of the literal text inside a `string` / `template_string`. The
 *  corpus `schema-usage` producer re-homes a *top-level* reference to this
 *  fragment's start (the deepest node `findClosestNodeAt` returns for a table
 *  name inside a SQL string), reproducing the coordinate with no AST. */
export interface StringFragmentSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Project every `string_fragment` leaf into a `StringFragmentSpan`. The legacy
 * re-home's `findClosestNodeAt(ref.location)` returns the deepest node containing
 * the reference; for a table name parsed out of a SQL string that node is a
 * `string_fragment` (the `alias(…, $.string_fragment)` token, a named leaf). The
 * set and the start/end coordinates are byte-identical to that node, so a
 * corpus-side "innermost fragment containing the location" reproduces the
 * top-level coordinate (a reference is always inside exactly one fragment — the
 * fragments of one string are disjoint, and distinct strings are disjoint).
 *
 * @param ast The parsed AST whose string fragments are projected.
 * @param adapter The language adapter for type/child traversal.
 * @returns One `StringFragmentSpan` per `string_fragment` node, in walk pre-order.
 */
export function extractStringFragmentSpans(ast: AST, adapter: LanguageAdapter): StringFragmentSpan[] {
  const spans: StringFragmentSpan[] = [];
  const walk = (node: ASTNode) => {
    if (adapter.getNodeType(node) === 'string_fragment') {
      spans.push({
        startLine: node.location.start.line,
        startColumn: node.location.start.column,
        endLine: node.location.end.line,
        endColumn: node.location.end.column,
      });
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  };
  walk(ast.root);
  return spans;
}
