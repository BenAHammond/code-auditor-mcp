/**
 * Style value normalizer — Spec 10.
 *
 * Normalizes raw CSS values into structured NormalizedValue objects,
 * enabling cross-mechanism comparison (CSS vs Tailwind vs inline).
 *
 * Single entry point: normalizeValue(rawValue, property).
 */

import type { NormalizedValue, NormalizedColor, NormalizedLength, NormalizedLiteral } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Properties that take color values. */
const COLOR_PROPERTIES = new Set([
  'color', 'background-color', 'background', 'border-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'text-decoration-color', 'caret-color', 'column-rule-color',
  'fill', 'stroke', 'accent-color', 'caret-color', 'box-shadow-color',
]);

/** Properties that take length values. */
const LENGTH_PROPERTIES = new Set([
  'width', 'min-width', 'max-width',
  'height', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'top', 'right', 'bottom', 'left',
  'gap', 'row-gap', 'column-gap',
  'font-size', 'line-height',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'outline-width', 'letter-spacing', 'word-spacing',
  'text-indent', 'inset', 'inset-block', 'inset-inline',
]);

/** Common rem root size for px conversion (Tailwind default). */
const REM_ROOT_PX = 16;

/** Shorthand → longhand expansion maps. */
const SHORTHAND_EXPANSIONS: Record<string, string[]> = {
  'margin': ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  'padding': ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'inset': ['top', 'right', 'bottom', 'left'],
  'gap': ['row-gap', 'column-gap'],
};

interface ExpandedDeclaration {
  property: string;
  rawValue: string;
  normalizedValue: NormalizedValue | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a raw CSS value for a given property.
 * Returns null when the value cannot be normalized (e.g. dynamic expressions).
 */
export function normalizeValue(rawValue: string, property: string): NormalizedValue | null {
  const trimmed = rawValue.trim();

  // Skip empty, dynamic, or obviously non-static values
  if (!trimmed || trimmed === 'inherit' || trimmed === 'initial' || trimmed === 'unset') {
    return { type: 'literal', value: trimmed || 'initial' };
  }

  // CSS custom property references — keep as literal
  if (trimmed.startsWith('var(') || trimmed.startsWith('--')) {
    return { type: 'literal', value: trimmed };
  }

  // calc() expressions — keep as literal (too complex to normalize)
  if (trimmed.includes('calc(')) {
    return { type: 'literal', value: trimmed };
  }

  // clamp(), min(), max() — keep as literal
  if (/^(clamp|min|max)\(/.test(trimmed)) {
    return { type: 'literal', value: trimmed };
  }

  // 0 is 0 regardless of unit
  if (trimmed === '0') {
    return { type: 'length', value: 0, unit: 'px' };
  }

  if (COLOR_PROPERTIES.has(property.toLowerCase())) {
    return normalizeColor(trimmed);
  }

  if (LENGTH_PROPERTIES.has(property.toLowerCase())) {
    return normalizeLength(trimmed);
  }

  // Generic: try color first (for properties we might not have listed), then length
  const colorResult = tryNormalizeColor(trimmed);
  if (colorResult) return colorResult;

  const lengthResult = tryNormalizeLength(trimmed);
  if (lengthResult) return lengthResult;

  return { type: 'literal', value: trimmed };
}

/**
 * Expand shorthand declarations into their longhand equivalents.
 * Returns the original single declaration if property isn't a shorthand
 * or the value can't be meaningfully expanded.
 *
 * @returns Array of {property, rawValue, normalizedValue} tuples.
 */
export function expandShorthand(
  property: string,
  rawValue: string,
  normalizedValue: NormalizedValue | null,
): ExpandedDeclaration[] {
  const longhands = SHORTHAND_EXPANSIONS[property.toLowerCase()];
  if (!longhands) {
    return [{ property, rawValue, normalizedValue }];
  }

  const parts = rawValue.split(/\s+/).filter(Boolean);

  // Standard CSS shorthand values: 1, 2, 3, or 4 values
  // 1 value: all sides    → top right bottom left
  // 2 values: top/bottom left/right → 4 longhands
  // 3 values: top left/right bottom
  // 4 values: top right bottom left
  let expandedParts: string[];

  switch (parts.length) {
    case 1:
      expandedParts = [parts[0], parts[0], parts[0], parts[0]];
      break;
    case 2:
      expandedParts = [parts[0], parts[1], parts[0], parts[1]];
      break;
    case 3:
      expandedParts = [parts[0], parts[1], parts[2], parts[1]];
      break;
    case 4:
      expandedParts = parts;
      break;
    default:
      return [{ property, rawValue, normalizedValue }];
  }

  // For gap shorthand (2 longhands), handle 1 or 2 values
  if (longhands.length === 2) {
    if (parts.length === 1) {
      expandedParts = [parts[0], parts[0]];
    } else if (parts.length === 2) {
      expandedParts = parts;
    } else {
      return [{ property, rawValue, normalizedValue }];
    }
  }

  return longhands.map((longhand, i) => ({
    property: longhand,
    rawValue: expandedParts[i] ?? parts[0],
    normalizedValue: normalizeValue(expandedParts[i] ?? parts[0], longhand),
  }));
}

// ---------------------------------------------------------------------------
// Color Normalization
// ---------------------------------------------------------------------------

function normalizeColor(raw: string): NormalizedValue {
  const result = tryNormalizeColor(raw);
  if (result) return result;
  return { type: 'literal', value: raw };
}

function tryNormalizeColor(raw: string): NormalizedColor | null {
  const trimmed = raw.toLowerCase().trim();

  // Named colors: keep as literal (too many to canonicalize comprehensively)
  // But handle the most common Tailwind transparent
  if (trimmed === 'transparent') {
    return { type: 'color', hex: '000000', alpha: 0 };
  }

  // CurrentColor, inherit — not a real color
  if (trimmed === 'currentcolor' || trimmed === 'currentColor') {
    return null;
  }

  // Hex colors
  const hexMatch = trimmed.match(/^#([0-9a-f]{3,8})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    return normalizeHexColor(hex);
  }

  // rgb() / rgba()
  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)\s*(?:,?\s*\/?\s*([\d.]+%?))?\s*\)$/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    const alpha = parseAlpha(rgbMatch[4]);
    const hex = rgbToHex(r, g, b);
    return { type: 'color', hex, alpha };
  }

  // hsl() / hsla()
  const hslMatch = trimmed.match(/^hsla?\(\s*([\d.]+)\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%\s*(?:,?\s*\/?\s*([\d.]+%?))?\s*\)$/);
  if (hslMatch) {
    const h = parseFloat(hslMatch[1]);
    const s = parseFloat(hslMatch[2]) / 100;
    const l = parseFloat(hslMatch[3]) / 100;
    const alpha = parseAlpha(hslMatch[4]);
    const hex = hslToHex(h, s, l);
    return { type: 'color', hex, alpha };
  }

  return null;
}

