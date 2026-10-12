/**
 * Parser-based defined-class harvest for markup `<style>` blocks (Spec 45,
 * Piece 2 of the keyframe-pollution fix).
 *
 * The markup path used to scrape class names out of the regex-scraped selector
 * `context` with `scanClassNamesFromSelector` — a character-minimum pattern that
 * cannot tell a style-rule selector from a keyframe selector and admits decimal
 * points in keyframe percentages as class-selector dots. This module routes each
 * readable embedded `<style>` block body through the *same* CSS parser the
 * `.css`/`.scss` path uses (`parseFile` + `extractClassUsageFromCSSAst`), so the
 * discriminant for "is this a keyframes at-rule" is what the parser reports:
 * keyframe selectors (`from`/`to`/percentages) are structurally absent from the
 * `class_name`-under-`class_selector` walk, and there is no hand-maintained
 * at-rule-name list anywhere in the path.
 *
 * The block boundaries and dialect (`css`/`scss`) come from `collectStyleBlocks`,
 * the same single source of truth the declaration extractor reads, so the two
 * harvests can never disagree. Unread dialects (`sass`/`less`/`styl`/…) are
 * dropped by `collectStyleBlocks` before this function runs — exactly the
 * dialects the regex declaration path also skips, so the catalog never asserts a
 * class defined only in a dialect the tool cannot parse.
 */

import { collectStyleBlocks } from './styleExtractor.js';
import { extractClassUsageFromCSSAst } from './cssAstExtractor.js';
import { parseFile } from '../languages/adapterBridge.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import type { DefinedClassRef } from './definedClasses.js';

/**
 * Harvest the defined classes (`.foo` selectors) from one markup file's readable
 * embedded `<style>` blocks, using the CSS parser rather than a selector pattern.
 *
 * @param filePath The markup source path (becomes the catalog `file_path`).
 * @param sourceCode The raw markup source.
 * @returns One entry per distinct (className, filePath) defined selector.
 */
export function harvestMarkupStyleClasses(
  filePath: string,
  sourceCode: string,
): DefinedClassRef[] {
  const blocks = collectStyleBlocks(sourceCode);
  if (blocks.length === 0) return [];

  const registry = LanguageRegistry.getInstance();
  const refs: DefinedClassRef[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    // A synthetic path selects the CSS/SCSS grammar in `parseFile` and the
    // matching adapter in `getAdapterForFile`. The real markup path is threaded
    // to `extractClassUsageFromCSSAst` as `filePath` so the catalog records the
    // source file, not the synthetic one.
    const syntheticPath = block.lang === 'scss' ? 'embedded.scss' : 'embedded.css';
    const adapter = registry.getAdapterForFile(syntheticPath);
    if (!adapter) continue;

    const ast = parseFile(syntheticPath, block.body);
    if (!ast) continue;

    try {
      for (const u of extractClassUsageFromCSSAst(ast, adapter, filePath, block.body)) {
        if (u.unresolvable) continue; // SCSS `&`-references are uses, not definitions.
        // `filePath` is the single markup path threaded in above, so `className`
        // alone is a unique key for this file; dedup collapses a class selector
        // that appears in more than one `<style>` block.
        if (seen.has(u.className)) continue;
        seen.add(u.className);
        refs.push({ className: u.className, filePath: u.filePath });
      }
    } finally {
      ast.dispose?.();
    }
  }

  return refs;
}
