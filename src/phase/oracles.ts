/**
 * Spec 69 R1 — the completeness oracles a file processor declares.
 *
 * Each oracle is one of two arms: a `counted` count of the fragments a file
 * *should* yield (a cheap, independent upper bound computed from the same input,
 * written for that processor), or an explicit `none` with the reason no statable
 * oracle exists. `none` is not an exemption — it is the report that closes the
 * silent-unprovable failure mode: the run enumerates it, named, with its reason.
 *
 * The counts here are deliberately dumber than the producer they shadow. A
 * producer runs the full extraction (metrics, classification, dedup); the oracle
 * counts raw tree nodes off the same tree. The gap — a producer emitting fewer
 * than the oracle expects — is the *residual* the aggregate gate pins (§69 R1,
 * criterion 4). An oracle is an upper bound, not a promise of equality: e.g.
 * `countFileSymbols` counts `method_definition` nodes, which the file-symbols
 * producer folds into their class symbol rather than emitting, so a class with
 * methods has a positive residual by design. The baseline records what each
 * number is composed of, so a residual of mostly-non-candidates is not later
 * read as missing input.
 *
 * The `measured` half is the same unit counted *inside* the emitted fragments.
 * For a per-fragment producer both count and measured count fragments; for an
 * aggregate producer (one fragment per file) `count` still counts the units, so
 * `measured` must read them from the fragment's payload — comparing a unit count
 * against `fragments.length` would be a meaningless 1-against-1.
 */

import type {
  AstFile,
  CompletenessOracle,
  FileImportsFact,
  OracleShortfall,
  ParsedFile,
  ReactComponentScan,
  SchemaDeclaration,
  StyleDeclarationsFile,
} from './types.js';
import { isFunctionNodeType } from '../analyzers/universal/functionConcerns.js';
import { isTestFile } from '../languages/testConventions.js';
import { countSqlKeywordOccurrences } from '../analyzers/universal/schema/codeAnalysis.js';

/** A counted oracle: `count` returns the units one file should yield; `measured`
 *  reads the same unit back out of the emitted fragments.
 *
 * @param count The expected-unit counter, computed from the same input the
 *  processor walks.
 * @param measured Reads the same unit back out of the emitted fragments; defaults
 *  to the fragment-array length for one-fragment-per-unit producers.
 * @returns A counted completeness oracle pairing the two.
 */
export function countOracle(
  count: (file: ParsedFile) => number,
  measured: (fragments: readonly unknown[]) => number = (frags) => frags.length,
): CompletenessOracle {
  return { status: 'counted', count, measured };
}

/** A no-oracle: there is no statable count, and here is why. */
export function noOracle(reason: string): CompletenessOracle {
  return { status: 'none', reason };
}

/**
 * Compare a `counted` oracle against what its processor actually emitted for one
 * file. Returns the shortfall record when the emitted count fell below the
 * expected count, else `null`. The actual count is read through the oracle's own
 * `measured` so aggregate producers compare the unit inside their single
 * fragment, not the fragment array length. A `none` oracle never produces a
 * shortfall — its absence is enumerated by `noOracleProcessors`, not measured
 * here.
 *
 * @param oracle The completeness oracle to compare against (only `counted` ones).
 * @param file The parsed file whose emission is being checked.
 * @param fragments The fragments the file's processor actually emitted.
 * @param processorId The id of the processor being checked, recorded on a shortfall.
 * @returns A shortfall record when the emitted count fell below the expected
 *  count, otherwise `null`.
 */
export function oracleShortfall(
  oracle: CompletenessOracle,
  file: ParsedFile,
  fragments: readonly unknown[],
  processorId: string,
): OracleShortfall | null {
  if (oracle.status !== 'counted') return null;
  const expected = oracle.count(file);
  const actual = oracle.measured(fragments);
  return actual < expected ? { file: file.file, processor: processorId, expected, actual } : null;
}

/** Count nodes whose type is in `types` off the raw tree. The "dumb" half of the
 *  oracle pair: a raw node-type count over the same AST the producer walks. */
