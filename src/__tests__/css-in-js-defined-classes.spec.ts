/**
 * Spec 45, Piece 3 — CSS-in-JS defined-class harvest routes through the CSS
 * parser, the same path markup `<style>` blocks already use.
 *
 * TS/JS source carries its CSS-in-JS class definitions (`.foo` selectors inside
 * a `css`/`styled.*`/`createGlobalStyle`/`keyframes` tagged template) in no CSS
 * AST. The pre-fix path scraped the declarations' selector `context` (hardcoded
 * `'styled'`) with `scanClassNamesFromSelector`, which is empty for `'styled'` —
 * so a class defined in a nested CSS-in-JS block never entered the catalog, and
 * using it in markup produced a false `styles/undefined-class` finding. Worse,
 * `extractDeclarationsFromBlock`'s `{` filter dropped every declaration whose
 * line carried a nested block, so no declaration even recorded the selector.
 *
 * These tests drive the real `extractStylesSource` producer and the
 * `defined-classes` corpus producer: a class selector nested inside a CSS-in-JS
 * template block is present in the catalog, while a keyframe percentage inside a
 * `keyframes` template is absent (the parser excludes keyframe selectors
 * structurally, exactly as it does for `.css` and markup `<style>` blocks).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { extractStylesSource } from '../phase/stylesSource.js';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import type { AstFile } from '../phase/types.js';

let registry: LanguageRegistry;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  registry = LanguageRegistry.getInstance();
}, 30_000);

/** Parse a TSX fixture into an `AstFile` and run the real source producer. */
async function sourceCatalog(source: string, fileName = 'fixture.tsx'): Promise<string[]> {
  const adapter = registry.getAdapterForFile(fileName);
  const ast = await adapter.parse(fileName, source);
  const file: AstFile = {
    file: fileName,
    format: 'tsx',
    source,
    ast,
    adapter,
  };
  const facts = extractStylesSource(file);
  const defined = CORPUS_PRODUCERS['defined-classes'].process({ 'style-declarations': facts });
  return defined.map((d) => d.className);
}

describe('defined-classes catalog — CSS-in-JS harvest', () => {
  it('harvests a class selector nested inside a CSS-in-JS template block', async () => {
    const src = [
      "import { css } from 'styled-components';",
      '',
      'export const styles = css`',
      '  .card {',
      '    color: red;',
      '    .inner {',
      '      color: blue;',
      '    }',
      '  }',
      '`;',
    ].join('\n');
    const names = await sourceCatalog(src);
    expect(names).toContain('card');
    expect(names).toContain('inner');
  });

  it('excludes a keyframe percentage inside a keyframes template (parser-structural)', async () => {
    const src = [
      "import { keyframes } from 'styled-components';",
      '',
      'export const pulse = keyframes`',
      '  0% { opacity: 0; }',
      '  15.8% { opacity: 0.5; }',
      '  to { opacity: 1; }',
      '`;',
    ].join('\n');
    const names = await sourceCatalog(src);
    expect(names).not.toContain('8');
  });
});
