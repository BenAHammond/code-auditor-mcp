/**
 * Effective-config resolution for `print-config` (Spec 38 R1).
 *
 * The tool's config is a flat blob spread across several layers:
 *   - runtime defaults (each analyzer's `DEFAULT_*_CONFIG`),
 *   - project config (`analyzerConfigs[name]` in .codeauditor.json),
 *   - `_infra` (pathProfiles, severityOverrides, files, projectRoot),
 *   - per-file path-profile overrides (resolved by glob).
 *
 * This module reconstructs, for a single file, the exact config the pipeline
 * hands to each analyzer — and names the source of every value, so a key that
 * silently drifted from its default (`minCorpus`, `schemas` vs `knownTables`,
 * `dbWrapperNames`) becomes visible instead of being archaeology.
 */

import { BUILTIN_PATH_PROFILES } from './defaults.js';
import { resolvePathProfile, type PathProfile } from './pathProfiles.js';
import type { Preset } from '../presets/presets.js';

import { DEFAULT_SOLID_CONFIG } from '../analyzers/universal/UniversalSOLIDAnalyzer.js';
import { DEFAULT_DRY_CONFIG } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import { DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { DEFAULT_DOCUMENTATION_CONFIG } from '../analyzers/universal/UniversalDocumentationAnalyzer.js';
import { DEFAULT_STYLES_CONFIG } from '../analyzers/universal/UniversalStylesAnalyzer.js';
import { DEFAULT_CONVENTIONS_CONFIG } from '../analyzers/universal/UniversalConventionsAnalyzer.js';
import { DEFAULT_REACT_CONFIG } from '../analyzers/reactAnalyzer.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';

export type ConfigSource =
  | 'default'
  | 'project-config'
  | 'env'
  | 'cli'
  | `path-profile:${string}`
  | `builtin:${string}`
  | `preset:${string}`;

export interface EffectiveKey {
  /** Dot-notation key (e.g. `solid.maxMethodsPerClass`). */
  key: string;
  value: unknown;
  source: ConfigSource;
  /** True when the effective value differs from the runtime default. */
  differsFromDefault: boolean;
  defaultValue?: unknown;
}

export interface EffectiveAnalyzerConfig {
  /** Kebab namespace matching pipeline visitor names. */
  namespace: string;
  keys: EffectiveKey[];
}

export interface EffectiveConfigResult {
  filePath: string;
  relativePath: string;
  projectRoot: string;
  matchedProfiles: string[];
  excludeFromGate?: boolean;
  analyzers: EffectiveAnalyzerConfig[];
  topLevel: EffectiveKey[];
}

/**
 * Cross-domain has no flat `DEFAULT_*_CONFIG` export; its runtime defaults are
 * inline `??` fallbacks in CrossDomainAnalyzer. `schemaLifecycle` is always on;
 * `validatorBypass` and `coverage` are opt-in (only active when the config key
 * is truthy), so their "default in effect" is the object the analyzer would use
 * once enabled.
 */
const CROSS_DOMAIN_DEFAULT: Record<string, unknown> = {
  schemaLifecycle: {
    enableWrittenNeverRead: true,
    enableReadNeverWritten: true,
    enableTransactionBoundaryRisk: true,
    txnTableMax: 4,
  },
  validatorBypass: {
    validators: [],
    modeShare: 0.8,
    minCorpus: 20,
    depth: 3,
  },
  coverage: {
    testGlobs: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
    staticReachDepth: 2,
    topRiskDecile: 0.1,
  },
};

/**
 * Runtime default config per kebab namespace. This is the ground truth that
 * each analyzer applies internally via `{ ...DEFAULT_X_CONFIG, ...config }`.
 *
 * `invariants` is intentionally absent — the invariants analyzer reads its
 * rules from the `.codeauditor.json` `rules` array, not `analyzerConfigs`.
 */
export const RUNTIME_DEFAULT_CONFIGS: Record<string, Record<string, unknown>> = {
  solid: DEFAULT_SOLID_CONFIG as unknown as Record<string, unknown>,
  dry: DEFAULT_DRY_CONFIG as unknown as Record<string, unknown>,
  'data-access': DEFAULT_DATA_ACCESS_CONFIG as unknown as Record<string, unknown>,
  documentation: DEFAULT_DOCUMENTATION_CONFIG as unknown as Record<string, unknown>,
  react: DEFAULT_REACT_CONFIG as unknown as Record<string, unknown>,
  styles: DEFAULT_STYLES_CONFIG as unknown as Record<string, unknown>,
  conventions: DEFAULT_CONVENTIONS_CONFIG as unknown as Record<string, unknown>,
  schema: DEFAULT_SCHEMA_CONFIG as unknown as Record<string, unknown>,
  'cross-domain': CROSS_DOMAIN_DEFAULT,
};

const BUILTIN_NAMES = new Set(BUILTIN_PATH_PROFILES.map((p) => p.name));

/** Classify a merged path profile as built-in or user-defined. */
function profileSource(profile: PathProfile): ConfigSource {
  return profile.builtin !== false && BUILTIN_NAMES.has(profile.name)
    ? `builtin:${profile.name}`
    : `path-profile:${profile.name}`;
}

/** Flatten a nested object to dot-notation. Arrays are treated as leaf values. */
export function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out[prefix] = value;
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    Object.assign(out, flatten(v, key));
  }
  return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Flatten the ordered presets for one namespace into a merged flat object and
 * a per-key source map. Later presets win on key collision (including nested
 * keys, which flatten to distinct dot-notation entries so partial overrides
 * compose rather than clobber).
 */
