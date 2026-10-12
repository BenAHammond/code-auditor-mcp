/**
 * Parser-based defined-class harvest for TS/JS CSS-in-JS tagged templates
 * (Spec 45, Piece 3 of the keyframe-pollution fix).
 *
 * The TS/JS source path used to scrape class names out of a declaration's
 * selector `context` with `scanClassNamesFromSelector` — but the CSS-in-JS
 * declaration extractor hardcodes `context: 'styled'` (no class names) and its
 * `{` filter drops every declaration whose line carries a nested block, so a
 * class defined inside a nested CSS-in-JS block never entered the catalog and
 * using it in markup produced a false `styles/undefined-class` finding. This
 * module routes each CSS-in-JS template body through the *same* CSS parser the
 * `.css`/`.scss` and markup paths use (`parseFile` + `extractClassUsageFromCSSAst`),
 * so the discriminant for "is this a keyframes at-rule" is what the parser
 * reports: keyframe selectors (`from`/`to`/percentages) are structurally absent
 * from the `class_name`-under-`class_selector` walk, and there is no
 * hand-maintained at-rule-name list anywhere in the path.
 *
 * The template bodies and their boundaries come from `collectCssInJsBlocks`
 * (`styleExtractor.ts`), the same single source of truth the declaration
 * extractor reads, so the two harvests can never disagree on which templates
 * count as CSS-in-JS or what their CSS body text is.
 */

import { collectCssInJsBlocks } from './styleExtractor.js';
import { extractClassUsageFromCSSAst } from './cssAstExtractor.js';
import { parseFile } from '../languages/adapterBridge.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import type { AST } from '../languages/types.js';
import type { DefinedClassRef } from './definedClasses.js';

/**
 * Harvest the defined classes (`.foo` selectors) from one TS/JS file's CSS-in-JS
 * tagged templates, using the CSS parser rather than a selector pattern.
 *
 * @param filePath The source path (becomes the catalog `file_path`).
 * @param sourceCode The raw TS/JS source.
 * @param ast The parsed TS/JS AST (locates the template nodes); null/absent
 *   yields an empty harvest, matching the declaration extractor's `!ast` guard.
 * @returns One entry per distinct (className, filePath) defined selector.
 */
export function harvestCssInJsStyleClasses(
  filePath: string,
  sourceCode: string,
  ast?: AST,
): DefinedClassRef[] {
  if (!ast) return [];

  const bodies = collectCssInJsBlocks(ast, sourceCode);
  if (bodies.length === 0) return [];

  const registry = LanguageRegistry.getInstance();
  const refs: DefinedClassRef[] = [];
  const seen = new Set<string>();

  for (const body of bodies) {
    // A synthetic path selects the CSS grammar in `parseFile` and the matching
    // adapter in `getAdapterForFile`. The real TS/JS path is threaded to
    // `extractClassUsageFromCSSAst` as `filePath` so the catalog records the
    // source file, not the synthetic one. CSS-in-JS templates are CSS (not SCSS),
    // so the dialect is fixed to `css` — unlike markup `<style lang="scss">`.
    const syntheticPath = 'embedded.css';
    const adapter = registry.getAdapterForFile(syntheticPath);
    if (!adapter) continue;

    const ast2 = parseFile(syntheticPath, body);
    if (!ast2) continue;

    try {
      for (const u of extractClassUsageFromCSSAst(ast2, adapter, filePath, body)) {
        if (u.unresolvable) continue; // `&`-references are uses, not definitions.
        // `filePath` is the single TS/JS path threaded in above, so `className`
        // alone is a unique key for this file; dedup collapses a class selector
        // that appears in more than one template.
        if (seen.has(u.className)) continue;
        seen.add(u.className);
        refs.push({ className: u.className, filePath: u.filePath });
      }
    } finally {
      ast2.dispose?.();
    }
  }

  return refs;
}
