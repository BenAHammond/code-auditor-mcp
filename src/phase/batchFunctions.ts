/**
 * Spec 68 §3.2 — the per-file `batch-functions` producer.
 *
 * Re-homes the legacy `CrossDomainAnalyzer.enclosingFunctionBatches` re-parse
 * (`readFileSync` + `parseFile` + ancestor walk) as a fact: instead of a rule
 * reaching the file system and an AST at analysis time to ask "does the function
 * enclosing this write line call `.batch(`?", the producer walks the file's AST
 * once and projects every function whose full source span contains `.batch(`.
 *
 * A `.batch(` commit is the transaction scope (Cloudflare D1 / SQLite batching):
 * writes accumulated into prepared statements and committed in one batch carry
 * no transaction-boundary risk, so `multi-table-write` must not flag them. The
 * producer runs the *same* node set and the *same* span test as the legacy walk
 * — `FUNCTION_NODE_TYPES` (including `generator_function_expression`, which the
 * adapter's `extractFunctions` set omits) and `source.slice(range).includes(
 * '.batch(')` over the node's full byte range — so a batch in a nested callback
 * still clears the enclosing outer function, exactly as the legacy ancestor walk
 * did.
 *
 * The fact carries the location span (`startLine`/`endLine`), not the range: the
 * legacy walk located the enclosing function by `loc.start.line <= writeLine <=
 * loc.end.line`, then tested the full range. The rule re-applies that same
 * location containment over this plain data.
 */

import type { AstFile, BatchFunctionFact } from './types.js';
import type { ASTNode } from '../languages/types.js';

/** The function node types the legacy `enclosingFunctionBatches` recognized. */
const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'generator_function_declaration',
  'generator_function_expression',
]);

/** One file's batch-containing functions as `BatchFunctionFact[]`. */
export function extractBatchFunctions(file: AstFile): BatchFunctionFact[] {
  const out: BatchFunctionFact[] = [];
  const walk = (node: ASTNode): void => {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const loc = node.location;
      const range = node.range;
      if (loc && range && file.source.slice(range[0], range[1]).includes('.batch(')) {
        out.push({ file: file.file, startLine: loc.start.line, endLine: loc.end.line });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(file.ast.root);
  return out;
}