function flattenPresetLayer(
  namespace: string,
  presets: Preset[],
): { flat: Record<string, unknown>; sourceByKey: Record<string, string> } {
  const flat: Record<string, unknown> = {};
  const sourceByKey: Record<string, string> = {};
  for (const preset of presets) {
    const fragment = preset.config[namespace];
    if (!fragment) continue;
    for (const [key, value] of Object.entries(flatten(fragment, namespace))) {
      flat[key] = value;
      sourceByKey[key] = preset.id;
    }
  }
  return { flat, sourceByKey };
}

/**
 * Compute the effective per-analyzer config for one file.
 *
 * Precedence (highest wins), mirroring pipeline.ts stage 2:
 *   path-profile overrides > project analyzerConfigs[name] > preset > runtime default
 *
 * `_infra` is infrastructure (pathProfiles, severityOverrides, files,
 * projectRoot) spread into every visitor's config; it is surfaced in
 * `topLevel` rather than re-listed per analyzer.
 */
export function computeEffectiveConfig(opts: {
  filePath: string;
  projectRoot: string;
  analyzerConfigs?: Record<string, unknown>;
  pathProfiles?: PathProfile[];
  enabledAnalyzers?: string[];
  /** Ordered presets; later presets win on key collision (Spec 38 R4). */
  presets?: Preset[];
}): EffectiveConfigResult {
  const { filePath, projectRoot, analyzerConfigs = {}, pathProfiles = [], enabledAnalyzers, presets = [] } = opts;

  const resolved = pathProfiles.length > 0
    ? resolvePathProfile(filePath, projectRoot, pathProfiles)
    : { overrides: {} as Record<string, unknown>, excludeFromGate: false as boolean, matchedProfileNames: [] as string[] };

  const relativePath = relativePosix(projectRoot, filePath);

  const namespaces = enabledAnalyzers && enabledAnalyzers.length > 0
    ? enabledAnalyzers.filter((n) => n in RUNTIME_DEFAULT_CONFIGS)
    : Object.keys(RUNTIME_DEFAULT_CONFIGS);

  const analyzers: EffectiveAnalyzerConfig[] = namespaces.map((namespace) => {
    const defaults = RUNTIME_DEFAULT_CONFIGS[namespace] ?? {};
    const projectOverride = (analyzerConfigs[namespace] as Record<string, unknown>) ?? {};

    const flatDefaults = flatten(defaults, namespace);
    const flatPreset = flattenPresetLayer(namespace, presets);
    const flatProject = flatten(projectOverride, namespace);
    // Path-profile overrides are flat and unnamespaced; the pipeline spreads
    // them into every visitor, so namespace them for display parity.
    const flatProfile = flatten(resolved.overrides, namespace);

    const merged = { ...flatDefaults, ...flatPreset.flat, ...flatProject, ...flatProfile };
    const keys: EffectiveKey[] = Object.keys(merged)
      .sort()
      .map((key) => {
        const value = merged[key];
        const defaultValue = flatDefaults[key];
        const differs = !(key in flatDefaults) || !valuesEqual(value, defaultValue);
        let source: ConfigSource = 'default';
        if (key in flatProfile) {
          // Highest precedence — attribute to the last matching profile.
          const lastProfile = resolved.matchedProfileNames[resolved.matchedProfileNames.length - 1];
          const profile = pathProfiles.find((p) => p.name === lastProfile);
          source = profile ? profileSource(profile) : 'path-profile:unknown';
        } else if (key in flatProject) {
          source = 'project-config';
        } else if (key in flatPreset.sourceByKey) {
          source = `preset:${flatPreset.sourceByKey[key]}`;
        }
        return {
          key,
          value,
          source,
          differsFromDefault: differs,
          defaultValue: key in flatDefaults ? defaultValue : undefined,
        };
      });

    return { namespace, keys };
  });

  return {
    filePath,
    relativePath,
    projectRoot,
    matchedProfiles: resolved.matchedProfileNames,
    excludeFromGate: resolved.excludeFromGate,
    analyzers,
    topLevel: [],
  };
}

/**
 * Top-level (non-analyzer) config keys with source tracking. `base` is
 * `getDefaultConfig()`; `project` is the config loaded from file/env/cli.
 */
export function computeTopLevelConfig(
  base: Record<string, unknown>,
  project: Record<string, unknown>,
): EffectiveKey[] {
  const keys = new Set<string>([...Object.keys(base), ...Object.keys(project)]);
  const out: EffectiveKey[] = [];
  for (const key of [...keys].sort()) {
    const baseValue = base[key];
    const projectValue = project[key];
    const hasProject = key in project && projectValue !== undefined;
    const value = hasProject ? projectValue : baseValue;
    const differs = hasProject && !valuesEqual(value, baseValue);
    out.push({
      key,
      value,
      // A key that equals its default is indistinguishable from unset — the
      // effective value is the default. Only a differing value is attributable
      // to project config.
      source: differs ? 'project-config' : 'default',
      differsFromDefault: differs,
      defaultValue: baseValue,
    });
  }
  return out;
}

function relativePosix(root: string, file: string): string {
  // Use path.relative then normalize separators for stable output.
  const rel = file.startsWith(root)
    ? file.slice(root.length).replace(/^[/\\]+/, '')
    : file;
  return rel.split('\\').join('/');
}
