/**
 * Spec 68 §9 — the `go-functions` producer.
 *
 * Re-homes the Go binary's function extraction (the `Function` payload in
 * `analyzer-src/parser.go`) as a plain-data fact. It walks the tree-sitter Go
 * AST for `function_declaration` / `method_declaration` nodes and projects the
 * metrics the two size/behaviour rules threshold on:
 *
 *   - `parameterCount` is *expanded* — a `A, B, C int` parameter is three
 *     (the Go binary appends one `Parameter` per `param.Names` entry, and an
 *     anonymous `int` appends one unnamed Parameter);
 *   - `returnCount` is the number of result entries — 0 for none, 1 for a single
 *     type result, N for a parenthesised `(a, b, c)` list (the Go binary splits
 *     `strings.Join(returnTypes, ", ")` on ",");
 *   - `complexity` is the Go binary's `calculateComplexity` — base 1, +1 per
 *     `if_statement` / `for_statement` (both `for` and `range`) /
 *     `expression_switch_statement` / `type_switch_statement` and per
 *     `expression_case` / `type_case` / `default_case` clause;
 *   - `callsPanic` — the subtree contains a `call_expression` whose direct
 *     `identifier` child is `panic` (the Go binary matches `call.Fun` being a
 *     bare `*ast.Ident` named "panic", so `foo.panic()` does not trip it);
 *   - `line` — the `func` keyword's 1-based line (`funcDecl.Pos().Line`).
 *
 * Test functions (`Test`/`Benchmark`/`Example`/`Fuzz` prefix) are skipped —
 * the Go binary's `ExtractFunctions` does the same, and `liskov-substitution`
 * re-checks the prefix independently. The tree dies with the file; `function-size`
 * and `liskov-substitution` read only this data (never the AST, never the Go
 * subprocess).
 */

import type { AstFile, GoFunctionFact } from './types.js';
import type { ASTNode } from '../languages/types.js';
import { walkAST, getNodeText } from '../languages/adapterBridge.js';
import { isTestFile } from '../languages/testConventions.js';

/** The Go binary's `isTestFunction` prefix set (`testconventions.go`). */
function isTestFunction(name: string): boolean {
  return (
    name.startsWith('Test') ||
    name.startsWith('Benchmark') ||
    name.startsWith('Example') ||
    name.startsWith('Fuzz')
  );
}

/** The node types `calculateComplexity` counts (`if_statement` covers `for` and
 *  `range` too — tree-sitter-go folds both `*ast.ForStmt`/`*ast.RangeStmt`). */
const COMPLEXITY_NODES = new Set([
  'if_statement',
  'for_statement',
  'expression_switch_statement',
  'type_switch_statement',
  'expression_case',
  'type_case',
  'default_case',
]);

function complexityOf(node: ASTNode): number {
  let complexity = 1;
  walkAST(node, (n) => {
    if (COMPLEXITY_NODES.has(n.type)) complexity++;
  });
  return complexity;
}

/** Σ over `parameter_declaration` children of max(1, identifier-count) — the
 *  Go binary's expanded `Parameters` length. */
function parameterCountOf(params: ASTNode | undefined): number {
  if (!params) return 0;
  let count = 0;
  for (const decl of params.children ?? []) {
    if (decl.type !== 'parameter_declaration') continue;
    const names = (decl.children ?? []).filter((c) => c.type === 'identifier');
    count += names.length > 0 ? names.length : 1;
  }
  return count;
}

/** The number of result entries: a parenthesised result list contributes one per
 *  `parameter_declaration`; a single type result contributes 1; absent is 0. */
function returnCountOf(result: ASTNode | undefined): number {
  if (!result) return 0;
  if (result.type === 'parameter_list') {
    return (result.children ?? []).filter((c) => c.type === 'parameter_declaration').length;
  }
  return 1;
}

/** Whether the function subtree has a direct `panic(...)` call. */
function callsPanic(node: ASTNode, source: string): boolean {
  let found = false;
  walkAST(node, (n) => {
    if (found || n.type !== 'call_expression') return;
    const fn = (n.children ?? []).find((c) => c.type === 'identifier');
    if (fn && getNodeText(fn, source) === 'panic') found = true;
  });
  return found;
}

/** The result node of a function/method declaration, if any: the child before
 *  `block` that is not the params `parameter_list` (nor, for a method, the
 *  receiver list). A parenthesised result list IS a `parameter_list`, so it is
 *  told apart from the params list by count — a function carries one params
 *  list, a method two (receiver + params); a further list is the result. */
function resultOf(node: ASTNode, isMethod: boolean): ASTNode | undefined {
  const children = node.children ?? [];
  const blockIdx = children.findIndex((c) => c.type === 'block');
  if (blockIdx < 0) return undefined;
  const before = children[blockIdx - 1];
  if (!before) return undefined;
  if (before.type === 'parameter_list') {
    const paramListsBefore = children.slice(0, blockIdx).filter((c) => c.type === 'parameter_list').length;
    const nonResultLists = isMethod ? 2 : 1;
    if (paramListsBefore <= nonResultLists) return undefined;
  }
  return before;
}

/**
 * Extract every non-test function/method from one parsed Go file.
 *
 * @param file - The parsed Go file whose functions are projected.
 * @returns One `GoFunctionFact` per function/method (size, complexity, panic).
 */
export function extractGoFunctions(file: AstFile): GoFunctionFact[] {
  if (isTestFile('go', file.file)) return [];
  const out: GoFunctionFact[] = [];
  walkAST(file.ast.root, (node) => {
    if (node.type !== 'function_declaration' && node.type !== 'method_declaration') return;
    const isMethod = node.type === 'method_declaration';
    const children = node.children ?? [];
    // function_declaration → `identifier`; method_declaration → `field_identifier`.
    const nameNode = children.find((c) => c.type === 'identifier' || c.type === 'field_identifier');
    if (!nameNode) return;
    const name = getNodeText(nameNode, file.source);
    if (isTestFunction(name)) return;
    const paramLists = children.filter((c) => c.type === 'parameter_list');
    // function: params = the one list (paramLists[0]); method: receiver is
    // paramLists[0], params is paramLists[1].
    const params = isMethod ? paramLists[1] : paramLists[0];
    out.push({
      file: file.file,
      name,
      line: node.location.start.line,
      isMethod,
      parameterCount: parameterCountOf(params),
      returnCount: returnCountOf(resultOf(node, isMethod)),
      complexity: complexityOf(node),
      callsPanic: callsPanic(node, file.source),
    });
  });
  return out;
}