function countNodeTypes(types: readonly string[]): (file: ParsedFile) => number {
  return (file) => {
    const astFile = file as AstFile;
    return astFile.adapter.findNodes(astFile.ast, {
      custom: (n) => types.includes(n.type),
    }).length;
  };
}

/** Like {@link countNodeTypes}, but returns 0 for Go `*_test.go` files — the Go
 *  producers exempt test files, so a count that did not would record a false
 *  shortfall on every test file (expected > 0 against an intentionally empty
 *  emission). */
function goNodeCount(types: readonly string[]): (file: ParsedFile) => number {
  return (file) => {
    if (isTestFile('go', file.file)) return 0;
    return countNodeTypes(types)(file);
  };
}

// ── Counted oracles ───────────────────────────────────────────────────────────

/** file-symbols — count function-like, class, and interface declaration nodes
 *  off the tree. An upper bound: a method is a function-like node that rides on
 *  its class symbol, so a class with methods emits fewer symbols than the node
 *  count.
 *
 * @param file The parsed file to count over.
 * @returns The number of function-like, class, and interface declaration nodes.
 */
export function countFileSymbols(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) =>
      isFunctionNodeType(n.type) || n.type === 'class_declaration' || n.type === 'interface_declaration',
  }).length;
}

/** imports (TS/JS) — count `import_statement` nodes off the tree.
 *
 * @param file The parsed file to count over.
 * @returns The number of `import_statement` nodes.
 */
export function countImports(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) => n.type === 'import_statement',
  }).length;
}

/** export-form (TS/JS) — count `export_statement` nodes off the tree.
 *
 * @param file The parsed file to count over.
 * @returns The number of `export_statement` nodes.
 */
export function countExportForm(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) => n.type === 'export_statement',
  }).length;
}

/** function-index — count `function_declaration` + `arrow_function` nodes. A
 *  function declaration is emitted one-to-one; an arrow is emitted only when
 *  bound to a `variable_declarator`, so a bare callback arrow is a residual by
 *  design (the producer legitimately skips it). Class components and
 *  `memo`/`forwardRef` wrappers that are not a function/arrow are under-counted
 *  (a safe bound, never a false shortfall). */
export const countFunctionIndex = countNodeTypes(['function_declaration', 'arrow_function']);

/** string-literals — count `string` + `template_string` nodes; the producer
 *  emits one literal per node, so this is exact, not merely an upper bound. */
export const countStringLiterals = countNodeTypes(['string', 'template_string']);

/** cross-language-entities — count the entity-declaring node types the
 *  cross-language extractor projects: TS/JS function/method/arrow/interface, and
 *  Go function + type_spec. Go test files are NOT exempted here (the
 *  cross-language entity extractor does not skip them). */
export const countCrossLanguageEntities = countNodeTypes([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'interface_declaration',
  'type_spec',
]);

/** code-block — count the block nodes (functions, classes, control-flow) plus the
 *  fragment nodes (object literals, call expressions) the DRY extractor projects.
 *  Methods are emitted through both the function walk and the class walk, so the
 *  single node count under-counts them (safe); object literals outside a
 *  declarator/assignment value are a residual. */
export const countCodeBlocks = countNodeTypes([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'class_declaration',
  'abstract_class_declaration',
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'try_statement',
  'object',
  'call_expression',
]);

/** file-imports — count the static import nodes (`import_statement` for TS/JS,
 *  `import_spec` for Go). The producer's `imports` array is a deduped set, so
 *  duplicate specifiers are a residual; re-exports and dynamic `import()` are
 *  under-counted (safe). */
export const countFileImports = countNodeTypes(['import_statement', 'import_spec']);

/** react-component — count `jsx_element` + `jsx_self_closing_element` nodes off
 *  the tree; the measured side sums each component's `jsxElementDetails` (one per
 *  JSX element occurrence, nested included), so the residual is JSX that sits
 *  outside a component. */
export const countJsxElements = countNodeTypes(['jsx_element', 'jsx_self_closing_element']);

/** batch-functions — count the function node types the batch walk recognizes; a
 *  function whose span holds no `.batch(`/`.transaction(` is a residual. */
export const countBatchFunctions = countNodeTypes([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'generator_function_declaration',
  'generator_function_expression',
]);

