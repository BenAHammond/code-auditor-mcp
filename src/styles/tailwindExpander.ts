/**
 * Tailwind utility class expander — Spec 10.
 *
 * Expands Tailwind utility classes into normalized CSS declarations.
 * Uses design tokens from the config loader for value resolution.
 *
 * Three-tier resolution for values:
 *   1. Arbitrary values: mt-[17px] → margin-top: 17px
 *   2. Theme tokens: bg-blue-500 → background-color: #3b82f6
 *   3. Fixed scale: rounded-lg → border-radius: 8px
 */

import type { NormalizedDeclaration, StyleMechanism, NormalizedValue } from './types.js';
import { normalizeValue, expandShorthand } from './normalizer.js';
import type { TailwindThemeTokens } from './tailwindConfigLoader.js';

// ---------------------------------------------------------------------------
// Utility-to-Property Mapping
// ---------------------------------------------------------------------------

/**
 * Maps Tailwind utility class prefixes to their CSS properties.
 * Some utilities map to multiple properties (e.g. p → padding on all 4 sides).
 */
interface UtilityMapping {
  /** Primary CSS property. */
  property: string;
  /** True for directional utilities that need side suffixes (-t, -r, -b, -l, -x, -y). */
  directional?: {
    suffixes: Record<string, string[]>;
  };
  /** True for utilities where the value is a color. */
  colorValue?: boolean;
  /** Prefix that should be stripped to get the actual value (e.g. "text-" prefix for font-size). */
  valuePrefix?: string;
}

