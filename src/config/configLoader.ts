/**
 * Configuration Loader (Functional)
 * Handles loading and merging configuration from multiple sources
 */

import { promises as fs, realpathSync } from 'fs';
import path from 'path';
import { AuditConfig, PathProfile, ProjectFileConfig, PROJECT_FILE_CONFIG_KEYS } from '../types.js';
import { getDefaultConfig, DEFAULT_CODE_INDEX_CONFIG, mergePathProfiles } from './defaults.js';
import { RUNTIME_DEFAULT_CONFIGS } from './effectiveConfig.js';

/**
 * A config key dropped by `sanitizeProjectFileConfig`, with why.
 * Surfaced in CLI output — a silent drop is how this class of bug survives.
 *
 * Only *value-level* rejections remain here: a path that escapes the project
 * root, or a file-sourced output directory (refused for security). Unknown keys
 * no longer land in this array — they throw (see `sanitizeProjectFileConfig`).
 */
export interface RejectedConfigEntry {
  key: string;
  value: string;
  reason: 'outside-project-root' | 'output-directory-refused';
}

/**
 * What `loadConfig` returns: the merged config plus every file-sourced entry
 * that was rejected during sanitization (Spec 61 R1.4).
 */
export interface LoadConfigResult {
  config: AuditConfig;
  rejected: RejectedConfigEntry[];
}

/** Realpath that falls back to `path.resolve` when the path does not exist
 * (globs, not-yet-created output dirs). */
