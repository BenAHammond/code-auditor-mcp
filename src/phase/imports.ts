/**
 * Spec 68 §3.2 — the per-file `imports` producer.
 *
 * Projects the adapter's `extractImports` (`ImportInfo[]`) onto the serializable
 * `ImportFact`: `source` plus the 1-based start position. The `duplicate-import`
 * rule groups by `(file, source)`, so the fact keeps `file` on every element and
 * the rule re-does the per-file grouping the legacy analyzer did implicitly by
 * running `checkDuplicateImports` once per AST.
 */

import type { AstFile, ImportFact } from './types.js';

/**
 * One file's import statements as `ImportFact[]`.
 *
 * @param file - The parsed file whose imports are projected.
 * @returns The file's imports with their 1-based start position.
 */
export function extractImports(file: AstFile): ImportFact[] {
  const infos = file.adapter.extractImports(file.ast);
  return infos.map((imp) => ({
    file: file.file,
    source: imp.source,
    line: imp.location.start.line,
    column: imp.location.start.column,
  }));
}
