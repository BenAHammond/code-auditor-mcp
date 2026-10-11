import { describe, it, expect } from 'vitest';
import { expandUtility } from './tailwindExpander.js';
import type { TailwindThemeTokens } from './tailwindConfigLoader.js';

/**
 * Regression: `shadow-*` box-shadow utilities must resolve against a boxShadow
 * scale or resolve to nothing. They must never fall through the spacing →
 * fontSize → borderRadius chain, which previously turned `shadow-md` into
 * `box-shadow: calc(var(--radius) - 2px)` — a value that appears nowhere in the
 * source as a shadow.
 */
describe('tailwindExpander — box-shadow scale isolation', () => {
  // Tokens shaped like a shadcn-style theme: no boxShadow scale, but `md` present
  // in both fontSize and borderRadius so a fallthrough would land on a value.
  const tokens: TailwindThemeTokens = {
    colors: {},
    spacing: {},
    fontSize: { md: '0.875rem' },
    borderRadius: { md: 'calc(var(--radius) - 2px)' },
  };

  it('shadow-md resolves to nothing (no boxShadow scale, no cross-scale fallthrough)', () => {
    const decls = expandUtility('shadow-md', tokens, '/x/Component.tsx', 1);
    expect(decls).toEqual([]);
  });

  it('shadow-sm resolves to nothing rather than the fontSize "sm" value', () => {
    const decls = expandUtility('shadow-sm', { ...tokens, fontSize: { sm: '0.875rem' } }, '/x/Component.tsx', 1);
    expect(decls).toEqual([]);
  });

  it('shadow-lg resolves to nothing rather than the borderRadius "lg" value', () => {
    const decls = expandUtility('shadow-lg', { ...tokens, borderRadius: { lg: '8px' } }, '/x/Component.tsx', 1);
    expect(decls).toEqual([]);
  });

  it('a length-valued utility still resolves against the spacing scale', () => {
    const decls = expandUtility('border-2', { ...tokens, spacing: { '2': '8px' } }, '/x/Component.tsx', 1);
    expect(decls.length).toBeGreaterThan(0);
    expect(decls[0].value ?? decls[0].rawValue).toBe('8px');
  });
});

describe('tailwindExpander — per-property scale isolation', () => {
  // A theme where the same key is present in several scales, so any
  // cross-scale fallthrough lands on the wrong value. fontSize and
  // borderRadius both carry a value; spacing carries numeric keys a line-height
  // or letter-spacing utility must never borrow.
  const tokens: TailwindThemeTokens = {
    colors: {},
    spacing: { '4': '16px' },
    fontSize: { lg: '1.125rem' },
    borderRadius: { md: 'calc(var(--radius) - 2px)', lg: '8px' },
  };

  it('text-lg resolves against the fontSize scale', () => {
    const decls = expandUtility('text-lg', tokens, '/x/Component.tsx', 1);
    expect(decls.length).toBeGreaterThan(0);
    expect(decls[0].property).toBe('font-size');
    expect(decls[0].rawValue).toBe('1.125rem');
  });

  it('a font-size utility does not borrow a value from the borderRadius scale', () => {
    // fontSize has no "md" but borderRadius does. The old chain fell through
    // spacing → fontSize → borderRadius and reported borderRadius's "md" as a
    // font-size; the property must resolve to nothing instead.
    const decls = expandUtility('text-md', { ...tokens, fontSize: {} }, '/x/Component.tsx', 1);
    expect(decls).toEqual([]);
  });

  it('leading-4 resolves to nothing (no lineHeight scale, no spacing fallthrough)', () => {
    const decls = expandUtility('leading-4', tokens, '/x/Component.tsx', 1);
    expect(decls).toEqual([]);
  });

  it('tracking-wide resolves to nothing (no letterSpacing scale, no fallthrough)', () => {
    const decls = expandUtility('tracking-wide', tokens, '/x/Component.tsx', 1);
    expect(decls).toEqual([]);
  });

  it('font-sans resolves to nothing (no fontFamily scale, no fontSize fallthrough)', () => {
    const decls = expandUtility('font-sans', { ...tokens, fontSize: { ...tokens.fontSize, sans: '1rem' } }, '/x/Component.tsx', 1);
    expect(decls).toEqual([]);
  });
});
