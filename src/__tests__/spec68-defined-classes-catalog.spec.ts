/**
 * Spec 68 §3.2 — the `defined-classes` corpus producer (Item 4 2b / the "fix the
 * defined-classes catalog" directive).
 *
 * The catalog is derived from each declaration's selector `context` by the same
 * regex every `style_defined_classes` writer uses. That regex must NOT split a
 * compound selector's single-letter part into a standalone class (`.rp-letters .p`
 * yielding `p`) nor read a keyframe percentage as a class (`15.8%` yielding `8`).
 * The corrected regex `/\.([a-zA-Z_-][a-zA-Z0-9_-]+)/g` enforces both: the first
 * char must be a letter/underscore/hyphen (a leading digit is a decimal point, not
 * a class), and the name must be at least two chars (a single-letter selector part
 * is a fragment of a larger selector, not a class name on its own).
 *
 * This pins the producer directly, so a regression in the regex is caught here
 * even though the parity test (which seeds only multi-char class names) would not
 * notice.
 */

import { describe, it, expect } from 'vitest';
import { CORPUS_PRODUCERS } from '../phase/producers.js';
import type { DefinedClassesFact } from '../phase/types.js';

/** Build the `style-declarations` upstream fact for a list of (context, file)
 *  selector fragments and run the producer, returning the sorted catalog. */
function catalog(contexts: Array<{ context: string; filePath: string }>): DefinedClassesFact[] {
  return CORPUS_PRODUCERS['defined-classes'].process({
    'style-declarations': [
      {
        declarations: contexts.map(({ context, filePath }) => ({
          property: 'color',
          rawValue: 'red',
          normalizedValue: null,
          mechanism: 'css',
          filePath,
          line: 1,
          context,
          variantContext: null,
          tokenRef: null,
        })),
        tokens: [],
        classUsage: [],
        unreadSources: [],
      },
    ],
  });
}

describe('Spec 68 defined-classes catalog (compound-selector and keyframe pollution)', () => {
  it('keeps the compound selector name but drops its single-letter descendant part', () => {
    const result = catalog([{ context: '.rp-letters .p', filePath: 'a.css' }]);
    expect(result.map((c) => c.className)).toEqual(['rp-letters']);
  });

  it('drops a keyframe percentage (leading digit is a decimal point, not a class)', () => {
    const result = catalog([{ context: '15.8%', filePath: 'kf.css' }]);
    expect(result).toEqual([]);
  });

  it('keeps a normal multi-char class name', () => {
    const result = catalog([{ context: '.btn-primary', filePath: 'a.css' }]);
    expect(result.map((c) => c.className)).toEqual(['btn-primary']);
  });

  it('keeps a short class that starts with a letter (p-4, not a bare fragment)', () => {
    const result = catalog([{ context: '.p-4', filePath: 'a.css' }]);
    expect(result.map((c) => c.className)).toEqual(['p-4']);
  });

  it('stops the class name at a pseudo-class colon', () => {
    const result = catalog([{ context: '.text-red-500:hover', filePath: 'a.css' }]);
    expect(result.map((c) => c.className)).toEqual(['text-red-500']);
  });

  it('drops single-letter parts of a multi-selector list, keeping only multi-char names', () => {
    const result = catalog([{ context: '.a .btn .b', filePath: 'a.css' }]);
    expect(result.map((c) => c.className)).toEqual(['btn']);
  });

  it('keeps the lexicographically smallest file path when a class is defined twice', () => {
    const result = catalog([
      { context: '.shared', filePath: 'z.css' },
      { context: '.shared', filePath: 'a.css' },
    ]);
    expect(result).toEqual([{ className: 'shared', filePath: 'a.css' }]);
  });

  it('sorts the catalog by class name', () => {
    const result = catalog([
      { context: '.zeta', filePath: 'a.css' },
      { context: '.alpha', filePath: 'a.css' },
      { context: '.mid', filePath: 'a.css' },
    ]);
    expect(result.map((c) => c.className)).toEqual(['alpha', 'mid', 'zeta']);
  });
});