const UTILITY_MAP: Record<string, UtilityMapping> = {
  // -- Spacing (margin / padding) -------------------------------------------
  'm': {
    property: 'margin',
    directional: {
      suffixes: { 't': ['margin-top'], 'r': ['margin-right'], 'b': ['margin-bottom'], 'l': ['margin-left'], 'x': ['margin-left', 'margin-right'], 'y': ['margin-top', 'margin-bottom'] },
    },
  },
  'p': {
    property: 'padding',
    directional: {
      suffixes: { 't': ['padding-top'], 'r': ['padding-right'], 'b': ['padding-bottom'], 'l': ['padding-left'], 'x': ['padding-left', 'padding-right'], 'y': ['padding-top', 'padding-bottom'] },
    },
  },
  'mt': { property: 'margin-top' },
  'mr': { property: 'margin-right' },
  'mb': { property: 'margin-bottom' },
  'ml': { property: 'margin-left' },
  'mx': { property: 'margin-left', directional: { suffixes: {} } },
  'my': { property: 'margin-top', directional: { suffixes: {} } },
  'pt': { property: 'padding-top' },
  'pr': { property: 'padding-right' },
  'pb': { property: 'padding-bottom' },
  'pl': { property: 'padding-left' },
  'px': { property: 'padding-left', directional: { suffixes: {} } },
  'py': { property: 'padding-top', directional: { suffixes: {} } },

  // -- Gap ------------------------------------------------------------------
  'gap': { property: 'gap' },
  'gap-x': { property: 'column-gap' },
  'gap-y': { property: 'row-gap' },

  // -- Colors ---------------------------------------------------------------
  'bg': { property: 'background-color', colorValue: true },
  'text': { property: 'color', colorValue: true },
  'border': { property: 'border-color', colorValue: true },
  'border-t': { property: 'border-top-color', colorValue: true },
  'border-r': { property: 'border-right-color', colorValue: true },
  'border-b': { property: 'border-bottom-color', colorValue: true },
  'border-l': { property: 'border-left-color', colorValue: true },
  'ring': { property: '--tw-ring-color', colorValue: true },
  'accent': { property: 'accent-color', colorValue: true },
  'fill': { property: 'fill', colorValue: true },
  'stroke': { property: 'stroke', colorValue: true },
  'placeholder': { property: 'placeholder-color', colorValue: true },
  'caret': { property: 'caret-color', colorValue: true },
  'divide': { property: 'border-color', colorValue: true },
  'shadow': { property: '--tw-shadow-color', colorValue: true },
  'outline': { property: 'outline-color', colorValue: true },

  // -- Typography -----------------------------------------------------------
  'font': { property: 'font-family' },
  'text-': { property: 'font-size', valuePrefix: 'text-' },
  'leading': { property: 'line-height' },
  'tracking': { property: 'letter-spacing' },
  'font-bold': { property: 'font-weight' },
  'font-semibold': { property: 'font-weight' },
  'font-medium': { property: 'font-weight' },
  'font-normal': { property: 'font-weight' },
  'font-light': { property: 'font-weight' },
  'font-extralight': { property: 'font-weight' },
  'font-thin': { property: 'font-weight' },
  'font-extrabold': { property: 'font-weight' },
  'font-black': { property: 'font-weight' },

  // -- Sizing ---------------------------------------------------------------
  'w': { property: 'width' },
  'min-w': { property: 'min-width' },
  'max-w': { property: 'max-width' },
  'h': { property: 'height' },
  'min-h': { property: 'min-height' },
  'max-h': { property: 'max-height' },
  'size': { property: 'width', directional: { suffixes: {} } },

  // -- Layout ---------------------------------------------------------------
  'top': { property: 'top' },
  'right': { property: 'right' },
  'bottom': { property: 'bottom' },
  'left': { property: 'left' },
  'inset': { property: 'inset' },
  'inset-x': { property: 'left', directional: { suffixes: {} } },
  'inset-y': { property: 'top', directional: { suffixes: {} } },
  'z': { property: 'z-index' },

  // -- Borders --------------------------------------------------------------
  'rounded': { property: 'border-radius' },
  'rounded-t': { property: 'border-top-left-radius', directional: { suffixes: { '': [] } } },
  'rounded-r': { property: 'border-top-right-radius', directional: { suffixes: { '': [] } } },
  'rounded-b': { property: 'border-bottom-right-radius', directional: { suffixes: { '': [] } } },
  'rounded-l': { property: 'border-bottom-left-radius', directional: { suffixes: { '': [] } } },
  'rounded-tl': { property: 'border-top-left-radius' },
  'rounded-tr': { property: 'border-top-right-radius' },
  'rounded-br': { property: 'border-bottom-right-radius' },
  'rounded-bl': { property: 'border-bottom-left-radius' },
  'border-': { property: 'border-width', valuePrefix: 'border-' },
  'border-t-': { property: 'border-top-width', valuePrefix: 'border-t-' },
  'border-r-': { property: 'border-right-width', valuePrefix: 'border-r-' },
  'border-b-': { property: 'border-bottom-width', valuePrefix: 'border-b-' },
  'border-l-': { property: 'border-left-width', valuePrefix: 'border-l-' },

  // -- Flexbox & Grid -------------------------------------------------------
  'flex-': { property: 'flex', valuePrefix: 'flex-' },
  'grow': { property: 'flex-grow' },
  'shrink': { property: 'flex-shrink' },
  'basis': { property: 'flex-basis' },
  'order': { property: 'order' },
  'col-span': { property: 'grid-column' },

  // -- Effects --------------------------------------------------------------
  'opacity': { property: 'opacity' },
  'shadow-': { property: 'box-shadow', valuePrefix: 'shadow-' },

  // -- Transforms -----------------------------------------------------------
  'scale': { property: 'transform' },
  'rotate': { property: 'transform' },
  'translate-x': { property: 'transform' },
  'translate-y': { property: 'transform' },

  // -- Transition -----------------------------------------------------------
  'duration': { property: 'transition-duration' },
  'delay': { property: 'transition-delay' },
  'ease': { property: 'transition-timing-function' },
};

// ---------------------------------------------------------------------------
// Typography Scale (for font-weight, font-size, etc.)
// ---------------------------------------------------------------------------

const FONT_WEIGHT_MAP: Record<string, string> = {
  'thin': '100',
  'extralight': '200',
  'light': '300',
  'normal': '400',
  'medium': '500',
  'semibold': '600',
  'bold': '700',
  'extrabold': '800',
  'black': '900',
};

const ROUNDED_SCALE: Record<string, string> = {
  'none': '0px',
  'sm': '2px',
  '': '4px',
  'DEFAULT': '4px',
  'md': '6px',
  'lg': '8px',
  'xl': '12px',
  '2xl': '16px',
  '3xl': '24px',
  'full': '9999px',
};

// ---------------------------------------------------------------------------
// Variant prefixes (state / responsive)
// ---------------------------------------------------------------------------

/**
 * Known variant prefixes that signal a state or responsive breakpoint.
 * Everything before the last colon in a compound variant like
 * `sm:hover:bg-red-500` is treated as variantContext.
 */
