/**
 * Spec 70 Item 4 (step 3) — the per-file `schema-usage-candidates` producer.
 *
 * The extract half of the corpus `schema-usage` reduction. The legacy
 * `schema-usage` producer ran `findTableReferences` — six strategies — then
 * re-homed each `TableReference` to its enclosing function. Four of the six
 * strategies are provenance-free (ORM, query-builder, collection-adapter, and the
 * dead `.sql` arm); two (tagged-template, DB-call) need the cross-file
 * `dbProvenanced` seed that only the `receiver-provenance` fixed point supplies.
 * The collapse splits them the same way `query-site-candidates` did:
 *
 *   • the provenance-free references are extracted *and re-homed* here while the
 *     AST lives (via `findClosestNodeAt` + `findEnclosingFunctionIdentity`, the
 *     exact legacy re-home);
 *   • the two provenance-dependent strategies emit raw candidates the corpus
 *     producer re-admits (`identifyHandle` over `classifyBuildProvenance`'s
 *     re-derived `dbProvenanced`) and re-homes via the projected `functions`
 *     spans.
 *
 * `hasSqlTag` is the one gate input a corpus producer cannot re-derive (it scans
 * source text). `sourceCode` travels with the fact so `parseSqlTables` can anchor
 * each SQL string against it verbatim (its contract throws on a missing match).
 */

import type {
  AstFile,
  DbCallCandidate,
  FunctionSpanFact,
  SchemaUsageCandidatesFact,
  SchemaUsageFact,
  StringFragmentFact,
  TaggedTemplateCandidate,
} from './types.js';
import {
  extractOrmRefs,
  extractQueryBuilderRefs,
  extractCollectionAdapterRefs,
  resolveQuerySql,
  receiverIsThisRootedLocal,
  extractEnclosingFunctionSpans,
  extractStringFragmentSpans,
  findClosestNodeAt,
  findEnclosingFunctionIdentity,
  getCallee,
  getTemplateText,
  getFirstStringArgument,
  getCallLocation,
  hasTemplateArgument,
  type FindTableReferencesContext,
} from '../analyzers/universal/schema/codeAnalysis.js';
import {
  getCallExpressionCallee,
  getMemberExpressionReceiver,
  extractMemberExpressionProperty,
} from '../analyzers/provenance.js';
import { resolveReceiverRoot } from '../analyzers/receiverRoot.js';
import { DEFAULT_SCHEMA_CONFIG, SQL_TAG_NAMES } from '../analyzers/universal/schema/config.js';
import { hasSqlTag } from '../analyzers/universal/schema/discovery.js';
import type { TableReference } from '../analyzers/universal/schema/types.js';

/** Re-home one provenance-free `TableReference` to a `SchemaUsageFact` — the exact
 *  legacy re-home (`findClosestNodeAt` + `findEnclosingFunctionIdentity`). The
 *  identity is never null for an adapter-backed file, so the `schema-file` arm is
 *  unreachable here (it only served the dead `.sql` strategy). */
function rehomeRef(ref: TableReference, file: AstFile): SchemaUsageFact {
  const node = findClosestNodeAt(file.ast.root, ref.location, file.adapter);
  const identity = node ? findEnclosingFunctionIdentity(node, file.adapter, file.file) : null;
  const functionName =
    identity == null
      ? file.file.endsWith('.sql') || file.file.includes('/migrations/')
        ? 'schema-file'
        : 'top-level'
      : identity.topLevel
        ? 'top-level'
        : identity.name;
  return {
    tableName: ref.table,
    filePath: file.file,
    functionName,
    functionStartLine: identity?.startLine ?? null,
    functionStartColumn: identity?.startColumn ?? null,
    usageType: ref.type,
    line: ref.location.line,
    column: ref.location.column,
    rawQuery: ref.context,
    origin: ref.origin,
  };
}

/**
 * One file's un-gated schema-usage candidates.
 *
 * @param file - The parsed file whose schema-usage candidates are projected.
 * @returns A one-element array carrying the candidates.
 */
