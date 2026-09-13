/**
 * Lint-config threshold reader — Spec 50 "size-threshold" recalibration, part 2.
 *
 * The size-threshold rules (`function-length`, `parameter-count`,
 * `method-complexity`) default to numbers the project may already have an
 * opinion about — its ESLint config. When a project declares
 * `max-lines-per-function`, `max-params`, or `complexity`, those are the
 * project's *own* authoritative thresholds and should win over our defaults
 * (though never over an explicit `.codeauditor.json`).
 *
 * This module mirrors the Tailwind compile-probe philosophy
 * (`src/styles/tailwindProbe.ts`): read the project's *own declared* config as
 * the oracle, never guess. It is deliberately narrow:
 *
 *   - Only the project's **own `rules` object** is read. `extends` / flat-config
 *     spreads are NOT resolved — a rule inherited from `@eslint/js`,
 *     `airbnb`, or a shared preset is invisible to us, exactly as the Tailwind
 *     probe does not hand-curate a dictionary for plugins it cannot load.
 *   - Only rules with a code-auditor equivalent are mapped. `max-depth` and
 *     `max-statements` are recognized (returned for transparency) but unmapped
 *     because no code-auditor rule measures nesting depth or statement count.
 *   - **Fail-open:** no config, an unloadable config, or an unparseable value
 *     yields `null` (or an empty result), never an error.
 *
 * Precedence (highest wins), enforced upstream in `auditRunner.ts`:
 *   `.codeauditor.json` (`analyzerConfigs`) > project lint config > presets > defaults
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LintThresholdResult {
  /** Absolute path to the config file that supplied thresholds, or null. */
  configPath: string | null;
  /** 'flat' (eslint.config.*) or 'legacy' (.eslintrc.*), or null when absent. */
  configKind: 'flat' | 'legacy' | null;
  /** ESLint rule name → mapped code-auditor threshold value (already numeric). */
  thresholds: Record<string, number>;
  /** Rules recognized but with no code-auditor equivalent. */
  recognizedUnmapped: Array<{ rule: string; value: unknown }>;
  /** The raw rules object, for transparency in coverage output. */
  rawRules: Record<string, unknown>;
}

/** ESLint rule → dot-notation code-auditor threshold key. */
const ESLINT_RULE_TO_THRESHOLD: Record<string, string> = {
  'max-lines-per-function': 'solid.maxLinesPerMethod',
  'max-params': 'solid.maxParametersPerMethod',
  complexity: 'solid.maxMethodComplexity',
};

/**
 * ESLint rules we can *see* but have no code-auditor threshold for. Returned in
 * `recognizedUnmapped` so the coverage output can say "the project configured
 * max-depth: 4, which code-auditor does not model", rather than silently
 * dropping it.
 */
const RECOGNIZED_UNMAPPED = new Set(['max-depth', 'max-statements']);

// Flat config first (ESLint 9+), legacy after (ESLint ≤8).
const CONFIG_CANDIDATES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the project's own lint-config size thresholds.
 *
 * Returns `null` when no lint config is found (or nothing loadable). The
 * caller treats `null` as "defaults" — absence is not an error.
 */
export async function readProjectLintThresholds(
  projectRoot: string,
): Promise<LintThresholdResult | null> {
  const configPath = findConfigFile(projectRoot);
  if (!configPath) return null;

  let loaded: unknown;
  try {
    loaded = await loadConfigModule(configPath, projectRoot);
  } catch {
    // Fail-open: an unloadable config (e.g. a `.ts` config without a loader,
    // or a `.js` config that throws at import time) is treated as absent.
    return null;
  }

  const rawRules = extractRules(loaded);
  if (!rawRules || typeof rawRules !== 'object') {
    return {
      configPath,
      configKind: configKind(configPath),
      thresholds: {},
      recognizedUnmapped: [],
      rawRules: {},
    };
  }

  const thresholds: Record<string, number> = {};
  const recognizedUnmapped: Array<{ rule: string; value: unknown }> = [];

  for (const [rule, value] of Object.entries(rawRules)) {
    const mapped = ESLINT_RULE_TO_THRESHOLD[rule];
    if (mapped) {
      const parsed = parseThreshold(value);
      if (parsed !== null) thresholds[mapped] = parsed;
      // `parsed === null` means "off"/"0"/absent — skip, not an error.
    } else if (RECOGNIZED_UNMAPPED.has(rule)) {
      recognizedUnmapped.push({ rule, value });
    }
  }

  return {
    configPath,
    configKind: configKind(configPath),
    thresholds,
    recognizedUnmapped,
    rawRules,
  };
}