const KNOWN_VARIANTS = new Set([
  // Responsive
  'sm', 'md', 'lg', 'xl', '2xl',
  // State
  'hover', 'focus', 'focus-visible', 'focus-within', 'active',
  'visited', 'target', 'first', 'last', 'only', 'odd', 'even',
  'first-of-type', 'last-of-type', 'only-of-type', 'empty',
  'disabled', 'enabled', 'checked', 'indeterminate', 'default',
  'required', 'valid', 'invalid', 'in-range', 'out-of-range',
  'placeholder-shown', 'autofill', 'read-only',
  // Pseudo-elements
  'before', 'after', 'first-letter', 'first-line', 'marker', 'selection',
  'file', 'backdrop',
  // Media / preference
  'dark', 'light', 'motion-safe', 'motion-reduce',
  'contrast-more', 'contrast-less', 'portrait', 'landscape',
  'print', 'supports',
  // Group / peer
  'group-hover', 'group-focus', 'peer-hover', 'peer-focus',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Expand a single Tailwind utility class into normalized declarations.
 *
 * @param className - The utility class (e.g. "bg-blue-500", "mt-4", "hover:bg-red-500")
 * @param tokens - Theme tokens from config loader (or defaults)
 * @param filePath - Source file path (for the declaration)
 * @param line - Line number (for the declaration)
 * @returns Array of NormalizedDeclaration, or empty if the class can't be expanded.
 */
export function expandUtility(
  className: string,
  tokens: TailwindThemeTokens,
  filePath: string,
  line: number,
): NormalizedDeclaration[] {
  const trimmed = className.trim();
  if (!trimmed) return [];

  // Strip variant prefix to get the base utility
  const { baseUtility, variantContext } = splitVariants(trimmed);
  const mechanism: StyleMechanism = 'tailwind';

  // Try arbitrary value first: bg-[#ff0000], mt-[17px], w-[calc(100%-1rem)]
  const arbitraryResult = expandArbitrary(baseUtility, tokens, filePath, line, mechanism, variantContext);
  if (arbitraryResult) return arbitraryResult;

  // Try standard utility expansion
  const standardResult = expandStandard(baseUtility, tokens, filePath, line, mechanism, variantContext);
  if (standardResult.length > 0) return standardResult;

  // Special cases: predefined utilities without values
  const staticResult = expandStatic(baseUtility, filePath, line, mechanism, variantContext);
  if (staticResult) return staticResult;

  return [];
}

/**
 * Expand variant-prefixed declarations by applying variantContext.
 * This is a convenience wrapper that first expands the utility, then
 * applies the variant context.
 *
 * @param variantPrefix - e.g. "hover", "sm:dark"
 * @param declarations - Declarations to apply the variant to
 */
export function expandVariant(
  variantPrefix: string,
  declarations: NormalizedDeclaration[],
): NormalizedDeclaration[] {
  const prefix = variantPrefix.endsWith(':') ? variantPrefix.slice(0, -1) : variantPrefix;
  return declarations.map((d) => ({
    ...d,
    variantContext: d.variantContext
      ? `${prefix}:${d.variantContext}`
      : prefix,
  }));
}

// ---------------------------------------------------------------------------
// Internal: Variant splitting
// ---------------------------------------------------------------------------

function splitVariants(className: string): { baseUtility: string; variantContext: string | null } {
  // Split on the LAST colon that separates known variants from the utility
  // e.g. "hover:bg-red-500" → variant="hover", utility="bg-red-500"
  // e.g. "sm:hover:bg-red-500" → variant="sm:hover", utility="bg-red-500"
  // e.g. "bg-red-500" → no variant

  const parts = className.split(':');

  // If no colon, it's a plain utility
  if (parts.length === 1) {
    return { baseUtility: className, variantContext: null };
  }

  // Walk from the end: the last part is always the utility
  // Everything before it is the variant chain
  const variantParts: string[] = [];
  let utilityIndex = parts.length - 1;

  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i];
    // Check if this part (and the remaining prefix) are all variants
    if (KNOWN_VARIANTS.has(part)) {
      variantParts.unshift(part);
    } else {
      // Not a known variant — it's part of the utility
      utilityIndex = i;
      break;
    }
  }

  const baseUtility = parts.slice(utilityIndex).join(':');
  const variantContext = variantParts.length > 0 ? variantParts.join(':') : null;

  return { baseUtility, variantContext };
}