function realpathIfExists(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Realpath the deepest *existing ancestor* of `p`, rejoining the non-existent
 * (glob) suffix. A containment check must compare the candidate against the
 * realpath'd project root on the same canonical basis: `path.resolve` alone
 * leaves `/var` (symlinked to `/private/var` on macOS) unresolved, so a glob
 * like `src/**` would otherwise be misread as outside the root. Realpathing the
 * existing prefix still resolves any symlink in the path, so a symlink pointing
 * out of the tree is caught.
 */
function realpathExistingAncestor(p: string): string {
  let cur = p;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // nothing above exists
      suffix.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `candidate` is `projectRootReal` or beneath it. Comparison is on
 * resolved real paths, so a symlink pointing out of the tree is caught. */
function isWithinProjectRoot(candidate: string, projectRootReal: string): boolean {
  return candidate === projectRootReal || candidate.startsWith(projectRootReal + path.sep);
}

/**
 * Top-level config keys that were renamed; the live key each one moved to. Used
 * by `sanitizeProjectFileConfig` to turn an unknown key into a migration message
 * (`analyzerConfig` → `analyzerConfigs`) instead of a bare "not recognised".
 */
const RENAMED_TOP_LEVEL_KEYS: Record<string, string> = {
  analyzerConfig: 'analyzerConfigs',
};

/**
 * Spec 61 R1.2 — strip every key not in `PROJECT_FILE_CONFIG_KEYS` and contain
 * path-valued keys to the project root. `raw` is the untrusted `JSON.parse`
 * result of a `.codeauditor.json` found inside the project being audited.
 *
 * `scope` is the canonical example of what this rejects: it was never declared
 * on `AuditConfig`, reached `execSync(\`git diff --name-only ${ref}\`)` only
 * because `mergeConfig` iterated raw JSON keys, and is absent from
 * `PROJECT_FILE_CONFIG_KEYS`.
 *
 * An unknown key is NOT silently dropped — it throws, naming the key and (where
 * one exists) the live key it was renamed to. This is the *single* disposition
 * for unknown keys in the loader: the same path `validateThresholds` uses, not
 * a soft-reject into a `rejected` array.
 *
 * @param raw The untrusted `JSON.parse` result of a `.codeauditor.json` file.
 * @param configPath The path to the config file, used to resolve relative paths.
 * @param projectRoot The project root that path-valued keys must stay within.
 * @returns The sanitized config fragment plus every value-level rejection.
 */
export function sanitizeProjectFileConfig(
  raw: unknown,
  configPath: string,
  projectRoot: string,
): { config: Partial<ProjectFileConfig>; rejected: RejectedConfigEntry[] } {
  const rejected: RejectedConfigEntry[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: {}, rejected };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  const unknownKeys = entries
    .filter(([key]) => !(PROJECT_FILE_CONFIG_KEYS as readonly string[]).includes(key))
    .map(([key]) => key);
  if (unknownKeys.length > 0) {
    const lines = unknownKeys.map((key) => {
      const live = RENAMED_TOP_LEVEL_KEYS[key];
      return live
        ? `"${key}" is not recognised — the live key is "${live}"`
        : `"${key}" is not recognised and has no live equivalent — remove it`;
    });
    throw new Error(`Unknown configuration keys in ${configPath}:\n${lines.map((l) => `  - ${l}`).join('\n')}`);
  }

  const configDir = path.dirname(configPath);
  const projectRootReal = realpathIfExists(projectRoot);
  const config: Partial<ProjectFileConfig> = {};

  for (const [key, value] of entries) {
    if (value === undefined) continue;

    if (key === 'includePaths' || key === 'excludePaths') {
      if (!Array.isArray(value)) continue;
      const kept: string[] = [];
      for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const resolved = path.resolve(configDir, entry);
        if (!isWithinProjectRoot(realpathExistingAncestor(resolved), projectRootReal)) {
          rejected.push({ key, value: entry, reason: 'outside-project-root' });
          continue;
        }
        kept.push(resolved);
      }
      config[key] = kept;
      continue;
    }

    if (key === 'outputDir' || key === 'outputDirectory') {
      if (typeof value !== 'string') continue;
      // Spec 61 R1.2 follow-up — a file-config-supplied output path is refused,
      // not clamped. The report writer writes only to an explicit CLI `--output`
      // path (or stdout); accepting an in-tree config path would pin a
      // destructive report write inside the audited project. Refuse the key so
      // it can never silently redirect a report into the tree.
      rejected.push({ key, value, reason: 'output-directory-refused' });
      continue;
    }

    (config as Record<string, unknown>)[key] = value;
  }

  return { config, rejected };
}

/**
 * Load configuration from multiple sources
 *
 * @param options Loader options: the config path, project root, and CLI overrides.
 * @returns The merged config plus every file-sourced entry that was rejected.
 */
export async function loadConfig(options: {
  configPath?: string;
  projectRoot: string;
  cliArgs?: Partial<AuditConfig>;
}): Promise<LoadConfigResult> {
  // Start with defaults
  let config = getDefaultConfig();

  // Add code index defaults
  (config as any).codeIndex = DEFAULT_CODE_INDEX_CONFIG;

  // Rejected file-sourced keys, surfaced to the CLI (Spec 61 R1.4).
  let rejected: RejectedConfigEntry[] = [];

  // Load from config file if specified
  if (options.configPath) {
    const loaded = await loadFromFile(config, options.configPath, options.projectRoot);
    config = loaded.config;
    rejected = loaded.rejected;
  }

  // Apply CLI arguments (highest priority)
  if (options.cliArgs) {
    config = { ...config, ...options.cliArgs };
  }

  // Normalize paths — resolve relative paths against the config file's directory
  // (or cwd when loading defaults only, which is the CLI's typical invocation)
  const baseDir = options.configPath ? path.dirname(options.configPath) : undefined;
  config = normalizePaths(config, baseDir);

  // Merge built-in path profiles with user-configured profiles (Spec-20)
  config.pathProfiles = mergePathProfiles(
    config.pathProfiles,
    (config as any).builtin
  );

  // Spec 61 R1.5 — validateConfig was exported and never called in the run
  // path; a bad config failed the audit only if a downstream reader noticed.
  // Fail loudly here instead of silently skipping a misconfigured rule.
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return { config, rejected };
}

/**
 * Find the nearest `.codeauditor.json` by walking up from `startDir` to the
 * filesystem root. Returns the absolute config path, or null when none exists.
 *
 * This is what lets a scoped audit (`code-audit audit --path src`) still load
 * the project-root config instead of silently falling back to defaults: the
 * config lives at the project root, which is an ancestor of the audit path.
 *
 * @param startDir The directory to begin the upward search from.
 * @returns The absolute path to the nearest `.codeauditor.json`, or null.
 */
export async function findConfigFileUp(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.codeauditor.json');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not here — continue up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Read the effective health-score floor for a project. When a `.codeauditor.json`
 * exists, this is `loadConfig`'s `thresholds.minHealthScore` — the file's value
 * when it sets one, otherwise `DEFAULT_HEALTH_SCORE_THRESHOLD` (the loader merges
 * the config default). When there is no config file it returns `undefined`, so
 * the caller falls back through `resolveHealthThreshold` — the one place the
 * final fallback is computed. Loading the full config here (not just the raw
 * `thresholds` fragment) means an invalid config surfaces as a load error before
 * any threshold is used, identical to the audit runner. The per-call `threshold`
 * argument still wins over this value.
 */
export async function loadMinHealthScore(projectRoot: string): Promise<number | undefined> {
  const configPath = await findConfigFileUp(projectRoot);
  if (!configPath) return undefined;
  const { config } = await loadConfig({ configPath, projectRoot });
  return config.thresholds?.minHealthScore;
}

/**
 * Load configuration from a JSON file
 */
async function loadFromFile(
  baseConfig: AuditConfig,
  configPath: string,
  projectRoot: string,
): Promise<{ config: AuditConfig; rejected: RejectedConfigEntry[] }> {
  // Only read/parse failures are tolerated (missing file, malformed JSON). An
  // unknown key thrown by `sanitizeProjectFileConfig` must propagate to
  // `loadConfig`'s caller — swallowing it here would silently re-open the
  // write-only-rejection channel this loader just closed.
  let fileConfig: unknown;
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    fileConfig = JSON.parse(content);
  } catch (error) {
    console.warn(`Failed to load config from ${configPath}:`, error);
    return { config: baseConfig, rejected: [] };
  }
  const { config: sanitized, rejected } = sanitizeProjectFileConfig(fileConfig, configPath, projectRoot);
  return { config: mergeConfig(baseConfig, sanitized), rejected };
}

/**
 * Deep merge two configuration objects
 */
function mergeConfig(base: AuditConfig, override: Partial<ProjectFileConfig>): AuditConfig {
  const result: any = { ...base };

  for (const key in override) {
    const value = override[key as keyof ProjectFileConfig];
    if (value !== undefined) {
      if (typeof value === 'object' && !Array.isArray(value)) {
        const baseValue = base[key as keyof AuditConfig];
        result[key] = {
          ...(typeof baseValue === 'object' ? baseValue : {}),
          ...value
        };
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Normalize file paths in configuration
 */
function normalizePaths(config: AuditConfig, baseDir?: string): AuditConfig {
  const normalized = { ...config };
  const root = baseDir || process.cwd();

  // Normalize output directory
  if (normalized.outputDirectory) {
    normalized.outputDirectory = path.resolve(root, normalized.outputDirectory);
  }

  // Normalize include/exclude paths
  if (normalized.includePaths) {
    normalized.includePaths = normalized.includePaths.map(p =>
      path.isAbsolute(p) ? p : path.resolve(root, p)
    );
  }

  if (normalized.excludePaths) {
    normalized.excludePaths = normalized.excludePaths.map(p =>
      path.isAbsolute(p) ? p : path.resolve(root, p)
    );
  }

  return normalized;
}

/**
 * Validate configuration
 *
 * @param config The merged config to validate.
 * @returns A list of validation error messages (empty when valid).
 */
export function validateConfig(config: AuditConfig): string[] {
  const errors: string[] = [];

  // Validate severity
  if (config.minSeverity && !['critical', 'severe', 'high'].includes(config.minSeverity)) {
    errors.push(`Invalid severity: ${config.minSeverity}`);
  }

  // Validate path profiles (Spec-20)
  errors.push(...validatePathProfiles(config.pathProfiles));

  // Validate detection mode (Spec-21 R3: shared provenance/fallback mode key)
  errors.push(...validateDetectionConfig(config.analyzerOptions));

  // Validate daemon config (Spec 50 R5)
  errors.push(...validateDaemonConfig(config.daemon));

  // Validate the health-score floor (Spec 11 sweep follow-up)
  errors.push(...validateThresholds(config.thresholds));

  // Validate the analyzer config in full — a phantom namespace (e.g. `component`)
  // or a phantom sub-key (e.g. `data-access.databasePatterns`) configures nothing
  // and must not be silently dropped.
  errors.push(...validateAnalyzerConfigs(config.analyzerConfigs));

  return errors;
}

/**
 * Validate Spec 50 R5 daemon config. `idleTimeoutMs` must be a positive number;
 * `autoStart` must be a boolean — and, since it is declared-but-not-wired, must
 * not be `true` (a user setting it gets told, instead of getting silence).
 */
function validateDaemonConfig(daemon: AuditConfig['daemon']): string[] {
  const errors: string[] = [];
  if (daemon === undefined || daemon === null) return errors;
  if (typeof daemon !== 'object' || Array.isArray(daemon)) {
    errors.push('daemon must be an object');
    return errors;
  }
  if (daemon.autoStart !== undefined && typeof daemon.autoStart !== 'boolean') {
    errors.push('daemon.autoStart must be a boolean');
  }
  if (daemon.autoStart === true) {
    errors.push('daemon.autoStart is not implemented — a daemon is only started by `code-audit daemon start`; remove the flag or set it to false');
  }
  if (
    daemon.idleTimeoutMs !== undefined &&
    (typeof daemon.idleTimeoutMs !== 'number' || !Number.isFinite(daemon.idleTimeoutMs) || daemon.idleTimeoutMs <= 0)
  ) {
    errors.push('daemon.idleTimeoutMs must be a positive number of milliseconds');
  }
  return errors;
}

/**
 * Validate the restored `thresholds.minHealthScore` (Spec 11 sweep follow-up).
 * Only `minHealthScore` survives the sweep; every other historical `thresholds`
 * key is rejected with a message that *is* the migration — it names the key,
 * says it was removed, and names the live key that replaced it where one exists.
 * A user upgrading from a config that still carries the old keys reads the error
 * and knows exactly what to change (no silent drop, no warning-and-continue).
 *
 * Removed-key fate:
 *   - `maxSevere`/`maxCritical`/`maxHigh`/`maxWarnings` — the severity gate is
 *     gone (Spec 54 R3: every finding blocks), so these have no replacement and
 *     must be deleted.
 *   - `maxComplexity` — moved, not removed: the per-method cyclomatic-complexity
 *     ceiling now lives at `analyzerConfigs.solid.maxMethodComplexity`.
 *   - `maxDuplication` — no live duplication-count threshold; delete it.
 */
function validateThresholds(thresholds: AuditConfig['thresholds']): string[] {
  const errors: string[] = [];
  if (thresholds === undefined || thresholds === null) return errors;
  if (typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    errors.push('thresholds must be an object');
    return errors;
  }

  // Removed `thresholds` key → its live replacement (as a `solid.*` leaf name),
  // or null when the key was removed outright with no replacement.
  const REMOVED: Record<string, string | null> = {
    maxSevere: null,
    maxCritical: null,
    maxHigh: null,
    maxWarnings: null,
    maxComplexity: 'maxMethodComplexity',
    maxDuplication: null,
  };

  const VALID_KEYS = new Set(['minHealthScore']);
  for (const key of Object.keys(thresholds as Record<string, unknown>)) {
    if (VALID_KEYS.has(key)) continue;
    const replacement = REMOVED[key];
    if (replacement !== undefined) {
      if (replacement === null) {
        errors.push(
          `thresholds.${key} was removed and has no replacement — the severity-gate thresholds were removed (Spec 54 R3: every finding blocks); delete it from your config`,
        );
      } else {
        errors.push(
          `thresholds.${key} was removed and replaced by "analyzerConfigs.solid.${replacement}" — move it there`,
        );
      }
    } else {
      errors.push(`Unknown key in thresholds "${key}" — only "minHealthScore" remains`);
    }
  }
  const m = (thresholds as { minHealthScore?: unknown }).minHealthScore;
  if (m !== undefined && (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > 100)) {
    errors.push(`thresholds.minHealthScore must be a number 0-100 — got "${String(m)}"`);
  }
  return errors;
}

/**
 * Namespaces that were renamed; the live namespace each one moved to. Used by
 * `validateAnalyzerConfigs` to turn an unknown namespace into a migration
 * message (`component` → `react`) instead of a bare "not recognised".
 */
const RENAMED_NAMESPACES: Record<string, string> = {
  component: 'react',
};

/**
 * Analyzer sub-keys that were renamed; the live key each one moved to, keyed by
 * its full dotted path (namespace-qualified, e.g. `solid.classMethodThreshold`).
 * A key absent from this map has no live equivalent and is rejected outright.
 *
 * This is the only hand-maintained fragment — and it is a *migration* map, not a
 * shape definition. The set of *valid* keys is derived from the config types
 * themselves (`RUNTIME_DEFAULT_CONFIGS`), so a new live key needs no entry here;
 * only a key that *moved* does.
 */
const RENAMED_ANALYZER_KEYS: Record<string, string> = {
  'solid.classMethodThreshold': 'solid.classMethodsThreshold',
  'solid.interfaceMemberThreshold': 'solid.maxInterfaceMembers',
  'data-access.performanceThresholds.maxJoins': 'data-access.performanceThresholds.joinedTableCount',
};

/**
 * Render a key path for an error message, bracket-quoting segments that are not
 * plain identifiers: `analyzerConfigs`, `data-access`, `ormPatterns` →
 * `analyzerConfigs["data-access"].ormPatterns`.
 */
function renderConfigKeyPath(segments: readonly string[]): string {
  // Dot-join identifier segments, but a bracket segment (`["data-access"]`) is
  // appended directly — `analyzerConfigs["data-access"].ormPatterns`, not
  // `analyzerConfigs.["data-access"].ormPatterns`.
  let out = '';
  for (const s of segments) {
    if (/^[A-Za-z0-9_]+$/.test(s)) {
      out += (out === '' ? '' : '.') + s;
    } else {
      out += `["${s}"]`;
    }
  }
  return out;
}

/**
 * Validate the `analyzerConfigs` object in full, not just its namespace names.
 *
 * The valid shape at every depth is derived from the analyzer config *types*,
 * via their runtime embodiment: each analyzer's `DEFAULT_*_CONFIG`, collected in
 * `RUNTIME_DEFAULT_CONFIGS` (effectiveConfig.ts). There is no hand-maintained key
 * whitelist and no parallel JSON Schema — the default object is the type's own
 * value, so a key is "live" iff it exists at that path in the default. A key
 * anywhere in the tree that is not live throws through the same disposition as
 * an unknown top-level key: named by full dotted location, with its live
 * equivalent where one exists.
 *
 * `component` and `security` are the two historical phantom namespaces;
 * `component` moved to `react`, `security` had no live replacement. Below the
 * namespace, a handful of keys were renamed rather than removed (see
 * `RENAMED_ANALYZER_KEYS`); the rest of the phantom sub-keys the examples once
 * carried (`databasePatterns`, `ifElseChainThreshold`, …) have no live
 * equivalent and are rejected outright.
 */
function validateAnalyzerConfigs(
  analyzerConfigs: AuditConfig['analyzerConfigs'],
): string[] {
  const errors: string[] = [];
  if (analyzerConfigs === undefined || analyzerConfigs === null) return errors;
  if (typeof analyzerConfigs !== 'object' || Array.isArray(analyzerConfigs)) {
    errors.push('analyzerConfigs must be an object');
    return errors;
  }

  for (const ns of Object.keys(analyzerConfigs as Record<string, unknown>)) {
    const defaults = RUNTIME_DEFAULT_CONFIGS[ns];
    if (defaults === undefined) {
      const live = RENAMED_NAMESPACES[ns];
      errors.push(
        live
          ? `analyzerConfigs.${ns} is not recognised — the live namespace is "${live}"`
          : `analyzerConfigs.${ns} is not recognised and has no live namespace — remove it`,
      );
      continue;
    }
    errors.push(...validateAnalyzerSubKeys((analyzerConfigs as Record<string, unknown>)[ns], defaults, [ns]));
  }
  return errors;
}

/**
 * Recursively check that every key in `user` exists at the same path in
 * `defaults`. A nested object in `defaults` is descended into; arrays, scalars
 * and null are leaf values (their contents are not key-validated). `segments` is
 * the dotted path accumulated so far, namespace first.
 */
function validateAnalyzerSubKeys(
  user: unknown,
  defaults: Record<string, unknown>,
  segments: string[],
): string[] {
  const errors: string[] = [];
  if (user === null || typeof user !== 'object' || Array.isArray(user)) return errors;

  for (const key of Object.keys(user as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      const fullSegments = [...segments, key];
      const fullPath = renderConfigKeyPath(['analyzerConfigs', ...fullSegments]);
      const target = RENAMED_ANALYZER_KEYS[fullSegments.join('.')];
      errors.push(
        target !== undefined
          ? `${fullPath} is not recognised — the live key is "${renderConfigKeyPath(['analyzerConfigs', ...target.split('.')])}"`
          : `${fullPath} is not recognised and has no live equivalent — remove it`,
      );
      continue;
    }
    const defaultValue = defaults[key];
    if (defaultValue !== null && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
      errors.push(...validateAnalyzerSubKeys(
        (user as Record<string, unknown>)[key],
        defaultValue as Record<string, unknown>,
        [...segments, key],
      ));
    }
  }
  return errors;
}

/**
 * Validate Spec-21 R3 detection mode config.
 * The `detection.mode` key is shared across analyzers that use provenance.
 */
function validateDetectionConfig(
  analyzerConfigs: Record<string, any> | undefined,
): string[] {
  const errors: string[] = [];
  if (!analyzerConfigs) return errors;

  const VALID_MODES = new Set(['hybrid', 'provenance', 'names']);
  const CONSUMERS = ['data-access', 'schema'];

  for (const name of CONSUMERS) {
    const cfg = analyzerConfigs[name];
    if (!cfg) continue;
    const detection = cfg.detection;
    if (detection == null) continue;
    if (typeof detection !== 'object' || Array.isArray(detection)) {
      errors.push(`analyzerConfigs.${name}.detection must be an object`);
      continue;
    }
    const mode = (detection as Record<string, unknown>).mode;
    if (mode !== undefined && (typeof mode !== 'string' || !VALID_MODES.has(mode))) {
      errors.push(
        `analyzerConfigs.${name}.detection.mode must be one of "hybrid", "provenance", "names" — got "${String(mode)}"`,
      );
    }
  }

  return errors;
}

/**
 * Validate path profiles structure and values.
 */
function validatePathProfiles(profiles: PathProfile[] | undefined): string[] {
  const errors: string[] = [];

  if (!profiles || profiles.length === 0) return errors;

  if (!Array.isArray(profiles)) {
    errors.push('pathProfiles must be an array');
    return errors;
  }

  const seenNames = new Set<string>();
  const VALID_PROFILE_KEYS = new Set(['name', 'paths', 'overrides', 'builtin']);

  for (const profile of profiles) {
    // Check for unknown keys
    for (const key of Object.keys(profile)) {
      if (!VALID_PROFILE_KEYS.has(key)) {
        errors.push(`Unknown key in path profile "${profile.name || '(unnamed)'}" : "${key}"`);
      }
    }

    // name must be a non-empty string
    if (typeof profile.name !== 'string' || profile.name.trim().length === 0) {
      errors.push('Path profile "name" must be a non-empty string');
    }

    // paths must be a non-empty array of strings
    if (!Array.isArray(profile.paths) || profile.paths.length === 0) {
      errors.push(`Path profile "${profile.name || '(unnamed)'}" : "paths" must be a non-empty array of glob patterns`);
    } else {
      for (const p of profile.paths) {
        if (typeof p !== 'string') {
          errors.push(`Path profile "${profile.name}" : "paths" entries must be strings`);
          break;
        }
      }
    }

    // overrides must be an object
    if (typeof profile.overrides !== 'object' || profile.overrides === null || Array.isArray(profile.overrides)) {
      errors.push(`Path profile "${profile.name}" : "overrides" must be an object`);
    }

    // Reject the removed severityCap key and validate excludeFromGate (Spec-36 R4).
    // severityCap was the "soften a finding in place" mechanism that made findings
    // invisible without excluding the file; it is removed outright.
    if (profile.overrides && typeof profile.overrides === 'object' && !Array.isArray(profile.overrides)) {
      const overrides = profile.overrides as Record<string, unknown>;
      if (overrides.severityCap !== undefined) {
        errors.push(
          `Path profile "${profile.name}" : "severityCap" has been removed (Spec-36 R4). Use "excludeFromGate": true to exclude a file from the blocking gate instead of softening findings within it.`
        );
      }
      if (overrides.excludeFromGate !== undefined && typeof overrides.excludeFromGate !== 'boolean') {
        errors.push(
          `Path profile "${profile.name}" : "excludeFromGate" must be a boolean — got "${String(overrides.excludeFromGate)}"`
        );
      }
    }

    // Check for duplicate names
    if (profile.name && seenNames.has(profile.name)) {
      errors.push(`Duplicate path profile name: "${profile.name}"`);
    }
    if (profile.name) {
      seenNames.add(profile.name);
    }
  }

  return errors;
}

// Re-export for convenience
export type { AuditConfig, ProjectFileConfig } from '../types.js';
