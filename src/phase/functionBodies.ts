/**
 * Spec 68 §3.2 — the per-file `function-bodies` producer.
 *
 * Projects the adapter's `extractFunctions` (`FunctionInfo[]`) onto the
 * serializable `FunctionBodyFact`: `name` + 1-based start position + the *full*
 * node source text. The node set is `extractFunctions`' full set
 * (`function_declaration`, `generator_function_declaration`,
 * `function_expression`, `arrow_function`, `method_definition`) — deliberately
 * wider than `function-index`'s visitor, which mirrors the DB `functions` table
 * (declaration + method + declarator-arrow + React component). `too-many-queries`
 * walks `extractFunctions` in the legacy schema-code visitor, so the fact must
 * project the same universe or the rule diverges on generators, function
 * expressions, and non-declarator arrows.
 *
 * The full text (`getNodeText`) rather than the `statement_block` alone is the
 * load-bearing choice: an expression-bodied arrow has no block, so its query
 * count would read 0 off the block while the legacy walk still counts the call
 * sites in the expression body.
 */

import type { AstFile, FunctionBodyFact } from './types.js';
import { findNodeByLocation } from '../analyzers/universal/schema/codeAnalysis.js';

/** One file's function bodies as `FunctionBodyFact[]`. */
export function extractFunctionBodies(file: AstFile): FunctionBodyFact[] {
  const infos = file.adapter.extractFunctions(file.ast);
  const out: FunctionBodyFact[] = [];
  for (const info of infos) {
    const node = findNodeByLocation(file.ast.root, info.location.start);
    if (!node) continue;
    const text = file.adapter.getNodeText(node, file.source);
    if (!text) continue;
    out.push({
      file: file.file,
      name: info.name,
      line: info.location.start.line,
      column: info.location.start.column,
      text,
    });
  }
  return out;
}