/** imports (Go) — count `import_spec` nodes, exempting `*_test.go`. */
export const countGoImports = goNodeCount(['import_spec']);

/** go-functions — count Go `function_declaration` + `method_declaration` nodes,
 *  exempting `*_test.go`. */
export const countGoFunctions = goNodeCount(['function_declaration', 'method_declaration']);

/** go-switches — count Go switch statements, exempting `*_test.go`. */
export const countGoSwitches = goNodeCount(['expression_switch_statement', 'type_switch_statement']);

/** type-declarations — count Go `type_spec` nodes (one per declared struct /
 *  interface), exempting `*_test.go`. */
export const countTypeDeclarations = goNodeCount(['type_spec']);

/** schema-objects — count the ORM-builder *call sites* off the source text (a
 *  different feature than the producer emits: the producer emits one fact per
 *  `const <id> = <builder>('name', …)` *binding*, this counts every `<builder>(`
 *  *invocation*). A builder call not bound to a `const` (e.g.
 *  `export default pgTable(…)`, or a table returned from a helper) is a positive
 *  residual by design — the oracle upper-bounds the emitted bindings rather than
 *  re-running the producer's own `ORM_OBJECT_RE` (which would prove 1 = 1 and
 *  measure nothing). */
const ORM_BUILDER_CALL_RE = /\b(?:pgTable|mysqlTable|sqliteTable)\s*\(/g;

export function countSchemaObjects(file: ParsedFile): number {
  return [...file.source.matchAll(ORM_BUILDER_CALL_RE)].length;
}

/** ddl-declarations — count the DDL *statement headers* (CREATE/DROP/ALTER TABLE)
 *  off the source text — a different, coarser feature than the producer emits.
 *  The producer's single fragment carries one op per CREATE/DROP/ALTER-RENAME
 *  TABLE statement, matched by its own `DDL_RE` (which also captures the names
 *  and the `RENAME TO` clause); this counts the bare header independently, so a
 *  change to `DDL_RE`'s name/rename machinery cannot silently propagate here.
 *  Every op header carries exactly one header, so this is an upper bound; an
 *  `ALTER TABLE … ADD COLUMN`/`… ADD CONSTRAINT` header (a column/constraint the
 *  producer correctly records in `tableColumns`, not as an op) is a positive
 *  residual by design. */
const DDL_HEADER_RE = /\b(?:CREATE|DROP|ALTER)\s+(?:VIRTUAL\s+)?TABLE\b/gi;

export function countDdlOps(file: ParsedFile): number {
  return [...file.source.matchAll(DDL_HEADER_RE)].length;
}

/** style-declarations (css/scss) — count `declaration` nodes off the CSS AST.
 *  An upper bound, not exact: the producer projects only declarations inside a
 *  `rule_set` (skipping `@keyframes`/`@font-face`/`@page` declarations) and may
 *  expand a shorthand into several, so a declaration outside a rule_set is a
 *  positive residual.
 *
 * @param file The parsed file to count over.
 * @returns The number of `declaration` nodes off the CSS AST.
 */
export function countCssDeclarations(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) => n.type === 'declaration',
  }).length;
}

// ── Coarse upper-bound oracles (Spec 69 R1 correction) ───────────────────────
// These are the *over-counting* oracles the R1 correction demands for the
// producers originally marked `none` on a "no exact counter exists" judgement.
// The bar is not exactness but the upper bound: an oracle counts a dumber
// superset of the same input, the residual (expected − actual) is pinned by the
// aggregate gate, and a movement in `actual` is the regression signal — exactly
// how `batch-functions` (counts every function node against the ~0–21 functions
// that hold a `.batch(`) already works. A large residual is by design, not a
// defect; the per-kind `composition` note records what it is made of.

/** secret-candidates — count `string` + `template_string` nodes. Every candidate
 *  (a declarator / assignment / pair / call that carries a string in a
 *  credential position) holds ≥1 string literal, so the string-node count
 *  upper-bounds the candidate count. Residual = string literals outside a
 *  credential position (the majority of a file's strings). */
export const countSecretCandidates = countNodeTypes(['string', 'template_string']);

