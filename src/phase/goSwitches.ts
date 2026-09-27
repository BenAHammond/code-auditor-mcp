/**
 * Spec 68 §9 — the `go-switches` producer.
 *
 * Re-homes the Go binary's switch-size extraction (the `analyzeSwitchSize` walk
 * in `analyzer-src/solid.go`) as a plain-data fact. It walks the tree-sitter Go
 * AST for `expression_switch_statement` / `type_switch_statement` nodes and
 * projects each one's case-clause count:
 *
 *   - `caseCount` counts `expression_case` + `default_case` (expression switch)
 *     or `type_case` + `default_case` (type switch) — the Go binary iterates
 *     `Body.List`, where a `default:` clause is a `*ast.CaseClause` too, so the
 *     `default` arm is included in the count;
 *   - `line` is the `switch` keyword's 1-based line (`node.Pos().Line`);
 *   - `kind` distinguishes the two messages (`switch` vs `type-switch`).
 *
 * The walk is whole-file (nested switches are each inspected independently,
 * matching the Go binary's `ast.Inspect`). The tree dies with the file;
 * `switch-size` reads only this data.
 */

import type { AstFile, GoSwitchFact } from './types.js';
import { walkAST } from '../languages/adapterBridge.js';
import { isTestFile } from '../languages/testConventions.js';

/** Extract every switch/type-switch statement from one parsed Go file. */
export function extractGoSwitches(file: AstFile): GoSwitchFact[] {
  if (isTestFile('go', file.file)) return [];
  const out: GoSwitchFact[] = [];
  walkAST(file.ast.root, (node) => {
    let kind: GoSwitchFact['kind'];
    if (node.type === 'expression_switch_statement') kind = 'switch';
    else if (node.type === 'type_switch_statement') kind = 'type-switch';
    else return;

    const clauses = node.type === 'expression_switch_statement'
      ? ['expression_case', 'default_case']
      : ['type_case', 'default_case'];
    let caseCount = 0;
    for (const child of node.children ?? []) {
      if (child.type === clauses[0] || child.type === clauses[1]) caseCount++;
    }
    out.push({ file: file.file, line: node.location.start.line, caseCount, kind });
  });
  return out;
}
