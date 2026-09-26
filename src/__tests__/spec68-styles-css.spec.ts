/**
 * Spec 68 §3.2 — the `styles-css` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array;
 * this test proves the extraction is *correct* against the three arrays the
 * styles rules read: normalized `declarations`, design `tokens` (custom
 * properties), and `classUsage`. It exercises the producer wiring in
 * `producers.ts`, not the `cssAstExtractor` functions directly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import type { ParsedFile, StylesCssFile } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function css(path: string, source: string): StylesCssFile {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = {
    file: path,
    format: path.endsWith('.scss') ? 'scss' : 'css',
    source,
    ast,
    adapter: adapter!,
  };
  try {
    const producer = PRODUCERS['styles-css'] as { process(f: ParsedFile): StylesCssFile[] };
    return producer.process(file)[0];
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 68 styles-css producer', () => {
  it('extracts a declaration with its selector context and css mechanism', () => {
    const fact = css('/fixture/a.css', '.button { color: red; }');

    expect(fact.declarations.length).toBe(1);
    const decl = fact.declarations[0];
    expect(decl.property).toBe('color');
    expect(decl.rawValue).toBe('red');
    expect(decl.mechanism).toBe('css');
    expect(decl.context).toContain('button');
    expect(decl.filePath).toBe('/fixture/a.css');
  });

  it('extracts class usage for the selector', () => {
    const fact = css('/fixture/a.css', '.button { color: red; }');
    expect(fact.classUsage.map((c) => c.className)).toContain('button');
    expect(fact.classUsage[0].mechanism).toBe('class');
  });

  it('extracts a design token from a CSS custom property', () => {
    const fact = css('/fixture/b.css', ':root { --brand: #ff0000; }');
    expect(fact.tokens.map((t) => t.name)).toContain('--brand');
    expect(fact.tokens[0].mechanism).toBe('css-custom-property');
  });

  it('returns empty arrays for an empty stylesheet', () => {
    const fact = css('/fixture/c.css', '');
    expect(fact.declarations).toEqual([]);
    expect(fact.tokens).toEqual([]);
    expect(fact.classUsage).toEqual([]);
  });
});
