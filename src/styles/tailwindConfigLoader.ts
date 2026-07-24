/**
 * Tailwind config loader — Spec 10.
 *
 * Loads a project's Tailwind configuration to resolve design tokens
 * (colors, spacing, font sizes, etc.) for utility expansion.
 *
 * Three-tier resolution:
 *   1. Tailwind v3 JS config (tailwind.config.js / tailwind.config.ts)
 *   2. Tailwind v4 CSS config (@theme blocks in CSS files)
 *   3. Bundled default design tokens (Tailwind v4 defaults)
 *
 * Falls back gracefully — no config means we use defaults only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { StyleToken } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw tailwind theme tokens extracted from config. */
export interface TailwindThemeTokens {
  colors: Record<string, string>;
  spacing: Record<string, string>;
  fontSize: Record<string, string>;
  borderRadius: Record<string, string>;
}

/** Config file discovery result. */
export interface TailwindConfigResult {
  tokens: TailwindThemeTokens;
  /** How the config was resolved. */
  source: 'v3-js' | 'v4-css' | 'defaults' | 'none';
  configPath: string | null;
}

// ---------------------------------------------------------------------------
// Tailwind v4 Default Design Tokens
// ---------------------------------------------------------------------------

/**
 * Bundled Tailwind v4 default design tokens.
 * This is a simplified subset covering the most-used values.
 * Full Tailwind v4 theme is massive; we cover the common scales.
 */