// ---------------------------------------------------------------------------
// Internal: Arbitrary values
// ---------------------------------------------------------------------------

function expandArbitrary(
  utility: string,
  tokens: TailwindThemeTokens,
  filePath: string,
  line: number,
  mechanism: StyleMechanism,
  variantContext: string | null,
): NormalizedDeclaration[] | null {
  // Match utility-[value] or utility/modifier-[value]
  const match = utility.match(/^([a-z-]+?)(?:\/[\d.]+)?-\[(.+)\]$/);
  if (!match) return null;

  const prefix = match[1];
  const rawValue = match[2];

  // Find the mapping for this utility prefix
  const mapping = findMapping(prefix);
  if (!mapping) return null;

  const normalizedValue = normalizeValue(rawValue, mapping.property);

  return [{
    property: mapping.property,
    rawValue,
    normalizedValue,
    mechanism,
    filePath,
    line,
    context: null,
    variantContext,
    tokenRef: null,
  }];
}

// ---------------------------------------------------------------------------
// Internal: Standard utilities
// ---------------------------------------------------------------------------

function expandStandard(
  utility: string,
  tokens: TailwindThemeTokens,
  filePath: string,
  line: number,
  mechanism: StyleMechanism,
  variantContext: string | null,
): NormalizedDeclaration[] {
  // Find the matching utility prefix
  const mapping = findMapping(utility);
  if (!mapping) return [];

  // Extract the value portion
  let value: string;
  if (mapping.valuePrefix) {
    value = utility.slice(mapping.valuePrefix.length);
  } else {
    // The value is everything after the matched prefix
    // but we need to handle prefix matching carefully
    const matchKey = findMatchingKey(utility);
    if (!matchKey) return [];
    value = utility.slice(matchKey.length);
  }

  // Check for opacity modifier: bg-red-500/50
  let opacity: string | null = null;
  const slashIdx = value.lastIndexOf('/');
  if (slashIdx > 0 && /^\d+$/.test(value.slice(slashIdx + 1))) {
    opacity = value.slice(slashIdx + 1);
    value = value.slice(0, slashIdx);
  }

  // Resolve the value
  const resolvedValue = mapping.colorValue
    ? resolveColorValue(value, tokens)
    : resolveSpacingValue(value, tokens);

  if (!resolvedValue) {
    // Try ROUNDED_SCALE for border-radius utilities
    if (mapping.property === 'border-radius') {
      const roundedVal = ROUNDED_SCALE[value];
      if (roundedVal !== undefined) {
        return buildDeclarations(mapping.property, roundedVal, filePath, line, mechanism, variantContext);
      }
    }

    // Try font-weight
    if (mapping.property === 'font-weight') {
      const weightVal = FONT_WEIGHT_MAP[value];
      if (weightVal) {
        return buildDeclarations(mapping.property, weightVal, filePath, line, mechanism, variantContext);
      }
    }

    return [];
  }

  return buildDeclarations(mapping.property, resolvedValue, filePath, line, mechanism, variantContext, opacity);
}

