/**
 * Spec 68 §3.2 — the per-file `export-form` producer.
 *
 * Projects the adapter's `extractExports` (`ExportInfo[]`) onto the serializable
 * `ExportFormFact`: the exported name plus `isDefault`. The `conventions/export-shape`
 * rule reads this to resolve a function's export form (default vs named) against
 * the directory's dominant form; the finding anchors to the function's
 * `function-index` line, not the export statement, so position is not projected.
 *
 * This is the AST-extracted exports set the legacy conventions reducer read as
 * `exportsMap` (pipelineAdapters.ts builds that map from the same `extractExports`
 * call), so the phase fact is byte-identical in the `(name, isDefault)` pair the
 * detector compares.
 */

import type { AstFile, ExportFormFact } from './types.js';

/**
 * One file's export declarations as `ExportFormFact[]`.
 *
 * @param file - The parsed file whose exports are projected.
 * @returns The exported `(name, isDefault)` pairs in the file.
 */
export function extractExportForm(file: AstFile): ExportFormFact[] {
  const infos = file.adapter.extractExports(file.ast);
  return infos.map((exp) => ({
    file: file.file,
    name: exp.name,
    isDefault: exp.isDefault,
  }));
}
