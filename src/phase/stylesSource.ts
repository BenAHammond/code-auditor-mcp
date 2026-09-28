/**
 * Spec 68 §3.2 — the TS/JS `style-declarations` FileProcessor extraction.
 *
 * `stylesCss.ts` re-homes the `styles-css` visitor (`.css`/`.scss` via the CSS
 * AST extractors). This module re-homes the *other* half of the style pipeline:
 * the `styles-source` visitor (`createStylesSourceVisitor` in
 * pipelineAdapters.ts), which extracts CSS-in-JS, inline styles, and Tailwind
 * class-attribute declarations from the TS/JS AST stage 1 already parsed.
 *
 * The visitor's `visit` body was only async to lazy-load `extractDeclarations`
 * / `extractClassUsage` and avoid a circular import; the extraction itself is
 * synchronous and takes the already-parsed AST. This processor calls them
 * directly and returns the per-file fact the styles rules read.
 *
 * `classUsage` is extracted here because the styles-source visitor emitted it
 * alongside declarations — the `undefined-class` rule (deferred, not in this
 * slice) reads it. The eight migrated rules read only `declarations` + `tokens`,
 * but the fact shape carries all three for parity with the CSS producer and so
 * `undefined-class` can land on the same fact without a shape change.
 *
 * Tailwind utility expansion needs the project's theme tokens (`className=
 * "flex"` must expand to `display: flex`, not record a `class: flex` literal).
 * The tokens are corpus-level — one per project, not per file — so the producer
 * reads `file.projectRoot` and calls the memoized `loadTailwindConfig`, a cache
 * hit on every file after the first (the full pipeline's style-index sync has
 * already loaded it this run).
 */

import type { AstFile, StyleDeclarationsFile } from './types.js';
import { extractDeclarations } from '../styles/styleExtractor.js';
import { extractClassUsage } from '../styles/styleIndexer.js';
import { loadTailwindConfig } from '../styles/tailwindConfigLoader.js';

/**
 * Extract the per-file styles fact from one parsed TS/JS file.
 *
 * @param file - The parsed TS/JS file whose styles are extracted.
 * @returns A single-element fact with the file's declarations and class usage.
 */
export function extractStylesSource(file: AstFile): StyleDeclarationsFile[] {
  const tailwindTokens = file.projectRoot
    ? loadTailwindConfig(file.projectRoot).tokens
    : undefined;
  return [{
    declarations: extractDeclarations(file.file, file.adapter, file.source, file.ast, tailwindTokens),
    tokens: [],
    classUsage: extractClassUsage(file.file, file.source),
  }];
}