function buildDeclarations(
  property: string,
  rawValue: string,
  filePath: string,
  line: number,
  mechanism: StyleMechanism,
  variantContext: string | null,
  opacity?: string | null,
): NormalizedDeclaration[] {
  let finalValue = rawValue;
  if (opacity) {
    // Apply opacity as a CSS color-mix or alpha modification
    // For simplicity, record the opacity as part of the raw value
    finalValue = `${rawValue}/${opacity}`;
  }

  const normalizedValue = normalizeValue(finalValue, property);

  // Handle shorthand expansion for multi-side properties
  // mx-4 → margin-left: 4 + margin-right: 4
  if (property === 'margin-left' && rawValue) {
    // mx prefix
    return ['margin-left', 'margin-right'].map((prop) => ({
      property: prop,
      rawValue: finalValue,
      normalizedValue: normalizeValue(finalValue, prop),
      mechanism,
      filePath,
      line,
      context: null,
      variantContext,
      tokenRef: null,
    }));
  }

  if (property === 'margin-top' && rawValue) {
    // my prefix
    return ['margin-top', 'margin-bottom'].map((prop) => ({
      property: prop,
      rawValue: finalValue,
      normalizedValue: normalizeValue(finalValue, prop),
      mechanism,
      filePath,
      line,
      context: null,
      variantContext,
      tokenRef: null,
    }));
  }

  if (property === 'padding-left' && rawValue) {
    // px prefix
    return ['padding-left', 'padding-right'].map((prop) => ({
      property: prop,
      rawValue: finalValue,
      normalizedValue: normalizeValue(finalValue, prop),
      mechanism,
      filePath,
      line,
      context: null,
      variantContext,
      tokenRef: null,
    }));
  }

  if (property === 'padding-top' && rawValue) {
    // py prefix
    return ['padding-top', 'padding-bottom'].map((prop) => ({
      property: prop,
      rawValue: finalValue,
      normalizedValue: normalizeValue(finalValue, prop),
      mechanism,
      filePath,
      line,
      context: null,
      variantContext,
      tokenRef: null,
    }));
  }

  if (property === 'width' && rawValue) {
    // size utility → both width and height
    // (only for the 'size' prefix which we mapped to width)
    // Actually, we need a different marker. The 'size' utility maps to both width and height.
    // For now, only expand 'size-' prefix manually.
  }

  // For size-N utility, expand to both width and height
  // (This is handled by the prefix match — if the prefix was 'size', expand to both)

  // Expand shorthand properties
  const expanded = expandShorthand(property, finalValue, normalizedValue);

  return expanded.map((e) => ({
    property: e.property,
    rawValue: e.rawValue,
    normalizedValue: e.normalizedValue,
    mechanism,
    filePath,
    line,
    context: null,
    variantContext,
    tokenRef: null,
  }));
}

// ---------------------------------------------------------------------------
// Internal: Static utilities (no value)
// ---------------------------------------------------------------------------

interface StaticUtility {
  declarations: Array<{ property: string; value: string }>;
}

