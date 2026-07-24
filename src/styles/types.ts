/**
 * Style intelligence types.
 *
 * Defines the normalized declaration, design token, and class-usage models
 * that the style extraction, indexing, and analyzer layers share.
 *
 * Part of Spec 10 — Style Intelligence.
 */

// ---------------------------------------------------------------------------
// Style Mechanism
// ---------------------------------------------------------------------------

/**
 * The mechanism through which a style declaration was applied.
 * - `css` / `scss` — traditional stylesheets
 * - `tailwind` — Tailwind utility classes
 * - `inline` — JSX style={{...}} objects
 * - `css-in-js` — styled-components / emotion tagged templates
 * - `design-token` — CSS custom properties defined as design tokens
 */
export type StyleMechanism = 'css' | 'scss' | 'tailwind' | 'inline' | 'css-in-js' | 'design-token';

// ---------------------------------------------------------------------------
// Normalized Value
// ---------------------------------------------------------------------------

/** A color value, always stored as 6-char lowercase hex + alpha. */
export interface NormalizedColor {
  type: 'color';
  hex: string;   // 6-char lowercase, e.g. "1e2328"
  alpha: number;  // 0–1
}

/** A length value, parsed into numeric value + unit. px where possible. */
export interface NormalizedLength {
  type: 'length';
  value: number;
  unit: string;   // "px", "rem", "em", "%", "vh", "vw", etc.
}

/** A literal value that is neither color nor length (e.g. "flex", "hidden"). */
export interface NormalizedLiteral {
  type: 'literal';
  value: string;
}

export type NormalizedValue = NormalizedColor | NormalizedLength | NormalizedLiteral;

// ---------------------------------------------------------------------------
// Normalized Declaration
// ---------------------------------------------------------------------------

/**
 * A single style declaration extracted from any mechanism, normalized for
 * cross-mechanism comparison. This is the fundamental unit of the style index.
 */
export interface NormalizedDeclaration {
  /** CSS property name (e.g. "margin-top", "color"). Always a longhand. */
  property: string;

  /** The raw value as written in source (e.g. "rgb(30,35,40)"). */
  rawValue: string;

  /** Normalized value for comparison; null for computed/unresolvable values. */
  normalizedValue: NormalizedValue | null;

  /** The mechanism that produced this declaration. */
  mechanism: StyleMechanism;

  /** File path (project-relative). */
  filePath: string;

  /** 1-indexed line number. */
  line: number;

  /**
   * The enclosing context:
   * - CSS/SCSS: the selector (e.g. ".card .header")
   * - Tailwind: the parent element identity
   * - Inline / CSS-in-JS: the component/function name
   */
  context: string | null;

  /**
   * The variant / responsive / state context:
   * - CSS/SCSS: enclosing at-rule (@media, @supports)
   * - Tailwind: variant prefix (hover:, sm:, dark:)
   */
  variantContext: string | null;

  /**
   * Reference to a design token, if this value came from one:
   * - CSS custom property: "--color-primary"
   * - Tailwind theme token: "colors.blue.500"
   * null when the value is a raw literal.
   */
  tokenRef: string | null;
}

// ---------------------------------------------------------------------------
// Design Token
// ---------------------------------------------------------------------------

export interface StyleToken {
  name: string;
  value: string;
  filePath: string;
  /** The mechanism that defined the token ('css-custom-property' | 'tailwind-theme'). */
  mechanism: 'css-custom-property' | 'tailwind-theme';
  usageCount?: number;
  bypassCount?: number;
}

// ---------------------------------------------------------------------------
// Class Usage
// ---------------------------------------------------------------------------

export interface StyleClassUsage {
  className: string;
  filePath: string;
  line: number;
  /** 'className' for JSX, 'class' for plain HTML/Vue. */
  mechanism: 'className' | 'class';
  /** True when the class value is dynamic (template literal, clsx call) and can't be fully resolved. */
  unresolvable: boolean;
}
