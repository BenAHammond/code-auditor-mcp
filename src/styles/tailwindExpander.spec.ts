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
