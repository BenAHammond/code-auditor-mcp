/**
 * Configuration Loader (Functional)
 * Handles loading and merging configuration from multiple sources
 */

import { promises as fs, realpathSync } from 'fs';
import path from 'path';
import { AuditConfig, PathProfile, ProjectFileConfig, PROJECT_FILE_CONFIG_KEYS } from '../types.js';
import { getDefaultConfig, DEFAULT_CODE_INDEX_CONFIG, mergePathProfiles } from './defaults.js';
import { RUNNABLE_ANALYZERS } from '../analyzers/ruleRegistry.js';

/**
 * A config key dropped by `sanitizeProjectFileConfig`, with why.
 * Surfaced in CLI output — a silent drop is how this class of bug survives.
 */
export interface RejectedConfigEntry {
  key: string;
  value: string;
  reason: 'unknown-key' | 'outside-project-root';
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

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}

/**
 * Spec 61 R1.2 — strip every key not in `PROJECT_FILE_CONFIG_KEYS` and contain
 * path-valued keys to the project root. `raw` is the untrusted `JSON.parse`
 * result of a `.codeauditor.json` found inside the project being audited.
 *
 * `scope` is the canonical example of what this drops: it was never declared on
 * `AuditConfig`, reached `execSync(\`git diff --name-only ${ref}\`)` only
 * because `mergeConfig` iterated raw JSON keys, and is absent from
 * `PROJECT_FILE_CONFIG_KEYS`.
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

  const configDir = path.dirname(configPath);
  const projectRootReal = realpathIfExists(projectRoot);
  const config: Partial<ProjectFileConfig> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(PROJECT_FILE_CONFIG_KEYS as readonly string[]).includes(key)) {
      rejected.push({ key, value: safeStringify(value), reason: 'unknown-key' });
      continue;
    }
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
      const resolved = path.resolve(configDir, value);
      if (!isWithinProjectRoot(realpathExistingAncestor(resolved), projectRootReal)) {
        rejected.push({ key, value, reason: 'outside-project-root' });
        continue;
      }
      config[key] = resolved;
      continue;
    }

    (config as Record<string, unknown>)[key] = value;
  }

  return { config, rejected };
}

/**
 * Load configuration from multiple sources
 */
export async function loadConfig(options: {
  configPath?: string;
  projectRoot: string;
  cliArgs?: Partial<AuditConfig>;
  environmentPrefix?: string;
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

  // Load from environment variables
  if (options.environmentPrefix) {
    config = loadFromEnvironment(config, options.environmentPrefix);
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
 * Load configuration from a JSON file
 */
async function loadFromFile(
  baseConfig: AuditConfig,
  configPath: string,
  projectRoot: string,
): Promise<{ config: AuditConfig; rejected: RejectedConfigEntry[] }> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const fileConfig = JSON.parse(content);
    const { config: sanitized, rejected } = sanitizeProjectFileConfig(fileConfig, configPath, projectRoot);
    return { config: mergeConfig(baseConfig, sanitized), rejected };
  } catch (error) {
    console.warn(`Failed to load config from ${configPath}:`, error);
    return { config: baseConfig, rejected: [] };
  }
}

/**
 * Load configuration from environment variables
 */
function loadFromEnvironment(baseConfig: AuditConfig, prefix: string): AuditConfig {
  const env = process.env;
  const envConfig: Partial<ProjectFileConfig> = {};

  // Map environment variables to config properties
  if (env[`${prefix}_MIN_SEVERITY`]) {
    envConfig.minSeverity = env[`${prefix}_MIN_SEVERITY`] as any;
  }

  if (env[`${prefix}_OUTPUT_DIR`]) {
    envConfig.outputDirectory = env[`${prefix}_OUTPUT_DIR`];
  }

  if (env[`${prefix}_FAIL_ON_CRITICAL`]) {
    envConfig.failOnCritical = env[`${prefix}_FAIL_ON_CRITICAL`] === 'true';
  }

  const enabledAnalyzersVar = env[`${prefix}_ANALYZERS`];
  if (enabledAnalyzersVar) {
    envConfig.enabledAnalyzers = enabledAnalyzersVar.split(',');
  }

  // Code index environment variables
  const codeIndexConfig: any = {};
  if (env[`${prefix}_CODE_INDEX_DB_PATH`]) {
    codeIndexConfig.databasePath = env[`${prefix}_CODE_INDEX_DB_PATH`];
  }
  const batchSizeVar = env[`${prefix}_CODE_INDEX_BATCH_SIZE`];
  if (batchSizeVar) {
    codeIndexConfig.maxBatchSize = parseInt(batchSizeVar, 10);
  }
  const searchLimitVar = env[`${prefix}_CODE_INDEX_SEARCH_LIMIT`];
  if (searchLimitVar) {
    codeIndexConfig.searchResultLimit = parseInt(searchLimitVar, 10);
  }
  if (Object.keys(codeIndexConfig).length > 0) {
    (envConfig as any).codeIndex = codeIndexConfig;
  }

  return mergeConfig(baseConfig, envConfig);
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
 */
export function validateConfig(config: AuditConfig): string[] {
  const errors: string[] = [];

  // Validate severity
  if (config.minSeverity && !['critical', 'severe', 'high'].includes(config.minSeverity)) {
    errors.push(`Invalid severity: ${config.minSeverity}`);
  }

  // Validate analyzers against the canonical runnable set (registry rule
  // emitters plus pipeline-only analyzers like `invariants`), so a user naming
  // any analyzer the pipeline can actually run is never rejected for an analyzer
  // that is valid but was missing from a hand-typed list.
  const validAnalyzers = RUNNABLE_ANALYZERS;
  if (config.enabledAnalyzers) {
    const invalid = config.enabledAnalyzers.filter(a => !validAnalyzers.includes(a));
    if (invalid.length > 0) {
      errors.push(`Invalid analyzers: ${invalid.join(', ')}`);
    }
  }

  // Validate path profiles (Spec-20)
  errors.push(...validatePathProfiles(config.pathProfiles));

  // Validate detection mode (Spec-21 R3: shared provenance/fallback mode key)
  errors.push(...validateDetectionConfig(config.analyzerOptions));

  // Validate daemon config (Spec 50 R5)
  errors.push(...validateDaemonConfig(config.daemon));

  return errors;
}

/**
 * Validate Spec 50 R5 daemon config. `idleTimeoutMs` must be a positive number;
 * `autoStart` must be a boolean.
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
  if (
    daemon.idleTimeoutMs !== undefined &&
    (typeof daemon.idleTimeoutMs !== 'number' || !Number.isFinite(daemon.idleTimeoutMs) || daemon.idleTimeoutMs <= 0)
  ) {
    errors.push('daemon.idleTimeoutMs must be a positive number of milliseconds');
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
