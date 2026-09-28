/**
 * Spec 68 §3.2 — the `styles-css` FileProcessor extraction.
 *
 * Re-homes `createStylesCssVisitor` (pipelineAdapters.ts) as a pure per-file
 * processor. The visitor's `visit` body was only async to lazy-load the CSS
 * extractors and avoid a circular import; the extraction itself is synchronous
 * and takes the already-parsed AST. This processor calls the three extractors
 * directly — `extractDeclarationsFromCSSAst`, `extractTokensFromCSSAst`,
 * `extractClassUsageFromCSSAst` — and returns the per-file fact the styles
 * rules read (declarations + tokens + classUsage, each with `filePath` baked
 * in).
 *
 * The `file` field on `AstFile` is the path, and `adapter` is the CSS/SCSS
 * adapter that parsed it; both are exactly what the extractors expect. No
 * `sourceCode` re-derivation and no second parse — the AST lives only here.
 */

import type { AstFile, StyleDeclarationsFile } from './types.js';
import {
  extractDeclarationsFromCSSAst,
  extractTokensFromCSSAst,
  extractClassUsageFromCSSAst,
} from '../styles/cssAstExtractor.js';

/**
 * Extract the per-file styles fact from one parsed CSS/SCSS file.
 *
 * @param file - The parsed CSS/SCSS file whose declarations are extracted.
 * @returns The file's declarations, tokens, and class usage.
 */
export function extractStylesCss(file: AstFile): StyleDeclarationsFile {
  return {
    declarations: extractDeclarationsFromCSSAst(file.ast, file.adapter, file.file, file.source),
    tokens: extractTokensFromCSSAst(file.ast, file.adapter, file.file, file.source),
    classUsage: extractClassUsageFromCSSAst(file.ast, file.adapter, file.file, file.source),
  };
}