const DEFAULT_TOKENS: TailwindThemeTokens = {
  colors: defaultColorScale(),
  spacing: defaultSpacingScale(),
  fontSize: defaultFontSizeScale(),
  borderRadius: defaultBorderRadiusScale(),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load Tailwind config tokens from a project root.
 * Returns default tokens if no config is found — this is always graceful.
 */
export function loadTailwindConfig(projectRoot: string): TailwindConfigResult {
  // Tier 1: Tailwind v3 JS config
  const v3Result = tryLoadV3Config(projectRoot);
  if (v3Result) return v3Result;

  // Tier 2: Tailwind v4 CSS config
  const v4Result = tryLoadV4Config(projectRoot);
  if (v4Result) return v4Result;

  // Tier 3: Bundled defaults
  return {
    tokens: { ...DEFAULT_TOKENS },
    source: 'defaults',
    configPath: null,
  };
}

/**
 * Get the tokens as StyleToken[] for storage in the style index.
 */
export function tokensToStyleTokens(
  result: TailwindConfigResult,
  projectRoot: string,
): StyleToken[] {
  const tokens: StyleToken[] = [];
  const configPath = result.configPath ?? 'built-in defaults';

  for (const [name, value] of Object.entries(result.tokens.colors)) {
    tokens.push({
      name: `colors.${name}`,
      value,
      filePath: configPath,
      mechanism: 'tailwind-theme',
    });
  }

  for (const [name, value] of Object.entries(result.tokens.spacing)) {
    tokens.push({
      name: `spacing.${name}`,
      value,
      filePath: configPath,
      mechanism: 'tailwind-theme',
    });
  }

  for (const [name, value] of Object.entries(result.tokens.fontSize)) {
    tokens.push({
      name: `fontSize.${name}`,
      value,
      filePath: configPath,
      mechanism: 'tailwind-theme',
    });
  }

  for (const [name, value] of Object.entries(result.tokens.borderRadius)) {
    tokens.push({
      name: `borderRadius.${name}`,
      value,
      filePath: configPath,
      mechanism: 'tailwind-theme',
    });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Tier 1: v3 JS config
// ---------------------------------------------------------------------------

function tryLoadV3Config(projectRoot: string): TailwindConfigResult | null {
  const candidates = [
    'tailwind.config.js',
    'tailwind.config.ts',
    'tailwind.config.cjs',
    'tailwind.config.mjs',
  ];

  for (const candidate of candidates) {
    const configPath = join(projectRoot, candidate);
    if (!existsSync(configPath)) continue;

    try {
      const tokens = loadV3ConfigFile(configPath);
      if (tokens) {
        return { tokens, source: 'v3-js', configPath };
      }
    } catch {
      // Silently fall through — config exists but can't be parsed
    }
  }

  return null;
}

function loadV3ConfigFile(configPath: string): TailwindThemeTokens | null {
  try {
    // Dynamic require to load the config module
    const require = createRequire(import.meta.url);
    const config = require(configPath);

    // Handle default exports
    const resolved = config.default ?? config;
    if (!resolved || !resolved.theme) return null;

    const theme = resolved.theme;
    const extend = theme.extend ?? {};

    // Merge extend over theme
    return {
      colors: mergeThemeConfig(
        theme.colors ?? {},
        extend.colors ?? {},
      ),
      spacing: mergeThemeConfig(
        resolveSpacing(theme.spacing),
        resolveSpacing(extend.spacing),
      ),
      fontSize: mergeThemeConfig(
        theme.fontSize ?? {},
        extend.fontSize ?? {},
      ),
      borderRadius: mergeThemeConfig(
        theme.borderRadius ?? {},
        extend.borderRadius ?? {},
      ),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 2: v4 CSS config
// ---------------------------------------------------------------------------

function tryLoadV4Config(projectRoot: string): TailwindConfigResult | null {
  // Tailwind v4 typically uses app.css or globals.css with @theme
  const candidates = [
    'app/globals.css',
    'src/app/globals.css',
    'app.css',
    'src/styles/globals.css',
    'styles/globals.css',
    'globals.css',
  ];

  for (const candidate of candidates) {
    const configPath = join(projectRoot, candidate);
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf-8');
      const tokens = parseV4ThemeBlocks(content);
      // Only return if we actually found @theme directives
      if (tokens.colors.size > 0 || tokens.spacing.size > 0 ||
          tokens.fontSize.size > 0 || tokens.borderRadius.size > 0) {
        return {
          tokens: {
            colors: Object.fromEntries(tokens.colors),
            spacing: Object.fromEntries(tokens.spacing),
            fontSize: Object.fromEntries(tokens.fontSize),
            borderRadius: Object.fromEntries(tokens.borderRadius),
          },
          source: 'v4-css',
          configPath,
        };
      }
    } catch {
      // Silently continue
    }
  }

  return null;
}

interface V4ThemeTokens {
  colors: Map<string, string>;
  spacing: Map<string, string>;
  fontSize: Map<string, string>;
  borderRadius: Map<string, string>;
}

function parseV4ThemeBlocks(css: string): V4ThemeTokens {
  const tokens: V4ThemeTokens = {
    colors: new Map(),
    spacing: new Map(),
    fontSize: new Map(),
    borderRadius: new Map(),
  };

  // Match @theme { ... } blocks
  const themeRegex = /@theme\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = themeRegex.exec(css)) !== null) {
    const block = match[1];

    // Parse individual declarations: --key: value;
    const declRegex = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let declMatch: RegExpExecArray | null;

    while ((declMatch = declRegex.exec(block)) !== null) {
      const name = declMatch[1].trim();
      const value = declMatch[2].trim();

      // Classify the token by naming convention
      if (name.startsWith('color-') || name === 'colors') {
        const colorName = name.startsWith('color-') ? name.slice(6) : name;
        tokens.colors.set(colorName, value);
      } else if (name.startsWith('spacing-') || name.endsWith('-spacing')) {
        const spaceName = name.startsWith('spacing-') ? name.slice(8) : name;
        tokens.spacing.set(spaceName, value);
      } else if (name.startsWith('font-size-') || name.endsWith('-font-size')) {
        const fontSizeName = name.startsWith('font-size-') ? name.slice(10) : name;
        tokens.fontSize.set(fontSizeName, value);
      } else if (name.startsWith('radius-') || name.endsWith('-radius')) {
        const radiusName = name.startsWith('radius-') ? name.slice(7) : name;
        tokens.borderRadius.set(radiusName, value);
      }
      // Many v4 themes use dotted notation: --color-blue-500, --spacing-4
      if (name.startsWith('color-')) {
        const colorName = name.slice(6);
        tokens.colors.set(colorName, value);
      }
    }

    // Re-parse: dotted notation like --color-blue-500, --color-red-400
    resetLastIndex(declRegex);
    while ((declMatch = declRegex.exec(block)) !== null) {
      const name = declMatch[1].trim();
      const value = declMatch[2].trim();
      if (name.startsWith('color-')) {
        const colorName = name.slice(6);
        if (!tokens.colors.has(colorName)) {
          tokens.colors.set(colorName, value);
        }
      }
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeThemeConfig(
  base: Record<string, unknown>,
  extend: Record<string, unknown>,
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') {
      merged[key] = value;
    } else if (typeof value === 'object' && value !== null) {
      // Nested objects like colors: { blue: { 500: '#...' } }
      flattenNested(key, value as Record<string, unknown>, merged);
    }
  }

  for (const [key, value] of Object.entries(extend)) {
    if (typeof value === 'string') {
      merged[key] = value;
    } else if (typeof value === 'object' && value !== null) {
      flattenNested(key, value as Record<string, unknown>, merged);
    }
  }

  return merged;
}

function flattenNested(
  prefix: string,
  obj: Record<string, unknown>,
  out: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      // Handle DEFAULT key: "DEFAULT": "#fff" → out["blue"] = "#fff"
      if (key === 'DEFAULT') {
        out[prefix] = value;
      } else {
        out[`${prefix}.${key}`] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      // Nested object: { blue: { 500: '#...', 600: '#...' } }
      flattenNested(`${prefix}.${key}`, value as Record<string, unknown>, out);
    }
  }
}

function resolveSpacing(spacing: unknown): Record<string, unknown> {
  if (!spacing) return {};
  if (typeof spacing === 'function') {
    // Spacing in Tailwind v3 can be a function
    try {
      return (spacing as () => Record<string, unknown>)();
    } catch {
      return {};
    }
  }
  return spacing as Record<string, unknown>;
}

function resetLastIndex(regex: RegExp): void {
  regex.lastIndex = 0;
}

// ---------------------------------------------------------------------------
// Bundled Defaults
// ---------------------------------------------------------------------------

function defaultColorScale(): Record<string, string> {
  // Tailwind v4 default color palette (subset — core grays + popular hues)
  return {
    'white': '#ffffff',
    'black': '#000000',
    'transparent': 'transparent',
    'current': 'currentColor',
    // Slate
    'slate.50': '#f8fafc', 'slate.100': '#f1f5f9', 'slate.200': '#e2e8f0',
    'slate.300': '#cbd5e1', 'slate.400': '#94a3b8', 'slate.500': '#64748b',
    'slate.600': '#475569', 'slate.700': '#334155', 'slate.800': '#1e293b',
    'slate.900': '#0f172a', 'slate.950': '#020617',
    // Gray
    'gray.50': '#f9fafb', 'gray.100': '#f3f4f6', 'gray.200': '#e5e7eb',
    'gray.300': '#d1d5db', 'gray.400': '#9ca3af', 'gray.500': '#6b7280',
    'gray.600': '#4b5563', 'gray.700': '#374151', 'gray.800': '#1f2937',
    'gray.900': '#111827', 'gray.950': '#030712',
    // Red
    'red.50': '#fef2f2', 'red.100': '#fee2e2', 'red.200': '#fecaca',
    'red.300': '#fca5a5', 'red.400': '#f87171', 'red.500': '#ef4444',
    'red.600': '#dc2626', 'red.700': '#b91c1c', 'red.800': '#991b1b',
    'red.900': '#7f1d1d', 'red.950': '#450a0a',
    // Blue
    'blue.50': '#eff6ff', 'blue.100': '#dbeafe', 'blue.200': '#bfdbfe',
    'blue.300': '#93c5fd', 'blue.400': '#60a5fa', 'blue.500': '#3b82f6',
    'blue.600': '#2563eb', 'blue.700': '#1d4ed8', 'blue.800': '#1e40af',
    'blue.900': '#1e3a8a', 'blue.950': '#172554',
    // Green
    'green.50': '#f0fdf4', 'green.100': '#dcfce7', 'green.200': '#bbf7d0',
    'green.300': '#86efac', 'green.400': '#4ade80', 'green.500': '#22c55e',
    'green.600': '#16a34a', 'green.700': '#15803d', 'green.800': '#166534',
    'green.900': '#14532d', 'green.950': '#052e16',
    // Yellow
    'yellow.50': '#fefce8', 'yellow.100': '#fef9c3', 'yellow.200': '#fef08a',
    'yellow.300': '#fde047', 'yellow.400': '#facc15', 'yellow.500': '#eab308',
    'yellow.600': '#ca8a04', 'yellow.700': '#a16207', 'yellow.800': '#854d0e',
    'yellow.900': '#713f12', 'yellow.950': '#422006',
    // Indigo
    'indigo.50': '#eef2ff', 'indigo.100': '#e0e7ff', 'indigo.200': '#c7d2fe',
    'indigo.300': '#a5b4fc', 'indigo.400': '#818cf8', 'indigo.500': '#6366f1',
    'indigo.600': '#4f46e5', 'indigo.700': '#4338ca', 'indigo.800': '#3730a3',
    'indigo.900': '#312e81', 'indigo.950': '#1e1b4b',
  };
}

function defaultSpacingScale(): Record<string, string> {
  // Tailwind spacing scale (px values)
  return {
    '0': '0px', 'px': '1px', '0.5': '2px',
    '1': '4px', '2': '8px', '3': '12px', '4': '16px',
    '5': '20px', '6': '24px', '7': '28px', '8': '32px',
    '9': '36px', '10': '40px', '11': '44px', '12': '48px',
    '14': '56px', '16': '64px', '20': '80px', '24': '96px',
    '28': '112px', '32': '128px', '36': '144px', '40': '160px',
    '44': '176px', '48': '192px', '52': '208px', '56': '224px',
    '60': '240px', '64': '256px', '72': '288px', '80': '320px',
    '96': '384px',
  };
}

function defaultFontSizeScale(): Record<string, string> {
  return {
    'xs': '12px', 'sm': '14px', 'base': '16px',
    'lg': '18px', 'xl': '20px', '2xl': '24px',
    '3xl': '30px', '4xl': '36px', '5xl': '48px',
    '6xl': '60px', '7xl': '72px', '8xl': '96px', '9xl': '128px',
  };
}

function defaultBorderRadiusScale(): Record<string, string> {
  return {
    'none': '0px', 'sm': '2px', '': '4px', 'DEFAULT': '4px',
    'md': '6px', 'lg': '8px', 'xl': '12px', '2xl': '16px',
    '3xl': '24px', 'full': '9999px',
  };
}