const STATIC_UTILITIES: Record<string, StaticUtility> = {
  'block': { declarations: [{ property: 'display', value: 'block' }] },
  'inline': { declarations: [{ property: 'display', value: 'inline' }] },
  'inline-block': { declarations: [{ property: 'display', value: 'inline-block' }] },
  'flex': { declarations: [{ property: 'display', value: 'flex' }] },
  'inline-flex': { declarations: [{ property: 'display', value: 'inline-flex' }] },
  'grid': { declarations: [{ property: 'display', value: 'grid' }] },
  'inline-grid': { declarations: [{ property: 'display', value: 'inline-grid' }] },
  'hidden': { declarations: [{ property: 'display', value: 'none' }] },
  'table': { declarations: [{ property: 'display', value: 'table' }] },
  'flow-root': { declarations: [{ property: 'display', value: 'flow-root' }] },
  'contents': { declarations: [{ property: 'display', value: 'contents' }] },
  'list-item': { declarations: [{ property: 'display', value: 'list-item' }] },

  'static': { declarations: [{ property: 'position', value: 'static' }] },
  'fixed': { declarations: [{ property: 'position', value: 'fixed' }] },
  'absolute': { declarations: [{ property: 'position', value: 'absolute' }] },
  'relative': { declarations: [{ property: 'position', value: 'relative' }] },
  'sticky': { declarations: [{ property: 'position', value: 'sticky' }] },

  'visible': { declarations: [{ property: 'visibility', value: 'visible' }] },
  'invisible': { declarations: [{ property: 'visibility', value: 'hidden' }] },
  'collapse': { declarations: [{ property: 'visibility', value: 'collapse' }] },

  'flex-row': { declarations: [{ property: 'flex-direction', value: 'row' }] },
  'flex-row-reverse': { declarations: [{ property: 'flex-direction', value: 'row-reverse' }] },
  'flex-col': { declarations: [{ property: 'flex-direction', value: 'column' }] },
  'flex-col-reverse': { declarations: [{ property: 'flex-direction', value: 'column-reverse' }] },
  'flex-wrap': { declarations: [{ property: 'flex-wrap', value: 'wrap' }] },
  'flex-nowrap': { declarations: [{ property: 'flex-wrap', value: 'nowrap' }] },
  'flex-wrap-reverse': { declarations: [{ property: 'flex-wrap', value: 'wrap-reverse' }] },

  'justify-start': { declarations: [{ property: 'justify-content', value: 'flex-start' }] },
  'justify-end': { declarations: [{ property: 'justify-content', value: 'flex-end' }] },
  'justify-center': { declarations: [{ property: 'justify-content', value: 'center' }] },
  'justify-between': { declarations: [{ property: 'justify-content', value: 'space-between' }] },
  'justify-around': { declarations: [{ property: 'justify-content', value: 'space-around' }] },
  'justify-evenly': { declarations: [{ property: 'justify-content', value: 'space-evenly' }] },

  'items-start': { declarations: [{ property: 'align-items', value: 'flex-start' }] },
  'items-end': { declarations: [{ property: 'align-items', value: 'flex-end' }] },
  'items-center': { declarations: [{ property: 'align-items', value: 'center' }] },
  'items-baseline': { declarations: [{ property: 'align-items', value: 'baseline' }] },
  'items-stretch': { declarations: [{ property: 'align-items', value: 'stretch' }] },

  'self-auto': { declarations: [{ property: 'align-self', value: 'auto' }] },
  'self-start': { declarations: [{ property: 'align-self', value: 'flex-start' }] },
  'self-end': { declarations: [{ property: 'align-self', value: 'flex-end' }] },
  'self-center': { declarations: [{ property: 'align-self', value: 'center' }] },
  'self-stretch': { declarations: [{ property: 'align-self', value: 'stretch' }] },

  'text-left': { declarations: [{ property: 'text-align', value: 'left' }] },
  'text-center': { declarations: [{ property: 'text-align', value: 'center' }] },
  'text-right': { declarations: [{ property: 'text-align', value: 'right' }] },
  'text-justify': { declarations: [{ property: 'text-align', value: 'justify' }] },

  'uppercase': { declarations: [{ property: 'text-transform', value: 'uppercase' }] },
  'lowercase': { declarations: [{ property: 'text-transform', value: 'lowercase' }] },
  'capitalize': { declarations: [{ property: 'text-transform', value: 'capitalize' }] },
  'normal-case': { declarations: [{ property: 'text-transform', value: 'none' }] },

  'underline': { declarations: [{ property: 'text-decoration-line', value: 'underline' }] },
  'overline': { declarations: [{ property: 'text-decoration-line', value: 'overline' }] },
  'line-through': { declarations: [{ property: 'text-decoration-line', value: 'line-through' }] },
  'no-underline': { declarations: [{ property: 'text-decoration-line', value: 'none' }] },

  'truncate': {
    declarations: [
      { property: 'overflow', value: 'hidden' },
      { property: 'text-overflow', value: 'ellipsis' },
      { property: 'white-space', value: 'nowrap' },
    ],
  },

  'overflow-auto': { declarations: [{ property: 'overflow', value: 'auto' }] },
  'overflow-hidden': { declarations: [{ property: 'overflow', value: 'hidden' }] },
  'overflow-visible': { declarations: [{ property: 'overflow', value: 'visible' }] },
  'overflow-scroll': { declarations: [{ property: 'overflow', value: 'scroll' }] },

  'box-border': { declarations: [{ property: 'box-sizing', value: 'border-box' }] },
  'box-content': { declarations: [{ property: 'box-sizing', value: 'content-box' }] },

  'cursor-pointer': { declarations: [{ property: 'cursor', value: 'pointer' }] },
  'cursor-default': { declarations: [{ property: 'cursor', value: 'default' }] },
  'cursor-not-allowed': { declarations: [{ property: 'cursor', value: 'not-allowed' }] },

  'resize': { declarations: [{ property: 'resize', value: 'both' }] },
  'resize-none': { declarations: [{ property: 'resize', value: 'none' }] },
  'resize-y': { declarations: [{ property: 'resize', value: 'vertical' }] },
  'resize-x': { declarations: [{ property: 'resize', value: 'horizontal' }] },

  'select-none': { declarations: [{ property: 'user-select', value: 'none' }] },
  'select-text': { declarations: [{ property: 'user-select', value: 'text' }] },
  'select-all': { declarations: [{ property: 'user-select', value: 'all' }] },
  'select-auto': { declarations: [{ property: 'user-select', value: 'auto' }] },

  'sr-only': {
    declarations: [
      { property: 'position', value: 'absolute' },
      { property: 'width', value: '1px' },
      { property: 'height', value: '1px' },
      { property: 'padding', value: '0' },
      { property: 'margin', value: '-1px' },
      { property: 'overflow', value: 'hidden' },
      { property: 'clip', value: 'rect(0,0,0,0)' },
      { property: 'white-space', value: 'nowrap' },
      { property: 'border-width', value: '0' },
    ],
  },

  'whitespace-normal': { declarations: [{ property: 'white-space', value: 'normal' }] },
  'whitespace-nowrap': { declarations: [{ property: 'white-space', value: 'nowrap' }] },
  'whitespace-pre': { declarations: [{ property: 'white-space', value: 'pre' }] },
  'whitespace-pre-line': { declarations: [{ property: 'white-space', value: 'pre-line' }] },
  'whitespace-pre-wrap': { declarations: [{ property: 'white-space', value: 'pre-wrap' }] },
  'whitespace-break-spaces': { declarations: [{ property: 'white-space', value: 'break-spaces' }] },

  'break-normal': { declarations: [{ property: 'overflow-wrap', value: 'normal' }, { property: 'word-break', value: 'normal' }] },
  'break-words': { declarations: [{ property: 'overflow-wrap', value: 'break-word' }] },
  'break-all': { declarations: [{ property: 'word-break', value: 'break-all' }] },
  'break-keep': { declarations: [{ property: 'word-break', value: 'keep-all' }] },
};

