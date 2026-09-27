/**
 * Spec 68 §3.2 — the per-file `import-form` producer.
 *
 * Projects `parseFileImports` (conventionMiner.ts) onto the serializable
 * `ImportFormFact`: the module source plus the classified import form, and the
 * 1-based line the `conventions/import-form` finding anchors to. The producer
 * re-runs the same regex the legacy miner/detector ran over raw source text —
 * NOT the AST `imports` fact — because the legacy path classified forms the AST
 * extractor does not (`default`-plus-`named`, `require` destructuring,
 * `side-effect`). It reads `file.source` alone, so it never narrows to `AstFile`.
 */

import type { ImportFormFact, ParsedFile } from './types.js';
import { parseFileImports } from '../conventions/conventionMiner.js';

/** One file's imports as `ImportFormFact[]` (form + source + anchor line). */
export function extractImportForm(file: ParsedFile): ImportFormFact[] {
  return parseFileImports(file.source).map((imp) => ({
    file: file.file,
    source: imp.source,
    form: imp.form,
    line: imp.line,
  }));
}