/**
 * Convert a mapped `thresholds` map (dot-notation keys) into the
 * `analyzerConfigs` fragment shape the pipeline merges, grouped by namespace
 * (the prefix before the first `.`).
 */
export function thresholdsToAnalyzerConfig(
  thresholds: Record<string, number>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [key, value] of Object.entries(thresholds)) {
    const dot = key.indexOf('.');
    const namespace = dot >= 0 ? key.slice(0, dot) : key;
    const leaf = dot >= 0 ? key.slice(dot + 1) : key;
    (out[namespace] ??= {})[leaf] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function findConfigFile(projectRoot: string): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const full = join(projectRoot, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

function configKind(configPath: string): 'flat' | 'legacy' {
  return configPath.endsWith('.eslintrc.js') ||
    configPath.endsWith('.eslintrc.cjs') ||
    configPath.endsWith('.eslintrc.json') ||
    configPath.endsWith('.eslintrc.yaml') ||
    configPath.endsWith('.eslintrc.yml')
    ? 'legacy'
    : 'flat';
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a lint config module from disk. Handles JSON, ESM (`.mjs`, or `.js`
 * under `"type": "module"`), and CommonJS (`.cjs`, or `.js` under CJS).
 * `.ts` and `.yaml`/`.yml` are attempted but fail open when they cannot be
 * loaded without a runtime loader.
 */
async function loadConfigModule(configPath: string, projectRoot: string): Promise<unknown> {
  const ext = extname(configPath);

  if (ext === '.json') {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }

  if (ext === '.yaml' || ext === '.yml') {
    // No YAML dependency is bundled; a legacy .eslintrc.yaml is rare and
    // fails open here rather than pulling a parser.
    return null;
  }

  // .cjs is always CommonJS; .mjs is always ESM.
  if (ext === '.cjs') {
    return createRequire(join(projectRoot, 'package.json'))(configPath);
  }

  let loaded: unknown;
  if (ext === '.mjs' || readPackageType(projectRoot) === 'module') {
    const mod = await import(pathToFileURL(configPath).href);
    loaded = (mod as { default?: unknown }).default ?? mod;
  } else {
    loaded = createRequire(join(projectRoot, 'package.json'))(configPath);
  }

  // Some flat configs export a factory function that returns the array.
  if (typeof loaded === 'function') {
    loaded = await (loaded as () => unknown | Promise<unknown>)();
  }

  return loaded;
}

function readPackageType(projectRoot: string): 'module' | 'commonjs' {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
    return pkg?.type === 'module' ? 'module' : 'commonjs';
  } catch {
    return 'commonjs';
  }
}

// ---------------------------------------------------------------------------
// Rule extraction + value parsing
// ---------------------------------------------------------------------------

/**
 * Pull the project's own `rules` object out of a loaded config.
 *
 * Flat config is an array of config objects (each possibly carrying `rules`,
 * `files`, `languageOptions`, `ignores`); we merge every `rules` object in
 * order. Legacy config is a single object with a top-level `rules`.
 */
function extractRules(loaded: unknown): Record<string, unknown> | null {
  if (Array.isArray(loaded)) {
    const rules: Record<string, unknown> = {};
    for (const entry of loaded) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const r = (entry as Record<string, unknown>).rules;
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          Object.assign(rules, r as Record<string, unknown>);
        }
      }
    }
    return rules;
  }

  if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
    const rules = (loaded as Record<string, unknown>).rules;
    if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
      return rules as Record<string, unknown>;
    }
  }

  return null;
}

/**
 * Parse an ESLint rule's threshold value into a number, or null when absent.
 *
 * ESLint accepts several shapes for these rules:
 *   `6`                 — a bare number (legacy shorthand)
 *   `["error", 6]`      — severity + number
 *   `["error", {max:6}]`— severity + options object (max-lines-per-function,
 *                         complexity)
 *   `{ max: 6 }`        — options object only
 *   `"off"` / `0`       — disabled (treated as absent)
 */
function parseThreshold(value: unknown): number | null {
  if (typeof value === 'number') return value;

  if (typeof value === 'string') {
    if (value === 'off') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'number') return item;
      const max = maxFromOptions(item);
      if (max !== null) return max;
    }
    return null;
  }

  return maxFromOptions(value);
}

function maxFromOptions(value: unknown): number | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const max = (value as Record<string, unknown>).max;
    if (typeof max === 'number') return max;
  }
  return null;
}
