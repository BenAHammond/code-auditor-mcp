/**
 * Spec 68 §3.2 — the per-file `string-literals` producer.
 *
 * Projects every string / template-string node onto the serializable
 * `StringLiteralFact`: the raw source text (`getNodeText`, quotes/backticks
 * included) plus the 1-based start position. The raw text is the grouping key,
 * matching `UniversalDRYAnalyzer.checkDuplicateStrings` which read `getNodeText`
 * and compared the quoted string verbatim.
 */

import type { AstFile, StringLiteralFact } from './types.js';

/** One file's string/template-string literals as `StringLiteralFact[]`. */
export function extractStringLiterals(file: AstFile): StringLiteralFact[] {
  const nodes = file.adapter.findNodes(file.ast, {
    custom: (node) => node.type === 'string' || node.type === 'template_string',
  });
  return nodes.map((node) => ({
    file: file.file,
    value: file.adapter.getNodeText(node, file.source),
    line: node.location.start.line,
    column: node.location.start.column,
  }));
}
