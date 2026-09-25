/**
 * Declared design scale — Spec 55 R6.
 *
 * The off-scale rule must not infer a scale. It reads the project's *declared*
 * tokens — Tailwind theme `spacing.*` / `fontSize.*`, or CSS custom properties
 * named by the conventions the Tailwind v4 `@theme` classifier parses — and
 * treats only those as authoritative. Where a project declares no scale for a
 * family, the rule is notApplicable: a plain-CSS project that never opted into
 * a token system must not have its raw values judged against a scale it did not
 * choose.
 *
 * This module is intentionally free of analyzer and pipeline imports so that
 * both the UniversalStylesAnalyzer (which judges raw values against the scale)
 * and the derived-applicability predicate in applicability.ts (which decides
 * whether the rule *can* fire at all) read the SAME scale definition. The two
 * consumers cannot drift — the same property that "declares a scale" for one
 * declares it for the other.
 */

/** The minimal token shape `buildDeclaredScale` needs. */
export interface StyleTokenLike {
  name: string;
  value: string;
  /** `built-in defaults` marks the bundled Tailwind fallback palette, not a
   *  project token. */
  file_path: string;
}

/** A declared design scale, derived from the project's own tokens. */
export interface DeclaredScale {
  /** px values the project's spacing tokens declare (margin/padding/gap). */
  spacing: Set<number>;
  /** px values the project's font-size tokens declare (font-size). */
  fontSize: Set<number>;
}

/** Parse a CSS length value to px-equivalent, or null if not parseable. */
export function parseLengthToPx(raw: string): number | null {
  try {
    const v = raw.trim().toLowerCase();
    if (v === '0' || v === '0px') return 0;

    const match = v.match(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em|%|vh|vw|pt|cm|mm)?$/);
    if (!match) return null;

    const num = parseFloat(match[1]);
    const unit = match[2] || 'px';

    // Approximate conversions (assuming 16px base for rem/em)
    switch (unit) {
      case 'px': return num;
      case 'rem': return num * 16;
      case 'em': return num * 16;
      case 'pt': return num * 1.333;
      case 'cm': return num * 37.795;
      case 'mm': return num * 3.7795;
      default: return null; // can't convert %/vh/vw without context
    }
  } catch {
    return null;
  }
}

/**
 * Classify a token name into the scale-family property it declares, or null if
 * the token does not belong to a scale family (colors, radii, tap targets).
 *
 * - Tailwind theme tokens carry explicit category names: `spacing.*`, `fontSize.*`.
 * - CSS custom properties use the Tailwind v4 `@theme` conventions: `--space-*`/
 *   `--spacing-*` → spacing, `--font-size-*`/`--text-*` → font-size. (`--font-*`
 *   is a font-*family* token, not a length, so it is deliberately excluded.)
 */
export function tokenScaleCategory(name: string): 'spacing' | 'font-size' | null {
  if (name.startsWith('spacing.')) return 'spacing';
  if (name.startsWith('fontSize.')) return 'font-size';
  if (name.startsWith('--')) {
    const bare = name.slice(2).toLowerCase();
    if (bare.startsWith('space-') || bare.startsWith('spacing-')) return 'spacing';
    if (bare === 'font-size' || bare.startsWith('font-size-') || bare.startsWith('text-')) return 'font-size';
  }
  return null;
}

/** Build the declared scale from the project's own token rows. */
export function buildDeclaredScale(tokens: readonly StyleTokenLike[]): DeclaredScale {
  const scale: DeclaredScale = { spacing: new Set(), fontSize: new Set() };
  for (const t of tokens) {
    // Exclude the bundled Tailwind default palette (see buildTokenValueMap) — a
    // project that did not declare its own tokens has no declared scale.
    if (t.file_path === 'built-in defaults') continue;
    const category = tokenScaleCategory(t.name);
    if (!category) continue;
    const px = parseLengthToPx(t.value);
    if (px === null) continue;
    if (category === 'spacing') scale.spacing.add(px);
    else scale.fontSize.add(px);
  }
  return scale;
}

/** Whether the project declared *any* scale family (spacing or font-size). */
export function hasDeclaredScale(scale: DeclaredScale): boolean {
  return scale.spacing.size > 0 || scale.fontSize.size > 0;
}
