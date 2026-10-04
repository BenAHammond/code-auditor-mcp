/**
 * Spec 70 Item 4 (2a) — the per-file `import-specifiers` producer.
 *
 * Projects the adapter's `extractImports` (`ImportInfo[]`) onto the full
 * serializable specifier detail the cross-file receiver-provenance fixed point
 * reads: `source` plus every `ImportSpecifier` (name / alias / isDefault /
 * isNamespace). This is a deliberate *addition* to, not a replacement of, the
 * `imports` fact — `imports` keeps one row per statement with a position for
 * `duplicate-import`, while this fact keeps the full specifier list the fixed
 * point needs to resolve namespace/default/named re-export bindings.
 */

import type { AstFile, ImportSpecifiersFact } from './types.js';

/**
 * One file's import statements as `ImportSpecifiersFact[]`.
 *
 * @param file - The parsed file whose imports are projected.
 * @returns The file's imports with their full specifier detail.
 */
export function extractImportSpecifiers(file: AstFile): ImportSpecifiersFact[] {
  return file.adapter.extractImports(file.ast).map((imp) => ({
    file: file.file,
    source: imp.source,
    specifiers: imp.specifiers.map((s) => ({
      name: s.name,
      alias: s.alias,
      isDefault: s.isDefault,
      isNamespace: s.isNamespace,
    })),
  }));
}