export function extractSchemaUsageCandidates(file: AstFile): SchemaUsageCandidatesFact[] {
  const { ast, adapter, source } = file;

  // The provenance-free references, extracted + re-homed now.
  const ormRefs = extractOrmRefs(ast, adapter, source).map((ref) => rehomeRef(ref, file));
  const queryBuilderRefs = extractQueryBuilderRefs(ast, adapter, source, {
    config: DEFAULT_SCHEMA_CONFIG,
  } satisfies FindTableReferencesContext).map((ref) => rehomeRef(ref, file));
  const collectionAdapterRefs = extractCollectionAdapterRefs(ast, adapter, source).map((ref) =>
    rehomeRef(ref, file),
  );

  // The enclosing-function spans the corpus producer re-homes against.
  const functions: FunctionSpanFact[] = extractEnclosingFunctionSpans(ast, adapter);

  // The string-fragment spans the corpus producer re-homes *top-level* references
  // against (the deepest node `findClosestNodeAt` returns for a table name inside
  // a SQL string is a `string_fragment`, whose start is the top-level coordinate).
  const stringFragments: StringFragmentFact[] = extractStringFragmentSpans(ast, adapter);

  // Strategy (1) — tagged templates (`sql`SELECT …``). The tag-name gate mirrors
  // `extractTaggedTemplateRefs`' predicate; the provenance-free tag is captured,
  // and the corpus producer resolves the per-site dialect from the tag's package.
  const sqlTags = DEFAULT_SCHEMA_CONFIG.sqlTagNames ?? [...SQL_TAG_NAMES];
  const tagged: TaggedTemplateCandidate[] = [];
  for (const callNode of adapter.findNodes(ast, {
    custom: (node) => {
      if (node.type !== 'call_expression') return false;
      const callee = getCallee(node, adapter, source);
      if (!callee || !sqlTags.includes(callee)) return false;
      return hasTemplateArgument(node, adapter);
    },
  })) {
    const templateText = getTemplateText(callNode, adapter, source);
    if (!templateText) continue;
    tagged.push({ tagName: getCallee(callNode, adapter, source)!, templateText, location: getCallLocation(callNode) });
  }

  // Strategy (2) — DB-call patterns. Only the *structural* half of `dbCallVerdict`
  // runs here (callee shape, method gate, root gate); the provenance-dependent
  // admission (`identifyHandle`) is deferred to the corpus producer, which
  // re-derives `dbProvenanced` and re-folds the verdict. Resolvable SQL is carried
  // as `sqlText`; an unresolvable argument is carried as `unresolved` (Spec 70 1b)
  // so the corpus-side reduction can re-admit the call and emit the
  // `unresolved-query` diagnostic instead of silently dropping it.
  const dbCalls: DbCallCandidate[] = [];
  for (const callNode of adapter.findNodes(ast, { type: 'call_expression' })) {
    const callee = getCallExpressionCallee(callNode, adapter);
    if (!callee) continue;

    if (callee.type === 'identifier') {
      const name = adapter.getNodeText(callee, source);
      if (!name) continue;
      const sqlArgument = getFirstStringArgument(callNode, adapter, source);
      const resolved = resolveQuerySql(callNode, ast, adapter, source);
      if (resolved.sqlText === null && resolved.unresolved === null) continue;
      dbCalls.push({
        calleeType: 'identifier',
        name,
        sqlArgument,
        sqlText: resolved.sqlText,
        unresolved: resolved.unresolved,
        location: getCallLocation(callNode),
      });
      continue;
    }

    if (callee.type !== 'member_expression' && callee.type !== 'selector_expression') continue;
    const method = extractMemberExpressionProperty(callee, adapter, source);
    if (!method) continue;
    const root = resolveReceiverRoot(callee, adapter, source);
    if (root === null) continue;
    const sqlArgument = getFirstStringArgument(callNode, adapter, source);
    const resolved = resolveQuerySql(callNode, ast, adapter, source);
    if (resolved.sqlText === null && resolved.unresolved === null) continue;
    dbCalls.push({
      calleeType: 'member',
      method,
      root,
      receiver: getMemberExpressionReceiver(callee, adapter, source),
      thisField: receiverIsThisRootedLocal(callee, adapter),
      sqlArgument,
      sqlText: resolved.sqlText,
      unresolved: resolved.unresolved,
      location: getCallLocation(callNode),
    });
  }

  return [
    {
      file: file.file,
      sourceCode: source,
      hasSqlTag: hasSqlTag(source, DEFAULT_SCHEMA_CONFIG),
      functions,
      stringFragments,
      tagged,
      dbCalls,
      ormRefs,
      queryBuilderRefs,
      collectionAdapterRefs,
    },
  ];
}
