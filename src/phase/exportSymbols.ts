/**
 * Spec 70 Item 4 (2a) — the per-file `export-symbols` producer.
 *
 * Projects `collectExports` (receiverResolution.ts) — the *same* function the
 * legacy `resolveCorpusReceivers` fixed point calls — onto the serializable full
 * export set the cross-file receiver-provenance fixed point resolves against:
 * every exported name (including the `'*'` star re-export), the re-export
 * `source` when present, and `isDefault`. Using the exact legacy extractor (not
 * a re-implementation) makes the export set byte-identical by construction, so
 * the parity assertion in step 2.5 is a diff of the wiring, not of the
 * extraction.
 */

import type { AstFile, ExportSymbolFact } from './types.js';
import { collectExports } from '../analyzers/receiverResolution.js';

/**
 * One file's exported symbols as `ExportSymbolFact[]`.
 *
 * @param file - The parsed file whose exports are projected.
 * @returns The file's full export set (named, default, and star re-exports).
 */
export function extractExportSymbols(file: AstFile): ExportSymbolFact[] {
  return collectExports(file.ast, file.adapter, file.source).map((ex) => ({
    file: file.file,
    name: ex.name,
    source: ex.source,
    isDefault: ex.isDefault,
  }));
}