function normalizeHexColor(hex: string): NormalizedColor {
  let r: number, g: number, b: number, alpha = 1;

  switch (hex.length) {
    case 3: // #RGB
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      break;
    case 4: // #RGBA
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      alpha = parseInt(hex[3] + hex[3], 16) / 255;
      break;
    case 6: // #RRGGBB
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      break;
    case 8: // #RRGGBBAA
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      alpha = parseInt(hex.slice(6, 8), 16) / 255;
      break;
    default:
      return { type: 'color', hex, alpha };
  }

  return { type: 'color', hex: rgbToHex(r, g, b), alpha };
}

function parseAlpha(raw: string | undefined): number {
  if (!raw) return 1;
  const trimmed = raw.trim();
  if (trimmed.endsWith('%')) {
    return parseFloat(trimmed) / 100;
  }
  return parseFloat(trimmed);
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hslToHex(h: number, s: number, l: number): string {
  h = h / 360;
  let r: number, g: number, b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return rgbToHex(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

// ---------------------------------------------------------------------------
// Length Normalization
// ---------------------------------------------------------------------------

function normalizeLength(raw: string): NormalizedValue {
  const result = tryNormalizeLength(raw);
  if (result) return result;
  return { type: 'literal', value: raw };
}

function tryNormalizeLength(raw: string): NormalizedLength | null {
  const trimmed = raw.toLowerCase().trim();

  // Number with optional decimal
  const match = trimmed.match(/^(-?[\d.]+)\s*(px|rem|em|%|vh|vw|vmin|vmax|pt|cm|mm|in|ch|ex)?$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2] || 'px'; // Unitless values: treat as px

  // Convert rem to px for comparison (using standard 16px root)
  if (unit === 'rem') {
    return { type: 'length', value: value * REM_ROOT_PX, unit: 'px' };
  }

  if (unit === 'pt') {
    return { type: 'length', value: value * 4 / 3, unit: 'px' };
  }

  return { type: 'length', value, unit };
}

// ---------------------------------------------------------------------------
// Utility: check property types
// ---------------------------------------------------------------------------

/**
 * Returns true if the property accepts color values.
 */
export function isColorProperty(property: string): boolean {
  return COLOR_PROPERTIES.has(property.toLowerCase());
}

/**
 * Returns true if the property accepts length values.
 */
export function isLengthProperty(property: string): boolean {
  return LENGTH_PROPERTIES.has(property.toLowerCase());
}
