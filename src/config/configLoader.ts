/**
 * Configuration Loader (Functional)
 * Handles loading and merging configuration from multiple sources
 */

import { promises as fs } from 'fs';
import path from 'path';
import { AuditConfig, PathProfile } from '../types.js';
import { getDefaultConfig, DEFAULT_CODE_INDEX_CONFIG, mergePathProfiles } from './defaults.js';

/**
 * Load configuration from multiple sources
 */
export async function loadConfig(options?: {
  configPath?: string;
  cliArgs?: Partial<AuditConfig>;
  environmentPrefix?: string;
}): Promise<AuditConfig> {
  // Start with defaults
  let config = getDefaultConfig();
  
  // Add code index defaults
  (config as any).codeIndex = DEFAULT_CODE_INDEX_CONFIG;
  
  // Load from config file if specified
  if (options?.configPath) {
    config = await loadFromFile(config, options.configPath);
  }
  
  // Load from environment variables
  if (options?.environmentPrefix) {
    config = loadFromEnvironment(config, options.environmentPrefix);
  }
  
  // Apply CLI arguments (highest priority)
  if (options?.cliArgs) {
    config = { ...config, ...options.cliArgs };
  }
  
  // Normalize paths
  config = normalizePaths(config);

  // Merge built-in path profiles with user-configured profiles (Spec-20)
  config.pathProfiles = mergePathProfiles(
    config.pathProfiles,
    (config as any).builtin
  );

  return config;
}

/**
 * Load configuration from a JSON file
 */
async function loadFromFile(baseConfig: AuditConfig, configPath: string): Promise<AuditConfig> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const fileConfig = JSON.parse(content);
    return mergeConfig(baseConfig, fileConfig);
  } catch (error) {
    console.warn(`Failed to load config from ${configPath}:`, error);
    return baseConfig;
  }
}

/**
 * Load configuration from environment variables
 */
function loadFromEnvironment(baseConfig: AuditConfig, prefix: string): AuditConfig {
  const env = process.env;
  const envConfig: Partial<AuditConfig> = {};
  
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
function mergeConfig(base: AuditConfig, override: Partial<AuditConfig>): AuditConfig {
  const result: any = { ...base };
  
  for (const key in override) {
    const value = override[key as keyof AuditConfig];
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
function normalizePaths(config: AuditConfig): AuditConfig {
  const normalized = { ...config };
  
  // Normalize output directory
  if (normalized.outputDirectory) {
    normalized.outputDirectory = path.resolve(normalized.outputDirectory);
  }
  
  // Normalize include/exclude paths
  if (normalized.includePaths) {
    normalized.includePaths = normalized.includePaths.map(p => 
      path.isAbsolute(p) ? p : path.join(process.cwd(), p)
    );
  }
  
  if (normalized.excludePaths) {
    normalized.excludePaths = normalized.excludePaths.map(p => 
      path.isAbsolute(p) ? p : path.join(process.cwd(), p)
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
  if (config.minSeverity && !['critical', 'warning', 'suggestion'].includes(config.minSeverity)) {
    errors.push(`Invalid severity: ${config.minSeverity}`);
  }
  
  // Validate analyzers
  const validAnalyzers = ['solid', 'dry', 'react', 'documentation', 'data-access', 'schema', 'invariants'];
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
  const VALID_SEVERITIES = new Set(['suggestion', 'warning', 'critical']);

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

    // Validate severityCap value if present
    if (profile.overrides && typeof profile.overrides === 'object' && !Array.isArray(profile.overrides)) {
      const cap = (profile.overrides as Record<string, unknown>).severityCap;
      if (cap !== undefined) {
        if (typeof cap !== 'string' || !VALID_SEVERITIES.has(cap)) {
          errors.push(
            `Path profile "${profile.name}" : severityCap must be one of "suggestion", "warning", "critical" — got "${String(cap)}"`
          );
        }
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
export type { AuditConfig } from '../types.js';