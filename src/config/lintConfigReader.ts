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
import type { CoverageDiagnostic } from '../types.js';
import { extractModuleExport } from './staticObjectExtract.js';

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
  /** When the config exists but could not be read statically (Spec 61 R3.2),
   *  a `cannot-fire` coverage diagnostic naming the file and the reason. */
  diagnostic?: CoverageDiagnostic;
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
  let diagnostic: CoverageDiagnostic | undefined;
  try {
    const result = await loadConfigModule(configPath, projectRoot);
    loaded = result.value;
    diagnostic = result.diagnostic;
  } catch {
    // Fail-open: an unreadable config (e.g. the file was deleted between
    // discovery and read) is treated as absent.
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
      ...(diagnostic ? { diagnostic } : {}),
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
    ...(diagnostic ? { diagnostic } : {}),
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
 * Load a lint config from disk **without executing it** (Spec 61 R3.2).
 *
 * A config file inside a cloned repository is data, not code. JSON is parsed;
 * `.js` / `.cjs` / `.mjs` / `.ts` are reduced to a plain value by
 * `extractModuleExport` — never `require()`d, never `import()`ed, never invoked
 * as a factory. A config whose export is not a literal (a call, a computed key,
 * an imported spread, a template substitution) yields `{ value: null,
 * diagnostic }` naming the file and the reason; the caller surfaces that as a
 * `cannot-fire` coverage diagnostic rather than silently reading "absent".
 */
async function loadConfigModule(
  configPath: string,
  projectRoot: string,
): Promise<{ value: unknown | null; diagnostic?: CoverageDiagnostic }> {
  const ext = extname(configPath);

  if (ext === '.json') {
    return { value: JSON.parse(readFileSync(configPath, 'utf-8')) };
  }

  if (ext === '.yaml' || ext === '.yml') {
    // No YAML dependency is bundled; a legacy .eslintrc.yaml is rare and
    // fails open here rather than pulling a parser.
    return { value: null };
  }

  const sourceText = readFileSync(configPath, 'utf-8');
  const extracted = extractModuleExport(configPath, sourceText);
  if (!extracted.resolved) {
    return {
      value: null,
      diagnostic: {
        analyzerName: 'config',
        kind: 'cannot-fire',
        message: `Config ${configPath} could not be read statically: ${extracted.reason}`,
        file: configPath,
        line: extracted.node?.line ?? 0,
        details: { reason: extracted.reason },
      },
    };
  }

  return { value: extracted.value };
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
