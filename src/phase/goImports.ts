/**
 * Spec 68 §9 — the Go `imports` producer.
 *
 * Re-homes the Go binary's import extraction (`runImportAnalysis` in
 * `analyzer-src/analyzer.go`) as a plain-data fact. It walks the tree-sitter Go
 * AST for `import_spec` nodes and projects each one's source path and local
 * name:
 *
 *   - `source` is the unquoted `path` field (`interpreted_string_literal`), the
 *     same `strconv.Unquote` the Go binary applied;
 *   - `alias` is the import's local name — `dot` → `.` (dot import),
 *     `package_identifier` → the named alias (`f`), `blank_identifier` → `_`,
 *     and `null` for an unnamed `"fmt"` import — mirroring `importSpec.Name`;
 *   - `line`/`column` are the `import_spec`'s 1-based start position.
 *
 * The order of `import_spec` nodes is source order, so `import-organization`
 * can reconstruct the grouping sequence from `(file, source, line)` and
 * `import-style` reads `alias === '.'`. The tree dies with the file; the two
 * rules read only this data (never the AST, never the Go subprocess).
 */

import type { AstFile, ImportFact } from './types.js';
import { walkAST, getNodeText, getFieldNode } from '../languages/adapterBridge.js';
import { isTestFile } from '../languages/testConventions.js';

/**
 * Extract every import spec from one parsed Go file.
 *
 * @param file - The parsed Go file whose import specs are projected.
 * @returns One `ImportFact` per `import_spec` (source, alias, position).
 */
export function extractGoImports(file: AstFile): ImportFact[] {
  // `go test` compiles only `*_test.go` — test files are not production API, so
  // the Go facts (and every rule reading them) must exempt them, matching the
  // deleted Go subprocess's `filePatterns`.
  if (isTestFile('go', file.file)) return [];
  const out: ImportFact[] = [];
  walkAST(file.ast.root, (node) => {
    if (node.type !== 'import_spec') return;
    const path = getFieldNode(node, 'path');
    if (!path) return;
    const source = getNodeText(path, file.source).replace(/^['"]|['"]$/g, '');

    let alias: string | null = null;
    for (const child of node.children ?? []) {
      if (child.type === 'dot') {
        alias = '.';
        break;
      }
      if (child.type === 'package_identifier') {
        alias = getNodeText(child, file.source);
        break;
      }
      if (child.type === 'blank_identifier') {
        alias = '_';
        break;
      }
    }

    out.push({
      file: file.file,
      source,
      line: node.location.start.line,
      column: node.location.start.column,
      alias,
    });
  });
  return out;
}