/** security-candidates — count `call_expression` + `template_string` nodes.
 *  Every candidate is either a call (command-injection / dynamic-require) or a
 *  sink-reaching template (unescaped-html), so this upper-bounds the candidate
 *  count. Residual = the large majority of calls/templates that are not
 *  security-relevant. */
export const countSecurityCandidates = countNodeTypes(['call_expression', 'template_string']);

/** data-access-calls — count `call_expression` + `template_string` nodes. Every
 *  resolved DB call is a call (or a tagged-template call), so this upper-bounds
 *  the resolved-call count. Residual = non-DB calls/templates (the bulk of a
 *  file's call sites). */
export const countDataAccessCalls = countNodeTypes(['call_expression', 'template_string']);

/** loop-queries — count loop nodes. The producer emits one candidate per loop
 *  whose body issues a DB call; this counts every loop. Residual = loops whose
 *  body holds no DB call. */
export const countLoopQueries = countNodeTypes([
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
]);

/** dynamic-sql — count `query(` / `execute(` call sites off the source text, a
 *  different, coarser feature than the producer's `DANGEROUS_SQL_PATTERNS`
 *  (which match only the dangerous `${…}` / `+` template/concat forms). Every
 *  dangerous candidate is a `query(`/`execute(` call, so this upper-bounds the
 *  candidate count. Residual = safe/parameterized query/execute calls. */
const DYNAMIC_SQL_CALL_RE = /\b(?:query|execute)\s*\(/g;

export function countDynamicSql(file: ParsedFile): number {
  return [...file.source.matchAll(DYNAMIC_SQL_CALL_RE)].length;
}

/** query-sites — count every member-call site (`.name(`) plus every SQL keyword
 *  occurrence in the raw source: two coarse, independent supersets of the
 *  producer's three-component located scan (eager DB-method calls, `.exec`-with-
 *  SQL, and standalone SQL keywords in call-body-stripped text). Every query site
 *  is a member call or a SQL keyword, so this upper-bounds the site count.
 *  Residual = non-DB member calls + SQL keywords inside recognized call bodies
 *  (which the producer strips) + the DB-context gate the producer applies. */
const ALL_MEMBER_CALLS_RE = /\.\w+\s*\(/g;

export function countQuerySites(file: ParsedFile): number {
  const calls = (file.source.match(ALL_MEMBER_CALLS_RE) || []).length;
  return calls + countSqlKeywordOccurrences(file.source);
}

/** schema-usage — count `call_expression` + `string` + `template_string` nodes.
 *  Every table reference is carried in a string literal, a tagged template, or a
 *  call, so this upper-bounds the reference count. Residual = strings/calls/
 *  templates that name no table reference (the bulk of the file). */
export const countSchemaUsage = countNodeTypes(['call_expression', 'string', 'template_string']);

// ── Measured helpers (aggregate producers) ────────────────────────────────────
// A producer that emits at most one fragment per file must compare the count of
// the units *inside* that fragment, not the fragment array length (which is 0 or
// 1 and proves nothing). Each helper reads the emitted payload back into the same
// unit its count function counted.

/** ddl-declarations — the DDL op count inside the (single) declaration fragment. */
export function measuredDdlOps(fragments: readonly unknown[]): number {
  return (fragments as SchemaDeclaration[]).reduce((n, f) => n + f.ops.length, 0);
}

/** style-declarations css/scss — the declaration count inside the fragment. */
export function measuredStyleDeclarations(fragments: readonly unknown[]): number {
  return (fragments as StyleDeclarationsFile[]).reduce((n, f) => n + f.declarations.length, 0);
}

/** react-component — the JSX element count across the file's components.
 *
 * @param fragments The emitted react-component fragments for one file.
 * @returns The total JSX element count summed across every component.
 */
export function measuredJsxElements(fragments: readonly unknown[]): number {
  return (fragments as ReactComponentScan[]).reduce(
    (n, f) => n + f.components.reduce((m, c) => m + (c.jsxElementDetails?.length ?? 0), 0),
    0,
  );
}

/** file-imports — the import specifier count inside the fragment. */
export function measuredFileImports(fragments: readonly unknown[]): number {
  return (fragments as FileImportsFact[]).reduce((n, f) => n + f.imports.length, 0);
}
