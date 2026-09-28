/**
 * Spec 68 §3.2 — the per-file `string-literals` producer.
 *
 * Projects every string / template-string node onto the serializable
 * `StringLiteralFact`: the raw source text (`getNodeText`, quotes/backticks
 * included) plus the 1-based start position. The raw text is the grouping key,
 * matching `UniversalDRYAnalyzer.checkDuplicateStrings` which read `getNodeText`
 * and compared the quoted string verbatim.
 *
 * `enclosingFunction` is the enclosing-identity label computed here (where the
 * AST still lives) via the shared `findEnclosingFunctionIdentity` +
 * `functionIdentityLabel` — the same pair `UniversalDataAccessAnalyzer`'s
 * `enclosingIdentity` used for `hardcoded-connection`'s symbol. The rule only
 * reads the label; the tree is gone before it runs.
 */

import type { AstFile, StringLiteralFact } from './types.js';
import {
  findEnclosingFunctionIdentity,
  functionIdentityLabel,
} from '../analyzers/universal/schema/codeAnalysis.js';

/**
 * One file's string/template-string literals as `StringLiteralFact[]`.
 *
 * @param file - The parsed file whose literals are projected.
 * @returns The file's string literals with their enclosing-function labels.
 */
export function extractStringLiterals(file: AstFile): StringLiteralFact[] {
  const nodes = file.adapter.findNodes(file.ast, {
    custom: (node) => node.type === 'string' || node.type === 'template_string',
  });
  return nodes.map((node) => ({
    file: file.file,
    value: file.adapter.getNodeText(node, file.source),
    line: node.location.start.line,
    column: node.location.start.column,
    enclosingFunction: functionIdentityLabel(
      findEnclosingFunctionIdentity(node, file.adapter, file.file),
    ),
  }));
}
