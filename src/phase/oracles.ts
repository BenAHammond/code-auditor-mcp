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
import { ORM_OBJECT_RE } from './schemaObjects.js';
import { DDL_RE } from '../analyzers/universal/schema/migrations.js';

/** A counted oracle: `count` returns the units one file should yield; `measured`
 *  reads the same unit back out of the emitted fragments. */
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
 *  count. */
export function countFileSymbols(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) =>
      isFunctionNodeType(n.type) || n.type === 'class_declaration' || n.type === 'interface_declaration',
  }).length;
}

/** imports (TS/JS) — count `import_statement` nodes off the tree. */
export function countImports(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) => n.type === 'import_statement',
  }).length;
}

/** export-form (TS/JS) — count `export_statement` nodes off the tree. */
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

/** schema-objects — count the ORM-builder bindings off the source text (the same
 *  regex the producer emits one fact per). Exact, not an upper bound. */
export function countSchemaObjects(file: ParsedFile): number {
  return [...file.source.matchAll(ORM_OBJECT_RE)].length;
}

/** ddl-declarations — count the raw DDL ops (CREATE/DROP/ALTER-RENAME) off the
 *  source text; the producer's single fragment carries one entry per op, so the
 *  measured side reads `ops.length`. Exact. */
export function countDdlOps(file: ParsedFile): number {
  return [...file.source.matchAll(DDL_RE)].length;
}

/** style-declarations (css/scss) — count `declaration` nodes off the CSS AST;
 *  the producer emits one normalized declaration per node, so this is exact. */
export function countCssDeclarations(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) => n.type === 'declaration',
  }).length;
}

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

/** react-component — the JSX element count across the file's components. */
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
