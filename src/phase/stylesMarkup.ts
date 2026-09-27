/**
 * Spec 68 §3.2 — the markup `style-declarations` FileProcessor extraction.
 *
 * `stylesCss.ts` re-homes the `styles-css` visitor (`.css`/`.scss` via the CSS
 * AST extractors) and `stylesSource.ts` the `styles-source` visitor (CSS-in-JS /
 * inline / Tailwind in the TS/JS AST stage 1 already parsed). This module
 * re-homes the *third* half: markup component files (`.astro`/`.vue`/`.svelte`/
 * `.html`) that have no language adapter, which the legacy `styleIndexer` read
 * via regex (`extractForFile` + `extractClassUsage`).
 *
 * The extraction is the same regex path the legacy indexer ran: `extractDeclarations`
 * dispatches to `extractFromHTML` for markup (embedded `<style>` blocks + class
 * attributes), and `extractClassUsage` reads `class`/`className` attributes. The
 * producer takes `ParsedFile` (not `AstFile`) — there is no AST — and returns
 * the same `StyleDeclarationsFile` shape the CSS and source producers do, so the
 * nine migrated styles rules read one uniform fact and markup files are not
 * silently dropped (the `.astro` undefined-class regression).
 *
 * Tailwind utility expansion needs the project's theme tokens; like
 * `extractStylesSource`, the producer reads `file.projectRoot` and calls the
 * memoized `loadTailwindConfig`.
 */

import type { ParsedFile, StyleDeclarationsFile } from './types.js';
import { extractDeclarations } from '../styles/styleExtractor.js';
import { extractClassUsage } from '../styles/styleIndexer.js';
import { loadTailwindConfig } from '../styles/tailwindConfigLoader.js';

/** Extract the per-file styles fact from one markup component file (regex, no AST). */
export function extractStylesMarkup(file: ParsedFile): StyleDeclarationsFile[] {
  const tailwindTokens = file.projectRoot
    ? loadTailwindConfig(file.projectRoot).tokens
    : undefined;
  return [{
    declarations: extractDeclarations(file.file, null as never, file.source, undefined, tailwindTokens),
    tokens: [],
    classUsage: extractClassUsage(file.file, file.source),
  }];
}
