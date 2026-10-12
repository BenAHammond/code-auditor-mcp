/**
 * Piece 2 — keyframe-percentage pollution fixed at the catalog layer.
 *
 * Every writer of the defined-class catalog (`defined-classes` fact and the
 * `style_defined_classes` table) used to scrape class names out of a declaration's
 * selector `context` with a selector regex. That scrape is wrong twice: a keyframe
 * selector like `15.8%` (in a markup `<style>` block) carries a `.` before `8` that
 * is a decimal point, not a class selector, and a CSS attribute selector like
 * `[data-ratio="1.5"]` carries a `.` inside its value. A class name cannot begin
 * with a digit, so every such `.digit` is pollution — a class that no stylesheet
 * defines.
 *
 * The catalog must instead come from the CSS parser's class-selector harvest:
 * for CSS/SCSS from `classUsage` (which walks `class_name` nodes under
 * `class_selector`), and for markup from `harvestMarkupStyleClasses` (which
 * parses each embedded `<style>` block body with the CSS parser). Only TS/JS
 * source scans the selector `context` (it has no CSS AST). These tests drive the
 * real `defined-classes` corpus producer and pin the catalog to the parser
 * harvest: the real class is present, the keyframe fractions and attribute-value
 * decimals are absent, `@media`-wrapped rules are still harvested, and
 * escaped/numeric-leading selectors behave exactly as the parser reports them.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { extractDeclarationsFromCSSAst, extractClassUsageFromCSSAst } from '../styles/cssAstExtractor.js';
import { extractDeclarations } from '../styles/styleExtractor.js';
import { extractClassUsage } from '../styles/styleIndexer.js';
import { harvestMarkupStyleClasses } from '../styles/markupStyleHarvest.js';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import type { StyleDeclarationsFile } from '../phase/types.js';

let registry: LanguageRegistry;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  registry = LanguageRegistry.getInstance();
}, 30_000);

/** Parse a CSS fixture into the per-file fact, exactly as `extractStylesCss` would. */
async function cssFact(css: string, fileName = 'fixture.css'): Promise<StyleDeclarationsFile> {
  const adapter = registry.getAdapterForFile(fileName);
  const ast = await adapter.parse(fileName, css);
  return {
    declarations: extractDeclarationsFromCSSAst(ast, adapter, fileName, css),
    tokens: [],
    classUsage: extractClassUsageFromCSSAst(ast, adapter, fileName, css),
    definedClasses: [],
    unreadSources: [],
  };
}

/** Build the per-file fact for a markup `<style>` block, as `extractStylesMarkup` would. */
function markupFact(html: string, fileName = 'fixture.html'): StyleDeclarationsFile {
  return {
    declarations: extractDeclarations(fileName, null as never, html, undefined, undefined),
    tokens: [],
    classUsage: extractClassUsage(fileName, html),
    definedClasses: harvestMarkupStyleClasses(fileName, html),
    unreadSources: [],
  };
}

function catalogOf(fact: StyleDeclarationsFile): string[] {
  const defined = CORPUS_PRODUCERS['defined-classes'].process({ 'style-declarations': [fact] });
  return defined.map((d) => d.className);
}

describe('defined-classes catalog — keyframe/selector pollution', () => {
  it('markup @keyframes: keeps the real class and excludes 8/5/0', async () => {
    const html = [
      '<style>',
      '@keyframes pulse {',
      '  0%    { opacity: 0; }',
      '  15.8% { opacity: 0.5; }',
      '  12.5% { opacity: 0.25; }',
      '  10.0% { opacity: 0.1; }',
      '  from  { opacity: 0.2; }',
      '  to    { opacity: 1; }',
      '}',
      '.card { color: red; }',
      '</style>',
    ].join('\n');
    const names = catalogOf(markupFact(html));
    expect(names).toContain('card');
    expect(names).not.toContain('8');
    expect(names).not.toContain('5');
    expect(names).not.toContain('0');
  });

  it('CSS attribute selector: excludes a decimal inside the value (no 5)', async () => {
    const css = '.foo[data-ratio="1.5"] { color: red; }\n.card { margin: 0.5rem; }';
    const names = catalogOf(await cssFact(css));
    expect(names).toContain('foo');
    expect(names).toContain('card');
    expect(names).not.toContain('5');
  });

  it('still harvests a class inside an @media block', async () => {
    const css = '@media (min-width: 600px) {\n  .responsive-card { display: block; }\n}';
    const names = catalogOf(await cssFact(css));
    expect(names).toContain('responsive-card');
  });

  it('equals the parser harvest for escaped/numeric-leading selectors', async () => {
    // `.\\:weird` is an escaped class name and `[data-x]` an attribute selector —
    // the catalog reports exactly what the CSS parser's class_selector walk
    // reports, nothing more (no hand-rolled expectation).
    const css = [
      '.\\:weird { color: red; }',
      '[data-x] { color: blue; }',
      '.normal { color: green; }',
    ].join('\n');
    const fact = await cssFact(css);
    const parserHarvest = fact.classUsage
      .filter((u) => !u.unresolvable)
      .map((u) => u.className)
      .sort();
    const names = catalogOf(fact).sort();
    expect(names).toEqual(parserHarvest);
    expect(names).toContain('normal');
  });
});