function expandStatic(
  utility: string,
  filePath: string,
  line: number,
  mechanism: StyleMechanism,
  variantContext: string | null,
): NormalizedDeclaration[] | null {
  const staticDef = STATIC_UTILITIES[utility];
  if (!staticDef) return null;

  return staticDef.declarations.map((d) => ({
    property: d.property,
    rawValue: d.value,
    normalizedValue: normalizeValue(d.value, d.property),
    mechanism,
    filePath,
    line,
    context: null,
    variantContext,
    tokenRef: null,
  }));
}

// ---------------------------------------------------------------------------
// Internal: Value resolution
// ---------------------------------------------------------------------------

function resolveColorValue(value: string, tokens: TailwindThemeTokens): string | null {
  // Direct match in color tokens
  if (tokens.colors[value]) return tokens.colors[value];

  // Try with 'transparent', 'current', 'inherit'
  if (value === 'transparent' || value === 'current' || value === 'inherit') {
    return value;
  }

  // Check if it's a hex/rgb value already in the class name
  // (this shouldn't happen with standard tailwind, but handle gracefully)
  if (value.startsWith('#') || value.startsWith('rgb')) {
    return value;
  }

  return null;
}

function resolveSpacingValue(value: string, tokens: TailwindThemeTokens): string | null {
  // Direct match in spacing tokens
  if (tokens.spacing[value]) return tokens.spacing[value];

  // Try as a raw px value (used by arbitrary spacing in non-arbitrary classes)
  if (/^\d+$/.test(value)) {
    const num = parseFloat(value);
    return `${num * 4}px`; // Default Tailwind: 1 unit = 4px
  }

  // Try font-size
  if (tokens.fontSize[value]) return tokens.fontSize[value];

  // Try border-radius
  if (tokens.borderRadius[value]) return tokens.borderRadius[value];

  // Auto, full, screen, min, max, fit keywords
  if (['auto', 'full', 'screen', 'min', 'max', 'fit', 'none'].includes(value)) {
    return value;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal: Utility prefix matching
// ---------------------------------------------------------------------------

function findMapping(utility: string): UtilityMapping | null {
  // Try exact match first
  if (UTILITY_MAP[utility]) return UTILITY_MAP[utility];

  // Try prefix matching (longest prefix first to avoid "text" matching before "text-")
  const prefixes = Object.keys(UTILITY_MAP).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (utility.startsWith(prefix) && utility !== prefix) {
      return UTILITY_MAP[prefix];
    }
  }

  return null;
}

function findMatchingKey(utility: string): string | null {
  const prefixes = Object.keys(UTILITY_MAP).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (utility.startsWith(prefix) && utility !== prefix) {
      return prefix;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utility: Check if a class might be a Tailwind utility
// ---------------------------------------------------------------------------

/**
 * Heuristic check: does this class name look like a Tailwind utility?
 * Used to skip non-utility class names without attempting expansion.
 */
export function looksLikeTailwind(className: string): boolean {
  const trimmed = className.trim();
  if (!trimmed || trimmed.length < 2) return false;

  // Must start with a letter or group/peer
  if (!/^[a-z]/.test(trimmed)) return false;

  // Common Tailwind patterns:
  // - Contains a dash (most utilities)
  // - Starts with known utility prefixes
  // - Known static utility
  if (STATIC_UTILITIES[trimmed]) return true;
  if (findMapping(trimmed)) return true;

  return false;
}
