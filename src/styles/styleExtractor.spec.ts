/**
 * Golden fixture tests for extractDeclarationsFromBlock.
 *
 * CSS text with gnarly comments in → expected {property, value} array out.
 * These tests encode the exact comment-contamination bug class: multi-line
 * `/* ... *​/` comments leaking body text into the property column through
 * per-line stripping, producing malformed properties that dodge the `--`
 * guard and generate false token-bypass findings.
 *
 * The production mechanism: Frosted-prism.css (a comment-heavy design-token
 * file) has multi-line `/* ... *​/` blocks throughout. Per-line stripping
 * via `stripAllBlockComments(trimmed)` would see comment-body lines with no
 * `/*` trigger and return them verbatim, prepending comment text to the
 * next declaration's property field. The whole-block fix strips all comments
 * before splitting into lines, eliminating the class of bug.
 */
import { describe, it, expect } from 'vitest';
import { extractDeclarationsFromBlock } from './styleExtractor.js';
import type { NormalizedDeclaration } from './types.js';

/** Shorthand: extract declarations from a CSS block and return {property, rawValue} pairs. */
function extract(block: string): Array<{ property: string; rawValue: string }> {
  const declarations: NormalizedDeclaration[] = [];
  extractDeclarationsFromBlock(block, 'test.css', 'css', '.test', null, declarations, 0);
  return declarations.map(d => ({ property: d.property, rawValue: d.rawValue }));
}

// expandShorthand turns padding: 8px into four longhands
const paddingLonghands = [
  { property: 'padding-top', rawValue: '8px' },
  { property: 'padding-right', rawValue: '8px' },
  { property: 'padding-bottom', rawValue: '8px' },
  { property: 'padding-left', rawValue: '8px' },
];

describe('extractDeclarationsFromBlock — comment stripping', () => {
  // -----------------------------------------------------------------------
  // Baseline
  // -----------------------------------------------------------------------

  it('extracts declarations with no comments', () => {
    const result = extract(`
      color: #eef4f9;
      display: flex;
    `);
    expect(result).toEqual([
      { property: 'color', rawValue: '#eef4f9' },
      { property: 'display', rawValue: 'flex' },
    ]);
  });

  it('extracts a shorthand declaration', () => {
    const result = extract(`padding: 8px;`);
    expect(result).toEqual(paddingLonghands);
  });

  // -----------------------------------------------------------------------
  // Single-line comments
  // -----------------------------------------------------------------------

  it('strips a single-line comment before a declaration', () => {
    const result = extract(`
      /* foreground ink */
      color: #eef4f9;
    `);
    expect(result).toEqual([
      { property: 'color', rawValue: '#eef4f9' },
    ]);
  });

  it('strips a single-line comment after a declaration', () => {
    const result = extract(`
      color: #eef4f9; /* the main text color */
      display: flex;
    `);
    expect(result).toEqual([
      { property: 'color', rawValue: '#eef4f9' },
      { property: 'display', rawValue: 'flex' },
    ]);
  });

  it('strips two comments on the same line', () => {
    const result = extract(`
      /* stylelint-disable */ color: #eef4f9; /* the ink */
      display: flex;
    `);
    expect(result).toEqual([
      { property: 'color', rawValue: '#eef4f9' },
      { property: 'display', rawValue: 'flex' },
    ]);
  });

  // -----------------------------------------------------------------------
  // Multi-line comments — the bug class
  // -----------------------------------------------------------------------

  it('strips a multi-line comment spanning several lines', () => {
    // Per-line stripAllBlockComments: comment-body lines ("* Back-compat: ...",
    // "* into the single iridescent identity.") and the bare "*/" closing line
    // have no `/*` trigger → returned verbatim → buffer accumulates comment
    // body text → malformed property with comment text in the property field.
    // Whole-block stripping removes the entire `/* ... */` atomically.
    const result = extract(`
      color: #eef4f9;
      /*
       * Back-compat: collapse the old four-role accent system
       * into the single iridescent identity.
       */
      display: flex;
    `);
    expect(result).toEqual([
      { property: 'color', rawValue: '#eef4f9' },
      { property: 'display', rawValue: 'flex' },
    ]);
  });

  it('strips a single-line comment wrapping a declaration', () => {
    const result = extract(`
      color: #eef4f9;
      /* --brand-action: #22d3ee; */
      display: flex;
    `);
    // The commented-out declaration must NOT appear.
    expect(result).toEqual([
      { property: 'color', rawValue: '#eef4f9' },
      { property: 'display', rawValue: 'flex' },
    ]);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('handles unclosed comment — discards rest of block', () => {
    const result = extract(`
      /* this comment never closes
      color: #eef4f9;
      display: flex;
    `);
    expect(result).toEqual([]);
  });

  it('handles empty block', () => {
    const result = extract('');
    expect(result).toEqual([]);
  });

  it('handles only comments', () => {
    const result = extract(`/* section heading */ /* another comment */`);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // CSS custom properties — design token definitions
  // -----------------------------------------------------------------------

  it('preserves --prefix on custom property definitions', () => {
    const result = extract(`
      --ink: #eef4f9;
      --accent: #22d3ee;
    `);
    expect(result).toEqual([
      { property: '--ink', rawValue: '#eef4f9' },
      { property: '--accent', rawValue: '#22d3ee' },
    ]);
  });

  it('multi-line comment before a custom property — item-2 production regression', () => {
    // Frosted-prism.css is comment-heavy. Multi-line `/* ... */` blocks
    // leaked body text through per-line stripping, producing malformed
    // properties that dodged the `--` guard. This is the production
    // mechanism for the 11 item-2 survivors: the fixture alone couldn't
    // reproduce them because it had no multi-line comments wrapping
    // custom-property definitions.
    const result = extract(`
      /*
       * Back-compat: collapse the old four-role accent system
       * into the single iridescent identity.
       */
      --brand-action: #22d3ee;
    `);
    expect(result).toEqual([
      { property: '--brand-action', rawValue: '#22d3ee' },
    ]);
  });
});
